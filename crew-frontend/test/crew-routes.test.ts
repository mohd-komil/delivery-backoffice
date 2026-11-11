import assert from 'node:assert/strict';
import { createElement } from 'react';
import test from 'node:test';
import { crewRouteSchema, routeReturnSchema, type CrewRoute } from '../src/shared/api/route-contracts';
import { groupRoutes } from '../src/_pages/routes/model/schedule';
import { prepareRouteCommand } from '../src/_pages/route-detail/model/command';
import { RouteStopCard } from '../src/_pages/route-detail/ui/route-stop';
import { RouteActionPanel } from '../src/_pages/route-detail/ui/route-actions';
import { RouteStatus } from '../src/shared/ui/route-status';
import { renderLocalized } from './render-localized';

const routeId = '10000000-0000-4000-8000-000000000001';
const crewId = '10000000-0000-4000-8000-000000000002';
const personId = '10000000-0000-4000-8000-000000000003';
const vehicleId = '10000000-0000-4000-8000-000000000004';
const appointmentId = '10000000-0000-4000-8000-000000000005';
const deliveryId = '10000000-0000-4000-8000-000000000006';
const person = { id: personId, name: 'DEMO Matteo' };

function fixture(): CrewRoute {
  return {
    id: routeId, version: 1, status: 'published', name: 'DEMO Catania trip',
    draft: { departAt: '2026-11-11T08:00:00Z', startPointId: 'warehouse', endPointId: 'warehouse',
      stops: [{ deliveryId, workMinutes: 30 }], planning: { transferBufferMinutes: 10 } },
    review: { timeline: { departAt: '2026-11-11T08:00:00Z', returnAt: '2026-11-11T10:00:00Z', returnTravelMinutes: 25 } },
    runtime: { departed: null, returning: null, returned: null, aborted: null, cancelled: null, closed: null, skipped: [] },
    resources: { crew: { id: crewId, name: 'DEMO Crew' }, vehicle: { id: vehicleId, name: 'DEMO Van', plate: 'DEMO 1' },
      driver: { kind: 'participant', person }, participants: [person], start: { id: 'warehouse', name: 'DEMO warehouse' }, end: { id: 'warehouse', name: 'DEMO warehouse' } },
    routeResponsible: person, nextAppointmentId: appointmentId,
    stops: [{ deliveryId, appointmentId, sequence: 1, source: 'created', pickingName: 'DEMO/OUT/01', customerName: 'DEMO customer',
      address: 'Piazza Duomo', city: 'Catania', entrance: { latitude: 37.5021, longitude: 15.0872, addressKey: 'demo-destination' },
      customerWindow: { kind: 'work_end', startsAt: '2026-11-11T08:30:00Z', endsAt: '2026-11-11T10:00:00Z' },
      eta: '2026-11-11T08:30:00Z', workStartAt: '2026-11-11T08:30:00Z', workEndAt: '2026-11-11T09:00:00Z',
      status: 'booked', confirmationStatus: 'awaiting_customer_confirmation', responsibleParticipant: person,
      canStart: false, startBlocker: 'Record departure first', startBlockerCode: 'ROUTE_DEPARTURE_REQUIRED', skipped: false, reported: false }],
    lines: [11, 12].map((sourceLineId, index) => ({ deliveryId, appointmentId, sourceLineId, orderName: index ? 'Order B' : 'Order A', productName: 'Identical chair', uom: 'unit',
      plannedDeliveryMilli: index ? 500 : 1000, plannedInstallationMilli: 0, plannedCollectionMilli: 0,
      deliveredMilli: 0, installedMilli: 0, collectedMilli: 0, remainingDeliveryMilli: 2000, remainingInstallationMilli: 0, remainingCollectionMilli: 0,
      reportMissing: false, incompleteWork: [] })),
    capabilities: { canDepart: false, canReturn: false, canMarkReturned: false, departBlocker: 'The next customer must confirm before departure', returnBlocker: null,
      departBlockerCode: 'CUSTOMER_CONFIRMATION_REQUIRED', returnBlockerCode: null },
  };
}

void test('Crew route contract validates capabilities and keeps identical SKU lines separate', () => {
  const route = crewRouteSchema.parse(fixture());
  assert.deepEqual(route.lines.map((line) => [line.sourceLineId, line.orderName, line.plannedDeliveryMilli]), [[11, 'Order A', 1000], [12, 'Order B', 500]]);
  assert.equal(crewRouteSchema.safeParse({ ...route, capabilities: { ...route.capabilities, canDepart: 'true' } }).success, false);
  assert.equal(crewRouteSchema.safeParse({ ...route, version: -1 }).success, false);
});

void test('route grouping keeps overdue active travel visible and finished future routes out of Upcoming', () => {
  const route = fixture();
  const future: CrewRoute = { ...route, id: vehicleId, draft: { ...route.draft, departAt: '2026-11-12T08:00:00Z' } };
  const returning: CrewRoute = { ...route, id: personId, status: 'returning', draft: { ...route.draft, departAt: '2026-11-09T08:00:00Z' } };
  const returned: CrewRoute = { ...future, id: crewId, status: 'returned' };
  const cancelled: CrewRoute = { ...future, id: appointmentId, status: 'cancelled' };
  const input = [returned, future, route, returning, cancelled];
  const grouped = groupRoutes(input, '2026-11-11T09:00:00Z');
  assert.deepEqual(grouped.active.map(({ id }) => id), [personId, routeId]);
  assert.deepEqual(grouped.upcoming.map(({ id }) => id), [vehicleId]);
  assert.deepEqual(grouped.history.map(({ id }) => id), [crewId, appointmentId]);
  assert.deepEqual(input.map(({ id }) => id), [crewId, vehicleId, routeId, personId, appointmentId]);
});

void test('uncertain return retry keeps its original ID and actual timestamp, while changed input gets a new command', () => {
  let calls = 0;
  const createId = () => { calls += 1; return calls === 1 ? routeId : personId; };
  const first = prepareRouteCommand(null, 'return', 4, '  Delayed report  ', createId, () => '2026-11-11T12:00:00Z');
  const retry = prepareRouteCommand(first, 'return', 4, 'Delayed report', createId, () => '2026-11-11T12:05:00Z');
  assert.equal(retry, first);
  assert.deepEqual(routeReturnSchema.parse(retry.command), { requestId: routeId, version: 4, actualReturnedAt: '2026-11-11T12:00:00Z', note: 'Delayed report' });
  assert.equal(calls, 1);
  const changed = prepareRouteCommand(first, 'return', 5, 'Delayed report', createId, () => '2026-11-11T12:05:00Z');
  assert.equal(changed.command.requestId, personId);
  assert.equal(changed.command.version, 5);
  assert.equal(calls, 2);
});

void test('stop card shows exact orders, work-end window and saved unloading entrance without merging work', () => {
  const route = fixture();
  const stop = route.stops[0];
  assert.ok(stop);
  const html = renderLocalized(createElement(RouteStopCard, { stop, route, next: true }));
  assert.match(html, /Order A/);
  assert.match(html, /Order B/);
  assert.match(html, /1 unit/);
  assert.match(html, /0.5 unit/);
  assert.match(html, /Work completed/);
  assert.match(html, /query=37.5021%2C15.0872/);
  assert.match(html, new RegExp(`/visits/${appointmentId}`));
  assert.match(html, /Record departure/);
});

void test('departure is disabled by server capability and return stays distinct from missing reports and warehouse receipt', () => {
  const route = fixture();
  const actions = { busy: null, run: () => Promise.resolve(true) };
  const departure = renderLocalized(createElement(RouteActionPanel, { route, actions }));
  assert.match(departure, /next customer has not confirmed/);
  assert.match(departure, /disabled=""/);
  const returningRoute: CrewRoute = { ...route, status: 'in_progress', capabilities: {
    ...route.capabilities, canMarkReturned: true, returnBlocker: 'Some stops require reports', returnBlockerCode: 'ROUTE_UNFINISHED_STOPS',
  } };
  const html = renderLocalized(createElement(RouteActionPanel, { route: returningRoute, actions }));
  assert.match(html, /Some stops still need a report/);
  assert.match(html, /We have returned/);
  assert.match(html, /does not confirm that goods have been received at the warehouse/);
  assert.match(html, /type="checkbox"/);
});

void test('route lifecycle states and action panels render in all four languages', () => {
  const route = fixture();
  const expected = { en: 'Ready for departure', it: 'Pronto alla partenza', ru: 'Ожидает выезда', uz: 'Chiqishni kutmoqda' };
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(RouteStatus, { status: 'published' }), locale);
    assert.ok(html.includes(expected[locale]));
    const actionHtml = renderLocalized(createElement(RouteActionPanel, { route, actions: { busy: null, run: () => Promise.resolve(true) } }), locale);
    assert.doesNotMatch(actionHtml, /MISSING_MESSAGE|undefined/);
  }
});
