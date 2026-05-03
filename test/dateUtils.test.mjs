import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  addDays,
  addMonths,
  dateKey,
  endOfDay,
  eventOccursOn,
  fromLocalInputValue,
  minutesSinceStartOfDay,
  sameDay,
  startOfDay,
  startOfMonthGrid,
  startOfWeek,
  toLocalInputValue,
} from '../js/dateUtils.js';

const REF = new Date(2026, 4, 1, 12, 30, 45, 123); // Fri 1 May 2026 12:30:45.123

test('startOfDay zeroes time', () => {
  const r = startOfDay(REF);
  assert.equal(r.getHours(), 0);
  assert.equal(r.getMinutes(), 0);
  assert.equal(r.getMilliseconds(), 0);
  assert.equal(r.getDate(), 1);
});

test('endOfDay maxes time', () => {
  const r = endOfDay(REF);
  assert.equal(r.getHours(), 23);
  assert.equal(r.getMinutes(), 59);
  assert.equal(r.getSeconds(), 59);
});

test('addDays handles month rollover', () => {
  const r = addDays(REF, 31);
  assert.equal(r.getMonth(), 5); // June
  assert.equal(r.getDate(), 1);
});

test('addDays handles negative offsets', () => {
  const r = addDays(REF, -1);
  assert.equal(r.getMonth(), 3); // April
  assert.equal(r.getDate(), 30);
});

test('addMonths preserves day if possible', () => {
  const r = addMonths(REF, 1);
  assert.equal(r.getMonth(), 5);
  assert.equal(r.getDate(), 1);
});

test('startOfWeek anchors on Monday', () => {
  // REF is Friday → Monday is 4 days back.
  const r = startOfWeek(REF);
  assert.equal(r.getDay(), 1);
  assert.equal(r.getDate(), 27); // 27 April Monday
});

test('startOfWeek for a Sunday rolls back six days', () => {
  const sunday = new Date(2026, 4, 3, 9, 0, 0); // Sun 3 May
  const r = startOfWeek(sunday);
  assert.equal(r.getDay(), 1);
  assert.equal(r.getDate(), 27);
});

test('startOfMonthGrid returns the Monday on or before the 1st of the month', () => {
  const r = startOfMonthGrid(REF); // May 2026 → grid begins Mon 27 Apr
  assert.equal(r.getDay(), 1);
  assert.equal(r.getDate(), 27);
  assert.equal(r.getMonth(), 3);
});

test('sameDay ignores time-of-day', () => {
  const a = new Date(2026, 4, 1, 0, 0, 0);
  const b = new Date(2026, 4, 1, 23, 59, 59);
  const c = new Date(2026, 4, 2, 0, 0, 0);
  assert.equal(sameDay(a, b), true);
  assert.equal(sameDay(a, c), false);
});

test('toLocalInputValue / fromLocalInputValue roundtrip', () => {
  const v = toLocalInputValue(REF);
  assert.match(v, /^2026-05-01T12:30$/);
  const back = fromLocalInputValue(v);
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 4);
  assert.equal(back.getDate(), 1);
  assert.equal(back.getHours(), 12);
  assert.equal(back.getMinutes(), 30);
});

test('dateKey is YYYY-MM-DD in local time', () => {
  assert.equal(dateKey(REF), '2026-05-01');
  assert.equal(dateKey(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(dateKey(new Date(2026, 11, 31)), '2026-12-31');
});

test('eventOccursOn — single-day event', () => {
  const event = {
    starts_at: new Date(2026, 4, 1, 9, 0).toISOString(),
    ends_at: new Date(2026, 4, 1, 17, 0).toISOString(),
  };
  assert.equal(eventOccursOn(event, new Date(2026, 4, 1)), true);
  assert.equal(eventOccursOn(event, new Date(2026, 4, 2)), false);
  assert.equal(eventOccursOn(event, new Date(2026, 3, 30)), false);
});

test('eventOccursOn — multi-day event spans every day in range', () => {
  const event = {
    starts_at: new Date(2026, 4, 1, 9, 0).toISOString(),
    ends_at: new Date(2026, 4, 3, 17, 0).toISOString(),
  };
  assert.equal(eventOccursOn(event, new Date(2026, 4, 1)), true);
  assert.equal(eventOccursOn(event, new Date(2026, 4, 2)), true);
  assert.equal(eventOccursOn(event, new Date(2026, 4, 3)), true);
  assert.equal(eventOccursOn(event, new Date(2026, 4, 4)), false);
});

test('minutesSinceStartOfDay', () => {
  assert.equal(minutesSinceStartOfDay(new Date(2026, 4, 1, 0, 0)), 0);
  assert.equal(minutesSinceStartOfDay(new Date(2026, 4, 1, 9, 30)), 570);
  assert.equal(minutesSinceStartOfDay(new Date(2026, 4, 1, 23, 59)), 23 * 60 + 59);
});
