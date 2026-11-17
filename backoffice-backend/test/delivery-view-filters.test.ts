import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Appointment, Assignment, DeliveryView, Issue } from '../src/domain/model';
import { CrewSchema } from '../src/operations/contracts';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { lifecycleFixture, type LifecycleFixture } from './support/route-lifecycle-fixture';

type CrewFixture = Pick<Awaited<ReturnType<LifecycleFixture['fixture']>>, 'crew' | 'participant' | 'template'>;

function assignment(fixture: CrewFixture, done = false): Assignment {
  const { crew, participant, template } = fixture;
  return {
    id: randomUUID(), crewId: crew.id, crewName: crew.name,
    people: [{ id: participant.id, name: participant.name, external: participant.external }],
    tasks: [{ id: randomUUID(), templateId: template.id, title: 'Check order', severity: 'low', order: 0,
      checklist: [{ id: randomUUID(), label: 'Order checked', done, waiver: null }] }],
  };
}

function visit(status: Appointment['status'], assignments: Assignment[], startsAt = '2031-01-01T20:00:00Z',
  endsAt = '2031-01-01T23:00:00Z'): Appointment {
  return { id: randomUUID(), startsAt, endsAt, status, assignments, results: [], returnRequestId: null, cancellationReason: null };
}

void test('delivery views filter before pagination with Rome dates, visit crews, open issues, and unresolved returns', async () => {
  const app = await lifecycleFixture();
  try {
    const alpha = await app.fixture({ count: 17 });
    const bravo = await app.fixture({ count: 1 });
    const idleCrew = CrewSchema.parse(await app.ok('/crews', { method: 'POST', body: {
      name: 'DEMO Unassigned', classification: 'outdoor', area: 'Milano', enabled: true, participantIds: [],
    } }));
    const alphaId = alpha.crew.id;
    const bravoId = bravo.crew.id;
    const [first] = alpha.deliveries;
    const [eleventh, twelfth, planned, active, partial, completed, followUp] = alpha.deliveries.slice(10);
    const [inboxOnly] = bravo.deliveries;
    assert.ok(first && eleventh && twelfth && planned && active && partial && completed && followUp && inboxOnly);
    const list = async (view: DeliveryView, filters: Record<string, string> = {}) =>
      DeliveryListSchema.parse(await app.ok(`/deliveries?${new URLSearchParams({ view, ...filters })}`));
    Object.assign(inboxOnly.source.customer, { city: 'Milano', province: 'MI', postalCode: '20121' });
    await app.database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [inboxOnly.id, JSON.stringify(inboxOnly)]);

    const emptyAssigned = await list('assigned', { province: 'mi' });
    assert.equal(emptyAssigned.counts.assigned, 0);
    assert.deepEqual(emptyAssigned.items, []);
    assert.deepEqual(emptyAssigned.geographyFacets.cities, [{ value: 'Catania', count: 0 }, { value: 'Milano', count: 0 }]);
    assert.ok(emptyAssigned.geographyFacets.provinces.some(({ value, count }) => value === 'MI' && count === 0));
    assert.deepEqual(emptyAssigned.geographyFacets.postalCodes, [{ value: '20121', count: 0 }]);
    assert.deepEqual(emptyAssigned.matchingGeographyFacets, {
      cities: [{ value: 'Milano', count: 1 }], provinces: [{ value: 'MI', count: 1 }], postalCodes: [{ value: '20121', count: 1 }],
    });
    assert.deepEqual(emptyAssigned.filterFacets.crews, [alpha.crew, bravo.crew, idleCrew].map(({ id, name }) => ({ id, name, count: 0 })));

    for (const delivery of alpha.deliveries) Object.assign(delivery.source.customer, { province: 'CT', postalCode: '95125' });
    for (const delivery of alpha.deliveries.slice(0, 11)) delivery.appointments.push(visit('booked', [assignment(alpha)]));
    first.appointments.push(visit('booked', [assignment(bravo)], '2031-01-02T10:00:00Z', '2031-01-02T11:00:00Z'));
    first.appointments.push(visit('booked', [assignment(alpha)], '2031-01-01T16:00:00Z', '2031-01-01T17:00:00Z'));
    twelfth.appointments.push(visit('booked', [assignment(bravo)]));
    twelfth.source.customer.city = 'Messina';
    twelfth.source.customer.province = 'ME';
    twelfth.source.customer.postalCode = '98121';
    planned.appointments.push(visit('booked', []));
    active.appointments.push(visit('booked', [assignment(alpha)]), visit('in_progress', [assignment(bravo)]));
    const prior = visit('completed', [assignment(alpha, true)]);
    partial.appointments.push(prior);
    const historicalCrew = { ...assignment(bravo, true), crewId: randomUUID(), crewName: 'DEMO Historical' };
    completed.appointments.push(visit('completed', [assignment(alpha, true), historicalCrew]), visit('cancelled', [assignment(bravo)]));
    completed.completedAt = '2031-01-02T23:30:00Z';

    const openIssue = (type: Issue['type']): Issue => ({
      id: randomUUID(), type, description: 'Demo issue', itemIds: [], photoIds: [], notes: null, status: 'open',
      createdAt: prior.startsAt, authorId: alpha.participant.id, authorName: alpha.participant.name, source: 'operator',
      resolution: null, resolvedAt: null, resolvedBy: null,
    });
    partial.issues.push(openIssue('damage'), openIssue('damage'), {
      ...openIssue('access'), status: 'resolved', resolution: 'Access confirmed', resolvedAt: prior.endsAt, resolvedBy: alpha.participant.id,
    });
    followUp.issues.push(openIssue('missing_parts'));
    partial.returnRequests.push({
      id: randomUUID(), originAppointmentId: prior.id, reason: 'Replace damaged piece', remainingWork: 'One piece',
      notes: null, photoIds: [], issueIds: [], status: 'requested', appointmentId: null,
      createdAt: prior.endsAt, resolvedAt: null, resolution: null,
    });
    const original = partial.returnRequests[0];
    assert.ok(original);
    const failed = visit('failed', [assignment(bravo)]);
    const next = visit('booked', []);
    followUp.appointments.push(failed, next);
    followUp.returnRequests.push({ ...original, id: randomUUID(), originAppointmentId: failed.id, status: 'planned', appointmentId: next.id });
    partial.returnRequests.push({ ...original, id: randomUUID(), status: 'resolved', resolvedAt: prior.endsAt, resolution: 'Resolved' });
    for (const delivery of alpha.deliveries) {
      await app.database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [delivery.id, JSON.stringify(delivery)]);
    }

    const calendarDay = { dateFrom: '2031-01-01', dateTo: '2031-01-01' };
    const assigned = await list('assigned', { ...calendarDay, crewId: alphaId, page: '2' });
    assert.equal(assigned.total, 11);
    assert.deepEqual(assigned.items.map(({ id }) => id), [eleventh.id]);
    assert.equal(assigned.counts.assigned, 12);
    assert.deepEqual(assigned.filterFacets.crews, [
      { id: alphaId, name: alpha.crew.name, count: 11 }, { id: bravoId, name: bravo.crew.name, count: 1 },
      { id: idleCrew.id, name: idleCrew.name, count: 0 },
    ]);
    assert.deepEqual(assigned.geographyFacets.cities, [
      { value: 'Catania', count: 11 }, { value: 'Messina', count: 0 }, { value: 'Milano', count: 0 },
    ]);
    assert.deepEqual((await list('assigned', { city: 'CATANIA' })).geographyFacets.provinces, [{ value: 'CT', count: 11 }]);
    const secondDay = { dateFrom: '2031-01-02', dateTo: '2031-01-02' };
    assert.equal((await list('assigned', { ...secondDay, crewId: alphaId })).total, 0,
      'A separate visit cannot supply the crew for the visit matching the date');
    assert.deepEqual((await list('assigned', { ...secondDay, crewId: bravoId })).items.map(({ id }) => id), [first.id]);

    const extraOrder = first.source.salesOrders?.[1];
    assert.ok(extraOrder);
    assert.deepEqual((await list('assigned', { search: extraOrder.name.toLowerCase(), city: 'catania' })).items.map(({ id }) => id), [first.id]);
    const city = await list('assigned', { city: 'messina', province: 'me' });
    assert.deepEqual(city.items.map(({ id }) => id), [twelfth.id]);
    assert.deepEqual(city.filterFacets.crews, [
      { id: alphaId, name: alpha.crew.name, count: 0 }, { id: bravoId, name: bravo.crew.name, count: 1 },
      { id: idleCrew.id, name: idleCrew.name, count: 0 },
    ]);

    const plannedResult = await list('planned', { search: planned.source.pickingName, ...calendarDay });
    assert.deepEqual(plannedResult.items.map(({ id }) => id), [planned.id]);
    assert.deepEqual(plannedResult.filterFacets.crews, []);
    assert.equal((await list('in_progress', { crewId: alphaId })).total, 0);
    assert.deepEqual((await list('in_progress', { crewId: bravoId })).items.map(({ id }) => id), [active.id]);
    assert.deepEqual((await list('partially_completed', { crewId: alphaId, ...calendarDay })).items.map(({ id }) => id), [partial.id]);
    const issues = await list('issues', { issueType: 'damage' });
    assert.deepEqual(issues.items.map(({ id }) => id), [partial.id]);
    assert.deepEqual(issues.filterFacets.issueTypes, [{ value: 'damage', count: 1 }, { value: 'missing_parts', count: 1 }]);
    assert.equal((await list('issues', { issueType: 'access' })).total, 0);
    const returns = await list('return_required', { returnStatus: 'planned' });
    assert.deepEqual(returns.items.map(({ id }) => id), [followUp.id]);
    assert.deepEqual(returns.filterFacets.returnStatuses, [{ value: 'requested', count: 1 }, { value: 'planned', count: 1 }]);
    assert.equal((await list('completed', { ...calendarDay, crewId: alphaId })).total, 0);
    const closed = await list('completed', { dateFrom: '2031-01-03', dateTo: '2031-01-03' });
    assert.deepEqual(closed.items.map(({ id }) => id), [completed.id]);
    assert.deepEqual(closed.filterFacets.crews, [
      { id: historicalCrew.crewId, name: historicalCrew.crewName, count: 1 },
      { id: alphaId, name: alpha.crew.name, count: 1 }, { id: bravoId, name: bravo.crew.name, count: 0 },
      { id: idleCrew.id, name: idleCrew.name, count: 0 },
    ]);

    for (const query of ['view=assigned&dateFrom=2031-02-29', 'view=assigned&dateFrom=2031-01-02&dateTo=2031-01-01',
      'view=issues&issueType=resolved', 'view=assigned&issueType=damage', 'view=return_required&returnStatus=resolved',
      'view=assigned&crewId=unknown', 'view=inbox&dateTo=2031-01-01']) {
      assert.equal((await app.request('/deliveries?' + query)).status, 400, query);
    }
    assert.equal((await app.request('/deliveries?view=assigned', { cookie: '' })).status, 401);
  } finally { await app.close(); }
});
