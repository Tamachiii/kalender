import {
  createCalendar,
  createTag,
  deleteCalendar,
  deleteEvent,
  deleteTag,
  fetchCalendars,
  fetchEvents,
  fetchTags,
  getSession,
  onAuthStateChange,
  removeChannel,
  saveEvent,
  setEventCompleted,
  shareCalendar,
  signIn,
  signOut,
  subscribeToEvents,
  updateCalendarArchive,
  updateTag,
} from './api.js';
import { addDays, addMonths, dateKey, startOfDay, startOfMonthGrid, startOfWeek } from './dateUtils.js';
import { canEditCalendar, state, syncSelectedTags } from './store.js';
import {
  bindElements,
  elements,
  closeDayDetail,
  openCalendarModal,
  openDayDetail,
  openEventModal,
  openTagModal,
  openShareModal,
  readEventForm,
  readTagForm,
  renderAll,
  renderCalendar,
  renderCalendars,
  renderUser,
  selectEventTag,
  setActivePanel,
  setAuthenticatedView,
  showToast,
} from './ui.js';

bindElements();
const els = elements();
let eventSaveInFlight = false;
let eventDeleteInFlight = false;
let resumeInFlight = false;
let lastResumeAt = 0;
let searchRenderTimer = 0;
let refreshRequestId = 0;

boot();

async function boot() {
  registerServiceWorker();
  bindUiEvents();
  bindLifecycleEvents();
  document.documentElement.dataset.theme =
    localStorage.getItem('kalender-theme') || 'light';
  syncThemeButton();

  state.session = await getSession();
  setAuthenticatedView(Boolean(state.session));
  if (state.session) await loadWorkspace();

  onAuthStateChange(async (_event, session) => {
    state.session = session;
    setAuthenticatedView(Boolean(session));
    if (session) {
      await loadWorkspace();
    } else {
      state.calendars = [];
      state.events = [];
      state.tags = [];
      renderUser();
      await removeChannel(state.realtimeChannel);
      state.realtimeChannel = null;
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // The app remains fully usable if service worker registration is blocked.
    });
  });
}

function bindUiEvents() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.loginError.textContent = '';
    try {
      await signIn(els.email.value.trim(), els.password.value);
    } catch (error) {
      els.loginError.textContent = error.message;
    }
  });

  els.logoutBtn.addEventListener('click', signOut);
  els.themeToggle.addEventListener('click', toggleTheme);
  els.newCalendarBtn.addEventListener('click', openCalendarModal);
  els.newTagBtn.addEventListener('click', () => openTagModal());
  els.prevBtn.addEventListener('click', () => movePeriod(-1));
  els.todayBtn.addEventListener('click', () => {
    state.selectedDate = new Date();
    state.dayDetailDate = null;
    refreshEventsAndRender();
  });
  els.nextBtn.addEventListener('click', () => movePeriod(1));

  els.viewTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      state.dayDetailDate = null;
      refreshEventsAndRender();
    });
  });

  els.bottomTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'create') {
        openEventModal();
        return;
      }
      setActivePanel(tab.dataset.tab);
    });
  });

  els.eventSearch.addEventListener('input', () => {
    state.search = els.eventSearch.value;
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = window.setTimeout(renderAll, 90);
  });

  els.categoryFilters.addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"]')) {
      if (event.target.checked) state.selectedCategories.add(event.target.value);
      else state.selectedCategories.delete(event.target.value);
      renderAll();
    }
  });

  if (els.archivedToggle) {
    els.archivedToggle.addEventListener('change', async () => {
      state.showArchivedCalendars = els.archivedToggle.checked;
      renderCalendars();
      await setupRealtime();
      await refreshEventsAndRender();
    });
  }

  els.eventTagOptions.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tag-id]');
    if (!chip) return;
    selectEventTag(chip.dataset.tagId);
  });

  els.calendarList.addEventListener('click', (event) => {
    const shareTarget = event.target.closest('.share-affordance');
    const deleteTarget = event.target.closest('.calendar-delete');
    const archiveTarget = event.target.closest('.calendar-archive');
    const item = event.target.closest('.calendar-list-item');
    if (!item) return;
    if (shareTarget) {
      openShareModal(item.dataset.calendarId);
      return;
    }
    if (deleteTarget) {
      handleDeleteCalendar(item.dataset.calendarId);
      return;
    }
    if (archiveTarget) {
      handleArchiveCalendar(item.dataset.calendarId);
      return;
    }
    const calendar = state.calendars.find((entry) => entry.id === item.dataset.calendarId);
    if (calendar?.archived_at) {
      showToast('Restore this calendar before selecting it.');
      return;
    }
    state.activeCalendarId =
      state.activeCalendarId === item.dataset.calendarId ? null : item.dataset.calendarId;
    renderAll();
  });

  els.calendarList.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const item = event.target.closest('.calendar-list-item');
    if (!item || event.target.closest('button')) return;
    event.preventDefault();
    state.activeCalendarId =
      state.activeCalendarId === item.dataset.calendarId ? null : item.dataset.calendarId;
    renderAll();
  });

  els.tagList.addEventListener('click', (event) => {
    const row = event.target.closest('.tag-list-item');
    if (!row) return;
    const tag = state.tags.find((item) => item.id === row.dataset.tagId);
    if (!tag) return;

    if (event.target.closest('.tag-delete')) {
      handleDeleteTag(tag.id);
      return;
    }

    if (event.target.closest('.tag-edit') || row.contains(event.target)) {
      openTagModal(tag);
    }
  });

  els.calendarGrid.addEventListener('click', (event) => {
    if (event.target.closest('[data-day-detail-back]')) {
      closeDayDetail();
      return;
    }

    if (event.target.closest('[data-day-add-event]')) {
      openEventModal(null, state.dayDetailDate || state.selectedDate);
      return;
    }

    if (event.target.closest('[data-day-add-task]')) {
      openEventModal(null, state.dayDetailDate || state.selectedDate, {
        title: 'Task: ',
      });
      return;
    }

    const eventButton = event.target.closest('[data-event-id]');
    if (eventButton) {
      const calendarEvent = state.events.find((item) => item.id === eventButton.dataset.eventId);
      if (calendarEvent) openEventModal(calendarEvent);
      return;
    }

    const dated = event.target.closest('[data-date]');
    if (dated) openDayDetail(new Date(`${dated.dataset.date}T00:00:00`));
  });

  els.calendarGrid.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-quick-add-form]');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('[data-quick-add-input]');
    const draft = parseQuickAdd(input.value, state.dayDetailDate || state.selectedDate);
    if (!draft.title) {
      showToast('Add a title to quick-add.');
      return;
    }
    input.value = '';
    openEventModal(null, new Date(draft.starts_at), draft);
  });

  els.calendarGrid.addEventListener('dragstart', (event) => {
    const eventButton = event.target.closest('[data-event-id]');
    if (!eventButton) return;
    event.dataTransfer.setData('text/plain', eventButton.dataset.eventId);
  });
  els.calendarGrid.addEventListener('dragover', (event) => {
    if (event.target.closest('[data-date]')) event.preventDefault();
  });
  els.calendarGrid.addEventListener('drop', handleEventDrop);
  bindSwipeNavigation();

  els.weeklyOverview.addEventListener('click', (event) => {
    const completeButton = event.target.closest('[data-complete-event-id]');
    if (completeButton) {
      handleToggleComplete(completeButton.dataset.completeEventId);
      return;
    }

    const eventButton = event.target.closest('[data-event-id]');
    if (!eventButton) return;
    const calendarEvent = state.events.find((item) => item.id === eventButton.dataset.eventId);
    if (calendarEvent) openEventModal(calendarEvent);
  });

  els.eventForm.addEventListener('submit', handleEventSubmit);
  els.deleteEventBtn.addEventListener('click', handleDeleteEvent);
  els.calendarForm.addEventListener('submit', handleCreateCalendar);
  els.tagForm.addEventListener('submit', handleSaveTag);
  els.deleteTagBtn.addEventListener('click', () => handleDeleteTag(els.tagId.value));
  els.shareForm.addEventListener('submit', handleShareCalendar);
  els.closeModalButtons.forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });

  if ('Notification' in window && Notification.permission === 'default') {
    window.setTimeout(() => Notification.requestPermission(), 1200);
  }
}

async function loadWorkspace() {
  renderUser();
  const [calendars, tags] = await Promise.all([loadCalendarsSafely(), loadTagsSafely()]);
  state.calendars = calendars;
  state.tags = tags;
  syncSelectedTags();
  state.activeCalendarId = state.calendars.find((calendar) => !calendar.archived_at)?.id || null;
  setActivePanel('calendar');
  await setupRealtime();
  await refreshEventsAndRender();
}

async function loadCalendarsSafely() {
  try {
    return await fetchCalendars();
  } catch (error) {
    showToast('Calendar data could not be loaded. Check Supabase setup.');
    return [];
  }
}

async function loadTagsSafely() {
  try {
    return await fetchTags();
  } catch (error) {
    showToast('Custom tags need the latest Supabase migration.');
    return [];
  }
}

async function refreshEventsAndRender() {
  const requestId = ++refreshRequestId;
  const [rangeStart, rangeEnd] = eventRangeForView();
  const calendarIds = state.calendars
    .filter((calendar) => !calendar.archived_at || state.showArchivedCalendars)
    .map((calendar) => calendar.id);
  if (!calendarIds.length) {
    state.events = [];
    renderAll();
    return;
  }

  try {
    const events = await fetchEvents(calendarIds, rangeStart, rangeEnd);
    if (requestId !== refreshRequestId) return;
    state.events = events;
    renderAll();
    scheduleReminders();
  } catch (error) {
    showToast(error.message || 'Events could not be loaded.');
  }
}

async function setupRealtime() {
  await removeChannel(state.realtimeChannel);
  const calendarIds = state.calendars
    .filter((calendar) => !calendar.archived_at || state.showArchivedCalendars)
    .map((calendar) => calendar.id);
  state.realtimeChannel = subscribeToEvents(
    calendarIds,
    async () => {
      await refreshEventsAndRender();
      showToast('Calendar updated');
    },
  );
}

function eventRangeForView() {
  if (state.view === 'month') {
    const start = startOfMonthGrid(state.selectedDate);
    return [start, addDays(start, 42)];
  }
  if (state.view === 'week') {
    const start = startOfWeek(state.selectedDate);
    return [start, addDays(start, 7)];
  }
  const start = startOfDay(state.selectedDate);
  return [start, addDays(start, 1)];
}

function movePeriod(direction) {
  if (state.dayDetailDate) {
    state.dayDetailDate = addDays(state.dayDetailDate, direction);
    state.selectedDate = state.dayDetailDate;
    refreshEventsAndRender();
    return;
  }
  if (state.view === 'month') state.selectedDate = addMonths(state.selectedDate, direction);
  if (state.view === 'week') state.selectedDate = addDays(state.selectedDate, direction * 7);
  if (state.view === 'day') state.selectedDate = addDays(state.selectedDate, direction);
  refreshEventsAndRender();
}

async function handleEventSubmit(event) {
  event.preventDefault();
  if (eventSaveInFlight) return;
  els.eventError.textContent = '';
  eventSaveInFlight = true;
  let previousEvents = null;
  try {
    const payload = readEventForm();
    if (!canEditCalendar(payload.calendar_id)) {
      throw new Error('You do not have permission to edit this calendar.');
    }
    setFormBusy(els.eventForm, true);
    previousEvents = state.events;
    const temporaryId = payload.id || `tmp-${Date.now()}`;
    const optimisticEvent = {
      ...payload,
      id: temporaryId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    refreshRequestId += 1;
    state.events = payload.id
      ? state.events.map((item) => (item.id === payload.id ? { ...item, ...payload } : item))
      : [...state.events, optimisticEvent];
    renderAll();
    setFormBusy(els.eventForm, true);

    const saved = await saveEvent(payload);
    state.events = state.events.map((item) =>
      item.id === temporaryId || item.id === saved.id ? saved : item,
    );
    els.eventModal.close();
    await refreshEventsAndRender();
    showToast('Event saved');
  } catch (error) {
    if (previousEvents) {
      state.events = previousEvents;
      renderAll();
    }
    els.eventError.textContent = error.message;
    showToast('Event could not be saved.');
  } finally {
    eventSaveInFlight = false;
    setFormBusy(els.eventForm, false);
  }
}

async function handleDeleteEvent() {
  if (eventDeleteInFlight) return;
  const eventId = els.eventId.value;
  const event = state.events.find((item) => item.id === eventId);
  if (!event) {
    showToast('This event is no longer available.');
    return;
  }
  if (!canEditCalendar(event.calendar_id)) {
    showToast('You do not have permission to delete this event.');
    return;
  }

  eventDeleteInFlight = true;
  els.deleteEventBtn.disabled = true;
  const previousEvents = state.events;
  refreshRequestId += 1;
  state.events = state.events.filter((item) => item.id !== eventId);
  els.eventModal.close();
  renderAll();

  try {
    await deleteEvent(eventId);
    showToast('Event deleted');
  } catch (error) {
    state.events = previousEvents;
    renderAll();
    showToast(error.message || 'Event could not be deleted.');
  } finally {
    eventDeleteInFlight = false;
    els.deleteEventBtn.disabled = false;
  }
}

async function handleCreateCalendar(event) {
  event.preventDefault();
  els.calendarError.textContent = '';
  try {
    const calendar = await createCalendar({
      name: els.calendarName.value.trim(),
      color: els.calendarColor.value,
    });
    state.activeCalendarId = calendar.id;
    els.calendarModal.close();
    await loadWorkspace();
    showToast('Calendar created');
  } catch (error) {
    els.calendarError.textContent = error.message;
  }
}

async function handleSaveTag(event) {
  event.preventDefault();
  els.tagError.textContent = '';
  try {
    const tag = readTagForm();
    if (tag.id) {
      await updateTag(tag.id, tag);
      showToast('Tag updated');
    } else {
      await createTag(tag);
      showToast('Tag created');
    }
    els.tagModal.close();
    state.tags = await fetchTags();
    syncSelectedTags();
    renderAll();
  } catch (error) {
    els.tagError.textContent = error.message;
  }
}

async function handleDeleteTag(tagId) {
  const tag = state.tags.find((item) => item.id === tagId);
  if (!tag) return;

  const confirmed = window.confirm(
    `Delete the "${tag.name}" tag? Events using it will keep their color but lose the tag link.`,
  );
  if (!confirmed) return;

  try {
    await deleteTag(tagId);
    if (els.tagModal.open) els.tagModal.close();
    state.tags = await fetchTags();
    syncSelectedTags();
    await refreshEventsAndRender();
    showToast('Tag deleted');
  } catch (error) {
    if (els.tagModal.open) els.tagError.textContent = error.message;
    else showToast(error.message);
  }
}

async function handleShareCalendar(event) {
  event.preventDefault();
  els.shareError.textContent = '';
  try {
    await shareCalendar({
      calendar_id: els.shareCalendarId.value,
      email: els.shareUserId.value.trim(),
      role: els.shareRole.value,
    });
    els.shareModal.close();
    showToast('Calendar shared');
  } catch (error) {
    els.shareError.textContent = error.message;
  }
}

async function handleDeleteCalendar(calendarId) {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  if (!calendar || calendar.role !== 'owner') return;

  const confirmed = window.confirm(
    `Delete "${calendar.name}" and all of its events? This cannot be undone.`,
  );
  if (!confirmed) return;

  try {
    await deleteCalendar(calendarId);
    if (state.activeCalendarId === calendarId) state.activeCalendarId = null;
    await loadWorkspace();
    showToast('Calendar deleted');
  } catch (error) {
    showToast(error.message);
  }
}

async function handleArchiveCalendar(calendarId) {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  if (!calendar || calendar.role !== 'owner') return;

  const archived = !calendar.archived_at;
  const previousCalendars = state.calendars;
  const nextArchivedAt = archived ? new Date().toISOString() : null;
  state.calendars = state.calendars.map((item) =>
    item.id === calendarId ? { ...item, archived_at: nextArchivedAt } : item,
  );
  if (archived && state.activeCalendarId === calendarId) {
    state.activeCalendarId = state.calendars.find((item) => !item.archived_at)?.id || null;
  }
  renderAll();

  try {
    await updateCalendarArchive(calendarId, archived);
    await loadWorkspace();
    state.showArchivedCalendars = archived || state.showArchivedCalendars;
    renderAll();
    showToast(archived ? 'Calendar archived' : 'Calendar restored');
  } catch (error) {
    state.calendars = previousCalendars;
    renderAll();
    showToast(error.message?.includes('archived_at') ? 'Run the calendar archive migration.' : error.message);
  }
}

async function handleToggleComplete(eventId) {
  const event = state.events.find((item) => item.id === eventId);
  if (!event) return;
  if (!canEditCalendar(event.calendar_id)) {
    showToast('You do not have permission to update this task.');
    return;
  }

  const nextCompleted = !event.completed;
  const previousCompleted = event.completed;
  refreshRequestId += 1;
  event.completed = nextCompleted;
  renderAll();

  try {
    await setEventCompleted(eventId, nextCompleted);
  } catch (error) {
    const currentEvent = state.events.find((item) => item.id === eventId);
    if (currentEvent) currentEvent.completed = previousCompleted;
    renderAll();
    showToast(error.message);
  }
}

async function handleEventDrop(event) {
  const dropTarget = event.target.closest('[data-date]');
  if (!dropTarget) return;
  event.preventDefault();

  const eventId = event.dataTransfer.getData('text/plain');
  const calendarEvent = state.events.find((item) => item.id === eventId);
  if (!calendarEvent || !canEditCalendar(calendarEvent.calendar_id)) return;

  const destination = new Date(`${dropTarget.dataset.date}T00:00:00`);
  const oldStart = new Date(calendarEvent.starts_at);
  const oldEnd = new Date(calendarEvent.ends_at);
  const duration = oldEnd - oldStart;
  destination.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);

  await saveEvent({
    ...calendarEvent,
    starts_at: destination.toISOString(),
    ends_at: new Date(destination.getTime() + duration).toISOString(),
  });
  await refreshEventsAndRender();
  showToast('Event moved');
}

function toggleTheme() {
  const next =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('kalender-theme', next);
  syncThemeButton();
}

function syncThemeButton() {
  els.themeToggle.textContent =
    document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
}

function parseQuickAdd(value, fallbackDate) {
  const raw = value.trim();
  if (!raw) return {};

  const now = new Date();
  let date = startOfDay(fallbackDate || now);
  let title = raw;
  const lower = raw.toLowerCase();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  if (lower.includes('tomorrow')) {
    date = startOfDay(addDays(now, 1));
    title = removeToken(title, 'tomorrow');
  } else if (lower.includes('today')) {
    date = startOfDay(now);
    title = removeToken(title, 'today');
  } else {
    const namedDay = dayNames.find((day) => lower.includes(day));
    if (namedDay) {
      const target = dayNames.indexOf(namedDay);
      const current = now.getDay();
      const offset = (target - current + 7) % 7 || 7;
      date = startOfDay(addDays(now, offset));
      title = removeToken(title, namedDay);
    }
  }

  const timeRange = title.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\b/i);
  const singleTime = title.match(/\b(\d{1,2})(?::(\d{2}))\b/);
  let startHour = 9;
  let startMinute = 0;
  let endHour = 10;
  let endMinute = 0;

  if (timeRange) {
    startHour = Number(timeRange[1]);
    startMinute = Number(timeRange[2] || 0);
    endHour = Number(timeRange[3]);
    endMinute = Number(timeRange[4] || 0);
    title = title.replace(timeRange[0], '');
  } else if (singleTime) {
    startHour = Number(singleTime[1]);
    startMinute = Number(singleTime[2]);
    endHour = startHour + 1;
    endMinute = startMinute;
    title = title.replace(singleTime[0], '');
  }

  const start = new Date(date);
  start.setHours(startHour, startMinute, 0, 0);
  const end = new Date(date);
  end.setHours(endHour, endMinute, 0, 0);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
  };
}

function removeToken(value, token) {
  return value.replace(new RegExp(`\\b${token}\\b`, 'i'), '').trim();
}

function bindSwipeNavigation() {
  let startX = 0;
  let startY = 0;
  let startedAt = 0;

  els.calendarGrid.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startedAt = Date.now();
    },
    { passive: true },
  );

  els.calendarGrid.addEventListener(
    'touchend',
    (event) => {
      if (!startedAt) return;
      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const isHorizontal = Math.abs(deltaX) > 72 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5;
      const isQuick = Date.now() - startedAt < 600;
      startedAt = 0;

      if (isHorizontal && isQuick) {
        movePeriod(deltaX > 0 ? -1 : 1);
      }
    },
    { passive: true },
  );
}

function bindLifecycleEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverAfterResume();
  });
  window.addEventListener('focus', recoverAfterResume);
  window.addEventListener('offline', () => showToast('Offline. Changes will need a connection.'));
  window.addEventListener('online', () => {
    showToast('Back online. Syncing...');
    recoverAfterResume();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) recoverAfterResume();
  });
}

async function recoverAfterResume() {
  if (resumeInFlight) return;
  if (!state.session && !document.body.classList.contains('authenticated')) return;

  const now = Date.now();
  if (now - lastResumeAt < 1500) return;
  lastResumeAt = now;
  resumeInFlight = true;

  const activePanel = document.querySelector('.app-panel.active')?.dataset.panel || 'calendar';
  const activeCalendarId = state.activeCalendarId;

  try {
    const session = await getSession();
    state.session = session;
    setAuthenticatedView(Boolean(session));

    if (!session) {
      state.calendars = [];
      state.events = [];
      state.tags = [];
      await removeChannel(state.realtimeChannel);
      state.realtimeChannel = null;
      return;
    }

    renderUser();
    const [calendars, tags] = await Promise.all([loadCalendarsSafely(), loadTagsSafely()]);
    state.calendars = calendars;
    state.tags = tags;
    syncSelectedTags();
    state.activeCalendarId =
      calendars.find((calendar) => calendar.id === activeCalendarId)?.id ||
      calendars[0]?.id ||
      null;
    setActivePanel(activePanel);
    await setupRealtime();
    await refreshEventsAndRender();
  } catch (error) {
    showToast(error.message || 'Sync could not be restored.');
  } finally {
    resumeInFlight = false;
  }
}

function setFormBusy(form, isBusy) {
  form.setAttribute('aria-busy', String(isBusy));
  form.querySelectorAll('button, input, select, textarea').forEach((control) => {
    control.disabled = isBusy;
  });
}

function scheduleReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  state.events.forEach((event) => {
    if (!event.reminder_minutes || event.reminderScheduled) return;
    const notifyAt =
      new Date(event.starts_at).getTime() - event.reminder_minutes * 60 * 1000;
    const delay = notifyAt - Date.now();
    if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
      event.reminderScheduled = true;
      window.setTimeout(() => {
        new Notification(event.title, {
          body: `Starts at ${new Date(event.starts_at).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}`,
        });
      }, delay);
    }
  });
}
