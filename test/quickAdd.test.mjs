// Quick Add parser tests. Pure-logic, no DOM, no Supabase.
// Reference date is fixed so weekday/today/tomorrow are deterministic.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  parseDurationToken,
  parseQuickAddInput,
  parseTimeToken,
} from '../js/quickAdd.js';

// Friday, 1 May 2026, 12:00 local. Picked so weekday math wraps cleanly:
//   today=Friday → "friday" must mean +7 (the *next* Friday).
const REF = new Date(2026, 4, 1, 12, 0, 0, 0);

const minutesOf = (h, m = 0) => h * 60 + m;

test('parseTimeToken — bare hours, am/pm, and HH:MM', () => {
  assert.equal(parseTimeToken('9').minutes, minutesOf(9));
  assert.equal(parseTimeToken('14:00').minutes, minutesOf(14));
  assert.equal(parseTimeToken('9am').minutes, minutesOf(9));
  assert.equal(parseTimeToken('1pm').minutes, minutesOf(13));
  assert.equal(parseTimeToken('12am').minutes, minutesOf(0));
  assert.equal(parseTimeToken('12pm').minutes, minutesOf(12));
});

test('parseTimeToken — invalid inputs return null', () => {
  assert.equal(parseTimeToken(''), null);
  assert.equal(parseTimeToken('25'), null);
  assert.equal(parseTimeToken('9:99'), null);
  assert.equal(parseTimeToken('13pm'), null);
  assert.equal(parseTimeToken('not-a-time'), null);
});

test('parseDurationToken — h, m, and combined', () => {
  assert.equal(parseDurationToken('1h'), 60);
  assert.equal(parseDurationToken('30m'), 30);
  assert.equal(parseDurationToken('2h30m'), 150);
  assert.equal(parseDurationToken(''), null);
  assert.equal(parseDurationToken('h'), null);
  assert.equal(parseDurationToken('abc'), null);
});

test('original spec example: "Work tomorrow 9-17"', () => {
  const r = parseQuickAddInput('Work tomorrow 9-17', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Work');
  assert.equal(r.date.getDate(), 2); // 2026-05-02 (Saturday)
  assert.equal(r.startMinutes, minutesOf(9));
  assert.equal(r.endMinutes, minutesOf(17));
  assert.equal(r.durationMinutes, null);
});

test('original spec example: "Dentist Friday 14:00"', () => {
  const r = parseQuickAddInput('Dentist Friday 14:00', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Dentist');
  // Friday is today; "Friday" must roll forward 7 days.
  assert.equal(r.date.getDate(), 8);
  assert.equal(r.startMinutes, minutesOf(14));
  assert.equal(r.endMinutes, null);
});

test('original spec example: "Gym today 18:30"', () => {
  const r = parseQuickAddInput('Gym today 18:30', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Gym');
  assert.equal(r.date.getDate(), 1);
  assert.equal(r.startMinutes, minutesOf(18, 30));
});

test('original spec example: "Meeting Monday 10-11"', () => {
  const r = parseQuickAddInput('Meeting Monday 10-11', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Meeting');
  // Friday → next Monday is +3.
  assert.equal(r.date.getDate(), 4);
  assert.equal(r.startMinutes, minutesOf(10));
  assert.equal(r.endMinutes, minutesOf(11));
});

test('"H to H" style range', () => {
  const r = parseQuickAddInput('Standup 9 to 10', REF);
  assert.equal(r.startMinutes, minutesOf(9));
  assert.equal(r.endMinutes, minutesOf(10));
  assert.equal(r.title, 'Standup');
});

test('"for Xh" duration', () => {
  const r = parseQuickAddInput('Standup tomorrow 9 for 30m', REF);
  assert.equal(r.startMinutes, minutesOf(9));
  assert.equal(r.endMinutes, null);
  assert.equal(r.durationMinutes, 30);
});

test('ISO date token', () => {
  const r = parseQuickAddInput('Trip 2026-12-01', REF);
  assert.equal(r.ok, true);
  assert.equal(r.date.getFullYear(), 2026);
  assert.equal(r.date.getMonth(), 11);
  assert.equal(r.date.getDate(), 1);
  assert.equal(r.title, 'Trip');
});

test('partial: title only', () => {
  const r = parseQuickAddInput('Lunch with Anna', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Lunch with Anna');
  assert.equal(r.date, null);
  assert.equal(r.startMinutes, null);
  assert.equal(r.endMinutes, null);
});

test('partial: date only', () => {
  const r = parseQuickAddInput('tomorrow', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, '');
  assert.notEqual(r.date, null);
});

test('partial: time only', () => {
  const r = parseQuickAddInput('14:00', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, '');
  assert.equal(r.startMinutes, minutesOf(14));
});

test('empty / whitespace returns ok:false', () => {
  assert.equal(parseQuickAddInput('', REF).ok, false);
  assert.equal(parseQuickAddInput('   ', REF).ok, false);
});

test('truly unparseable still returns the title; ok stays true if anything matched', () => {
  // The parser is permissive — if a title remains it counts as a hit.
  // This documents the intentional design: only fully empty input is "ok:false".
  const r = parseQuickAddInput('???xyz???', REF);
  assert.equal(r.ok, true);
  assert.equal(r.title, '???xyz???');
  assert.equal(r.date, null);
  assert.equal(r.startMinutes, null);
});

test('weekday name when today is the same weekday rolls forward 7 days', () => {
  // REF is a Friday; "friday" must mean 8 days from now, not zero.
  const r = parseQuickAddInput('Standup friday', REF);
  assert.equal(r.date.getDate(), 8);
});

test('weekday name picks the soonest matching day', () => {
  const r = parseQuickAddInput('Plan monday', REF);
  // Friday → Monday is +3.
  assert.equal(r.date.getDate(), 4);
});

test('range parsing wins over single-time parsing on the same token', () => {
  const r = parseQuickAddInput('Sprint 9-17', REF);
  assert.equal(r.startMinutes, minutesOf(9));
  assert.equal(r.endMinutes, minutesOf(17));
});

test('first-token title plus parsed date — no template merge here', () => {
  // This documents the parser's behavior in isolation. Template merging
  // (parsed values overriding template defaults) is buildQuickAddDraft's
  // job and is exercised separately in the build-draft tests.
  const r = parseQuickAddInput('coffee tomorrow 9', REF);
  assert.equal(r.title, 'coffee');
  assert.equal(r.date.getDate(), 2);
  assert.equal(r.startMinutes, minutesOf(9));
});
