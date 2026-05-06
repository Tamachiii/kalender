# iOS PWA wake — bugs and fixes

Self-contained report on the iOS PWA suspend/resume bug class and the
three commits that fix it. Useful for anyone working on a fork that
branched before the fixes landed (or for feeding to an AI assistant as
an apply-this prompt).

## Summary

When the Kalender PWA is backgrounded on iOS (home button, app switcher,
lock screen) and then resumed, the Supabase client gets into a stuck
state and the UI partially freezes. Three layered fixes are needed; the
third addresses the root cause and the first two are defense in depth so
future suspend patterns don't reintroduce the freeze.

Commits on `main` that implement these fixes, in order:

- `5d4858d` — synchronous render in `refreshEventsAndRender`
- `5fb7fe1` — 10 s timeout wrapper for writes
- `18d2355` — pause auth refresh + tear down realtime on suspend

## Symptoms

After backgrounding the PWA on iOS and returning:

1. **Tapping the Month / Week / Day tabs in the topbar appears to do
   nothing.** The button highlights briefly, the active class doesn't
   move, and the grid keeps showing the previous view. Same for the
   prev/next arrows.
2. **Bottom tabs (Calendar / Tasks / Settings) still work.** So does
   scrolling. Anything that doesn't touch Supabase responds normally.
3. **Creating or editing an event freezes the modal.** Tap Save → Save
   and Cancel both go disabled (`aria-busy="true"`) → nothing else
   happens. The optimistic event is in `state.events` (visible on the
   grid) but the network insert never resolves.

The bug does not reproduce on desktop browsers. Android Chrome is much
less affected. The trigger is iOS Safari/WebKit aggressively suspending
the JS engine when a PWA goes to the home screen.

## Root cause

When iOS suspends the PWA two things go wrong, both invisible to the
Supabase client:

- The auth auto-refresh timer is frozen mid-flight. On resume the
  client has a refresh promise that never resolves, and it serializes
  every other auth-touching call behind it. Reads and writes hang for
  an indefinite time after wake.
- The realtime websocket is silently killed by iOS without firing a
  close event. The Supabase realtime client thinks it's still connected
  and the next `channel.subscribe()` attaches to a zombie socket. iOS
  Safari has a small per-origin connection limit; a zombie socket can
  hold a slot subsequent fetches need.

## Fix 1 — Synchronous render in `refreshEventsAndRender`

**Why.** View tabs and prev/next call `refreshEventsAndRender`, which
`await`s `fetchEvents` *before* `renderAll`. If the network is slow or
wedged the user sees the tab highlight but no view change.

**File:** [js/app.js](js/app.js), function `refreshEventsAndRender`.
Move `renderAll()` to the top, before the await:

```js
async function refreshEventsAndRender() {
  const requestId = ++refreshRequestId;
  const [rangeStart, rangeEnd] = eventRangeForView();
  const calendarIds = state.calendars
    .filter((calendar) => !calendar.archived_at || state.showArchivedCalendars)
    .map((calendar) => calendar.id);

  // Render synchronously first with the events we already have so that
  // view-tab switches and prev/next arrows update the UI immediately. If
  // we awaited fetchEvents before rendering, a slow or hung network
  // (notably right after iOS PWA wake) would leave the user staring at
  // the previous view with no feedback. The refetched events overwrite
  // state.events and re-render once they arrive.
  renderAll();

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
```

The existing `refreshRequestId` race protection still works.

## Fix 2 — Timeout wrapper for writes

**Why.** `handleEventSubmit` calls `setFormBusy(true)` and then
`await saveEvent(payload)`. If the Supabase call hangs the modal is
dead forever. Same shape for `deleteEvent` and `setEventCompleted`.

**File:** [js/api.js](js/api.js). Add a private `withTimeout` helper
near the top, after `onAuthStateChange`:

```js
// Race a Supabase call against a timeout so the UI never locks behind a
// promise that never resolves. The wrapped promise still runs to
// completion in the background — the caller just stops waiting. Used for
// user-visible writes; without this, a stuck Supabase client (e.g. after
// an iOS PWA wake or a corrupted refresh-token chain) freezes the modal
// indefinitely with the form in aria-busy. The thrown message is surfaced
// in the toast so the user knows to retry or sign out and back in.
const SUPABASE_OP_TIMEOUT_MS = 10000;

async function withTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out — check your connection, or sign out and back in to clear a stale session.`,
          ),
        ),
      SUPABASE_OP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

Wrap the three write paths:

```js
// saveEvent — both branches
if (event.id) {
  const { data, error } = await withTimeout(
    supabase.from('events').update(payload).eq('id', event.id).select().single(),
    'Save',
  );
  if (error) throw error;
  return data;
}
const { data, error } = await withTimeout(
  supabase.from('events').insert(payload).select().single(),
  'Save',
);

// deleteEvent
const { error } = await withTimeout(
  supabase.from('events').delete().eq('id', id),
  'Delete',
);

// setEventCompleted
const { data, error } = await withTimeout(
  supabase.from('events').update({ completed }).eq('id', id).select().single(),
  'Update',
);
```

The existing `try/finally` in `handleEventSubmit` rolls back the
optimistic insert and clears `setFormBusy` once the timeout error is
thrown, so the modal recovers cleanly.

## Fix 3 — Pause auth refresh and tear down realtime on suspend (the actual fix)

**File:** [js/api.js](js/api.js). Three new exports — they wrap the
official Supabase mobile lifecycle APIs:

```js
// Pause/resume Supabase's auto-refresh loop around mobile background.
// iOS suspends the JS engine when the PWA goes to the home screen, which
// freezes the auto-refresh timer mid-flight; on resume the client can
// end up with a refresh promise that never resolves, queuing every read
// and write behind it. Stopping the loop on hidden and starting it on
// visible cleans up that timer state.
export function pauseAutoRefresh() {
  try {
    supabase.auth.stopAutoRefresh();
  } catch (error) {
    console.warn('[auth] stopAutoRefresh threw', error);
  }
}

export function resumeAutoRefresh() {
  try {
    supabase.auth.startAutoRefresh();
  } catch (error) {
    console.warn('[auth] startAutoRefresh threw', error);
  }
}

// Force-close the realtime websocket. iOS silently kills the socket in
// the background and the Supabase client doesn't notice; the next channel
// subscription is then attached to a zombie connection that never fires
// events and may be holding an iOS connection slot.
export function resetRealtime() {
  try {
    supabase.realtime.disconnect();
  } catch (error) {
    console.warn('[realtime] disconnect threw', error);
  }
}
```

**File:** [js/app.js](js/app.js). Add the three names to the existing
import from `./api.js`, then update `bindLifecycleEvents`:

```js
function bindLifecycleEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      recoverAfterResume();
    } else {
      // Proactively shut things down before iOS suspends the JS engine.
      // Stopping auto-refresh prevents the in-flight refresh promise from
      // being frozen mid-flight, and tearing down the realtime channel
      // means we don't come back to a zombie websocket that the Supabase
      // client thinks is still connected. Both are rebuilt by
      // recoverAfterResume() on the next visible event.
      pauseAutoRefresh();
      if (state.realtimeChannel) {
        removeChannel(state.realtimeChannel);
        state.realtimeChannel = null;
      }
    }
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
```

Add the cleanup at the start of `recoverAfterResume`'s `try` block,
**before** `await getSession()`:

```js
try {
  // Force-close any leftover realtime websocket from before the
  // suspend, then restart the auth auto-refresh loop. Without this,
  // iOS PWA wake leaves the Supabase client with a stuck refresh
  // promise (every subsequent read/write queues behind it) and a
  // dead websocket that holds an iOS connection slot. Both are
  // rebuilt below; this is the cleanup pass that makes that safe.
  resetRealtime();
  resumeAutoRefresh();

  const session = await getSession();
  // ...rest unchanged
```

## What NOT to do

A natural-looking fix is to call `supabase.auth.refreshSession()` inside
`recoverAfterResume` to "unstick" the client, optionally racing it
against a timeout. **This is strictly worse.** When the local refresh
token is in the corrupted state we're trying to recover from,
`refreshSession()` itself hangs. Even with a `Promise.race` timeout the
*inner* Supabase promise keeps running and holds an internal mutex — so
reads, writes, and even subsequent `getSession()` calls all queue
behind it. The user goes from "writes hang" to "the entire client
deadlocks on every resume." Don't go there.

The official lifecycle hooks (`stopAutoRefresh` / `startAutoRefresh`,
`realtime.disconnect`) avoid this trap because they don't trigger a
refresh — they just put the client into a clean paused state.

## Verification

In the dev preview (`node server.mjs`, then mobile viewport), simulating
the visibility hidden → visible cycle:

- Before fix: a write probe (`supabase.from('events').select('id').limit(1)`)
  hangs past 5 s on a fresh page load.
- After fix: same probe completes in ~60 ms after the simulated resume.
  `state.realtimeChannel` is `null` while hidden and re-instantiated on
  visible. Tab switches and prev/next render the new view immediately
  even if the network call hasn't returned yet.
- All 55 unit tests in `test/` still pass: `node --test test/`.

Users who already have the corrupted refresh-token state in their
localStorage from before the fix need to sign out from the Settings tab
and sign back in once. That writes a fresh token. New users won't hit
that state because the lifecycle cleanup prevents it from accruing.
