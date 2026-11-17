import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { CalendarCreateSchema, CalendarDetailSchema, CalendarListSchema, type CalendarEntry } from '../src/planning/calendar-contracts';
import { resolveRouteCalendar } from '../src/planning/calendar';
import { RouteDraftInputSchema } from '../src/routing/contracts';
import { RouteDetailSchema, RoutePreviewSchema, RouteSuggestionSchema } from '../src/routing/http-contracts';
import { RouteAmendReviewSchema, RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { PublicationReviewSchema } from '../src/routing/publication-contracts';
import { lifecycleFixture, type LifecycleFixture } from './support/route-lifecycle-fixture';

function change(entry: CalendarEntry, overrides: Partial<Pick<CalendarEntry, 'startsAt' | 'endsAt' | 'archived' | 'note'>> = {}) {
  return { requestId: randomUUID(), version: entry.version, personId: entry.personId, kind: entry.kind,
    startsAt: entry.startsAt, endsAt: entry.endsAt, timeZone: entry.timeZone,
    sourceReference: entry.sourceReference, note: entry.note, archived: entry.archived, reason: 'DEMO verified roster adjustment', ...overrides };
}
async function shift(h: LifecycleFixture, personId: string, startsAt: string, endsAt: string, kind: 'shift' | 'break' | 'absence' = 'shift') {
  return CalendarDetailSchema.parse(await h.ok('/planning/calendar', { method: 'POST', body: {
    requestId: randomUUID(), personId, kind, startsAt, endsAt, timeZone: 'Europe/Rome',
    sourceReference: 'DEMO Francesca roster', note: 'Private scheduling note', reason: 'DEMO confirmed availability',
  } })).entry;
}
async function setUpShifts(h: LifecycleFixture, f: Awaited<ReturnType<LifecycleFixture['fixture']>>) {
  assert.ok(f.draft.planning);
  f.draft.planning.availabilityMode = 'shared_calendar';
  const startsAt = new Date(Date.parse(f.draft.departAt) - 2 * 60 * 60_000).toISOString();
  const endsAt = new Date(Date.parse(f.draft.departAt) + 8 * 60 * 60_000).toISOString();
  return Promise.all([f.participant.id, f.colleague.id].map((id) => shift(h, id, startsAt, endsAt)));
}

void test('calendar explicit instants preserve overnight and repeated DST hours, and manual mode remains unchanged', () => {
  const personId = randomUUID();
  const data = { requestId: randomUUID(), personId, kind: 'shift', startsAt: '2026-10-25T01:30:00+02:00', endsAt: '2026-10-25T03:30:00+01:00',
    timeZone: 'Europe/Rome', sourceReference: 'Verified roster', note: '', reason: 'Correct autumn shift' };
  const parsed = CalendarCreateSchema.parse(data);
  assert.equal(Date.parse(parsed.endsAt) - Date.parse(parsed.startsAt), 3 * 60 * 60_000);
  assert.equal(CalendarCreateSchema.safeParse({ ...data, startsAt: '2026-10-25T01:30:00' }).success, false);
  assert.equal(CalendarCreateSchema.safeParse({ ...data, endsAt: data.startsAt }).success, false);
  const manual = RouteDraftInputSchema.parse({ name: 'Manual preserved', departAt: data.startsAt, crewId: null, vehicleId: null,
    startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', stops: [], manualEstimates: [] });
  assert.equal(resolveRouteCalendar(manual, { departAt: data.startsAt, returnAt: data.endsAt }, []).input, manual);
});

void test('shared participant calendar uses normal auth, versioned actor-bound receipts and immutable archive history', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1 });
    const requestId = randomUUID();
    const command = { requestId, personId: f.participant.id, kind: 'shift', startsAt: '2026-11-13T22:00:00+01:00', endsAt: '2026-11-14T06:00:00+01:00',
      timeZone: 'Europe/Rome', sourceReference: 'DEMO roster signed by Francesca', note: '', reason: 'DEMO initial night shift' };
    assert.equal((await h.request('/planning/calendar', { method: 'POST', body: command, cookie: '' })).status, 401);
    assert.equal((await h.request('/planning/calendar', { method: 'POST', body: command, origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await h.request('/planning/calendar', { method: 'POST', body: command, cookie: f.cookie })).status, 401);
    assert.equal((await h.request('/planning/calendar', { method: 'POST', body: { ...command, sourceReference: '' } })).status, 400);
    const first = CalendarDetailSchema.parse(await h.ok('/planning/calendar', { method: 'POST', body: command }));
    assert.equal(first.entry.id, requestId);
    assert.equal(first.entry.startsAt, '2026-11-13T21:00:00.000Z');
    assert.deepEqual(await h.ok('/planning/calendar', { method: 'POST', body: command }), first);
    assert.equal((await h.request('/planning/calendar', { method: 'POST', body: command, cookie: h.adminCookie })).status, 409);
    const archive = change(first.entry, { archived: true });
    const archived = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${requestId}`, { method: 'PATCH', body: archive }));
    assert.deepEqual(archived.history[1], first.history[0]);
    assert.equal(archived.history[0]?.action, 'archived');
    assert.deepEqual(await h.ok(`/planning/calendar/${requestId}`, { method: 'PATCH', body: archive }), archived);
    assert.equal((await h.request(`/planning/calendar/${requestId}`, { method: 'PATCH', body: { ...archive, requestId: randomUUID() } })).status, 409);
    assert.equal((await h.request(`/planning/calendar/${requestId}`, { method: 'PATCH', body: { ...change(archived.entry), personId: f.colleague.id } })).status, 400);
    const query = new URLSearchParams({ startsAt: '2026-11-13T00:00:00Z', endsAt: '2026-11-15T00:00:00Z', personId: f.participant.id });
    assert.equal(CalendarListSchema.parse(await h.ok(`/planning/calendar?${query}`)).entries.length, 0);
    query.set('status', 'archived');
    assert.equal(CalendarListSchema.parse(await h.ok(`/planning/calendar?${query}`)).entries.length, 1);
    const restored = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${requestId}`, { method: 'PATCH', body: change(archived.entry, { archived: false }) }));
    assert.equal(restored.entry.version, 3); assert.equal(restored.history[0]?.action, 'restored');
    assert.deepEqual(restored.history[2], first.history[0]);
    query.set('personId', f.colleague.id); query.set('status', 'all');
    assert.equal(CalendarListSchema.parse(await h.ok(`/planning/calendar?${query}`)).entries.length, 0);
    const table = z.array(z.object({ count: z.string() })).parse(await h.database.source.query('SELECT count(*)::text AS count FROM planning_calendar_event WHERE entry_id=$1', [requestId]));
    assert.equal(table[0]?.count, '3');
  } finally { await h.close(); }
});

void test('shared calendar evaluates return coverage, adjacent shifts, breaks and relevant revision fingerprints', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1, departAt: '2026-11-16T08:00:00+01:00' });
    assert.ok(f.draft.planning); f.draft.planning.availabilityMode = 'shared_calendar';
    const missing = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.equal(missing.feasibility.findings.filter(({ code }) => code === 'working_hours_unknown').length, 2,
      'Shared mode ignores manually supplied availability instead of inventing a shift');
    const endOfWork = missing.timeline.stops[0]?.workEndAt; const returnAt = missing.timeline.returnAt;
    assert.ok(endOfWork && returnAt && returnAt > endOfWork);
    const first = await shift(h, f.participant.id, '2026-11-16T06:00:00Z', endOfWork);
    await shift(h, f.colleague.id, '2026-11-16T06:00:00Z', '2026-11-16T18:00:00Z');
    const outside = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.ok(outside.feasibility.findings.some(({ code, resourceId }) => code === 'outside_working_hours' && resourceId === `person:${f.participant.id}`));
    await shift(h, f.participant.id, endOfWork, '2026-11-16T18:00:00Z');
    const ready = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.equal(ready.feasibility.findings.some(({ code }) => code === 'outside_working_hours'), false, 'Adjacent shifts cover the trip continuously');
    assert.equal(ready.calendar?.entries.length, 3);
    assert.equal(JSON.stringify(ready.calendar).includes('Private scheduling note'), false);
    assert.equal(JSON.stringify(ready.calendar).includes('sourceReference'), false);
    const same = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.equal(same.feasibility.fingerprint, ready.feasibility.fingerprint, 'Query time does not stale the review');
    await shift(h, f.participant.id, '2026-11-20T06:00:00Z', '2026-11-20T18:00:00Z');
    const unrelated = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.equal(unrelated.feasibility.fingerprint, ready.feasibility.fingerprint, 'Another day is not a current dependency');
    const paused = await shift(h, f.participant.id, endOfWork, returnAt, 'break');
    const broken = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.ok(broken.feasibility.findings.some(({ code }) => code === 'participant_break'));
    await h.ok(`/planning/calendar/${paused.id}`, { method: 'PATCH', body: change(paused, { archived: true }) });
    const restored = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.equal(restored.feasibility.fingerprint, ready.feasibility.fingerprint, 'Archiving unrelated facts restores the same effective entry set');
    const updated = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${first.id}`, { method: 'PATCH', body: change(first, { note: 'Francesca rechecked this shift' }) }));
    assert.equal(updated.entry.version, 2);
    const changed = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
    assert.notEqual(changed.feasibility.fingerprint, ready.feasibility.fingerprint);
    const suggested = RouteSuggestionSchema.parse(await h.ok('/routes/suggest-order', { method: 'POST', body: { ...f.draft, objective: 'travel_minutes' } }));
    assert.deepEqual(suggested.current.calendar, changed.calendar, 'Suggested-order assessment uses fresh shared entries too');
  } finally { await h.close(); }
});

void test('shared calendar changes invalidate publication review and require amendment before departure but never block started reporting or return', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1 }); const shifts = await setUpShifts(h, f); const first = shifts[0]; assert.ok(first);
    const saved = RouteDetailSchema.parse(await h.ok('/routes', { method: 'POST', body: { ...f.draft, requestId: randomUUID() } }));
    const selection = { version: saved.version, stops: f.deliveries.map(({ id }) => ({ mode: 'create', deliveryId: id,
      responsibleParticipantId: f.participant.id, workLines: f.workLines, templateIds: [f.template.id] })) };
    const old = PublicationReviewSchema.parse(await h.ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: selection }));
    const updated = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${first.id}`, { method: 'PATCH', body: change(first, { note: 'Updated roster evidence' }) }));
    assert.equal((await h.request(`/routes/${saved.id}/publish`, { method: 'POST', body: { ...selection, requestId: randomUUID(), fingerprint: old.fingerprint, acknowledgeEstimates: true } })).status, 409);
    const fresh = PublicationReviewSchema.parse(await h.ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: selection }));
    await h.ok(`/routes/${saved.id}/publish`, { method: 'POST', body: { ...selection, requestId: randomUUID(), fingerprint: fresh.fingerprint, acknowledgeEstimates: true } });
    let state = RouteOperationsSchema.parse(await h.ok(`/routes/${saved.id}/operations`));
    const stop = state.stops[0]; assert.ok(stop); await h.confirm(stop.deliveryId, stop.appointmentId);
    const originalRevision = await h.ok(`/routes/${saved.id}/revisions/1`);
    const shortened = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${first.id}`, { method: 'PATCH', body: change(updated.entry, {
      endsAt: new Date(Date.parse(f.draft.departAt) + 1_000).toISOString(),
    }) }));
    state = RouteOperationsSchema.parse(await h.ok(`/routes/${saved.id}/operations`));
    assert.equal(state.capabilities.canDepart, false); assert.equal(state.capabilities.departBlockerCode, 'ROUTE_CALENDAR_REVIEW_REQUIRED');
    assert.equal((await h.request(`/crew/routes/${saved.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: state.version, requestId: randomUUID() } })).status, 409);
    const restored = CalendarDetailSchema.parse(await h.ok(`/planning/calendar/${first.id}`, { method: 'PATCH', body: change(shortened.entry, { endsAt: first.endsAt }) }));
    const amend = { version: state.version, reason: 'DEMO roster rechecked', confirmNotDeparted: true, confirmNotLoaded: true, plan: state.draft,
      responsibleParticipants: [{ appointmentId: stop.appointmentId, participantId: f.participant.id }] };
    const reviewed = RouteAmendReviewSchema.parse(await h.ok(`/routes/${saved.id}/amend-review`, { method: 'POST', body: amend }));
    state = RouteOperationsSchema.parse(await h.ok(`/routes/${saved.id}/amend`, { method: 'POST', body: { ...amend, requestId: randomUUID(), fingerprint: reviewed.fingerprint, acknowledgeEstimates: true } }));
    assert.deepEqual(await h.ok(`/routes/${saved.id}/revisions/1`), originalRevision, 'Frozen publication is never rewritten from current roster');
    await h.confirm(stop.deliveryId, stop.appointmentId);
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${saved.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: state.version, requestId: randomUUID() } }));
    assert.equal(state.status, 'in_progress');
    await h.ok(`/planning/calendar/${first.id}`, { method: 'PATCH', body: change(restored.entry, { archived: true }) });
    await h.start(stop.appointmentId, f.cookie);
    await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 32, deliveredMilli: 1000, installedMilli: 0 }]);
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${saved.id}`, { cookie: f.cookie }));
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${saved.id}/returning`, { method: 'POST', cookie: f.cookie, body: { version: state.version, requestId: randomUUID() } }));
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${saved.id}/return`, { method: 'POST', cookie: f.cookie, body: {
      version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'DEMO actual return despite later roster edit',
    } }));
    assert.equal(state.status, 'returned');
    assert.deepEqual(await h.ok(`/routes/${saved.id}/revisions/1`), originalRevision);
  } finally { await h.close(); }
});
