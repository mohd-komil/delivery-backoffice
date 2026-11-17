import assert from 'node:assert/strict';
import { createElement } from 'react';
import test from 'node:test';
import { crewRouteSchema, routeReturnSchema, type CrewRoute } from '../src/shared/api/route-contracts';
import { groupRoutes } from '../src/_pages/routes/model/schedule';
import { prepareRouteCommand } from '../src/_pages/route-detail/model/command';
import { RouteContent } from '../src/_pages/route-detail/ui/route-detail-screen';
import { RouteStopCard } from '../src/_pages/route-detail/ui/route-stop';
import { RouteActionPanel } from '../src/_pages/route-detail/ui/route-actions';
import { RouteStatus } from '../src/shared/ui/route-status';
import { routeMessages } from '../src/shared/i18n/route-messages';
import { renderLocalized } from './render-localized';

const routeId = '10000000-0000-4000-8000-000000000001';
const crewId = '10000000-0000-4000-8000-000000000002';
const personId = '10000000-0000-4000-8000-000000000003';
const vehicleId = '10000000-0000-4000-8000-000000000004';
const appointmentId = '10000000-0000-4000-8000-000000000005';
const deliveryId = '10000000-0000-4000-8000-000000000006';
const person = { id: personId, name: 'DEMO Matteo' };
const actions = { busy: null, run: () => Promise.resolve(true) };

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
  assert.match(html, /Unloading entrance/);
  assert.doesNotMatch(html, /Powered by Geoapify/);
});

void test('the next stop appears once above compact lists with Rome ETA and status labels', () => {
  const route = fixture();
  const planned = route.stops[0];
  assert.ok(planned);
  const next = { ...planned, sequence: 2, confirmationStatus: 'customer_confirmed' as const };
  const upcoming = {
    ...planned, deliveryId: '10000000-0000-4000-8000-000000000007', appointmentId: '10000000-0000-4000-8000-000000000008',
    sequence: 3, pickingName: 'DEMO/OUT/02', address: 'Via Etnea', eta: '2026-11-11T09:15:00Z', customerWindow: null,
  };
  const skipped = {
    ...planned, deliveryId: '10000000-0000-4000-8000-000000000009', appointmentId: '10000000-0000-4000-8000-000000000010',
    sequence: 4, pickingName: 'DEMO/OUT/04', address: 'Via Crociferi', eta: null, customerWindow: null,
    status: 'cancelled' as const, skipped: true,
  };
  const past = {
    ...planned, deliveryId: '10000000-0000-4000-8000-000000000011', appointmentId: '10000000-0000-4000-8000-000000000012',
    sequence: 1, pickingName: 'DEMO/OUT/00', address: 'Via Vittorio Emanuele', eta: '2026-11-11T08:00:00Z',
    status: 'completed' as const, confirmationStatus: 'customer_confirmed' as const, reported: true,
  };
  const live: CrewRoute = { ...route, status: 'in_progress', stops: [past, next, upcoming, skipped] };
  const html = renderLocalized(createElement(RouteContent, { route: live, actions }));
  const highlight = html.match(/<article\b[^>]*aria-label="Next stop"[^>]*>[\s\S]*?<\/article>/)?.[0];
  assert.ok(highlight);
  assert.match(highlight, /Piazza Duomo, Catania/);
  assert.match(highlight, /09:30/);
  assert.match(highlight, /Customer confirmed/);
  assert.equal(html.split(`href="/visits/${next.appointmentId}"`).length - 1, 1);

  const summaries = html.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/g) ?? [];
  const upcomingRow = summaries.find((summary) => summary.includes(upcoming.pickingName));
  const skippedRow = summaries.find((summary) => summary.includes(skipped.pickingName));
  const pastRow = summaries.find((summary) => summary.includes(past.pickingName));
  assert.ok(upcomingRow);
  assert.match(upcomingRow, /Via Etnea/);
  assert.match(upcomingRow, /10:15/);
  assert.match(upcomingRow, /Awaiting customer confirmation/);
  assert.ok(skippedRow);
  assert.ok(skippedRow.includes(routeMessages.en.unknown));
  assert.ok(skippedRow.includes(routeMessages.en.skipped));
  assert.ok(pastRow);
  assert.match(pastRow, /09:00/);
  assert.match(pastRow, /Completed/);
  assert.ok(!summaries.some((summary) => summary.includes(next.pickingName)));
});

void test('geocoded route references retain attribution and never claim a confirmed unloading entrance in any locale', () => {
  const original = fixture();
  const geocoding = { provider: 'geoapify', precision: 'building', confidence: 1,
    attribution: 'Synthetic datasource <img src=x onerror=alert(1)>', acceptance: 'automatic' };
  const route = crewRouteSchema.parse({ ...original, stops: original.stops.map((stop) => ({ ...stop, geocoding })) });
  const stop = route.stops[0]; assert.ok(stop);
  assert.deepEqual(stop.geocoding, geocoding);
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(RouteStopCard, { stop, route, next: true }), locale);
    assert.ok(html.includes(routeMessages[locale].addressPoint));
    assert.ok(html.includes(routeMessages[locale].addressPointHint));
    assert.ok(!html.includes(`${routeMessages[locale].entrance} ·`));
    assert.match(html, /href="https:\/\/www\.geoapify\.com\/"/);
    assert.match(html, /href="https:\/\/www\.openstreetmap\.org\/copyright"/);
    assert.match(html, /Synthetic datasource &lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /query=37.5021%2C15.0872/);
  }
  for (const invalid of [{ ...geocoding, confidence: 2 }, { ...geocoding, precision: 'exact_entrance' }, { ...geocoding, attribution: 'x'.repeat(2049) }]) {
    assert.equal(crewRouteSchema.safeParse({ ...original, stops: original.stops.map((entry) => ({ ...entry, geocoding: invalid })) }).success, false);
  }
});

void test('the route action dock follows lifecycle and server capabilities', () => {
  const route = fixture();
  const renderActions = (current: CrewRoute) => renderLocalized(createElement(RouteActionPanel, { route: current, actions }));
  const departure = renderActions(route);
  assert.match(departure, /data-route-action-bar/);
  assert.match(departure, /next customer has not confirmed/);
  assert.match(departure, /disabled=""/);

  const readyToDepart = renderActions({ ...route, capabilities: {
    ...route.capabilities, canDepart: true, departBlocker: null, departBlockerCode: null,
  } });
  assert.match(readyToDepart, /data-route-action-bar/);
  assert.ok(readyToDepart.includes(routeMessages.en.depart));
  assert.doesNotMatch(readyToDepart, /disabled=""/);

  const inProgress: CrewRoute = { ...route, status: 'in_progress', capabilities: {
    ...route.capabilities, canMarkReturned: true, returnBlocker: 'Some stops require reports', returnBlockerCode: 'ROUTE_UNFINISHED_STOPS',
  } };
  const blockedReturn = renderActions(inProgress);
  assert.match(blockedReturn, /data-route-action-bar/);
  assert.match(blockedReturn, /Some stops still need a report/);
  assert.match(blockedReturn, /disabled=""/);
  assert.ok(blockedReturn.includes(routeMessages.en.recordReturn), 'Actual return remains available when a planned report is missing');

  const returning = renderActions({ ...inProgress, status: 'returning', capabilities: {
    ...inProgress.capabilities, returnBlocker: null, returnBlockerCode: null,
  } });
  assert.match(returning, /data-route-action-bar/);
  assert.match(returning, /aria-haspopup="dialog"/);
  assert.ok(returning.includes(routeMessages.en.recordReturn));
  assert.ok(!returning.includes(routeMessages.en.beginReturn));

  const otherParticipant = renderActions({ ...inProgress, status: 'returning', capabilities: {
    ...inProgress.capabilities, canMarkReturned: false, returnBlockerCode: 'ROUTE_RESPONSIBLE_REQUIRED',
  } });
  assert.match(otherParticipant, /data-route-action-bar/);
  assert.match(otherParticipant, /disabled=""/);
  assert.match(otherParticipant, /or assigned driver/);

  const returned = renderActions({ ...route, status: 'returned' });
  assert.doesNotMatch(returned, /data-route-action-bar|<button\b/);
  assert.ok(returned.includes(routeMessages.en.warehouseSeparate));
  assert.equal(renderActions({ ...route, status: 'closed' }), '');
  assert.equal(renderActions({ ...route, status: 'cancelled' }), '');
});

void test('route lifecycle states and action panels render in all four languages', () => {
  const route = fixture();
  const expected = { en: 'Ready for departure', it: 'Pronto alla partenza', ru: 'Ожидает выезда', uz: 'Chiqishni kutmoqda' };
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(RouteStatus, { status: 'published' }), locale);
    assert.ok(html.includes(expected[locale]));
    const actionHtml = renderLocalized(createElement(RouteActionPanel, { route, actions }), locale);
    assert.doesNotMatch(actionHtml, /MISSING_MESSAGE|undefined/);
  }
});

void test('driverless routes identify the responsible participant while retaining legacy assigned-driver guidance', () => {
  const original = fixture();
  const legacy = { ...original, capabilities: { ...original.capabilities, departBlockerCode: 'ROUTE_RESPONSIBLE_REQUIRED' } };
  const route = crewRouteSchema.parse({ ...legacy, resources: { ...legacy.resources, driver: { kind: 'none' } } });
  const html = renderLocalized(createElement(RouteActionPanel, { route, actions }));
  assert.match(html, /The route’s responsible participant records this action/);
  assert.doesNotMatch(html, /assigned driver/);
  assert.match(renderLocalized(createElement(RouteActionPanel, { route: legacy, actions })), /or assigned driver/);
});
