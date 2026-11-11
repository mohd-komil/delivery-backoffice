import assert from 'node:assert/strict';
import test from 'node:test';
import { groupVisits } from '../src/_pages/visits/model/schedule';
import type { VisitSummary } from '../src/shared/api/contracts';
import { formatVisitWindow, visitStatus } from '../src/shared/lib/visit-display';

function visit(pickingName: string, startsAt: string, endsAt: string): VisitSummary {
  return {
    id: 'a0000000-0000-4000-8000-000000000001', pickingName, startsAt, endsAt,
    status: 'booked', confirmationStatus: 'awaiting_customer_confirmation',
    destination: { address: null, city: null, country: null }, crews: [], vehicles: [],
  };
}

void test('crew schedule uses Rome day boundaries and treats the visit end as exclusive', () => {
  const now = '2026-11-05T23:05:00Z';
  const endingAtMidnight = visit('ends at midnight', '2026-11-05T21:00:00Z', '2026-11-05T23:00:00Z');
  const overnight = visit('overlaps today', '2026-11-05T22:30:00Z', '2026-11-05T23:30:00Z');
  const laterToday = visit('later today', '2026-11-06T11:00:00Z', '2026-11-06T12:00:00Z');
  const tomorrow = visit('next day', '2026-11-06T23:05:00Z', '2026-11-07T00:00:00Z');

  assert.deepEqual(groupVisits([tomorrow, laterToday, overnight, endingAtMidnight], now), {
    today: [overnight, laterToday], upcoming: [tomorrow], past: [endingAtMidnight],
  });
});

void test('completed and failed visits move to past even when scheduled for today or later', () => {
  const today = visit('active today', '2026-11-06T11:00:00Z', '2026-11-06T12:00:00Z');
  const upcoming = visit('active tomorrow', '2026-11-07T11:00:00Z', '2026-11-07T12:00:00Z');
  const completedToday: VisitSummary = { ...today, pickingName: 'completed today', status: 'completed' };
  const completedUpcoming: VisitSummary = { ...upcoming, pickingName: 'completed early', status: 'completed' };
  const failedToday: VisitSummary = { ...today, startsAt: '2026-11-06T10:30:00Z', pickingName: 'customer absent', status: 'failed' };

  assert.deepEqual(groupVisits([today, completedUpcoming, failedToday, upcoming, completedToday], '2026-11-06T09:00:00Z'), {
    today: [today], upcoming: [upcoming], past: [completedUpcoming, completedToday, failedToday],
  });
  assert.equal(visitStatus(failedToday).label, 'attemptFailureTitle');
});

void test('a repeated Rome clock hour displays both offsets and customer confirmation remains distinct from progress', () => {
  const fallback = visit('DST visit', '2026-10-25T00:15:00Z', '2026-10-25T01:15:00Z');
  const display = formatVisitWindow(fallback, 'en');
  assert.match(display, /02:15 GMT\+2.*02:15 GMT\+1/u);
  assert.equal(visitStatus(fallback).label, 'awaiting');
  const confirmed: VisitSummary = { ...fallback, confirmationStatus: 'customer_confirmed' };
  assert.equal(visitStatus(confirmed).label, 'confirmed');
  assert.equal(visitStatus({ ...confirmed, status: 'in_progress' }).label, 'inProgress');
});
