import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRouteTimeline, distanceKm, type RouteTimelineInput } from '../src/routing/calculation';
import { RouteDraftInputSchema, RouteTimelineSchema, type RouteTravelEstimate } from '../src/routing/contracts';
import { getLocalDemoRouteEstimates } from '../src/routing/demo-estimates';

const depot = 'depot';
const first = { deliveryId: '91000000-0000-4000-8000-00000000000a', pointId: 'first', workMinutes: 40 };
const second = { deliveryId: '91000000-0000-4000-8000-00000000000b', pointId: 'second', workMinutes: 35 };

function demoEstimate(fromPointId: string, toPointId: string, minutes: number): RouteTravelEstimate {
  return { fromPointId, toPointId, minutes, source: 'demo' };
}

const route: RouteTimelineInput = {
  departAt: '2026-11-06T09:00:00+01:00',
  startPointId: depot,
  endPointId: depot,
  stops: [first, second],
  travelEstimates: [
    demoEstimate(depot, first.pointId, 30), demoEstimate(first.pointId, second.pointId, 20),
    demoEstimate(second.pointId, depot, 25), demoEstimate(depot, second.pointId, 15),
    demoEstimate(second.pointId, first.pointId, 45), demoEstimate(first.pointId, depot, 10),
  ],
};

void test('ETA and depot return follow the directed legs and work durations in the requested order', () => {
  const original = RouteTimelineSchema.parse(calculateRouteTimeline(route));
  assert.deepEqual(original.stops.map(({ eta }) => eta), ['2026-11-06T08:30:00.000Z', '2026-11-06T09:30:00.000Z']);
  assert.equal(original.returnAt, '2026-11-06T10:30:00.000Z');
  assert.equal(original.travelMinutes, 75);
  assert.equal(original.workMinutes, 75);
  assert.equal(original.waitingMinutes, 0);
  assert.equal(original.totalMinutes, 150);
  assert.equal(original.departAt, route.departAt);
  assert.equal(original.stops[0]?.travelStartAt, '2026-11-06T08:00:00.000Z');
  assert.equal(original.stops[1]?.travelStartAt, '2026-11-06T09:10:00.000Z');
  assert.equal(original.stops[1]?.fromPointId, first.pointId);
  assert.equal(original.stops[1]?.workMinutes, 35);
  assert.equal(original.returnDepartAt, '2026-11-06T10:05:00.000Z');

  const reordered = calculateRouteTimeline({ ...route, stops: [second, first] });
  assert.deepEqual(reordered.stops.map(({ deliveryId, eta }) => ({ deliveryId, eta })), [
    { deliveryId: second.deliveryId, eta: '2026-11-06T08:15:00.000Z' },
    { deliveryId: first.deliveryId, eta: '2026-11-06T09:35:00.000Z' },
  ]);
  assert.equal(reordered.returnAt, '2026-11-06T10:25:00.000Z');
  assert.equal(reordered.totalMinutes, 145);

  const longer = calculateRouteTimeline({ ...route, stops: [{ ...first, workMinutes: 60 }, second] });
  assert.equal(longer.stops[1]?.eta, '2026-11-06T09:50:00.000Z');
  assert.equal(longer.returnAt, '2026-11-06T10:50:00.000Z');
});

void test('manual times override a directed leg while unknown legs invalidate later absolute times', () => {
  const timeline = calculateRouteTimeline({
    ...route,
    stops: [second, first],
    travelEstimates: [
      { fromPointId: depot, toPointId: second.pointId, minutes: 18, source: 'manual' },
      ...route.travelEstimates.filter(({ fromPointId, toPointId }) => fromPointId !== second.pointId || toPointId !== first.pointId),
    ],
  });
  assert.equal(timeline.stops[0]?.eta, '2026-11-06T08:18:00.000Z');
  assert.equal(timeline.stops[0]?.travelSource, 'manual');
  assert.equal(timeline.stops[1]?.eta, null);
  assert.equal(timeline.stops[1]?.workEndAt, null);
  assert.equal(timeline.returnTravelMinutes, 10);
  assert.equal(timeline.returnAt, null);
  assert.equal(timeline.travelMinutes, null);
  assert.equal(timeline.waitingMinutes, null);
  assert.equal(timeline.totalMinutes, null);
  assert.equal(timeline.workMinutes, 75);
});

void test('confirmed windows add exact waiting time and flag work that finishes after the window', () => {
  const timeline = calculateRouteTimeline({
    ...route,
    stops: [{ ...first, windowStart: '2026-11-06T08:45:30Z', windowEnd: '2026-11-06T09:25:00Z' }, second],
  });
  assert.equal(timeline.stops[0]?.eta, '2026-11-06T08:30:00.000Z');
  assert.equal(timeline.stops[0]?.workStartAt, '2026-11-06T08:45:30.000Z');
  assert.equal(timeline.stops[0]?.workEndAt, '2026-11-06T09:25:30.000Z');
  assert.equal(timeline.stops[0]?.late, true);
  assert.equal(timeline.stops[1]?.late, null);
  assert.equal(timeline.waitingMinutes, 15.5);
  assert.equal(timeline.returnAt, '2026-11-06T10:45:30.000Z');
  assert.equal(timeline.totalMinutes, 165.5);
  assert.equal(timeline.stops[0]?.windowStatus, 'confirmed');
  assert.equal(timeline.stops[0]?.windowStart, '2026-11-06T08:45:30Z');
  assert.equal(timeline.stops[1]?.windowStatus, 'none');
});

void test('an actual same-point leg is zero and an empty draft has no expected return', () => {
  const samePoint = calculateRouteTimeline({ ...route, stops: [{ ...first, pointId: depot }], travelEstimates: [] });
  assert.equal(samePoint.stops[0]?.travelMinutes, 0);
  assert.equal(samePoint.returnTravelMinutes, 0);
  assert.equal(samePoint.returnAt, '2026-11-06T08:40:00.000Z');

  const empty = calculateRouteTimeline({ ...route, stops: [] });
  assert.deepEqual(empty.stops, []);
  assert.equal(empty.returnAt, null);
  assert.equal(empty.totalMinutes, null);
  assert.equal(empty.returnDepartAt, null);
});

void test('route drafts validate absolute departure, work duration and uniqueness by delivery and direction', () => {
  const outward = { fromPointId: depot, toPointId: first.pointId, minutes: 20 };
  const back = { fromPointId: first.pointId, toPointId: depot, minutes: 10 };
  const draft = {
    name: 'DEMO route', departAt: route.departAt, crewId: null, vehicleId: null, startPointId: depot, endPointId: depot,
    stops: [{ deliveryId: first.deliveryId, workMinutes: first.workMinutes }], manualEstimates: [outward, back],
  };
  assert.equal(RouteDraftInputSchema.safeParse(draft).success, true);
  assert.equal(RouteDraftInputSchema.parse(draft).useLocalEstimates, false);
  assert.equal(RouteDraftInputSchema.safeParse({ ...draft, departAt: '2026-11-06T09:00:00' }).success, false);
  assert.equal(RouteDraftInputSchema.safeParse({ ...draft, stops: [{ deliveryId: first.deliveryId, workMinutes: 1441 }] }).success, false);
  assert.equal(RouteDraftInputSchema.safeParse({
    ...draft, stops: [...draft.stops, { deliveryId: first.deliveryId.toUpperCase(), workMinutes: 15 }],
  }).success, false);
  assert.equal(RouteDraftInputSchema.safeParse({ ...draft, manualEstimates: [outward, outward] }).success, false);
});

void test('local coordinate teaching estimates recalculate new Catania addresses without claiming road times', () => {
  // Orto Botanico, Museo Bellini and Castello Ursino public reference coordinates.
  const points = new Map([
    [depot, { latitude: 37.5154798, longitude: 15.0834923 }],
    [first.pointId, { latitude: 37.5025956, longitude: 15.0843868 }],
    [second.pointId, { latitude: 37.4989686, longitude: 15.084386 }],
  ]);
  const forwardLegs = getLocalDemoRouteEstimates([depot, first.pointId, second.pointId, depot], points);
  assert.deepEqual(forwardLegs.map(({ minutes, source }) => ({ minutes, source })), [
    { minutes: 4, source: 'local_demo' }, { minutes: 2, source: 'local_demo' }, { minutes: 5, source: 'local_demo' },
  ]);
  const forward = calculateRouteTimeline({ ...route, travelEstimates: forwardLegs });
  assert.deepEqual(forward.stops.map(({ eta }) => eta), ['2026-11-06T08:04:00.000Z', '2026-11-06T08:46:00.000Z']);
  assert.equal(forward.returnAt, '2026-11-06T09:26:00.000Z');
  const reverse = calculateRouteTimeline({ ...route, stops: [second, first],
    travelEstimates: getLocalDemoRouteEstimates([depot, second.pointId, first.pointId, depot], points) });
  assert.deepEqual(reverse.stops.map(({ eta }) => eta), ['2026-11-06T08:05:00.000Z', '2026-11-06T08:42:00.000Z']);
  assert.equal(reverse.returnAt, forward.returnAt, 'Symmetric distance around two stops and the same depot has the same total');
  assert.equal(reverse.returnTravelMinutes, 4);
  assert.equal(forward.returnTravelMinutes, 5);

  const incomplete = getLocalDemoRouteEstimates([depot, 'missing', first.pointId], points);
  assert.deepEqual(incomplete, [], 'Missing coordinates must not become zero travel');
  const tooFar = getLocalDemoRouteEstimates(['north', 'south'], new Map([
    ['north', { latitude: 89, longitude: 0 }], ['south', { latitude: -89, longitude: 0 }],
  ]));
  assert.deepEqual(tooFar, [], 'Out-of-range minutes remain unknown instead of being capped');
});

void test('different Picking at one coordinate retain both work durations, and manual zero takes precedence', () => {
  const points = new Map([
    [depot, { latitude: 37.5154798, longitude: 15.0834923 }],
    [first.pointId, { latitude: 37.5025956, longitude: 15.0843868 }],
    [second.pointId, { latitude: 37.5025956, longitude: 15.0843868 }],
  ]);
  const estimates = getLocalDemoRouteEstimates([depot, first.pointId, second.pointId, depot], points);
  const timeline = calculateRouteTimeline({ ...route, travelEstimates: [
    ...estimates, { fromPointId: depot, toPointId: first.pointId, minutes: 0, source: 'manual' },
  ] });
  assert.equal(timeline.stops.length, 2);
  assert.equal(timeline.stops[0]?.eta, '2026-11-06T08:00:00.000Z');
  assert.equal(timeline.stops[0]?.travelSource, 'manual');
  assert.equal(timeline.stops[1]?.travelMinutes, 0);
  assert.equal(timeline.workMinutes, 75);
  assert.equal(timeline.totalMinutes, 79);
});

void test('route instants cross midnight and the Rome autumn offset change without losing elapsed minutes', () => {
  const overnight = calculateRouteTimeline({ ...route, departAt: '2026-11-09T23:30:00+01:00', stops: [first] });
  assert.equal(overnight.stops[0]?.eta, '2026-11-09T23:00:00.000Z');
  assert.equal(overnight.returnDepartAt, '2026-11-09T23:40:00.000Z');
  assert.equal(overnight.returnAt, '2026-11-09T23:50:00.000Z');
  assert.equal(overnight.totalMinutes, 80);
  const clockChange = calculateRouteTimeline({ ...route, departAt: '2026-10-25T01:30:00+02:00', stops: [{ ...first, workMinutes: 90 }] });
  assert.equal(clockChange.returnAt, '2026-10-25T01:40:00.000Z');
  assert.equal(clockChange.totalMinutes, 130);
});

void test('nearby ranking can use straight-line distance without treating it as travel time', () => {
  const origin = { latitude: 0, longitude: 0 };
  assert.equal(distanceKm(origin, origin), 0);
  assert.ok(Math.abs(distanceKm(origin, { latitude: 0, longitude: 1 }) - 111.195) < 0.001);
});
