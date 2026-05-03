# Kalender

A static, GitHub Pages friendly calendar app with Supabase Auth, shared
calendars, collaborative events, realtime updates, drag-and-drop rescheduling,
dark mode, search, filters, and a weekly overview.

## Project structure

- `index.html` — app shell and dialogs
- `css/styles.css` — responsive light/dark design system
- `js/config.js` — Supabase URL/key and category colors **(gitignored; see below)**
- `js/config.example.js` — template/shape for `js/config.js`
- `js/api.js` — Supabase Auth, database, and realtime calls
- `js/ui.js` — rendering and form helpers
- `js/app.js` — application state transitions and event handlers
- `supabase/schema.sql` — tables, triggers, RLS policies, and realtime setup
- `.github/workflows/deploy.yml` — GitHub Pages deploy with secret injection

## Configuration

`js/config.js` holds the Supabase project URL and publishable (anon) key. It is
**gitignored** so credentials never land in the repository.

### Local development

```bash
cp js/config.example.js js/config.js
# Edit js/config.js and replace the two placeholders with your Supabase values.
node server.mjs
# Open http://127.0.0.1:4173/
```

A static server is required (rather than opening `index.html` directly) because
the app loads ES modules.

### CI / GitHub Pages

`.github/workflows/deploy.yml` regenerates `js/config.js` on every deploy from
two repository secrets:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

Set them under **Settings → Secrets and variables → Actions** on GitHub. Pages
must be configured with **Source: GitHub Actions** under **Settings → Pages**.

## Supabase setup

1. Create a Supabase project.
2. Enable Email/Password under Authentication providers.
3. Create users manually in Authentication. There is intentionally no public
   sign-up UI.
4. Run `supabase/schema.sql` in the SQL editor.
5. For an existing project that pre-dates the tag/archive features, also run
   `supabase/feature_updates.sql`. If calendar inserts fail with an RLS error,
   run `supabase/rls_fix_calendars.sql`.
6. In Authentication URL configuration, add your GitHub Pages URL to allowed
   redirect/site URLs.

The app uses these tables:

- `calendars` — owner-created calendars, with optional `archived_at` for hiding
  calendars without deleting their data.
- `calendar_members` — access control with `owner`, `collaborator`, and
  `viewer` roles.
- `profiles` — a safe public profile table populated from Supabase Auth for
  email-based sharing.
- `tags` — user-owned custom tags with names and colors.
- `events` — shared events with title, description, time range, color,
  category, completion state, and optional reminder.

RLS ensures users can only read calendars they belong to. Owners can share
calendars, owners and collaborators can modify events, and viewers can only
read.

## Authentication and ownership

The frontend signs users in with Supabase Auth email/password. After login,
Supabase stores the session in the browser and attaches the authenticated
user's JWT to database requests made with the publishable key.

Calendar creation in `js/api.js` sets `owner_id` to the authenticated user's
ID. The database also defaults `calendars.owner_id` to `auth.uid()`, and the
RLS policy verifies the submitted owner is the current authenticated user. A
user cannot create a calendar for someone else by editing browser code.

After insert, the `calendars_add_owner_member` trigger writes an `owner` row
into `calendar_members`. That membership is what makes the calendar visible
and enables future owner actions.

## RLS policy model

RLS must stay enabled on `calendars`, `calendar_members`, and `events`. The
app uses the browser publishable key, so the database is the authorization
boundary.

The policies are:

- `calendars INSERT`: authenticated users can insert only when
  `owner_id = auth.uid()`.
- `calendars SELECT`: authenticated users can read calendars they own or where
  they have a `calendar_members` row.
- `calendars UPDATE/DELETE`: only owners can modify or delete calendars.
- `calendar_members SELECT`: users can read their own memberships; owners can
  read memberships for calendars they own.
- `calendar_members INSERT/UPDATE/DELETE`: only calendar owners can manage
  sharing.
- `events SELECT`: calendar members can read events.
- `events INSERT/UPDATE/DELETE`: owners and collaborators can modify events;
  viewers cannot.
- `profiles SELECT`: users can read only their own profile. Calendar sharing
  by email goes through the `share_calendar_by_email` RPC, which checks that
  the caller owns the calendar before resolving the target email.
- `tags SELECT/INSERT/UPDATE/DELETE`: users can manage only their own tags.
  Events may reference a custom tag only when that tag belongs to the current
  user; the event also stores the tag color as a display snapshot.

Helper functions such as `is_calendar_member`, `is_calendar_owner`, and
`can_edit_calendar` are `security definer` functions so policies can check
membership without recursive RLS checks on `calendar_members`.

When changing schema or policies later, keep these rules intact:

- Do not add public `anon` policies for private calendar data.
- Do not hardcode user IDs in frontend code or SQL policies.
- Do not remove the owner membership trigger unless calendar creation is
  replaced by an RPC that creates the calendar and membership together.
- Test create, read, update, delete, share, and viewer-only access with at
  least two separate Supabase users.

## Sharing calendars

Open the share action beside an owned calendar and enter the target user's
email. The browser calls the `share_calendar_by_email` RPC instead of reading
`auth.users` directly. The function resolves the email through `profiles`,
rejects unknown emails, and grants `viewer` or `collaborator` membership only
if the caller is the calendar owner.

## Tags and archiving

Tags are managed in Settings, appear as horizontal chips in the event sheet,
and can be used for calendar events or task-style events. Built-in tags save
through `events.category`, custom tags save through `events.tag_id`, and both
paths also write `events.color` as a display snapshot. When debugging tag
edits, verify all three fields in the returned event row.

Calendar archiving updates `calendars.archived_at`. Archived calendars are
hidden from the normal calendar list by default and can be shown/restored from
Settings. If archive or restore fails with a missing-column error, run the
latest `supabase/feature_updates.sql` migration.

Calendar deletion removes a row from `calendars`. Related `calendar_members`
and `events` rows are cleaned up by `on delete cascade`, and RLS allows this
only for owners.

## Mobile UI notes

The app shell is mobile-first. The viewport disables accidental page zoom and
uses `100dvh` plus safe-area padding so the authenticated calendar appears at
the correct scale immediately after login. The main app uses four bottom tabs:

- **Calendar** — day, week, and month views with swipe navigation.
- **Tasks** — search, category filters, and weekly event overview.
- **Create** — opens the new event form without overlaying the calendar.
- **Settings** — calendar selection, sharing, theme, and sign out.

In month view, tapping a day opens a day-detail view rather than opening the
event form. The detail view shows that day's events/tasks, quick add, and
explicit add event/task actions. Use this flow when testing date accuracy
because it avoids accidental create actions from simple day selection.

The app includes `manifest.webmanifest`, app icons, mobile web app meta tags,
and a lightweight service worker so it can run as a standalone app when added
to the home screen. Week and day views snap to complete day columns on phones;
do not change them to partial-width columns (reintroduces the clipped-next-day
bug).

Keep primary actions touch-friendly. New event creation belongs in the Create
tab; less-frequent controls belong in Tasks or Settings. Avoid adding
desktop-style sidebars to the mobile layout — they can force the calendar grid
to render too wide after login.

## GitHub Pages deployment

The repository deploys via GitHub Actions (`.github/workflows/deploy.yml`):

1. On push to `main` (or manual `workflow_dispatch`), the workflow regenerates
   `js/config.js` from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` secrets.
2. The whole repository is uploaded as the Pages artifact and deployed via
   `actions/deploy-pages@v4`. No build step is required.
3. Add the resulting Pages URL to your Supabase project's Authentication URL
   configuration.

After any JS/CSS change, **bump both** the `?v=N` query in `index.html` and
`CACHE_NAME` in `sw.js` together. Mismatched versions cause a blank-screen
regression on Pages because the service worker holds a stale shell.

## Troubleshooting blank screens

If GitHub Pages shows only a plain repository title or an empty white page,
check these first:

- Confirm `index.html`, `css/styles.css`, and `js/app.js` load with HTTP 200
  from the deployed Pages URL. All app paths are repository-relative; do not
  change them to root paths like `/js/app.js`.
- Hard-refresh or clear site data after UI patches. Older versions used a
  cache-first service worker that could keep serving a stale broken shell.
  The current service worker is network-first for app navigations.
- Run `supabase/feature_updates.sql` after pulling tag/task updates. If the
  `tags` table is missing, the app falls back to built-in tags and shows a
  toast instead of aborting, but custom tags will not work.
- Test locally first: `node server.mjs`, then open `http://127.0.0.1:4173/`
  and verify the browser console has no new errors.

## Developer regression checklist

Before deploying a UI or data-flow change, run through this list on a narrow
mobile viewport and watch the browser console:

- Login and logout with a manually created Supabase user.
- Confirm Settings shows the signed-in user's email; log in as another user
  and verify it updates.
- Load calendars, switch active calendars, and verify archived calendars are
  hidden until "Show archived calendars" is enabled.
- Archive and restore an owned calendar; confirm collaborators/viewers cannot
  do owner-only actions.
- Create an event with tag A, edit it to tag B, save, and verify the new
  tag/color appears in month, week, day, and day-detail views.
- Reopen the edited event and confirm tag B is selected in the bottom sheet.
- Delete an event and confirm it disappears immediately without refresh.
- Tap a month date and confirm the day-detail view opens for the exact date.
- Add an event from day detail and confirm the selected date is prefilled.
- Add a task from day detail, then complete and uncomplete it from Tasks.
- Create, edit, and delete a custom tag in Settings.
- Share a calendar by email and verify unknown emails show a friendly error.
- Switch away from the browser/app and return; confirm data resyncs and
  realtime subscriptions still work without duplicated updates.
- Test airplane mode or poor network: the app shell should still load, and
  data failures should show toasts rather than blank screens.
- Confirm no horizontal overflow on Calendar, Tasks, Settings, day detail,
  and all dialogs/bottom sheets.

Common failure modes:

- **Tag edits only change visually** — inspect the update payload and returned
  row for `category`, `tag_id`, and `color`.
- **RLS failures on event updates** — confirm the user is an owner/collaborator
  and that any custom `tag_id` belongs to the current authenticated user.
- **Archive/restore errors** — run the latest feature migration so
  `calendars.archived_at` exists.
- **Stale UI after deployment** — bump the asset query version and
  service-worker cache name together.
