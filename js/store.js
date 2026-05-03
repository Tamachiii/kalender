import { BUILT_IN_TAGS } from './config.js';

export const state = {
  session: null,
  calendars: [],
  activeCalendarId: null,
  events: [],
  tags: [],
  selectedDate: new Date(),
  dayDetailDate: null,
  view: 'month',
  search: '',
  showArchivedCalendars: false,
  selectedCategories: new Set(['work', 'personal', 'urgent', 'focus', 'travel']),
  realtimeChannel: null,
};

export function activeCalendar() {
  return state.calendars.find((calendar) => calendar.id === state.activeCalendarId);
}

export function canEditCalendar(calendarId) {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  return calendar && ['owner', 'collaborator'].includes(calendar.role);
}

export function allTags() {
  return [...BUILT_IN_TAGS, ...state.tags];
}

export function findTag(tagId) {
  return allTags().find((tag) => tag.id === tagId);
}

export function eventTagKey(event) {
  return event.tag_id && findTag(event.tag_id) ? event.tag_id : event.category || 'work';
}

export function eventTag(event) {
  return findTag(eventTagKey(event)) || BUILT_IN_TAGS[0];
}

export function syncSelectedTags() {
  const validIds = new Set(allTags().map((tag) => tag.id));
  state.selectedCategories.forEach((id) => {
    if (!validIds.has(id)) state.selectedCategories.delete(id);
  });
  validIds.forEach((id) => state.selectedCategories.add(id));
}

export function visibleEvents() {
  const query = state.search.trim().toLowerCase();
  return state.events.filter((event) => {
    const matchesCalendar =
      !state.activeCalendarId || event.calendar_id === state.activeCalendarId;
    const matchesCategory = state.selectedCategories.has(eventTagKey(event));
    const matchesSearch =
      !query ||
      event.title.toLowerCase().includes(query) ||
      (event.description || '').toLowerCase().includes(query);
    return matchesCalendar && matchesCategory && matchesSearch;
  });
}
