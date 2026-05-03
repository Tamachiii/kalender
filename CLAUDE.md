# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No bundler, package manager, test runner, or linter. The app is plain ES modules served as static files. The only "build" step is generating `js/config.js` in CI.

- `node server.mjs` — serve the app at http://127.0.0.1:4173/. The server is a tiny static file handler in `server.mjs`; it must be used (not `file://`) because the app loads ES modules. `PORT=...` overrides the port.
- **Local config** — `js/config.js` is **gitignored**. For local dev, `cp js/config.example.js js/config.js` and fill in the two `__SUPABASE_*__` placeholders.
- **Deploys** are GitHub Pages via `.github/workflows/deploy.yml`. The workflow regenerates `js/config.js` from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` repository secrets before uploading the Pages artifact. **Never commit `js/config.js`** — `.gitignore` enforces this and the workflow is the only thing that should ever produce it.
- Supabase migrations live under `supabase/` and are applied by pasting them into the Supabase SQL editor — there is no migration CLI. Run order for an existing project: `rls_fix_calendars.sql` if calendar inserts fail RLS, then `feature_updates.sql` for tags / completion / archive / `share_calendar_by_email`. `schema.sql` is the from-scratch baseline.

## Architecture

Single-page PWA backed by Supabase. The browser holds the publishable key only — **the database (RLS) is the authorization boundary**. There is no backend server beyond Supabase.

### Module layering (`js/`)

Strict one-way dependency direction; do not introduce cycles:

```
config.js  →  supabaseClient.js  →  api.js  →  app.js  ←  ui.js
                                       ↑                ↑
                                  store.js (state)  ←──┘
                                  dateUtils.js  (pure helpers)
```

- `config.js` — Supabase URL/key, `CATEGORY_COLORS`, and the derived `BUILT_IN_TAGS` array. Built-in tag IDs (`work`, `personal`, ...) collide-by-design with `events.category` values; new built-ins must match a category string.
- `supabaseClient.js` — singleton client. Uses a custom `storageKey` (`shared-calendar-auth-v2`) and clears two legacy keys on first load; renaming the key strands users without warning.
- `api.js` — every Supabase call lives here. Notable: `fetchCalendars` retries the select without `archived_at` if the column is missing (graceful pre-migration fallback); `subscribeToEvents` opens one channel with one `postgres_changes` listener per calendar ID and returns the channel for later `removeChannel`.
- `store.js` — single mutable `state` object plus selectors. `eventTagKey` resolves an event's display tag by preferring a still-valid `tag_id` and falling back to `category`; `eventTag`/`findTag` look up against `BUILT_IN_TAGS ∪ state.tags`. `canEditCalendar` is the client-side mirror of the RLS edit rule.
- `ui.js` — all DOM rendering and form read/write. `app.js` never touches the DOM directly except through `elements()`/the helpers exported here.
- `app.js` — wires DOM events to api/store, owns lifecycle (`boot`, `loadWorkspace`, `recoverAfterResume`), realtime subscription churn, optimistic updates, swipe nav, quick-add parsing, and reminder scheduling.

### State and rendering flow

`state` in `store.js` is mutated directly by `app.js`; UI re-renders are imperative via `renderAll()` / `renderCalendar()` / `renderCalendars()` from `ui.js`. There is no framework and no diffing — re-render after every state change.

`refreshRequestId` in `app.js` is a monotonic counter that gates async event fetches against later state mutations (e.g. optimistic save, delete, archive). Bump it any time you mutate `state.events` optimistically so an in-flight `fetchEvents` cannot stomp newer state on resolve. The same pattern guards `recoverAfterResume`.

### Optimistic mutations

Event save and delete in `app.js` apply the change to `state.events` immediately, render, then call Supabase. On error they restore `previousEvents` and re-render. New events get a `tmp-${Date.now()}` ID that is replaced when the server row returns. Keep this pattern for any new event/calendar mutations — losing it makes the mobile UI feel broken on slow networks.

### Tag system invariant

An event's color/tag is stored in **three** fields that must stay consistent: `events.category` (built-in tag id or legacy category), `events.tag_id` (FK to user `tags`, nullable), and `events.color` (display snapshot). `saveEvent` in `api.js` writes all three from the form payload. When editing tag-related code, verify all three on the returned row — silent drift here is the most common cause of "tag changed visually but reverts on reopen" bugs.

### Realtime + lifecycle

`setupRealtime()` tears down and re-opens the channel whenever the set of visible calendar IDs changes (login, archive toggle, calendar create/delete). `recoverAfterResume()` runs on `visibilitychange`, `focus`, `online`, and `pageshow` (persisted), debounced by `lastResumeAt`/`resumeInFlight`, to re-validate the session and re-subscribe after the device wakes or returns to the tab. Mobile Safari/Chrome will silently drop the realtime socket otherwise.

### Service worker and cache versioning

`sw.js` is **network-first for navigations** and stale-while-revalidate for other GETs, keyed by `CACHE_NAME = 'kalender-shell-v11'`. The CSS/JS `<script>`/`<link>` tags in `index.html` are versioned with `?v=11`. **When shipping any JS/CSS change, bump both the `?v=N` query in `index.html` and `CACHE_NAME` in `sw.js` together** — mismatched versions are the documented cause of the GitHub Pages blank-screen regression.

### Supabase / RLS rules to preserve

- Never add `anon` policies for private calendar data; never hardcode user IDs.
- The `calendars_add_owner_member` trigger is what makes a freshly inserted calendar visible to its creator; do not remove it unless calendar creation is replaced by an RPC that also creates the membership row.
- Sharing must go through the `share_calendar_by_email` RPC — the frontend cannot read `auth.users` and must not try.
- Helper functions (`is_calendar_member`, `is_calendar_owner`, `can_edit_calendar`) are `security definer` to avoid recursive RLS on `calendar_members`; preserve that when editing them.

## Mobile UI constraints

The shell is mobile-first with four bottom tabs (Calendar / Tasks / Create / Settings). Specific constraints:

- Month view: tapping a day opens the **day detail** view (`openDayDetail`), it does **not** open the event form. Date-accuracy testing should use day detail to avoid accidental creates.
- Week and day views snap to full-width day columns on phones; do not switch to partial-width columns (reintroduces a clipped-next-day bug).
- New event creation belongs to the Create tab; keep secondary controls in Tasks/Settings. Do not add desktop sidebars to the mobile layout.
- The viewport tag disables zoom and uses `100dvh` + safe-area padding so the calendar renders correctly immediately after login.

## Regression checklist

A full pre-deploy mobile-viewport checklist lives in `README.md` ("Developer regression checklist"). Run it before shipping UI or data-flow changes, especially the tag-edit round-trip and the archive/restore flow.
