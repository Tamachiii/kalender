// Store-layer tests: tag-by-calendar selectors, the visible-event filter,
// and the syncSelectedTags re-seed behavior. No DOM, no Supabase — just the
// in-memory state object.
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import {
  canEditCalendar,
  defaultTagFor,
  eventTag,
  findQuickAddTemplateByShortcut,
  findTag,
  state,
  syncSelectedTags,
  tagsForCalendar,
  visibleEvents,
  visibleTags,
} from '../js/store.js';

const calA = { id: 'cal-a', name: 'A', color: '#aaaaaa', role: 'owner' };
const calB = { id: 'cal-b', name: 'B', color: '#bbbbbb', role: 'collaborator' };
const calC = { id: 'cal-c', name: 'C', color: '#cccccc', role: 'viewer' };
const calArch = { id: 'cal-arch', name: 'Arch', color: '#dddddd', role: 'owner', archived_at: '2026-04-01T00:00:00Z' };

const tagA1 = { id: 't-a-untagged', calendar_id: 'cal-a', name: 'Untagged', color: '#94a3b8' };
const tagA2 = { id: 't-a-work',     calendar_id: 'cal-a', name: 'Work',     color: '#3b82f6' };
const tagB1 = { id: 't-b-untagged', calendar_id: 'cal-b', name: 'Untagged', color: '#94a3b8' };
const tagB2 = { id: 't-b-personal', calendar_id: 'cal-b', name: 'Personal', color: '#22c55e' };
const tagC1 = { id: 't-c-untagged', calendar_id: 'cal-c', name: 'Untagged', color: '#94a3b8' };

beforeEach(() => {
  state.calendars = [calA, calB, calC, calArch];
  state.tags = [tagA1, tagA2, tagB1, tagB2, tagC1];
  state.events = [];
  state.activeCalendarId = null;
  state.search = '';
  state.showArchivedCalendars = false;
  state.selectedTagIds = new Set();
  state.quickAddTemplates = [];
});

test('canEditCalendar — owner and collaborator yes, viewer / unknown no', () => {
  assert.ok(canEditCalendar('cal-a'));
  assert.ok(canEditCalendar('cal-b'));
  assert.ok(!canEditCalendar('cal-c'));
  // For an unknown id the function short-circuits to a falsy value (currently
  // `undefined`); callers only depend on truthiness.
  assert.ok(!canEditCalendar('cal-missing'));
});

test('tagsForCalendar — only that calendar\'s tags, never bleed across', () => {
  assert.deepEqual(
    tagsForCalendar('cal-a').map((t) => t.id),
    [tagA1.id, tagA2.id],
  );
  assert.deepEqual(
    tagsForCalendar('cal-b').map((t) => t.id),
    [tagB1.id, tagB2.id],
  );
  assert.deepEqual(tagsForCalendar(null), []);
  assert.deepEqual(tagsForCalendar(undefined), []);
});

test('findTag returns the row or null, regardless of calendar scope', () => {
  assert.equal(findTag('t-a-work'), tagA2);
  assert.equal(findTag('t-b-personal'), tagB2);
  assert.equal(findTag('nope'), null);
  assert.equal(findTag(null), null);
});

test('defaultTagFor returns the calendar\'s Untagged row', () => {
  assert.equal(defaultTagFor('cal-a'), tagA1);
  assert.equal(defaultTagFor('cal-b'), tagB1);
  assert.equal(defaultTagFor(null), null);
  assert.equal(defaultTagFor('cal-missing'), null);
});

test('defaultTagFor falls back to first tag if Untagged is missing', () => {
  state.tags = [tagA2]; // no Untagged for cal-a
  assert.equal(defaultTagFor('cal-a'), tagA2);
});

test('eventTag — normal lookup', () => {
  const event = { tag_id: 't-b-personal' };
  assert.equal(eventTag(event), tagB2);
});

test('eventTag — unknown tag falls back to a frozen FALLBACK row', () => {
  const event = { tag_id: 'tag-deleted-mid-flight' };
  const fb = eventTag(event);
  assert.equal(fb.fallback, true);
  assert.equal(fb.id, null);
  assert.equal(fb.name, 'Untagged');
});

test('visibleTags — when active calendar set, returns only that calendar\'s tags', () => {
  state.activeCalendarId = 'cal-a';
  assert.deepEqual(
    visibleTags().map((t) => t.id),
    [tagA1.id, tagA2.id],
  );
});

test('visibleTags — no active calendar, union over visible (non-archived) calendars', () => {
  // archived calendar's tags should not show by default
  state.tags = [...state.tags, { id: 't-arch', calendar_id: 'cal-arch', name: 'Foo', color: '#000000' }];
  const visible = visibleTags().map((t) => t.id);
  assert.equal(visible.includes('t-arch'), false);
});

test('visibleTags — showArchivedCalendars includes archived', () => {
  state.tags = [...state.tags, { id: 't-arch', calendar_id: 'cal-arch', name: 'Foo', color: '#000000' }];
  state.showArchivedCalendars = true;
  const visible = visibleTags().map((t) => t.id);
  assert.equal(visible.includes('t-arch'), true);
});

test('syncSelectedTags — drops invalid ids, adds new visible ones (auto-check)', () => {
  state.selectedTagIds = new Set(['t-old-deleted']);
  syncSelectedTags();
  assert.equal(state.selectedTagIds.has('t-old-deleted'), false);
  // every visible tag is now checked (default state: nothing hidden)
  assert.equal(state.selectedTagIds.has(tagA1.id), true);
  assert.equal(state.selectedTagIds.has(tagB2.id), true);
});

test('syncSelectedTags — switching active calendar narrows the visible set', () => {
  state.activeCalendarId = 'cal-a';
  syncSelectedTags();
  // Only cal-a tags are now in the selection
  assert.deepEqual(
    [...state.selectedTagIds].sort(),
    [tagA1.id, tagA2.id].sort(),
  );
});

test('visibleEvents — filters by active calendar', () => {
  state.events = [
    { id: 'e1', calendar_id: 'cal-a', title: 'In A', description: '', tag_id: tagA1.id },
    { id: 'e2', calendar_id: 'cal-b', title: 'In B', description: '', tag_id: tagB1.id },
  ];
  state.activeCalendarId = 'cal-a';
  syncSelectedTags();
  assert.deepEqual(visibleEvents().map((e) => e.id), ['e1']);
});

test('visibleEvents — search matches title or description, case-insensitive', () => {
  state.events = [
    { id: 'e1', calendar_id: 'cal-a', title: 'Sprint planning', description: '', tag_id: tagA1.id },
    { id: 'e2', calendar_id: 'cal-a', title: 'Lunch', description: 'with the SPRINT crew', tag_id: tagA1.id },
    { id: 'e3', calendar_id: 'cal-a', title: 'Other', description: '', tag_id: tagA1.id },
  ];
  syncSelectedTags();
  state.search = 'sprint';
  assert.deepEqual(visibleEvents().map((e) => e.id).sort(), ['e1', 'e2']);
});

test('visibleEvents — events with NO tag_id bypass the tag filter', () => {
  state.events = [
    { id: 'e1', calendar_id: 'cal-a', title: 'Tagless', description: '', tag_id: null },
  ];
  state.selectedTagIds = new Set([tagA1.id]);
  // !event.tag_id short-circuits the filter so transient untagged rows
  // (during the migration window or realtime races) don't vanish from the UI.
  assert.equal(visibleEvents().length, 1);
});

test('visibleEvents — event whose tag_id is set but unknown to state IS hidden when filters are active', () => {
  state.events = [
    { id: 'e1', calendar_id: 'cal-a', title: 'Stale', description: '', tag_id: 'tag-deleted' },
  ];
  state.selectedTagIds = new Set([tagA1.id]);
  // After the cleanup migration the FK is `on delete restrict`, so this state
  // shouldn't occur — but if it does, the filter behaves predictably (hidden).
  assert.equal(visibleEvents().length, 0);
});

test('findQuickAddTemplateByShortcut — case-insensitive', () => {
  state.quickAddTemplates = [
    { id: 'q1', shortcut: 'work', default_title: 'Work', default_duration_minutes: 60 },
  ];
  assert.equal(findQuickAddTemplateByShortcut('WORK')?.id, 'q1');
  assert.equal(findQuickAddTemplateByShortcut('Work')?.id, 'q1');
  assert.equal(findQuickAddTemplateByShortcut('gym'), null);
  assert.equal(findQuickAddTemplateByShortcut(''), null);
});
