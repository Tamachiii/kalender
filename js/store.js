import { FALLBACK_TAG_COLOR, FALLBACK_TAG_NAME } from './config.js';

export const state = {
  session: null,
  calendars: [],
  activeCalendarId: null,
  events: [],
  tags: [],
  quickAddTemplates: [],
  selectedDate: new Date(),
  dayDetailDate: null,
  view: 'month',
  search: '',
  showArchivedCalendars: false,
  selectedTagIds: new Set(),
  realtimeChannel: null,
};

const FALLBACK_TAG = Object.freeze({
  id: null,
  name: FALLBACK_TAG_NAME,
  color: FALLBACK_TAG_COLOR,
  calendar_id: null,
  fallback: true,
});

export function canEditCalendar(calendarId) {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  return calendar && ['owner', 'collaborator'].includes(calendar.role);
}

// Tags loaded for the user across every calendar they're a member of. Pickers
// must consume tagsForCalendar(calendarId) — never the full list — so an event
// in calendar A can never be saved with a tag from calendar B.
export function tagsForCalendar(calendarId) {
  if (!calendarId) return [];
  return state.tags.filter((tag) => tag.calendar_id === calendarId);
}

// Find a tag by id across every loaded calendar. Used for rendering existing
// events whose tag may live in a different calendar than the active one.
export function findTag(tagId) {
  if (!tagId) return null;
  return state.tags.find((tag) => tag.id === tagId) || null;
}

export function eventTag(event) {
  return findTag(event.tag_id) || FALLBACK_TAG;
}

// Find the per-calendar default ("Untagged") for fallbacks during create.
// Created automatically by the seed_calendar_tags trigger; this lookup is
// defensive in case the migration hasn't run yet.
export function defaultTagFor(calendarId) {
  if (!calendarId) return null;
  return (
    state.tags.find(
      (tag) => tag.calendar_id === calendarId && tag.name === FALLBACK_TAG_NAME,
    ) || tagsForCalendar(calendarId)[0] || null
  );
}

// Visible-tag set: union of tags across calendars currently shown. Used to
// re-seed selectedTagIds after a calendar list/active-calendar change.
export function visibleTags() {
  const visibleCalendarIds = new Set(
    state.calendars
      .filter((calendar) => !calendar.archived_at || state.showArchivedCalendars)
      .map((calendar) => calendar.id),
  );
  if (state.activeCalendarId) {
    return state.tags.filter((tag) => tag.calendar_id === state.activeCalendarId);
  }
  return state.tags.filter((tag) => visibleCalendarIds.has(tag.calendar_id));
}

// Re-sync selectedTagIds with whatever tags are currently visible. Called any
// time tags or active calendar changes; keeps the filter in a sane state.
export function syncSelectedTags() {
  const validIds = new Set(visibleTags().map((tag) => tag.id));
  // Drop now-invalid ids and ensure new ones default to "checked" so newly
  // visible tags don't silently hide their events.
  state.selectedTagIds.forEach((id) => {
    if (!validIds.has(id)) state.selectedTagIds.delete(id);
  });
  validIds.forEach((id) => state.selectedTagIds.add(id));
}

export function findQuickAddTemplateByShortcut(shortcut) {
  if (!shortcut) return null;
  const needle = shortcut.toLowerCase();
  return (
    state.quickAddTemplates.find((template) => template.shortcut.toLowerCase() === needle) || null
  );
}

// Events filtered by the active calendar / tag-filter chips / search box.
// This is the canonical filter — every render site goes through it so adding
// a new filter dimension only has to be done in one place.
export function visibleEvents() {
  const query = state.search.trim().toLowerCase();
  return state.events.filter((event) => {
    const matchesCalendar =
      !state.activeCalendarId || event.calendar_id === state.activeCalendarId;
    // Events with no tag_id at all (transient, in the brief window before the
    // cleanup migration makes the column NOT NULL, or during a realtime/fetch
    // race) bypass the tag filter so they don't vanish from the UI.
    const matchesTag =
      !event.tag_id || state.selectedTagIds.size === 0 || state.selectedTagIds.has(event.tag_id);
    const matchesSearch =
      !query ||
      event.title.toLowerCase().includes(query) ||
      (event.description || '').toLowerCase().includes(query);
    return matchesCalendar && matchesTag && matchesSearch;
  });
}
