import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingLocalValue, bookingTimeOptions, calendarDay, calendarDayBounds, calendarHours, calendarLayout, calendarMinutes, formatDateTime, parseBookingInstant, weekDays } from '../src/lib/time';

void test('calendar consistently displays Rome time including DST boundary', () => {
  assert.equal(calendarMinutes('2026-03-29T00:30:00Z'), 90);
  assert.equal(calendarMinutes('2026-03-29T01:30:00Z'), 210);
  assert.equal(calendarDay('2026-11-03T23:30:00Z'), '2026-11-04');
});

void test('booking input requires an explicit offset for an unambiguous instant', () => {
  assert.equal(parseBookingInstant('2026-10-25T02:30+02:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(parseBookingInstant('2026-10-25T02:30+01:00'), '2026-10-25T01:30:00.000Z');
  assert.throws(() => parseBookingInstant('2026-10-25T02:30'), /offset/);
  assert.throws(() => parseBookingInstant('not a date'), /offset/);
  assert.throws(() => parseBookingInstant('2026-02-30T09:00+01:00'), /valid calendar date/);
  assert.throws(() => parseBookingInstant('2025-02-29T09:00+01:00'), /valid calendar date/);
  assert.throws(() => parseBookingInstant('2026-11-03T24:30+01:00'), /valid calendar date/);
  assert.equal(parseBookingInstant('2024-02-29T09:00+01:00'), '2024-02-29T08:00:00.000Z');
  assert.equal(parseBookingInstant('2026-11-03T08:00:00.000Z'), '2026-11-03T08:00:00.000Z');
});

void test('week view begins Monday and crosses month boundaries', () => {
  assert.deepEqual(weekDays('2026-11-01', 'week'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(weekDays('2026-11-03', 'day'), ['2026-11-03']);
});

void test('calendar separates overlapping visits while adjacent visits share a lane', () => {
  const result = calendarLayout([
    { id: 'a', startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z' },
    { id: 'b', startsAt: '2026-11-03T08:30:00Z', endsAt: '2026-11-03T10:00:00Z' },
    { id: 'c', startsAt: '2026-11-03T09:00:00Z', endsAt: '2026-11-03T09:30:00Z' },
    { id: 'd', startsAt: '2026-11-03T10:00:00Z', endsAt: '2026-11-03T11:00:00Z' },
  ], '2026-11-03');
  assert.deepEqual(result.map(({ id, lane, lanes }) => ({ id, lane, lanes })), [
    { id: 'a', lane: 0, lanes: 2 }, { id: 'b', lane: 1, lanes: 2 }, { id: 'c', lane: 0, lanes: 2 }, { id: 'd', lane: 0, lanes: 1 },
  ]);
  assert.equal(result[0]?.start, 540);
});

void test('fall-back visits remain visible when the ending wall time is earlier', () => {
  const result = calendarLayout([{ id: 'fallback', startsAt: '2026-10-25T02:45:00+02:00', endsAt: '2026-10-25T02:30:00+01:00' }], '2026-10-25');
  assert.equal(calendarDayBounds('2026-10-25').minutes, 1500);
  assert.equal(result[0]?.start, 165);
  assert.equal(result[0]?.end, 210);
  assert.ok(calendarHours('2026-10-25').some((tick) => tick.label === '02:00 +02:00'));
  assert.ok(calendarHours('2026-10-25').some((tick) => tick.label === '02:00 +01:00'));
  assert.match(formatDateTime('2026-10-25T02:45:00+02:00'), /UTC\+02:00/);
  assert.match(formatDateTime('2026-10-25T02:30:00+01:00'), /UTC\+01:00/);
});

void test('spring-forward calendar has 23 elapsed hours and no nonexistent 02:00 tick', () => {
  assert.equal(calendarDayBounds('2026-03-29').minutes, 1380);
  assert.equal(calendarHours('2026-03-29').length, 23);
  assert.equal(calendarHours('2026-03-29').some((tick) => tick.label.startsWith('02:00')), false);
});

void test('Rome booking picker resolves normal winter/summer wall times to explicit canonical instants', () => {
  assert.deepEqual(bookingTimeOptions('2026-01-15T09:15'), [{ value: '2026-01-15T08:15:00.000Z', offset: '+01:00' }]);
  assert.deepEqual(bookingTimeOptions('2026-07-15T09:15'), [{ value: '2026-07-15T07:15:00.000Z', offset: '+02:00' }]);
});

void test('Rome booking picker rejects impossible dates and the missing spring hour without silently normalizing', () => {
  for (const value of ['', 'not a date', '2026-02-30T09:00', '2025-02-29T09:00', '2026-11-03T24:00', '2026-03-29T02:30']) {
    assert.deepEqual(bookingTimeOptions(value), [], value);
  }
  assert.deepEqual(bookingTimeOptions('2026-03-29T01:59:59'), [{ value: '2026-03-29T00:59:59.000Z', offset: '+01:00' }]);
  assert.deepEqual(bookingTimeOptions('2026-03-29T03:00'), [{ value: '2026-03-29T01:00:00.000Z', offset: '+02:00' }]);
});

void test('Rome repeated-hour booking requires choosing between two chronologically ordered instants', () => {
  assert.deepEqual(bookingTimeOptions('2026-10-25T02:30'), [
    { value: '2026-10-25T00:30:00.000Z', offset: '+02:00' },
    { value: '2026-10-25T01:30:00.000Z', offset: '+01:00' },
  ]);
});

void test('existing booking instants prefill Rome wall time with seconds and milliseconds intact', () => {
  assert.equal(bookingLocalValue('2026-01-15T08:10:37Z'), '2026-01-15T09:10:37');
  assert.equal(bookingLocalValue('2026-07-15T07:10:37.123Z'), '2026-07-15T09:10:37.123');
  const local = bookingLocalValue('2026-10-25T01:30:45.123Z');
  assert.equal(local, '2026-10-25T02:30:45.123');
  assert.ok(bookingTimeOptions(local).some((option) => option.value === '2026-10-25T01:30:45.123Z' && option.offset === '+01:00'));
});

void test('booking conversion stays in Europe/Rome independently of the computer timezone', { concurrency: false }, () => {
  const original = process.env['TZ'];
  try {
    for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
      process.env['TZ'] = zone;
      assert.deepEqual(bookingTimeOptions('2026-07-15T09:15'), [{ value: '2026-07-15T07:15:00.000Z', offset: '+02:00' }]);
      assert.equal(bookingLocalValue('2026-01-15T08:10:37.123Z'), '2026-01-15T09:10:37.123');
    }
  } finally { if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original; }
});
