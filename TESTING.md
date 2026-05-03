# Testing

## Automated tests

The unit suite uses Node's built-in `node:test` runner — zero install, no
bundler, no dev dependencies. It covers what can be exercised without a
browser or a live Supabase project.

```bash
npm test
```

`pretest` runs `scripts/ensure-config.mjs` which copies
`js/config.example.js` to `js/config.js` if missing — necessary because
`js/store.js` statically imports the two `FALLBACK_TAG_*` constants from
`config.js`, and that file is gitignored.

### Coverage

| File | What it covers |
|---|---|
| `test/quickAdd.test.mjs` | Every example in the original Quick Add spec (`Work tomorrow 9-17`, `Dentist Friday 14:00`, `Gym today 18:30`, `Meeting Monday 10-11`), `H to H`, ISO dates, partial inputs (title-only / date-only / time-only), unparseable input, weekday-name math when today matches the named weekday, `parseTimeToken` / `parseDurationToken` edge cases. |
| `test/dateUtils.test.mjs` | `startOfDay`/`endOfDay`/`addDays`/`addMonths`/`startOfWeek`/`startOfMonthGrid`/`sameDay`/`dateKey`, `toLocalInputValue` ↔ `fromLocalInputValue` roundtrip, `eventOccursOn` for single- and multi-day events, `minutesSinceStartOfDay`. |
| `test/store.test.mjs` | `canEditCalendar`, `tagsForCalendar`, `findTag`, `defaultTagFor` (including the no-Untagged fallback), `eventTag`, `visibleTags` with active-calendar / archived-calendar filters, `syncSelectedTags` (drops invalid ids and auto-checks new visible ones), `visibleEvents` (calendar + search filter, untagged events bypass the tag filter), `findQuickAddTemplateByShortcut`. |
| `test/htmlSafe.test.mjs` | `escapeHtml` for every relevant character + non-string coercion, `safeColor` accepts canonical 6-digit hex and rejects everything else (including the literal XSS payload that motivated the helper). |

## Manual checklist

These cases need a real browser, real Supabase, and (for two of them) a
second user account. Run them before deploying any UI or data-flow change.

### Add flow

- [ ] Tap **Create** in the bottom tab → type picker shows Event / Task.
- [ ] Pick **Event** → event sheet opens with today's date prefilled.
- [ ] Pick **Task** → event sheet opens with `Task: ` prefilled in the title.
- [ ] Open day-detail (tap any month cell) → tap the in-day **Add** button →
      type picker opens; the prefilled date in the resulting sheet is the
      day-detail date, not today.

### Quick Add

- [ ] In day detail, type `Work tomorrow 9-17` → modal opens with title
      "Work", tomorrow's date, 09:00–17:00.
- [ ] `Dentist Friday 14:00` → next Friday, 14:00–15:00 (template
      duration default).
- [ ] `Gym today 18:30` → today, 18:30–19:30.
- [ ] Custom Quick Add: create a template `work` with default title "Work",
      duration 480m, default tag "Work" → typing `work` opens the modal
      pre-filled with all template defaults; typing `work tomorrow 9-17`
      keeps the template's tag/calendar/title but overrides time with
      09:00–17:00.
- [ ] Truly empty input → toast "Type something to quick-add."
- [ ] `???xyz???` → modal still opens with the title `???xyz???` and the
      day-detail date as the date (parser is intentionally permissive).

### Tag round-trip

- [ ] Create event with tag A → save → reopen → tag A is highlighted.
- [ ] Edit to tag B → save → month / week / day / day-detail all reflect
      tag B's color.
- [ ] Reopen edited event → tag B is highlighted (no flicker back to A).
- [ ] Switch the calendar dropdown inside an open event modal → tag picker
      re-renders with the new calendar's tags; previously selected tag
      from the old calendar falls back to the new calendar's "Untagged".

### Tag CRUD + reassignment

- [ ] Create a tag in calendar A → switch active calendar to B → the new
      tag is NOT in B's pickers.
- [ ] Delete a tag that's in use → confirmation modal shows the
      authoritative event count (matches a Supabase `count(*)` query).
- [ ] Confirm delete → events are reassigned to "Untagged" for that
      calendar; tag row is removed; UI shows updated state immediately.
- [ ] Try to delete the calendar's "Untagged" tag → toast blocks it.

### Calendars

- [ ] Archive an owned calendar → it disappears from the default list;
      "Show archived" reveals it; restore brings it back.
- [ ] Delete an owned calendar → confirmation prompt → events and tags
      cascade-delete.
- [ ] Share by email with an existing user → they see the calendar after
      a refresh.
- [ ] Share by email with a non-existing email → friendly error toast.

### Roles

- [ ] As **viewer** of a shared calendar:
  - [ ] Cannot open the "+ Add tag" affordance.
  - [ ] Cannot drag-and-drop reschedule (or any DB write attempt is
        blocked by RLS).
  - [ ] Tag list in Settings shows tags with NO Edit/Delete buttons (or,
        per current behavior, the section shows the
        "You need an editable calendar" placeholder — see REVIEW 3.1).
- [ ] As **collaborator**:
  - [ ] Can write/update/delete events and tags.
  - [ ] Cannot share or delete the calendar (owner-only).

### Lifecycle

- [ ] Background the tab → wait 2 minutes → return → realtime resumes,
      no duplicate "Calendar updated" toast for events the user just
      saved.
- [ ] Toggle airplane mode → mutate an event → toast shows "Offline" (or
      the persist-failure rollback runs).
- [ ] Hard-refresh → app shell loads from cache; data refetches.

### XSS smoke

- [ ] In the Supabase Studio table editor, set a tag's `color` to
      `#000"></span><script>alert(1)</script>`. Either:
      - the DB rejects it (after `2026-05-color-format-check.sql`), or
      - the row is saved but the rendered tag falls back to the safe
        gray color and the page shows no script alert. Both are pass.
