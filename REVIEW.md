# Code review

Read-only review of the Kalender repo as of `244e811`. Findings tagged
`[critical]` (correctness/security; ship a fix), `[important]` (real
defect or significant duplication), `[minor]` (small bug or rough edge),
`[nit]` (style/clarity).

Each item names the file and rough location. Severities follow the prompt's
intent: **critical = block ship**, **important = fix before merging more
features**, **minor/nit = sweep when you're in the area**.

---

## 1. Architecture

The module layering described in `CLAUDE.md` (`config → supabaseClient → api
→ app ← ui`, with `store` and `dateUtils` as leaves) holds in practice. No
import cycles. State lives in one place (`store.js`'s `state` object), every
Supabase call is in `api.js`, every DOM read/write is in `ui.js`. That much
is healthy.

What is NOT healthy after three feature PRs:

### 1.1 [important] Two sources of truth for "visible events" — `store.js` and `ui.js`

- `store.js:113` — `visibleEvents()` exported but **never imported** anywhere.
- `ui.js:705` — `visibleEventsForRender()`, a near-identical copy, is the
  one actually used in five render call sites
  (`ui.js:404, 728, 757, 761, 868, 919`).

The two functions implement the same calendar/tag/search filter. Deleting
the `store.js` copy and re-using a single exported helper would remove
20-odd lines of duplicated business logic and remove the trap of someone
fixing a filter bug in only one place.

### 1.2 [important] Two functions named `countEventsUsingTag`

- `api.js:152` — async, hits Supabase (the authoritative count used by the
  delete-tag confirmation modal).
- `store.js:132` — sync, counts the in-memory `state.events`.

`app.js:686` imports the `api.js` version; the `store.js` version has **no
importers**. The `app.js:689` fallback (`state.events.filter(...).length`)
is inlined rather than calling the store helper, so the store helper isn't
even reached on the error path. This is purely a footgun — two same-named
exports inviting an "I imported the wrong one" bug.

### 1.3 [important] `app.js` is doing too much

`app.js` is 1,288 lines and contains: boot, lifecycle, every `bind*`
listener, optimistic-update plumbing, the realtime channel manager, swipe
nav, the Quick Add parser (`parseQuickAddInput` + `parseTimeToken` +
`parseDurationToken` + `buildQuickAddDraft`), the reminder scheduler, and
all event/tag/calendar/share/template handlers.

The Quick Add parser in particular is 150 lines of pure logic with no DOM
or Supabase dependency — it belongs in its own module
(`js/quickAdd.js`) where it can be unit-tested without standing up the
whole app. Same for `scheduleReminders` (`app.js:1268`) and
`bindSwipeNavigation` (`app.js:1160`).

### 1.4 [minor] `setupRealtime` reuses calendar-id list logic from `refreshEventsAndRender`

Both compute `state.calendars.filter((c) => !c.archived_at || state.showArchivedCalendars).map(...id)` (`app.js:472-474`, `app.js:494-496`).
Tiny but obvious extract.

### 1.5 [minor] Toast/error display is scattered

`ui.js:696` exposes `showToast`. Every error site decides on its own whether
to use `showToast` (background errors), set a form-level error message
element (`els.eventError.textContent = ...`), or both. There is no single
helper for "render a Supabase error somewhere visible." Extracting one
would let the migration-hint patterns (`/quick_add_templates/i.test(error.message)`,
`/archived_at/i`) live in one spot.

---

## 2. Code quality

### 2.1 [important] Dead exports

- `store.js:27` `fallbackTag()` — exported, imported by `ui.js:20`,
  but never called in `ui.js` (the fallback is reached only via
  `eventTag(event)` which is internal to `store.js`).
- `store.js:31` `activeCalendar()` — exported, no importers.
- `store.js:59` `eventTagKey(event)` — exported, no importers.
- `store.js:113` `visibleEvents()` — exported, no importers (see 1.1).
- `store.js:132` `countEventsUsingTag` — exported, no importers (see 1.2).
- `dateUtils.js:1` `MS_PER_DAY` — exported, no importers.

### 2.2 [important] `console.log` in production code paths

The deploy stamps and ships these every run:

- `api.js:244` `console.log('[event] save payload', payload)` — logs the
  full payload (title, description, calendar id, tag id) on every save.
- `api.js:254, 265` `console.log('[event] save response', data)`.
- `app.js:652, 656` `console.log('[tags] update response' / 'create response', saved)`.
- `app.js:724` `console.log('[tags] reassigned events', { from, to, count })`.
- `app.js:726` `console.log('[tags] deleted', tag.id)`.
- `ui.js:464` `console.log('[tag] render picker', { calendarId, selected, tagCount })`.
- `ui.js:572` `console.log('[tag] selectEventTag', { tagId, resolved, calendarId })`.

None of these contain credentials, but they leak event titles/descriptions
into the user's devtools by default. They were clearly added for the tag
debugging mentioned in `README.md:394-396` (the "Common failure modes"
section). Either gate them behind a `DEBUG` flag or strip them.

`console.warn` calls (`app.js:203`, `app.js:449`, `app.js:459`,
`app.js:510`, `app.js:688`, `app.js:735`, `ui.js:592`) are fine — they
mark genuinely abnormal conditions.

### 2.3 [important] `handleEventSubmit` duplicates the optimistic pattern by hand

`app.js:542-587` is the single mutation that does NOT use
`withOptimisticUpdate`. Per the CLAUDE.md note this is intentional — the
"temporary id then reconcile" shape is hard to fold into the helper. But
inside the body there are two real bugs and one pessimization:

- **Double `setFormBusy(els.eventForm, true)`** — `app.js:553` and
  `app.js:567`. Harmless but obviously redundant.
- **`refreshEventsAndRender()` after a successful save** (`app.js:574`).
  We just received the saved row from `saveEvent`, the optimistic state is
  already updated, AND the realtime listener is going to fire `onEventChange`
  which itself calls `refreshEventsAndRender`. So the network round-trip
  for `fetchEvents` happens **three times** for one user-initiated save
  (optimistic, manual refresh, realtime echo). Drop the explicit refresh.
- **Rollback only restores `state.events`** (`app.js:577-580`) where the
  rest of the codebase rolls back four slices. For event saves only events
  are touched, so this is currently fine — but the asymmetry hides what
  should and shouldn't be snapshotted from a future reader.

### 2.4 [important] `onEventChange` toasts on the user's own edits

`app.js:498-501` toasts "Calendar updated" for every realtime event, including
the user's own save. Combined with the `handleEventSubmit` "Event saved"
toast and the redundant refresh in 2.3, a user creating an event sees two
overlapping toasts and three fetch round-trips. Suppress when the change
originated locally (cheapest: skip the toast entirely; data refresh already
happens via the helper).

### 2.5 [important] `scheduleReminders` schedules the same reminder repeatedly

`app.js:1268-1287`. The dedupe flag is `event.reminderScheduled`, mutated
on the event object. But `state.events = await fetchEvents(...)` replaces
the array with **new** objects every refresh, and `refreshEventsAndRender`
is called many times per session (load, archive toggle, view change, drop,
realtime, resume, ~every save). Each refresh re-schedules a fresh
`setTimeout` for every upcoming-reminder event still inside the 24-hour
window. After ten refreshes the user gets ten notifications.

The dedupe flag has to live somewhere stable — a Map keyed by event id,
or a hash of `(id, starts_at, reminder_minutes)` — outside the event row.

### 2.6 [important] `getSession` logs the user out on a transient `getUser` failure

`api.js:17-35`. If `auth.getUser()` errors (network blip, 5xx from
Supabase) it calls `signOut({ scope: 'local' })`, dropping the local
session entirely. Combined with the visibilitychange/online resume hooks
(`app.js:1195-1208`), a flaky connection on resume can quietly log the
user out. The session itself is valid; we should keep it and surface the
error.

### 2.7 [important] Quick Add silently drops at-token-boundary content

`app.js:1037-1056` (Pass 3, single time). `parseTimeToken` matches
`9`, `9am`, `14:00`. Then it tries to merge a trailing `am`/`pm` from the
next token. But it never accounts for the `pm` being **two tokens away**
in inputs like `Meeting at 9 pm`. It also accepts bare `9` (no meridiem)
as an unambiguous AM time, which works for `Standup tomorrow 9` but
silently miscategorises `Dinner 8` as 08:00. Worth documenting or guarding;
it's an edge of the spec rather than a flat bug.

### 2.8 [important] `tagDeleteInFlight` flag isn't cleared on early return

`app.js:699-741` flips `tagDeleteInFlight` to true at line 716 — AFTER the
no-target early return at line 709-714 — so that path is fine. But
`els.tagDeleteConfirmBtn.disabled = true` at line 718 is set inside the
in-flight try with a finally that resets, so the button can never get stuck.
**Re-flag retracted on closer read**; mention only because it's worth a comment.

### 2.9 [minor] `handleSaveTag` doesn't go through `withOptimisticUpdate`

`app.js:640-665`. Tag create/update is a non-optimistic round trip + manual
refetch. Realtime would also fire `onTagChange` and refetch, so we end up
with two `fetchTags` calls per save. Same shape as 2.3.

### 2.10 [minor] `handleEventDrop` is non-optimistic

`app.js:890-912`. Drag and drop awaits the save before re-rendering, then
explicitly refreshes (and realtime echoes again). The visual snap-back
during a slow network feels broken on mobile. Use `withOptimisticUpdate`.

### 2.11 [minor] `feature_updates.sql` defines the OLD `can_use_tag(uuid)` signature

`supabase/feature_updates.sql:101-114` defines a one-arg function. The
calendar-scoped tags migration (`2026-05-calendar-scoped-tags.sql:144`)
drops it and creates the two-arg version. A user replaying the migrations
on a fresh project in the order documented in CLAUDE.md will be fine.
But a partial replay (`feature_updates.sql` then nothing else) leaves
a one-arg function that's no longer referenced. Not a bug, just dead.

### 2.12 [minor] `defaultStart` in `ui.js:956` rolls past midnight

`ui.js:960` does `start.setHours(now.getHours() + 1, 0, 0, 0)`. On 23:00
this becomes 24:00, which JavaScript's Date silently rolls to next-day
00:00. The new event's date is then off by one day from what the user
expected. Clamp `now.getHours() + 1` to 23 (or jump to next day's 09:00).

### 2.13 [minor] `events.tag_id` has no index

`schema.sql:91` indexes `events(calendar_id, starts_at, ends_at)`. Nothing
indexes `events.tag_id` on its own. Two queries pay for this:

- `api.js:152` `countEventsUsingTag` does `count(*) where tag_id = ?` —
  seq-scans events on every delete-tag confirmation.
- `api.js:137` `reassignEventsTag` does `update events set tag_id = ?
  where tag_id = ?` — same.

Add `create index events_tag_id_idx on public.events(tag_id);` in a new
migration file.

### 2.14 [minor] `tags_user_id_idx` becomes vestigial after cleanup

`feature_updates.sql:23` creates it; `2026-05-calendar-scoped-tags-cleanup.sql:60`
drops it. On a project that ran the main migration but not the cleanup,
the index sticks around indexing a column that is no longer the access
path. Cosmetic.

### 2.15 [nit] Tracked-but-empty log files

`server.log` and `server.err` are listed in `.gitignore` (lines 7-8) but
exist as zero-byte tracked files in the repo. `git rm --cached server.log
server.err` once.

### 2.16 [nit] Naming: `new-event-btn` is the create-tab button

`index.html:167` — the button with id `new-event-btn` is actually the
"Create" bottom-tab that opens the type picker (Event vs Task). Misleading
name from before the type picker existed. Rename to `create-tab-btn` or
similar.

### 2.17 [nit] Supabase client imported from a CDN with a hardcoded version

`supabaseClient.js:1` pins `@supabase/supabase-js@2.43.4` from `esm.sh`.
Fine for a static deploy with no build, but a CDN outage takes the app
down. Pinning is good; making the URL more findable (constant at top, or
self-hosted vendor copy) would help future-you.

---

## 3. Mobile + UX consistency

### 3.1 [important] `renderTags` hides tag list from view-only users

`ui.js:225-235`. If the signed-in user is a viewer on every visible
calendar, `editableCalendars.length === 0` so the entire tag section
shows `"You need an editable calendar to manage tags."` and the
read-only tag list is suppressed. But viewers DO have read access to the
tags of calendars they belong to (RLS: `Members can read tags`). The "view
only" affordance code at `ui.js:248` is unreachable for users in this
state. Either drop the empty-list guard or use it only to hide the
"+ Add tag" buttons.

### 3.2 [important] Event modal hides the calendar picker behind `<details>`

`index.html:207-222`. The `<select id="event-calendar">` lives inside
`<details class="event-options">`, collapsed by default. The tag picker at
the top depends on which calendar is selected, but the user can't see what
calendar is selected without expanding "More options." When the active
calendar changes, the tag picker silently re-renders against the new
calendar's tags — which only makes sense if the user can see the trigger.

For users who have only one calendar this is invisible; for users with
shared calendars + multiple memberships it is a genuine "where did my tag
go" footgun.

Move the calendar select above the tag picker, or always show it.

### 3.3 [minor] `assets/icon.svg` referenced by `index.html:17` exists, but `mobile-brand` styling hides the icon and email

`css/styles.css:327-352`. `.mobile-brand .brand-mark` and `.mobile-brand
span` are `display: none`, leaving only the centered "Kalender" text in
the topbar. Then `index.html:62-66` still renders the brand-mark div and
the email span. They are valid HTML doing nothing. Either delete the dead
markup or rebind the CSS — the intent is unclear.

### 3.4 [minor] The "x" close button uses a literal letter

`index.html:183, 240, 261, 288, 320, 343, 409`. `>x<` is rendered as the
letter `x`. Use `×` (U+00D7) or an SVG with `aria-label="Close"` for both
visual and screen-reader correctness.

### 3.5 [minor] Drag-and-drop has no keyboard equivalent

`app.js:344-352, 890-912`. `data-event-id` items support drag, but not
arrow-key reschedule. Existing day-detail editing covers this case so it's
not a regression — just the only way to reschedule on a keyboard is to
open the event sheet.

### 3.6 [minor] Calendar-list-items have `tabindex="0"` and `role="button"` but no visible `:focus` styles

`ui.js:177-178`. Focusable elements should have a visible focus ring per
WCAG. The `*:focus-visible` browser default is being suppressed by the
zero-border styling.

### 3.7 [nit] Notification permission prompt fires before login

`app.js:413-415`. `bindUiEvents()` runs on boot, so the timeout to call
`Notification.requestPermission()` queues even on the login screen. Most
users will dismiss it before they sign in. Move the prompt to after a
successful first sign-in.

### 3.8 [nit] "Calendar updated" toast spam on resume

`app.js:498-501`. Coming back to the tab after a few minutes refetches and
fires the toast for every changed event, in sequence. (3.4 above is the
same root cause — toast on every realtime echo.)

---

## 4. Supabase

### 4.1 [critical] No DB-side validation on color values

`schema.sql:25, 49` define `color text not null default '#92c5fc'` with
no check constraint. The `<input type="color">` UI restricts the user to
hex strings, but a determined collaborator can directly call the Supabase
client (the publishable key is in the browser) with any string. See 5.1
below for the XSS that follows.

Add `check (color ~ '^#[0-9a-fA-F]{6}$')` to both `tags.color` and
`calendars.color`. Same for `events` if a color column gets re-added.

### 4.2 [important] No index on `events.tag_id`

Already covered at 2.13. Material now that the cleanup migration sets
`on delete restrict` and adds the reassign-then-delete flow.

### 4.3 [important] Session lookup race in `share_calendar_by_email`

`schema.sql:247-284`. The RPC is `security definer` and looks up the
target user via `public.profiles`. If the new collaborator hasn't ever
logged in (the trigger that backfills `profiles` from `auth.users`
fires on insert/update of `email`, not on initial sign-up flow), they
won't have a profile row and sharing fails with `'No user found for
email %'`. Documented behavior, but worth a friendlier error in
`app.js:797-810`.

### 4.4 [important] `quick_add_templates.default_tag` is text, not a UUID FK

`schema.sql:80` and `2026-05-add-quick-add-templates.sql:11`. It's
`text` (storing a tag id as a string) so the database can't enforce
that the tag exists or that the template owner can use it. The tag-cleanup
step in `2026-05-calendar-scoped-tags.sql:264-269` exists *because* the
column is text — if it were `uuid references tags(id) on delete set null`,
we'd never have orphans.

Migrate the column type, then drop the cleanup loop.

### 4.5 [minor] `calendar_members` SELECT policy lets owners read every membership

`schema.sql:351-356`. `using (user_id = auth.uid() or public.is_calendar_owner(calendar_id))`.
That's correct, but the API never reads `calendar_members` directly —
`fetchCalendars` joins through `calendar_members → calendars`. Consider
whether the owner-read branch is still needed.

### 4.6 [minor] `quick_add_templates.default_calendar_id on delete set null`

`schema.sql:81`. Deleting a calendar nulls out template defaults, but
`default_tag` (a text id) is left dangling pointing at a now-deleted tag.
Same root cause as 4.4. The frontend handles it (the `findTag` returns
null, `buildQuickAddDraft` falls through), but at the data layer this is
unenforced consistency.

### 4.7 [nit] `feature_updates.sql` and `rls_fix_calendars.sql` overlap

`feature_updates.sql:101-114` (one-arg `can_use_tag`) and the helpers in
`rls_fix_calendars.sql:12-57` re-create what `schema.sql` already defines.
On a from-scratch project the order is "schema.sql then nothing else."
On an existing project the right order is documented in `CLAUDE.md`. The
files do their job, but new readers get confused by the same function
defined three places. Consider moving the historical `feature_updates.sql`
under a `supabase/legacy/` folder (without changing the file content,
which is the historical record).

### 4.8 [nit] `events.reminder_minutes` check accepts only specific values

`schema.sql:70` allows `null` or one of `(5, 10, 15, 30, 60, 1440)`. The
UI only ever writes `15` or `null` (`ui.js:563`). Fine, but note the
mismatch — `app.js:1273` ignores any value not in `(15, …)` for actual
notification scheduling? Actually it uses the value directly, so all six
DB-allowed values would scheduling correctly. Just unused capacity.

---

## 5. Security + privacy

### 5.1 [critical] Stored XSS via tag color (and calendar color, event color)

Every renderer interpolates `tag.color` / `calendar.color` into a CSS
custom property inside an HTML `style` attribute **without escaping**:

- `ui.js:184` `style="--calendar-color:${calendar.color}"`
- `ui.js:215` `style="--category-color:${tag.color}"`
- `ui.js:256` `style="--tag-color:${tag.color}"`
- `ui.js:418` `style="--event-color:${eventColor(event)}"`
- `ui.js:479` `style="--tag-color:${tag.color}"`
- `ui.js:742` `style="--event-color:${eventColor(event)}"`
- `ui.js:840` `style="--event-color:${eventColor(event)}"`
- `ui.js:892` `style="--event-color:${eventColor(event)}"`
- `ui.js:941` `style="--event-color:${eventColor(event)}; --top:${top}%; --height:${height}%"`

`tag.color` flows from the DB and the DB has no format check (4.1). A
malicious **collaborator** of any shared calendar can write a tag with
`color = '#000"></span><img src=x onerror=alert(document.cookie)>'`,
and any other member who renders that tag is XSSed.

This is the highest-impact finding in the review. Two-layer fix:

1. Add the `check (color ~ '^#[0-9a-fA-F]{6}$')` constraints (4.1) so
   bad data can't enter the DB.
2. Run color values through `escapeHtml` at the render sites — defense
   in depth, and protects against a regression where the constraint is
   removed in a future migration.

`escapeHtml` already exists at `ui.js:993`.

### 5.2 [important] PII (event titles, descriptions) logged to console

Already covered at 2.2. Promoting it to important (not just minor) because
shared devices and screen-sharing scenarios surface devtools content to
people the user didn't intend to share with.

### 5.3 [important] No length validation on Quick Add free text

`app.js:1131-1158` accepts any-length input. The eventual `events.title`
column has `between 1 and 120` enforcement, so an over-length title gets
rejected at save time with the raw Postgres error message. Validate at
the UI seam too, with a clearer message.

### 5.4 [minor] Quick Add template form mostly validates well

`ui.js:367-384`. Catches empty shortcuts, shortcut spaces, out-of-range
durations. Doesn't catch shortcut clashes between users (the unique
constraint is per-user, so it's fine) but does surface the `23505` error
in `app.js:764-765`. Solid.

### 5.5 [minor] No CSP / no Subresource Integrity on the Supabase CDN import

`supabaseClient.js:1` imports from `esm.sh` without an integrity hash.
A compromised CDN could serve malicious code. Self-hosting a vendor copy
under `js/vendor/` and committing it would remove that risk; SRI on a
dynamic ESM import isn't well supported.

### 5.6 [nit] `server.mjs` path traversal guard works, no symlinks check

`server.mjs:22` resolves the path then checks the prefix. That's correct
on Linux/macOS. Symlinks within `root` could still escape, but server.mjs
is dev-only and runs against the project root, so this is not exploitable
in practice.

---

## Summary — recommended fix order

When you confirm cleanup, my proposed order:

1. **[critical]** XSS via color interpolation (5.1) + DB color constraint
   (4.1). This is one logical change spanning a SQL migration and the
   render sites.
2. **[important]** Strip / gate the production `console.log` lines (2.2,
   5.2).
3. **[important]** Reminder duplication on every refresh (2.5).
4. **[important]** `getSession` no longer logs the user out on transient
   `getUser` errors (2.6).
5. **[important]** Move calendar picker out of `<details>` (3.2) OR
   re-think the order of fields inside the event sheet.
6. **[important]** Render tag list for view-only users (3.1).
7. **[important]** Drop the redundant `refreshEventsAndRender` and
   "Calendar updated" toast on the user's own save (2.3, 2.4); move the
   no-toast logic into `setupRealtime`.
8. **[important]** Dead-code sweep: delete unused exports (2.1, 1.1, 1.2)
   and consolidate `visibleEvents` / `visibleEventsForRender`.
9. **[important]** Extract the Quick Add parser to `js/quickAdd.js`
   ahead of writing tests against it (1.3).
10. **[important]** Add `events.tag_id` index (2.13, 4.2).
11. **[important]** Migrate `quick_add_templates.default_tag` from text
    to a UUID FK (4.4).
12. **[minor]** `defaultStart` rollover bug (2.12), `setFormBusy` double
    call (2.3), drag-drop optimistic (2.10), tag save round-trip (2.9).
13. **[minor/nit]** Naming, dead files, tracked logs, accessibility
    polish (1.4, 1.5, 2.15-2.17, 3.3-3.7, 4.5-4.8, 5.5-5.6).

Items I'd flag for a behavior-change discussion before touching:

- 3.1 (viewer tag list) — small UX shift; confirm intent.
- 3.2 (event sheet field order) — visible UI change; confirm intent.
- 4.4 (quick_add_templates.default_tag → UUID FK) — needs a migration
  with a retry shape; confirm intent before writing the SQL.

Everything else is invariant-preserving refactor + correctness fixes.
