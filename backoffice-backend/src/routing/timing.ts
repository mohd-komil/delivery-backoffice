import type { z } from 'zod';
import type { Appointment } from '../domain/model';
import { effectiveResults } from '../domain/rules';
import type { RouteRuntime } from './lifecycle-contracts';
import type { PublicationReviewSchema, PublicationStatusSchema } from './publication-contracts';
import type { RouteTiming } from './timing-contracts';

const millisecondsPerMinute = 60_000;

function compareInstants(planned: string | null, actual: string | null) {
  return { planned, actual, deltaMinutes: planned && actual ? (Date.parse(actual) - Date.parse(planned)) / millisecondsPerMinute : null };
}

function compareDurations(planned: number | null, actual: number | null) {
  return { planned, actual, deltaMinutes: planned !== null && actual !== null ? actual - planned : null };
}

function elapsedMinutes(startAt: string | null, endAt: string | null) {
  if (startAt === null || endAt === null) return null;
  const minutes = (Date.parse(endAt) - Date.parse(startAt)) / millisecondsPerMinute;
  return minutes >= 0 ? minutes : null;
}

type StopTimingFacts = { appointment: Appointment; recordedStartAt: string | null };
type StopTiming = RouteTiming['stops'][number];
type Timeline = z.infer<typeof PublicationReviewSchema>['timeline'];
type PlannedStop = z.infer<typeof PublicationReviewSchema>['stops'][number];

function stopReason(appointment: Appointment, runtime: RouteRuntime, cancelled: boolean): StopTiming['reason'] {
  if (cancelled) return runtime.cancelled?.note ? { kind: 'cancelled', note: runtime.cancelled.note } : null;
  const skipped = runtime.skipped.find(({ appointmentId }) => appointmentId === appointment.id);
  if (skipped?.note) return { kind: 'skipped', note: skipped.note };
  if (appointment.failedAttempt) return { kind: 'customer_absent', note: appointment.failedAttempt.reason };
  if (appointment.cancellationReason) return { kind: 'cancelled', note: appointment.cancellationReason };
  return null;
}

function timingForStop(
  planned: PlannedStop, sequence: number, timeline: Timeline['stops'][number] | undefined,
  { appointment, recordedStartAt }: StopTimingFacts, runtime: RouteRuntime, cancelled: boolean,
): StopTiming {
  // A cancelled route may release an attached visit, which can then execute outside this route.
  const result = cancelled ? undefined : effectiveResults({ appointments: [appointment] }).at(-1);
  const actualStart = cancelled ? null : result?.actualStart ?? recordedStartAt;
  const actualEnd = result?.actualEnd ?? null;
  return {
    deliveryId: planned.deliveryId,
    appointmentId: planned.appointmentId,
    sequence,
    pickingName: planned.pickingName,
    status: cancelled ? 'cancelled' : appointment.status,
    arrivalAt: compareInstants(timeline?.eta ?? null, null),
    workStartAt: compareInstants(timeline?.workStartAt ?? null, actualStart),
    workEndAt: compareInstants(timeline?.workEndAt ?? null, actualEnd),
    travelMinutes: compareDurations(timeline?.travelMinutes ?? null, null),
    waitingMinutes: compareDurations(timeline?.waitMinutes ?? null, null),
    workMinutes: compareDurations(timeline?.workMinutes ?? null, elapsedMinutes(actualStart, actualEnd)),
    reason: stopReason(appointment, runtime, cancelled),
  };
}

function recordedReturnDeparture(runtime: RouteRuntime) {
  const returningAt = runtime.returning?.at ?? null;
  // Aborting a route can put it into `returning` without recording the physical start of the return journey.
  if (returningAt && runtime.aborted && Date.parse(returningAt) >= Date.parse(runtime.aborted.at)) return null;
  return returningAt;
}

function totalWorkMinutes(stops: readonly StopTiming[]) {
  let minutes = 0;
  for (const stop of stops) {
    const actual = stop.workMinutes.actual;
    if (actual === null) return null;
    minutes += actual;
  }
  return stops.length ? minutes : null;
}

export function buildRouteTiming(
  id: string, status: z.infer<typeof PublicationStatusSchema>, plan: RouteTiming['plan'],
  review: z.infer<typeof PublicationReviewSchema>, runtime: RouteRuntime, facts: readonly StopTimingFacts[],
): RouteTiming {
  const timeline = review.timeline;
  const segments = new Map(timeline.stops.map((stop) => [stop.deliveryId, stop]));
  const factsByVisit = new Map(facts.map((stop) => [stop.appointment.id, stop]));
  const stops = review.stops.map((stop, index) => {
    const actual = factsByVisit.get(stop.appointmentId);
    if (!actual) throw new Error('Published route references an unavailable visit');
    return timingForStop(stop, index + 1, segments.get(stop.deliveryId), actual, runtime, status === 'cancelled');
  });
  const actualDeparture = runtime.departed?.at ?? null;
  const actualReturnDeparture = recordedReturnDeparture(runtime);
  const actualReturn = runtime.returned?.actualReturnedAt ?? null;
  return {
    id, status, plan,
    route: {
      departAt: compareInstants(timeline.departAt, actualDeparture),
      returnDepartAt: compareInstants(timeline.returnDepartAt, actualReturnDeparture),
      returnAt: compareInstants(timeline.returnAt, actualReturn),
      travelMinutes: compareDurations(timeline.travelMinutes, null),
      waitingMinutes: compareDurations(timeline.waitingMinutes, null),
      workMinutes: compareDurations(timeline.workMinutes, totalWorkMinutes(stops)),
      totalMinutes: compareDurations(timeline.totalMinutes, elapsedMinutes(actualDeparture, actualReturn)),
      returnTravelMinutes: compareDurations(timeline.returnTravelMinutes, elapsedMinutes(actualReturnDeparture, actualReturn)),
    },
    stops,
  };
}
