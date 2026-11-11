import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, InstantSchema, type Delivery } from '../domain/model';
import type { Crew, Participant, Vehicle } from '../operations/contracts';
import { activeTransport } from '../operations/vehicles';
import { RouteWorkDurationSourceSchema, type RouteDraftInput, type RoutePointContext, type RouteTimeline } from './contracts';

export const RouteFeasibilityFindingSchema = z.object({
  severity: z.enum(['conflict', 'unknown']), code: z.string(), message: z.string(),
  deliveryId: IdSchema.optional(), resourceId: z.string().optional(),
  startsAt: InstantSchema.optional(), endsAt: InstantSchema.optional(),
}).strict();
export const RouteFeasibilitySchema = z.object({
  status: z.enum(['conflict', 'insufficient_data', 'feasible_estimate']), checkedAt: InstantSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(RouteFeasibilityFindingSchema),
  workDurations: z.array(z.object({ deliveryId: IdSchema, minutes: z.number().int().nonnegative().nullable(), source: RouteWorkDurationSourceSchema }).strict()),
}).strict();
export type RouteFeasibility = z.infer<typeof RouteFeasibilitySchema>;
export type RouteFinding = z.infer<typeof RouteFeasibilityFindingSchema>;
export type RouteBusyInterval = { resource: string; appointmentId: string; pickingName: string; startsAt: string; endsAt: string; routeId?: string | null; bufferMinutes?: number };
export type RouteResources = {
  participants: Participant[]; crews: Crew[]; vehicles: Vehicle[]; busy: RouteBusyInterval[];
  disabledSkillIds?: string[];
};
export type RouteWorkAssessment = { deliveryId: string; minutes: number | null; source: z.infer<typeof RouteWorkDurationSourceSchema>; fingerprint: string; blockedReason: string | null };
type Interval = { startsAt: string; endsAt: string };
function overlaps(left: Interval, right: Interval) {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(left.endsAt) > Date.parse(right.startsAt);
}
function covers(available: Interval, wanted: Interval) {
  return Date.parse(available.startsAt) <= Date.parse(wanted.startsAt) && Date.parse(available.endsAt) >= Date.parse(wanted.endsAt);
}
function coveredBy(intervals: readonly Interval[], wanted: Interval) {
  let coveredUntil = Date.parse(wanted.startsAt);
  for (const interval of [...intervals].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    if (Date.parse(interval.startsAt) > coveredUntil) break;
    coveredUntil = Math.max(coveredUntil, Date.parse(interval.endsAt));
  }
  return coveredUntil >= Date.parse(wanted.endsAt);
}
function sameIds(left: readonly string[], right: readonly string[]) {
  const ids = new Set(left);
  return ids.size === right.length && right.every((id) => ids.has(id));
}

/** Pure preview. It neither books resources nor substitutes default rosters for actual people. */
export function assessRoute(
  input: RouteDraftInput, timeline: RouteTimeline, deliveries: readonly Delivery[],
  resources: RouteResources, work: readonly RouteWorkAssessment[], extraFindings: readonly RouteFinding[] = [],
  pointContexts: readonly (RoutePointContext & { pointId: string })[] = [],
): RouteFeasibility {
  const findings: RouteFinding[] = [...extraFindings];
  const add = (severity: RouteFinding['severity'], code: string, message: string, details: Omit<RouteFinding, 'severity' | 'code' | 'message'> = {}) =>
    findings.push({ severity, code, message, ...details });
  const planning = input.planning;
  const ids = planning?.participantIds ?? [];
  const people = resources.participants.filter(({ id }) => ids.includes(id));
  const crew = resources.crews.find(({ id }) => id === input.crewId);
  const vehicle = resources.vehicles.find(({ id }) => id === input.vehicleId);
  const trip = timeline.returnAt ? { startsAt: timeline.departAt, endsAt: timeline.returnAt } : null;
  if (!input.stops.length) add('unknown', 'no_stops', 'Add route stops before checking the trip.');
  if (!crew) add('unknown', 'crew_unknown', 'Select a crew for the complete trip.');
  else if (!crew.enabled) add('conflict', 'crew_disabled', `Crew ${crew.name} is disabled.`, { resourceId: `crew:${crew.id}` });
  if (!vehicle) add('unknown', 'vehicle_unknown', 'Select a vehicle for the complete trip.');
  else if (!vehicle.enabled || vehicle.operationalStatus !== 'available') add('conflict', 'vehicle_unavailable', `Vehicle ${vehicle.name} is unavailable.`, { resourceId: `vehicle:${vehicle.id}` });
  if (!planning || ids.length === 0) add('unknown', 'participants_unknown', 'Select the actual participants; the default crew roster is not an assignment.');
  for (const id of ids) {
    const person = people.find((entry) => entry.id === id);
    if (!person) add('conflict', 'participant_missing', 'A selected participant no longer exists.', { resourceId: `person:${id}` });
    else if (!person.enabled) add('conflict', 'participant_disabled', `${person.name} is disabled.`, { resourceId: `person:${id}` });
    const availability = planning?.participantAvailability.find(({ participantId }) => participantId === id);
    if (!availability || availability.workingIntervals.length === 0) add('unknown', 'working_hours_unknown', `Enter working hours and breaks for ${person?.name ?? id}.`, { resourceId: `person:${id}` });
    else if (trip) {
      if (!coveredBy(availability.workingIntervals, trip)) add('conflict', 'outside_working_hours', `${person?.name ?? id} is not available for the complete departure-to-return interval.`, { resourceId: `person:${id}`, ...trip });
      for (const unavailable of availability.unavailableIntervals.filter((entry) => overlaps(entry, trip))) {
        add('conflict', unavailable.kind === 'break' ? 'participant_break' : 'participant_absence', `${person?.name ?? id} has a ${unavailable.kind} during this trip. Adjust the schedule before proceeding.`, { resourceId: `person:${id}`, startsAt: unavailable.startsAt, endsAt: unavailable.endsAt });
      }
    }
  }
  if (planning?.driver.kind === 'participant') {
    if (!ids.includes(planning.driver.participantId)) add('conflict', 'driver_not_selected', 'The driver must be one of the selected participants.');
  } else if (planning?.driver.kind === 'external') {
    if (!planning.driver.availability) add('unknown', 'external_driver_unknown', 'Confirm external driver availability for the full trip.');
    else if (trip && !covers(planning.driver.availability, trip)) add('conflict', 'external_driver_unavailable', 'The external driver availability does not cover the return journey.', trip);
  } else add('unknown', 'driver_unknown', 'Select the driver or record confirmed external driver availability.');
  if (vehicle?.ownership === 'external') {
    if (!planning?.vehicleAvailability) add('unknown', 'external_vehicle_unknown', 'Confirm external vehicle availability for the full trip.');
    else if (trip && !covers(planning.vehicleAvailability, trip)) add('conflict', 'external_vehicle_unavailable', 'The external vehicle availability does not cover the return journey.', { resourceId: `vehicle:${vehicle.id}`, ...trip });
  }
  if (planning?.transferBufferMinutes === null || planning?.transferBufferMinutes === undefined) add('unknown', 'transfer_buffer_unknown', 'Enter the transfer buffer required before and after other bookings.');
  if (!trip) add('unknown', 'schedule_unknown', 'Work duration or travel estimates are missing; the return time cannot be checked.');
  const ownReservations = new Set<string>();
  for (const stop of input.stops) {
    const delivery = deliveries.find(({ id }) => id === stop.deliveryId);
    const appointment = delivery?.appointments.find(({ id }) => id === stop.appointmentId);
    const assessment = work.find(({ deliveryId }) => deliveryId === stop.deliveryId);
    const calculated = timeline.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
    const details = { deliveryId: stop.deliveryId };
    if (assessment?.source === 'unknown' || assessment?.minutes === null) add('unknown', 'work_duration_unknown', 'Review the duration of the selected remaining work.', details);
    if (assessment && stop.workFingerprint !== assessment.fingerprint) add('unknown', 'work_changed_or_unreviewed', 'Review the selected work and its duration; the work snapshot is missing or has changed.', details);
    if (assessment?.blockedReason) add(assessment.blockedReason === 'stock_pending' ? 'unknown' : 'conflict', 'work_requires_review', `Selected work needs review: ${assessment.blockedReason}.`, details);
    if (!stop.customerWindow || stop.customerWindow.kind === 'unknown') add('unknown', 'customer_window_unknown', 'Confirm the customer window interpretation or explicitly record no restriction.', details);
    if (calculated?.late) add('conflict', 'customer_window_missed', stop.customerWindow?.kind === 'arrival' ? 'Arrival would be after the customer window.' : 'Work would finish after the customer window.', details);
    if (!appointment) {
      add('unknown', 'task_requirements_unknown', 'No reviewed visit task snapshot is linked; required skills must be confirmed before booking.', details);
      continue;
    }
    const assignedIds = [...new Set(appointment.assignments.flatMap(({ people: assigned }) => assigned.map(({ id }) => id)))];
    const compositionMatches = appointment.assignments.length > 0 && appointment.assignments.every(({ crewId }) => crewId === input.crewId) && sameIds(assignedIds, ids);
    if (appointment.assignments.length && !compositionMatches) add('conflict', 'composition_changes', 'This visit has a different crew or participant composition. A single fixed trip composition is required for this preview.', details);
    if (compositionMatches) {
      for (const id of ids) ownReservations.add(`${appointment.id}:person:${id}`);
      if (input.crewId) ownReservations.add(`${appointment.id}:crew:${input.crewId}`);
    }
    const skillIds = new Set(appointment.assignments.flatMap(({ tasks }) => tasks.flatMap(({ requiredSkillsSnapshot }) => (requiredSkillsSnapshot ?? []).map(({ id }) => id))));
    if ([...skillIds].some((id) => resources.disabledSkillIds?.includes(id))) add('conflict', 'required_skill_disabled', 'A required task skill has been disabled; review the task requirements.', details);
    if (appointment.assignments.some(({ tasks }) => tasks.some(({ requiredSkillsSnapshot }) => requiredSkillsSnapshot === undefined))) add('unknown', 'task_skills_unknown', 'The legacy task snapshot has no reviewed skill requirements.', details);
    if (!appointment.assignments.length) add('unknown', 'task_requirements_unknown', 'Assign reviewed visit task templates before considering skill requirements complete.', details);
    for (const person of people) {
      if ([...skillIds].some((id) => !person.skillIds.includes(id))) add('conflict', 'missing_skill', `${person.name} lacks a required task skill for this visit.`, { ...details, resourceId: `person:${person.id}` });
    }
    const transports = activeTransport(appointment);
    const allocation = transports.length === 1 ? transports[0] : undefined;
    if (transports.length && (!allocation || allocation.vehicle.id !== input.vehicleId)) add('conflict', 'vehicle_changes', 'This visit uses a different vehicle or multiple vehicles; review the trip composition.', details);
    else if (allocation && compositionMatches && planning) {
      const driverMatches = allocation.driver.kind === 'participant' && planning.driver.kind === 'participant' && allocation.driver.person.id === planning.driver.participantId;
      const externalMatches = allocation.driver.kind === 'external' && planning.driver.kind === 'external' && allocation.driver.name === planning.driver.name;
      if (driverMatches || externalMatches) ownReservations.add(`${appointment.id}:vehicle:${allocation.vehicle.id}`);
      else add('conflict', 'driver_changes', 'This visit has a different transport driver; review the trip composition.', details);
    }
  }
  if (trip) {
    const selectedResources = new Set([...ids.map((id) => `person:${id}`), ...(input.crewId ? [`crew:${input.crewId}`] : []), ...(input.vehicleId ? [`vehicle:${input.vehicleId}`] : [])]);
    const names = new Map(people.map(({ id, name }) => [`person:${id}`, name]));
    if (crew) names.set(`crew:${crew.id}`, crew.name);
    if (vehicle) names.set(`vehicle:${vehicle.id}`, vehicle.name);
    for (const busy of resources.busy) {
      const padding = Math.max(planning?.transferBufferMinutes ?? 0,busy.bufferMinutes ?? 0) * 60_000;
      const padded = { startsAt: new Date(Date.parse(trip.startsAt) - padding).toISOString(), endsAt: new Date(Date.parse(trip.endsAt) + padding).toISOString() };
      const own = busy.routeId == null && ownReservations.has(`${busy.appointmentId}:${busy.resource}`);
      if (selectedResources.has(busy.resource) && overlaps(padded, busy) && !own) {
        add('conflict', 'resource_busy', `${names.get(busy.resource) ?? busy.resource} is reserved for ${busy.pickingName}, including required transfer buffer.`, { resourceId: busy.resource, startsAt: busy.startsAt, endsAt: busy.endsAt });
      }
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ input, timeline, deliveries: deliveries.map(({ id, version }) => ({ id, version })), resources, work, pointContexts, extraFindings })).digest('hex');
  return {
    status: findings.some(({ severity }) => severity === 'conflict') ? 'conflict' : findings.length ? 'insufficient_data' : 'feasible_estimate',
    checkedAt: new Date().toISOString(), fingerprint, findings,
    workDurations: work.map(({ deliveryId, minutes, source }) => ({ deliveryId, minutes, source })),
  };
}
