import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarPeriodDays, calendarPeriodLabel, calendarPeriodRange, selectCalendarMonth, shiftCalendarAnchor } from '../src/lib/calendar-period';

void test('month periods contain complete Monday–Sunday weeks including real leap days and adjacent-month days', () => {
  const fourWeeks = calendarPeriodDays('2021-02-15', 'month');
  assert.equal(fourWeeks.length, 28);
  assert.equal(fourWeeks[0], '2021-02-01');
  assert.equal(fourWeeks.at(-1), '2021-02-28');
  const leapFebruary = calendarPeriodDays('2024-02-29', 'month');
  assert.equal(leapFebruary.length, 35);
  assert.equal(leapFebruary[0], '2024-01-29');
  assert.equal(leapFebruary.at(-1), '2024-03-03');
  assert.equal(leapFebruary.filter((day) => day.startsWith('2024-02-')).length, 29);
  const ordinaryFebruary = calendarPeriodDays('2026-02-28', 'month');
  assert.equal(ordinaryFebruary.filter((day) => day.startsWith('2026-02-')).length, 28);
  assert.equal(ordinaryFebruary.includes('2026-02-29'), false);
  const sixWeeks = calendarPeriodDays('2026-08-31', 'month');
  assert.equal(sixWeeks.length, 42);
  assert.deepEqual([sixWeeks[0], sixWeeks[6], sixWeeks[7], sixWeeks.at(-1)], ['2026-07-27', '2026-08-02', '2026-08-03', '2026-09-06']);
  for (const days of [fourWeeks, leapFebruary, ordinaryFebruary, sixWeeks]) {
    assert.equal(new Set(days).size, days.length);
    for (let index = 0; index < days.length; index += 1) {
      const day = days[index]; assert.ok(day);
      assert.equal(new Date(`${day}T12:00:00Z`).getUTCDay(), (index + 1) % 7);
      if (index > 0) {
        const previous = days[index - 1]; assert.ok(previous);
        assert.equal(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`), 86_400_000);
      }
    }
  }
});

void test('month navigation clamps the current day rather than overflowing into March and handles year boundaries', () => {
  assert.equal(shiftCalendarAnchor('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(shiftCalendarAnchor('2026-02-28', 'month', -1), '2026-01-28');
  assert.equal(shiftCalendarAnchor('2024-01-31', 'month', 1), '2024-02-29');
  assert.equal(shiftCalendarAnchor('2024-02-29', 'month', -1), '2024-01-29');
  assert.equal(shiftCalendarAnchor('2026-03-31', 'month', -1), '2026-02-28');
  assert.equal(shiftCalendarAnchor('2026-12-31', 'month', 1), '2027-01-31');
  assert.equal(shiftCalendarAnchor('2026-01-31', 'month', -1), '2025-12-31');
  assert.equal(selectCalendarMonth('2026-01-31', '2026-03'), '2026-03-31', 'Choosing March directly must not pass through a clamped February');
  assert.equal(selectCalendarMonth('2024-01-31', '2024-02'), '2024-02-29');
  assert.equal(selectCalendarMonth('2026-01-31', '2026-02'), '2026-02-28');
  assert.equal(calendarPeriodLabel('2024-02-29', 'month'), 'February 2024');
  assert.equal(calendarPeriodLabel('2026-11-30', 'month'), 'November 2026');
});

void test('day and week navigation keep their actual daily and weekly spans at month/year boundaries', () => {
  assert.equal(shiftCalendarAnchor('2026-12-31', 'day', 1), '2027-01-01');
  assert.equal(shiftCalendarAnchor('2026-01-01', 'day', -1), '2025-12-31');
  assert.equal(shiftCalendarAnchor('2026-12-29', 'week', 1), '2027-01-05');
  assert.equal(shiftCalendarAnchor('2026-01-02', 'week', -1), '2025-12-26');
  assert.deepEqual(calendarPeriodDays('2026-11-01', 'day'), ['2026-11-01']);
  assert.deepEqual(calendarPeriodDays('2026-11-01', 'week'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
});

void test('a 42-cell autumn month requests exact Rome boundaries including the extra DST hour', () => {
  const days = calendarPeriodDays('2023-10-15', 'month');
  assert.equal(days.length, 42);
  const range = calendarPeriodRange(days);
  assert.deepEqual(range, { from: '2023-09-24T22:00:00.000Z', to: '2023-11-05T23:00:00.000Z' });
  assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000, 42 * 24 + 1);
});

void test('a 42-cell spring month ends at the exclusive Rome midnight after its last adjacent day', () => {
  const days = calendarPeriodDays('2026-03-15', 'month');
  assert.equal(days.length, 42);
  const range = calendarPeriodRange(days);
  assert.deepEqual(range, { from: '2026-02-22T23:00:00.000Z', to: '2026-04-05T22:00:00.000Z' });
  assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000, 42 * 24 - 1);
  assert.deepEqual(calendarPeriodRange(['2026-10-25']), { from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' });
});
