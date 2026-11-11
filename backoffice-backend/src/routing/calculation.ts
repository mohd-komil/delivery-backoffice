import { directedRoutePair, type RoutePointCoordinates, type RouteTimeline, type RouteTravelEstimate } from './contracts';

const millisecondsPerMinute = 60_000;
const earthRadiusKm = 6_371.0088;

export function distanceKm(from: RoutePointCoordinates, to: RoutePointCoordinates) {
  const radians = Math.PI / 180;
  const latitudeDelta = (to.latitude - from.latitude) * radians;
  const longitudeDelta = (to.longitude - from.longitude) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export type RouteTimelineInput = {
  departAt: string;
  startPointId: string;
  endPointId: string;
  stops: readonly {
    deliveryId: string;
    pointId: string;
    workMinutes: number | null;
    windowKind?: 'unknown' | 'unrestricted' | 'arrival' | 'work_end';
    windowStatus?: 'none' | 'confirmed' | 'ambiguous';
    windowStart?: string | null;
    windowEnd?: string | null;
  }[];
  travelEstimates: readonly RouteTravelEstimate[];
};

type LegEstimate = { minutes: number | null; source: RouteTravelEstimate['source'] | null };

function estimateByDirection(estimates: readonly RouteTravelEstimate[]) {
  const byDirection = new Map<string, RouteTravelEstimate>();
  for (const estimate of estimates) {
    const key = directedRoutePair(estimate.fromPointId, estimate.toPointId);
    if (estimate.source === 'manual' || !byDirection.has(key)) byDirection.set(key, estimate);
  }
  return (fromPointId: string, toPointId: string): LegEstimate => {
    if (fromPointId === toPointId) return { minutes: 0, source: null };
    const estimate = byDirection.get(directedRoutePair(fromPointId, toPointId));
    return estimate ?? { minutes: null, source: null };
  };
}

function addMinutes(instant: number | null, minutes: number | null) {
  return instant === null || minutes === null ? null : instant + minutes * millisecondsPerMinute;
}

function toInstant(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function sumMinutes(values: readonly (number | null)[]) {
  return values.reduce<number | null>((total, minutes) => total === null || minutes === null ? null : total + minutes, 0);
}

export function calculateRouteTimeline(input: RouteTimelineInput): RouteTimeline {
  const departure = { departAt: input.departAt, startPointId: input.startPointId, endPointId: input.endPointId };
  if (!input.stops.length) {
    return {
      ...departure, stops: [], returnDepartAt: null, returnAt: null, returnTravelMinutes: null, returnTravelSource: null,
      travelMinutes: null, workMinutes: 0, waitingMinutes: null, totalMinutes: null,
    };
  }

  const departAt = Date.parse(input.departAt);
  const estimate = estimateByDirection(input.travelEstimates);
  const stops: RouteTimeline['stops'] = [];
  let previousPointId = input.startPointId;
  let previousWorkEnd: number | null = departAt;
  let workMinutes: number | null = 0;

  for (const stop of input.stops) {
    const leg = estimate(previousPointId, stop.pointId);
    const arrival: number | null = addMinutes(previousWorkEnd, leg.minutes);
    const workStart: number | null = arrival === null || !stop.windowStart
      ? arrival : Math.max(arrival, Date.parse(stop.windowStart));
    const workEnd: number | null = addMinutes(workStart, stop.workMinutes);
    stops.push({
      deliveryId: stop.deliveryId,
      fromPointId: previousPointId,
      travelStartAt: toInstant(previousWorkEnd),
      workMinutes: stop.workMinutes,
      ...(stop.windowKind ? { windowKind: stop.windowKind } : {}),
      windowStatus: stop.windowStatus ?? (stop.windowStart || stop.windowEnd ? 'confirmed' : 'none'),
      windowStart: stop.windowStart ?? null,
      windowEnd: stop.windowEnd ?? null,
      eta: toInstant(arrival),
      workStartAt: toInstant(workStart),
      workEndAt: toInstant(workEnd),
      waitMinutes: arrival === null || workStart === null ? null : (workStart - arrival) / millisecondsPerMinute,
      late: !stop.windowEnd ? null : stop.windowKind === 'arrival'
        ? workStart === null ? null : workStart > Date.parse(stop.windowEnd)
        : workEnd === null ? null : workEnd > Date.parse(stop.windowEnd),
      travelMinutes: leg.minutes,
      travelSource: leg.source,
    });
    previousPointId = stop.pointId;
    previousWorkEnd = workEnd;
    workMinutes = workMinutes === null || stop.workMinutes === null ? null : workMinutes + stop.workMinutes;
  }

  const returnLeg = estimate(previousPointId, input.endPointId);
  const returnAt = addMinutes(previousWorkEnd, returnLeg.minutes);
  return {
    ...departure, stops, returnDepartAt: toInstant(previousWorkEnd),
    returnAt: toInstant(returnAt),
    returnTravelMinutes: returnLeg.minutes,
    returnTravelSource: returnLeg.source,
    travelMinutes: sumMinutes([...stops.map((stop) => stop.travelMinutes), returnLeg.minutes]),
    workMinutes,
    waitingMinutes: sumMinutes(stops.map((stop) => stop.waitMinutes)),
    totalMinutes: returnAt === null ? null : (returnAt - departAt) / millisecondsPerMinute,
  };
}
