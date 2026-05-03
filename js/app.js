import {
  countEventsUsingTag,
  createCalendar,
  createQuickAddTemplate,
  createTag,
  deleteCalendar,
  deleteEvent,
  deleteQuickAddTemplate,
  deleteTag,
  fetchCalendars,
  fetchEvents,
  fetchQuickAddTemplates,
  fetchTags,
  getSession,
  onAuthStateChange,
  reassignEventsTag,
  removeChannel,
  saveEvent,
  setEventCompleted,
  shareCalendar,
  signIn,
  signOut,
  subscribeToWorkspace,
  updateCalendarArchive,
  updateQuickAddTemplate,
  updateTag,
} from './api.js';
import { addDays, addMonths, startOfDay, startOfMonthGrid, startOfWeek } from './dateUtils.js';
import { parseQuickAddInput } from './quickAdd.js';
import {
  canEditCalendar,
  defaultTagFor,
  findQuickAddTemplateByShortcut,
  findTag,
  state,
  syncSelectedTags,
} from './store.js';
import {
  bindElements,
  closeDayDetail,
  closeTagDeleteModal,
  closeTypePicker,
  consumePendingTypePickerDate,
  elements,
  openCalendarModal,
  openDayDetail,
  openEventModal,
  openQuickAddTemplateModal,
  openShareModal,
  openTagDeleteModal,
  openTagModal,
  openTypePicker,
  populateQuickAddTemplateTagOptions,
  readEventForm,
  readQuickAddTemplateForm,
  readTagForm,
  renderAll,
  renderCalendars,
  renderUser,
  selectEventTag,
  setActivePanel,
  setAuthenticatedView,
  setTagDeleteError,
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
let tagDeleteInFlight = false;
// Realtime echoes our own writes back. Suppress the "Calendar updated" toast
// for a short window after any local mutation finishes, so a save shows
// exactly one toast ("Event saved") instead of two.
let lastLocalMutationAt = 0;
const LOCAL_ECHO_WINDOW_MS = 1500;
function markLocalMutation() {
  lastLocalMutationAt = Date.now();
}

// Snapshot the state slices that any optimistic handler might touch, apply the
// change, render, persist; on failure restore the snapshot and toast. Bumping
// refreshRequestId prevents an in-flight fetchEvents from stomping our optimistic
// state when it resolves later. See "Optimistic mutations" in CLAUDE.md.
async function withOptimisticUpdate({ apply, persist, success, errorMessage }) {
  const previous = {
    events: state.events,
    calendars: state.calendars,
    tags: state.tags,
    activeCalendarId: state.activeCalendarId,
  };
  refreshRequestId += 1;
  apply();
  renderAll();
  try {
    const result = await persist();
    if (success) await success(result);
    renderAll();
    return result;
  } catch (error) {
    state.events = previous.events;
    state.calendars = previous.calendars;
    state.tags = previous.tags;
    state.activeCalendarId = previous.activeCalendarId;
    renderAll();
    const message =
      typeof errorMessage === 'function'
        ? errorMessage(error)
        : errorMessage ?? error.message ?? 'Something went wrong.';
    showToast(message);
    throw error;
  }
}

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
      state.quickAddTemplates = [];
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
  els.newTagBtn.addEventListener('click', () => openTagModal(null, state.activeCalendarId));
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
        openTypePicker(state.dayDetailDate || state.selectedDate);
        return;
      }
      setActivePanel(tab.dataset.tab);
    });
  });

  if (els.typePickerModal) {
    els.typePickerModal.addEventListener('click', (event) => {
      const option = event.target.closest('[data-type-pick]');
      if (!option) return;
      const type = option.dataset.typePick;
      const date = consumePendingTypePickerDate() || state.dayDetailDate || state.selectedDate;
      closeTypePicker();
      if (type === 'task') {
        openEventModal(null, date, { title: 'Task: ' });
      } else if (type === 'event') {
        openEventModal(null, date);
      } else {
        console.warn('[type-picker] unknown type', type);
      }
    });
  }

  els.eventSearch.addEventListener('input', () => {
    state.search = els.eventSearch.value;
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = window.setTimeout(renderAll, 90);
  });

  els.categoryFilters.addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"]')) {
      if (event.target.checked) state.selectedTagIds.add(event.target.value);
      else state.selectedTagIds.delete(event.target.value);
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

  // Re-render the event tag picker when the user changes the calendar
  // dropdown — the previously-selected tag may not exist in the new calendar.
  els.eventCalendar.addEventListener('change', () => {
    const calendarId = els.eventCalendar.value;
    const fallback = defaultTagFor(calendarId);
    selectEventTag(fallback?.id || '');
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
    syncSelectedTags();
    renderAll();
  });

  els.calendarList.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const item = event.target.closest('.calendar-list-item');
    if (!item || event.target.closest('button')) return;
    event.preventDefault();
    state.activeCalendarId =
      state.activeCalendarId === item.dataset.calendarId ? null : item.dataset.calendarId;
    syncSelectedTags();
    renderAll();
  });

  els.tagList.addEventListener('click', (event) => {
    // Per-calendar "+ Add tag" affordance on the group header.
    const addBtn = event.target.closest('[data-tag-add-calendar-id]');
    if (addBtn) {
      openTagModal(null, addBtn.dataset.tagAddCalendarId);
      return;
    }
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

    if (event.target.closest('[data-day-add]')) {
      openTypePicker(state.dayDetailDate || state.selectedDate);
      return;
    }

    const eventButton = event.target.closest('[data-event-id]');
    if (eventButton) {
      const calendarEvent = state.events.find((item) => item.id === eventButton.dataset.eventId);
      if (calendarEvent) openEventModal(calendarEvent);
      return;
    }

    // The day-detail-shell carries [data-date] for drag-drop drop targeting.
    // Without this guard, clicks on the Quick Add input bubble up here, match
    // the data-date selector, and re-render the shell — wiping the input
    // mid-keystroke. Once we're inside day-detail, only the Back/Add/event
    // buttons (handled above) should navigate.
    if (state.dayDetailDate) return;

    const dated = event.target.closest('[data-date]');
    if (dated) openDayDetail(new Date(`${dated.dataset.date}T00:00:00`));
  });

  els.calendarGrid.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-quick-add-form]');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('[data-quick-add-input]');
    handleQuickAddSubmit(input);
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
  els.tagDeleteForm.addEventListener('submit', handleConfirmDeleteTag);
  els.shareForm.addEventListener('submit', handleShareCalendar);

  if (els.newQuickAddTemplateBtn) {
    els.newQuickAddTemplateBtn.addEventListener('click', () => openQuickAddTemplateModal());
  }
  if (els.quickAddTemplateForm) {
    els.quickAddTemplateForm.addEventListener('submit', handleSaveQuickAddTemplate);
  }
  if (els.deleteQuickAddTemplateBtn) {
    els.deleteQuickAddTemplateBtn.addEventListener('click', () =>
      handleDeleteQuickAddTemplate(els.quickAddTemplateId.value),
    );
  }
  // Refresh the template's tag dropdown when the calendar dropdown changes —
  // tags only show for that calendar.
  if (els.quickAddTemplateCalendar) {
    els.quickAddTemplateCalendar.addEventListener('change', () => {
      populateQuickAddTemplateTagOptions(els.quickAddTemplateCalendar.value);
    });
  }
  if (els.quickAddTemplateList) {
    els.quickAddTemplateList.addEventListener('click', (event) => {
      const row = event.target.closest('.quick-add-template-item');
      if (!row) return;
      const template = state.quickAddTemplates.find(
        (item) => item.id === row.dataset.quickAddTemplateId,
      );
      if (!template) return;
      if (event.target.closest('.quick-add-template-delete')) {
        handleDeleteQuickAddTemplate(template.id);
        return;
      }
      openQuickAddTemplateModal(template);
    });
  }
  els.closeModalButtons.forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });

  if ('Notification' in window && Notification.permission === 'default') {
    window.setTimeout(() => Notification.requestPermission(), 1200);
  }
}

async function loadWorkspace() {
  renderUser();
  const [calendars, tags, templates] = await Promise.all([
    loadCalendarsSafely(),
    loadTagsSafely(),
    loadQuickAddTemplatesSafely(),
  ]);
  state.calendars = calendars;
  state.tags = tags;
  state.quickAddTemplates = templates;
  state.activeCalendarId = state.calendars.find((calendar) => !calendar.archived_at)?.id || null;
  syncSelectedTags();
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
    showToast('Run supabase/2026-05-calendar-scoped-tags.sql to enable per-calendar tags.');
    console.warn('[tags] fetch failed', error);
    return [];
  }
}

async function loadQuickAddTemplatesSafely() {
  try {
    const { rows, missingTable } = await fetchQuickAddTemplates();
    if (missingTable) {
      console.warn(
        '[quick-add] quick_add_templates table is missing. Run supabase/2026-05-add-quick-add-templates.sql.',
      );
    }
    return rows;
  } catch (error) {
    showToast('Quick-add templates could not be loaded.');
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
  state.realtimeChannel = subscribeToWorkspace(calendarIds, {
    onEventChange: async () => {
      await refreshEventsAndRender();
      if (Date.now() - lastLocalMutationAt > LOCAL_ECHO_WINDOW_MS) {
        showToast('Calendar updated');
      }
    },
    // Tag inserts/updates/deletes need to land in state before any subsequent
    // event renders pick up the new color/name. Refetch tags then re-render.
    onTagChange: async () => {
      try {
        state.tags = await fetchTags();
        syncSelectedTags();
        renderAll();
      } catch (error) {
        console.warn('[tags] refresh after realtime failed', error);
      }
    },
  });
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

    const saved = await saveEvent(payload);
    markLocalMutation();
    state.events = state.events.map((item) =>
      item.id === temporaryId || item.id === saved.id ? saved : item,
    );
    renderAll();
    els.eventModal.close();
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
  els.eventModal.close();

  try {
    await withOptimisticUpdate({
      apply: () => {
        state.events = state.events.filter((item) => item.id !== eventId);
      },
      persist: () => deleteEvent(eventId),
      errorMessage: (error) => error.message || 'Event could not be deleted.',
    });
    markLocalMutation();
    showToast('Event deleted');
  } catch {
    // rollback + toast handled inside withOptimisticUpdate
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
    if (!canEditCalendar(tag.calendar_id)) {
      throw new Error('You need editor access to manage this calendar’s tags.');
    }
    let saved;
    if (tag.id) {
      saved = await updateTag(tag.id, { name: tag.name, color: tag.color });
    } else {
      saved = await createTag(tag);
    }
    markLocalMutation();
    // Splice the saved row into state directly. Realtime would also echo it
    // back via onTagChange (which refetches), but rendering once with the
    // server's row keeps the modal-close flicker-free.
    state.tags = tag.id
      ? state.tags.map((item) => (item.id === saved.id ? saved : item))
      : [...state.tags, saved];
    syncSelectedTags();
    els.tagModal.close();
    renderAll();
    showToast(tag.id ? 'Tag updated' : 'Tag created');
  } catch (error) {
    els.tagError.textContent = error.message;
  }
}

// Two-step delete: confirmation modal first (with affected count + reassign
// target). Confirmation handler does the actual reassignment + delete.
async function handleDeleteTag(tagId) {
  const tag = state.tags.find((item) => item.id === tagId);
  if (!tag) return;
  if (!canEditCalendar(tag.calendar_id)) {
    showToast('You need editor access to delete this tag.');
    return;
  }
  const target = defaultTagFor(tag.calendar_id);
  if (target && target.id === tag.id) {
    showToast('"Untagged" cannot be deleted — it is the per-calendar default.');
    return;
  }

  // Authoritative count from the database (the local store filters by date
  // range, so a client-side count would undercount older events).
  let affected = 0;
  try {
    affected = await countEventsUsingTag(tag.id);
  } catch (error) {
    console.warn('[tags] count failed, falling back to local', error);
    affected = state.events.filter((item) => item.tag_id === tag.id).length;
  }

  openTagDeleteModal({
    tag,
    affectedCount: affected,
    targetTagName: target?.name || 'Untagged',
  });
}

async function handleConfirmDeleteTag(event) {
  event.preventDefault();
  if (tagDeleteInFlight) return;
  const tagId = els.tagDeleteId.value;
  const tag = state.tags.find((item) => item.id === tagId);
  if (!tag) {
    closeTagDeleteModal();
    return;
  }
  const target = defaultTagFor(tag.calendar_id);
  if (!target) {
    setTagDeleteError(
      'No "Untagged" tag found for this calendar. Re-run the migration before deleting.',
    );
    return;
  }

  tagDeleteInFlight = true;
  setTagDeleteError('');
  els.tagDeleteConfirmBtn.disabled = true;
  try {
    // Reassign first, then delete. With the cleanup migration applied,
    // events.tag_id is on delete restrict — deleteTag would fail if any event
    // still references this tag.
    const reassigned = await reassignEventsTag(tag.id, target.id);
    await deleteTag(tag.id);

    if (els.tagModal.open) els.tagModal.close();
    closeTagDeleteModal();
    state.tags = await fetchTags();
    syncSelectedTags();
    await refreshEventsAndRender();
    showToast(`Tag deleted${reassigned.length ? ` — ${reassigned.length} event${reassigned.length === 1 ? '' : 's'} reassigned to ${target.name}.` : '.'}`);
  } catch (error) {
    console.warn('[tags] delete failed', error);
    setTagDeleteError(error.message || 'Could not delete tag.');
  } finally {
    tagDeleteInFlight = false;
    els.tagDeleteConfirmBtn.disabled = false;
  }
}

async function handleSaveQuickAddTemplate(event) {
  event.preventDefault();
  els.quickAddTemplateError.textContent = '';
  try {
    const payload = readQuickAddTemplateForm();
    if (payload.id) {
      const { id, ...update } = payload;
      const saved = await updateQuickAddTemplate(id, update);
      state.quickAddTemplates = state.quickAddTemplates.map((item) =>
        item.id === saved.id ? saved : item,
      );
      showToast('Quick-add updated');
    } else {
      const { id, ...create } = payload;
      const created = await createQuickAddTemplate(create);
      state.quickAddTemplates = [...state.quickAddTemplates, created];
      showToast('Quick-add created');
    }
    els.quickAddTemplateModal.close();
    renderAll();
  } catch (error) {
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      els.quickAddTemplateError.textContent = 'A quick-add with that shortcut already exists.';
    } else if (error.code === '42P01' || /quick_add_templates/i.test(error.message || '')) {
      els.quickAddTemplateError.textContent =
        'Run supabase/2026-05-add-quick-add-templates.sql to enable Custom Quick Adds.';
    } else {
      els.quickAddTemplateError.textContent = error.message || 'Could not save quick-add.';
    }
  }
}

async function handleDeleteQuickAddTemplate(templateId) {
  const template = state.quickAddTemplates.find((item) => item.id === templateId);
  if (!template) return;

  const confirmed = window.confirm(`Delete the "${template.shortcut}" quick-add?`);
  if (!confirmed) return;

  try {
    await deleteQuickAddTemplate(templateId);
    state.quickAddTemplates = state.quickAddTemplates.filter((item) => item.id !== templateId);
    if (els.quickAddTemplateModal.open) els.quickAddTemplateModal.close();
    renderAll();
    showToast('Quick-add deleted');
  } catch (error) {
    if (els.quickAddTemplateModal.open) {
      els.quickAddTemplateError.textContent = error.message || 'Could not delete quick-add.';
    } else {
      showToast(error.message || 'Could not delete quick-add.');
    }
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
  const nextArchivedAt = archived ? new Date().toISOString() : null;

  try {
    await withOptimisticUpdate({
      apply: () => {
        state.calendars = state.calendars.map((item) =>
          item.id === calendarId ? { ...item, archived_at: nextArchivedAt } : item,
        );
        if (archived && state.activeCalendarId === calendarId) {
          state.activeCalendarId =
            state.calendars.find((item) => !item.archived_at)?.id || null;
        }
      },
      persist: () => updateCalendarArchive(calendarId, archived),
      success: async () => {
        await loadWorkspace();
        state.showArchivedCalendars = archived || state.showArchivedCalendars;
      },
      errorMessage: (error) =>
        error.message?.includes('archived_at')
          ? 'Run the calendar archive migration.'
          : error.message,
    });
    showToast(archived ? 'Calendar archived' : 'Calendar restored');
  } catch {
    // rollback + toast handled inside withOptimisticUpdate
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

  try {
    await withOptimisticUpdate({
      apply: () => {
        state.events = state.events.map((item) =>
          item.id === eventId ? { ...item, completed: nextCompleted } : item,
        );
      },
      persist: () => setEventCompleted(eventId, nextCompleted),
    });
    markLocalMutation();
  } catch {
    // rollback + toast handled inside withOptimisticUpdate
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

  const moved = {
    ...calendarEvent,
    starts_at: destination.toISOString(),
    ends_at: new Date(destination.getTime() + duration).toISOString(),
  };

  try {
    await withOptimisticUpdate({
      apply: () => {
        state.events = state.events.map((item) => (item.id === eventId ? moved : item));
      },
      persist: () => saveEvent(moved),
      errorMessage: (error) => error.message || 'Event could not be moved.',
    });
    markLocalMutation();
    showToast('Event moved');
  } catch {
    // rollback + toast handled inside withOptimisticUpdate
  }
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

// Build an event-modal draft from a parser result + optional template, layering
// parsed values on top of template defaults. Always returns ISO timestamps so
// the caller can pass the draft straight to openEventModal.
function buildQuickAddDraft(parsed, template, fallbackDate) {
  const baseDate = parsed.date || startOfDay(fallbackDate || new Date());
  const startMinutes = parsed.startMinutes ?? 9 * 60;
  const start = new Date(baseDate);
  start.setHours(0, 0, 0, 0);
  start.setMinutes(startMinutes);

  let endMinutes;
  if (parsed.endMinutes != null) {
    endMinutes = parsed.endMinutes;
  } else if (parsed.durationMinutes != null) {
    endMinutes = startMinutes + parsed.durationMinutes;
  } else if (template?.default_duration_minutes) {
    endMinutes = startMinutes + template.default_duration_minutes;
  } else {
    endMinutes = startMinutes + 60;
  }
  const end = new Date(baseDate);
  end.setHours(0, 0, 0, 0);
  end.setMinutes(endMinutes);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);

  let calendarId = null;
  if (template?.default_calendar_id) {
    const cal = state.calendars.find((c) => c.id === template.default_calendar_id);
    if (cal && !cal.archived_at && canEditCalendar(cal.id)) calendarId = cal.id;
  }

  // Tag default only carries through if it's still valid for the chosen
  // calendar — templates are user-scoped so they can outlive the tag they
  // pointed at.
  let tagId = null;
  if (template?.default_tag) {
    const tag = findTag(template.default_tag);
    if (tag && (!calendarId || tag.calendar_id === calendarId)) tagId = tag.id;
  }

  return {
    title: parsed.title || template?.default_title || '',
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    tag_id: tagId,
    calendar_id: calendarId,
  };
}

function handleQuickAddSubmit(input) {
  const raw = (input.value || '').trim();
  if (!raw) {
    showToast('Type something to quick-add.');
    input.focus();
    return;
  }

  // Match the first whitespace-delimited token against template shortcuts.
  const tokens = raw.split(/\s+/);
  const template = findQuickAddTemplateByShortcut(tokens[0]);
  const remainder = template ? tokens.slice(1).join(' ') : raw;

  // Reference date for "today/tomorrow/weekday" is always real-now; fallback
  // for the "no date parsed" case is the day under view.
  const parsed = parseQuickAddInput(remainder, new Date());
  const hasAnything = template || parsed.ok;

  if (!hasAnything) {
    console.warn('[quick-add] Could not parse input', { raw, parsed, template });
    showToast('Could not understand that quick-add. Try "Title tomorrow 9-17".');
    return;
  }

  const draft = buildQuickAddDraft(parsed, template, state.dayDetailDate || state.selectedDate);
  input.value = '';
  openEventModal(null, new Date(draft.starts_at), draft);
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
      state.quickAddTemplates = [];
      await removeChannel(state.realtimeChannel);
      state.realtimeChannel = null;
      return;
    }

    renderUser();
    const [calendars, tags, templates] = await Promise.all([
      loadCalendarsSafely(),
      loadTagsSafely(),
      loadQuickAddTemplatesSafely(),
    ]);
    state.calendars = calendars;
    state.tags = tags;
    state.quickAddTemplates = templates;
    state.activeCalendarId =
      calendars.find((calendar) => calendar.id === activeCalendarId)?.id ||
      calendars[0]?.id ||
      null;
    syncSelectedTags();
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

// Reminder dedupe set keyed by `${id}|${starts_at}|${reminder_minutes}`. We
// can't put the flag on the event row because state.events is replaced wholesale
// on every refreshEventsAndRender — without this set, every refresh would
// re-arm a fresh setTimeout for every upcoming-reminder event.
const scheduledReminderKeys = new Set();

function reminderKey(event) {
  return `${event.id}|${event.starts_at}|${event.reminder_minutes}`;
}

function scheduleReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  state.events.forEach((event) => {
    if (!event.reminder_minutes) return;
    const key = reminderKey(event);
    if (scheduledReminderKeys.has(key)) return;
    const notifyAt =
      new Date(event.starts_at).getTime() - event.reminder_minutes * 60 * 1000;
    const delay = notifyAt - Date.now();
    if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
      scheduledReminderKeys.add(key);
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
