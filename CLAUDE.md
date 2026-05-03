# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No bundler, package manager, test runner, or linter. The app is plain ES modules served as static files. The only "build" steps in CI are generating `js/config.js` from secrets and stamping `__BUILD_VERSION__` in `index.html` + `sw.js` with the commit SHA.

- `node server.mjs` — serve the app at http://127.0.0.1:4173/. The server is a tiny static file handler in `server.mjs`; it must be used (not `file://`) because the app loads ES modules. `PORT=...` overrides the port.
- **Preview tool** — `.claude/launch.json` registers a `kalender` server config so the Claude Preview tool can start/stop it (`preview_start`, `preview_screenshot`, `preview_console_logs`, etc.). On Windows + WSL the launch entry shells through `wsl.exe -d Ubuntu --cd /home/tamachi/kalender -- bash -lc "node server.mjs"` because Node is installed inside WSL, not on the Windows PATH. If you change distro name or the project path, update that file.
- **Local config** — `js/config.js` is **gitignored**. For local dev, `cp js/config.example.js js/config.js` and fill in the two `__SUPABASE_*__` placeholders. The publishable key must point at a Supabase project where you actually have a confirmed user, otherwise login returns a generic `Invalid login credentials` from Supabase. Local dev hits the same Supabase project as prod for whichever key is in the file — there is no offline mock.
- **Deploys** are GitHub Pages via `.github/workflows/deploy.yml`. The workflow regenerates `js/config.js` from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` repository secrets before uploading the Pages artifact. **Never commit `js/config.js`** — `.gitignore` enforces this and the workflow is the only thing that should ever produce it.
- Supabase migrations live under `supabase/` and are applied by pasting them into the Supabase SQL editor — there is no migration CLI. Run order for an existing project: `rls_fix_calendars.sql` if calendar inserts fail RLS, then `feature_updates.sql` for completion / archive / `share_calendar_by_email`, then `2026-05-add-quick-add-templates.sql`, then `2026-05-calendar-scoped-tags.sql` (move tags from user-scoped to calendar-scoped, drop `events.category` and `events.color`), then — only after verifying the new tag flow with two real users — `2026-05-calendar-scoped-tags-cleanup.sql` (drops legacy rows, adds `NOT NULL` and `unique(calendar_id, name)`), then `2026-05-events-tag-id-index.sql` (covers delete-tag reassign/count), and finally `2026-05-color-format-check.sql` (locks `tags.color`/`calendars.color` to strict 6-digit hex; defends against stored XSS via a malicious color string from a calendar collaborator). `schema.sql` is the from-scratch baseline.

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

- `config.js` — Supabase URL/key plus `FALLBACK_TAG_COLOR` / `FALLBACK_TAG_NAME` used only when an event arrives via realtime ahead of its tag row. There is no built-in-tag list anymore: every calendar gets six seeded tags (Untagged + Work/Personal/Urgent/Focus/Travel) at create time via the `seed_calendar_tags` SQL trigger.
- `supabaseClient.js` — singleton client. Uses a custom `storageKey` (`shared-calendar-auth-v2`) and clears two legacy keys on first load; renaming the key strands users without warning.
- `api.js` — every Supabase call lives here. Notable: `fetchCalendars` retries the select without `archived_at` if the column is missing (graceful pre-migration fallback); `subscribeToWorkspace` opens one channel with one `postgres_changes` listener per (table, calendar_id) pair (events + tags) and returns the channel for later `removeChannel`.
- `store.js` — single mutable `state` object plus selectors. `tagsForCalendar(calendarId)` is the only way to populate a tag picker — never iterate `state.tags` directly, or events from one calendar can be saved with a tag from another. `findTag(id)` is a global lookup used to resolve an existing event's tag for rendering. `canEditCalendar` is the client-side mirror of the RLS edit rule.
- `ui.js` — all DOM rendering and form read/write. `app.js` never touches the DOM directly except through `elements()`/the helpers exported here.
- `app.js` — wires DOM events to api/store, owns lifecycle (`boot`, `loadWorkspace`, `recoverAfterResume`), realtime subscription churn, optimistic updates, swipe nav, quick-add parsing, and reminder scheduling.

### State and rendering flow

`state` in `store.js` is mutated directly by `app.js`; UI re-renders are imperative via `renderAll()` / `renderCalendar()` / `renderCalendars()` from `ui.js`. There is no framework and no diffing — re-render after every state change.

`refreshRequestId` in `app.js` is a monotonic counter that gates async event fetches against later state mutations (e.g. optimistic save, delete, archive). Bump it any time you mutate `state.events` optimistically so an in-flight `fetchEvents` cannot stomp newer state on resolve. The same pattern guards `recoverAfterResume`.

### Optimistic mutations

Most mutations route through `withOptimisticUpdate({ apply, persist, success?, errorMessage? })` at the top of [js/app.js](js/app.js). It snapshots `events` / `calendars` / `tags` / `activeCalendarId`, bumps `refreshRequestId`, runs `apply()` + render, awaits `persist()`, and on failure restores the snapshot, re-renders, and toasts. Use this helper for any new event/calendar mutation — it removes the most common bug shape (forgetting to roll back, forgetting to bump `refreshRequestId`, or rendering at the wrong moment).

Two constraints when calling it:

- `apply()` must replace state slices immutably (`state.events = state.events.filter(...)`, `state.events = state.events.map(...)`). Mutating an object in place won't be undone by snapshot rollback.
- `handleEventSubmit` is intentionally *not* using the helper — its temporary-ID-then-reconcile shape is too specific to fold in cleanly. New event creation flows should follow that pattern; everything else uses the helper.

New events get a `tmp-${Date.now()}` ID that is replaced when the server row returns.

### Tag system invariants

Tags are **calendar-scoped**, not user-scoped. The contract:

- `events.tag_id` is the canonical tag identifier. `events.category` and `events.color` no longer exist on the row; color and name come from the joined `tags` row at render time. After the cleanup migration, `tag_id` is `NOT NULL`.
- A tag belongs to exactly one calendar (`tags.calendar_id`, `unique(calendar_id, name)`), and an event can only reference a tag from its own calendar. The RLS function `can_use_tag(tag_id, calendar_id)` enforces this on insert/update.
- Every calendar has an `Untagged` tag, seeded at calendar-create time by the `seed_calendar_tags` trigger. It is the per-calendar fallback the app re-assigns events to when a tag is deleted while in use. Never delete `Untagged`; the UI blocks it explicitly and the FK on events is `on delete restrict` as a database-level safety net.
- All tag pickers (event-modal chips, Quick Add template default, filter chips, settings list) consume `tagsForCalendar(calendarId)` from `store.js`, never `state.tags` directly. When the modal's calendar dropdown changes, the tag picker re-renders against the new calendar's tags and falls back to that calendar's `Untagged` if the previously-selected tag isn't valid there.

### Color XSS invariant

Every place a color value (`tag.color`, `calendar.color`, anything derived via `eventColor()`) is interpolated into HTML must go through `safeColor()` in [js/ui.js](js/ui.js). The DB enforces a strict `^#[0-9a-fA-F]{6}$` check on the columns (after `2026-05-color-format-check.sql`); `safeColor` is the defense-in-depth layer that re-validates at render time, so a regression on the DB side or a row predating the constraint can't escape a `style="--foo:VALUE"` attribute and inject script. Never interpolate a raw color into an HTML string.

### Realtime + lifecycle

`setupRealtime()` tears down and re-opens the channel whenever the set of visible calendar IDs changes (login, archive toggle, calendar create/delete). `recoverAfterResume()` runs on `visibilitychange`, `focus`, `online`, and `pageshow` (persisted), debounced by `lastResumeAt`/`resumeInFlight`, to re-validate the session and re-subscribe after the device wakes or returns to the tab. Mobile Safari/Chrome will silently drop the realtime socket otherwise.

### Service worker and cache versioning

`sw.js` is **network-first for navigations** and stale-while-revalidate for other GETs. The cache name and the `?v=...` query on `<script>`/`<link>` tags in `index.html` use a `__BUILD_VERSION__` placeholder that the deploy workflow replaces with `${{ github.sha }}` before publishing. Local dev keeps the literal placeholder string — fine, since the placeholder is stable across local sessions.

**Do not hand-bump these values**; every push to `main` produces a new SHA and therefore a fresh cache. If you ever rename or remove the placeholder, the workflow's "Stamp build version" step fails fast with a clear message.

### Supabase / RLS rules to preserve

- Never add `anon` policies for private calendar data; never hardcode user IDs.
- The `calendars_add_owner_member` trigger is what makes a freshly inserted calendar visible to its creator; do not remove it unless calendar creation is replaced by an RPC that also creates the membership row.
- Sharing must go through the `share_calendar_by_email` RPC — the frontend cannot read `auth.users` and must not try.
- Helper functions (`is_calendar_member`, `is_calendar_owner`, `can_edit_calendar`) are `security definer` to avoid recursive RLS on `calendar_members`; preserve that when editing them.

### RLS policy reference

Authoritative source is `supabase/schema.sql`; this is the summary used when reasoning about new policies.

| Table | Operation | Allowed when |
|---|---|---|
| `calendars` | `INSERT` | authenticated AND `owner_id = auth.uid()` |
| `calendars` | `SELECT` | user is owner OR has a `calendar_members` row |
| `calendars` | `UPDATE` / `DELETE` | user is owner |
| `calendar_members` | `SELECT` | row is the user's own membership, OR user owns the calendar |
| `calendar_members` | `INSERT` / `UPDATE` / `DELETE` | user is the calendar owner |
| `events` | `SELECT` | user is a member of the event's calendar |
| `events` | `INSERT` / `UPDATE` / `DELETE` | user is owner OR collaborator (viewers blocked) |
| `profiles` | `SELECT` | row is the user's own profile (sharing flows through `share_calendar_by_email` RPC instead) |
| `tags` | `SELECT` | user is a member of the tag's calendar |
| `tags` | `INSERT` / `UPDATE` / `DELETE` | user is owner OR collaborator of the tag's calendar (`can_edit_calendar`) |
| `events` (tag_id) | enforced via `can_use_tag(tag_id, calendar_id)` on `INSERT`/`UPDATE` — tag must belong to the event's calendar |

## Changing the Supabase schema

There is no migration runner — SQL is pasted into the Supabase SQL editor by hand. Each schema change must follow this process:

1. **New file per change, dated, in `supabase/`.** Example: `supabase/2026-05-add-event-recurrence.sql`. Do not edit existing migration files in place — they are the historical record of what's been applied to live projects. Existing files (`feature_updates.sql`, `rls_fix_calendars.sql`) keep their topic-based names; new ones get a `YYYY-MM-` prefix so the apply order is obvious.
2. **Make every statement idempotent.** `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS x ON t; CREATE POLICY x ON t ...`. The same SQL must be safe to re-paste into the editor or re-run after a partial failure.
3. **Ship the RLS policy in the same file as the table/column.** Never add a new table or sensitive column without its policy in the same migration. RLS is the only authorization boundary — a missing policy on a new column means the publishable key can read it from any browser.
4. **Pick fail-loud or graceful-fallback consciously, then update the frontend.** If the column is required and recent, let the API call throw. If users on the live deploy may not have run the migration yet, mirror the `fetchCalendars` pattern in [js/api.js](js/api.js): catch the missing-column error, retry without the field, `showToast` a hint to run the migration. Default to graceful for anything user-visible.
5. **Update `supabase/schema.sql` to reflect the new total state.** `schema.sql` is the from-scratch baseline; the dated files are deltas. Both must agree at HEAD or restoring a fresh project will diverge from production.
6. **Apply in the Supabase SQL editor, then test with two accounts in different roles** (owner / collaborator / viewer) on every CRUD path of the affected table. RLS bugs only show up with a second user.
7. **Update CLAUDE.md only if a new invariant lands** — e.g., another "these N columns must agree" rule like the existing tag invariant. Routine column additions are self-documenting from the SQL file and don't need a CLAUDE entry. (Cache versioning is automated by the deploy workflow, so no manual bump is needed for frontend changes either.)

## Mobile UI constraints

The shell is mobile-first with four bottom tabs (Calendar / Tasks / Create / Settings). Specific constraints:

- Month view: tapping a day opens the **day detail** view (`openDayDetail`), it does **not** open the event form. Date-accuracy testing should use day detail to avoid accidental creates.
- Week and day views snap to full-width day columns on phones; do not switch to partial-width columns (reintroduces a clipped-next-day bug).
- New event creation belongs to the Create tab; keep secondary controls in Tasks/Settings. Do not add desktop sidebars to the mobile layout.
- The viewport tag disables zoom and uses `100dvh` + safe-area padding so the calendar renders correctly immediately after login.

## Regression checklist

A full pre-deploy mobile-viewport checklist lives in `README.md` ("Developer regression checklist"). Run it before shipping UI or data-flow changes, especially the tag-edit round-trip and the archive/restore flow.
