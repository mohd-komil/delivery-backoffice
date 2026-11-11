import type { Delivery } from '../domain/model';
import { calculateRouteTimeline, type RouteTimelineInput } from './calculation';
import { directedRoutePair, type RouteDraftInput, type RoutePointContext, type RoutePointCoordinates, type RouteTravelEstimate } from './contracts';
import { getDemoRouteEstimates, getLocalDemoRouteEstimates } from './demo-estimates';
import { assessRoute, type RouteFinding, type RouteResources, type RouteWorkAssessment } from './feasibility';
import type { RouteJob, RouteRoad, RouteWarningSchema } from './http-contracts';
import type { z } from 'zod';

type Preview = {
  timeline: ReturnType<typeof calculateRouteTimeline>; jobs: RouteJob[];
  pointContexts: (RoutePointContext & { pointId: string })[];
  warnings: z.infer<typeof RouteWarningSchema>[]; road?: RouteRoad;
  feasibility: ReturnType<typeof assessRoute>;
};
export type PreparedRoute = {
  preview: Preview; stops: RouteTimelineInput['stops']; selected: Delivery[];
  resources: RouteResources; work: RouteWorkAssessment[];
  coordinates: ReadonlyMap<string, RoutePointCoordinates>;
  manualEstimates: RouteTravelEstimate[]; extraFindings: RouteFinding[];
};

/** Bounded pair-swap search over the same directed matrix. Never mutates or saves a draft. */
export function suggestRouteOrder(input: RouteDraftInput, objective: 'travel_minutes' | 'return_time', prepared: PreparedRoute) {
  const points = [...new Set([input.startPointId, ...input.stops.map(({ deliveryId }) => deliveryId), input.endPointId])];
  const matrix: RouteTravelEstimate[] = [];
  // Mixing a manually entered current route with coordinate-only candidate legs would invent savings.
  const manualOnly = input.manualEstimates.length > 0;
  const manual = new Map(prepared.manualEstimates.filter(({ context }) => context !== undefined).map((estimate) => [directedRoutePair(estimate.fromPointId, estimate.toPointId), estimate]));
  for (const from of points) for (const to of points) {
    if (from === to) continue;
    if (manualOnly) {
      const estimate = manual.get(directedRoutePair(from, to));
      if (estimate) matrix.push(estimate);
    } else matrix.push(...(input.useLocalEstimates ? getLocalDemoRouteEstimates([from, to], prepared.coordinates) : getDemoRouteEstimates([from, to])));
  }
  const assess = (stops: RouteTimelineInput['stops']): Preview => {
    const byId = new Map(input.stops.map((stop) => [stop.deliveryId, stop]));
    const ordered = stops.flatMap(({ deliveryId }) => {
      const stop = byId.get(deliveryId);
      return stop ? [stop] : [];
    });
    const timeline = calculateRouteTimeline({ ...input, stops, travelEstimates: matrix });
    return {
      ...prepared.preview, road: undefined, timeline,
      feasibility: assessRoute({ ...input, stops: ordered }, timeline, prepared.selected, prepared.resources, prepared.work, prepared.extraFindings, prepared.preview.pointContexts),
    };
  };
  const current = assess(prepared.stops);
  const unchanged = {
    objective, current, suggested: null, deliveryIds: input.stops.map(({ deliveryId }) => deliveryId),
    travelMinutesSaved: null, totalMinutesSaved: null,
  };
  if (current.feasibility.findings.some(({ severity }) => severity === 'unknown')) {
    return { ...unchanged, status: 'insufficient_data' as const, evaluatedOrders: 1,
      explanation: manualOnly ? 'Complete the reviewed manual directed estimates and missing feasibility inputs before comparing orders. No Google service is called.' : 'Complete the missing feasibility inputs before comparing stop orders. No Google service is called.' };
  }
  let best = current;
  let bestStops = [...prepared.stops];
  let evaluatedOrders = 1;
  let incompleteCandidates = false;
  const visited = new Set([bestStops.map(({ deliveryId }) => deliveryId).join(',')]);
  const objectiveValue = (preview: Preview) => objective === 'travel_minutes' ? preview.timeline.travelMinutes : preview.timeline.totalMinutes;
  for (let pass = 0; pass < 2; pass++) {
    const baseStops = [...bestStops];
    let improved = false;
    for (let left = 0; left < baseStops.length; left++) for (let right = left + 1; right < baseStops.length; right++) {
      const leftStop = baseStops[left]; const rightStop = baseStops[right];
      if (!leftStop || !rightStop) continue;
      const candidateStops = [...baseStops];
      candidateStops[left] = rightStop; candidateStops[right] = leftStop;
      const key = candidateStops.map(({ deliveryId }) => deliveryId).join(',');
      if (visited.has(key)) continue;
      visited.add(key); evaluatedOrders++;
      const candidate = assess(candidateStops);
      if (candidate.feasibility.findings.some(({ severity }) => severity === 'unknown')) { incompleteCandidates = true; continue; }
      if (candidate.feasibility.status !== 'feasible_estimate') continue;
      const candidateValue = objectiveValue(candidate); const bestValue = objectiveValue(best);
      if (candidateValue !== null && (best.feasibility.status !== 'feasible_estimate' || bestValue === null || candidateValue < bestValue)) {
        best = candidate; bestStops = candidateStops; improved = true;
      }
    }
    if (!improved) break;
  }
  if (best === current) return {
    ...unchanged, status: incompleteCandidates ? 'insufficient_data' as const : 'no_improvement_found' as const,
    evaluatedOrders,
    explanation: incompleteCandidates ? 'Some alternative directed legs lack comparable estimates. Complete the same-quality matrix before comparing.'
      : 'The bounded comparison found no feasible improvement. This is not a proof of the optimal order.',
  };
  const difference = (before: number | null, after: number | null) => before === null || after === null ? null : before - after;
  return {
    status: 'suggested' as const, objective, current, suggested: best,
    deliveryIds: bestStops.map(({ deliveryId }) => deliveryId), evaluatedOrders,
    travelMinutesSaved: difference(current.timeline.travelMinutes, best.timeline.travelMinutes),
    totalMinutesSaved: difference(current.timeline.totalMinutes, best.timeline.totalMinutes),
    explanation: 'A feasible improvement among the checked orders. Review it and apply explicitly; no appointments or resources have been reserved.',
  };
}
