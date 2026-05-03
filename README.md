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

#### What the dev environment actually does

There is no offline mock. Whatever Supabase URL and publishable key you put in
`js/config.js` is what the local app hits — **the same project as production
if you reuse the prod key, or a separate dev project if you point at one**.
Pick consciously: poking at events on localhost while pointed at the prod
project will mutate prod data through RLS just like the deployed site would.
A common pattern is to keep a second Supabase project for dev and switch the
config file's two values when iterating.

If sign-in fails with `Invalid login credentials`, it is almost never a local
environment issue (password sign-in does not enforce Site URL or CORS). The
two real causes are:

- The key in `js/config.js` points at a project where the user does not exist
  (or `email_confirmed_at` is null on that user's row).
- Wrong password.

Fix by creating/confirming the user in Supabase Studio → Authentication →
Users on the project the key actually points at.

#### Claude Preview integration

`.claude/launch.json` registers the static server with the Claude Preview
tool so a session can start it, screenshot it, and read browser console logs
without leaving the chat:

```jsonc
// .claude/launch.json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "kalender",
      "runtimeExecutable": "wsl.exe",
      "runtimeArgs": [
        "-d", "Ubuntu",
        "--cd", "/home/tamachi/kalender",
        "--", "bash", "-lc", "node server.mjs"
      ],
      "port": 4173
    }
  ]
}
```

The `wsl.exe` wrapper is needed because Claude Code runs on Windows while the
project lives inside WSL (`\\wsl.localhost\ubuntu\…`). Node is installed in
WSL, not on the Windows PATH, so a direct `node server.mjs` from the Windows
side fails with `ENOENT`. WSL2's localhost forwarder makes `127.0.0.1:4173`
reachable from the Windows-side preview pane automatically. If you switch
distro or the WSL home path, update `-d` and `--cd`. If you run Claude Code
natively on macOS/Linux against a checked-out copy, replace the entry with:

```jsonc
{ "name": "kalender", "runtimeExecutable": "node", "runtimeArgs": ["server.mjs"], "port": 4173 }
```

To use it inside a session: ask Claude to "start the preview server" — it
will call `preview_start` on the `kalender` config, and from there it can
screenshot the page, evaluate JS in the page context, and tail the browser
console while you click around.

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

## Architecture, RLS, and schema changes

Architectural invariants (module layering, optimistic-update pattern, the
three-field tag rule, RLS policies, the schema-change runbook) live in
[CLAUDE.md](CLAUDE.md). Read it before making non-trivial changes.

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

The shell is mobile-first with four bottom tabs: **Calendar** (day/week/month
+ swipe), **Tasks** (search, filters, weekly overview), **Create** (opens the
type picker), **Settings** (calendars, sharing, theme, sign out).

### Day Detail View

Tapping any date in the month view opens the Day Detail View — a focused,
mobile-first screen for that day:

- A back action returns to the month view.
- A header shows the selected date in long form ("Friday, May 1").
- A single primary **Add** button opens the type picker (Event vs Task).
- Quick Add stays available for power-users who want to type a phrase like
  "Dentist Friday 14:00" and skip the picker.
- Three lists follow: **Events**, **Tasks**, and **Upcoming** (the next few
  events from later days). Empty sections show a quiet placeholder line.
- Tapping any item in those lists opens the existing edit sheet for that
  event.

The Day Detail View has no horizontal scroll; lists wrap and clip overflowing
text with an ellipsis.

### Event vs Task add flow

There is a single create flow used everywhere — the bottom-nav **Create** tab
and the Day-Detail **Add** button both open the same type-picker modal:

1. Tap **Add** (or the Create tab) → the type picker shows two large,
   touch-friendly options: **Event** or **Task**.
2. Picking **Event** opens the event sheet with the standard fields and the
   selected day prefilled as the date.
3. Picking **Task** opens the same sheet, with the title prefilled as
   `Task: ` so the user can finish the title in one tap. The selected day is
   still prefilled as the date.
4. Both flows write to the same `events` table — a "task" is just an event
   whose title starts with `Task:`. There is no separate task entity.

Because both options reuse the existing event sheet, calendar membership,
RLS, optimistic updates, and tag selection all work identically for events
and tasks.

Specific UI invariants (day-detail flow, full-width day columns, no desktop
sidebars) live in [CLAUDE.md](CLAUDE.md) under "Mobile UI constraints" — read
those before changing layout.

## GitHub Pages deployment

The repository deploys via GitHub Actions (`.github/workflows/deploy.yml`):

1. On push to `main` (or manual `workflow_dispatch`), the workflow regenerates
   `js/config.js` from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` secrets.
2. The workflow stamps the commit SHA into the `__BUILD_VERSION__` placeholder
   in `index.html` and `sw.js`, so every deploy invalidates the service-worker
   cache automatically. No manual version bump needed.
3. The repository is uploaded as the Pages artifact and deployed via
   `actions/deploy-pages@v4`. No build step.
4. Add the resulting Pages URL to your Supabase project's Authentication URL
   configuration.

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
- **Stale UI after deployment** — should not occur (cache version is stamped
  per-commit). If it does, hard-refresh and check that the workflow's "Stamp
  build version" step ran.
