import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { destinationAddressKey } from '../domain/destination-address';
import { IdSchema, InstantSchema, type Delivery, type OperatorActor } from '../domain/model';
import { appointmentScopeReviewReason, customerConfirmationStatus, estimateWorkMinutes, lineServiceStatuses } from '../domain/rules';
import { workTimeAdjustmentContext } from '../domain/work-time-adjustments';
import { Participants } from '../operations/participants';
import type { EffectiveDeliveryPoint } from '../operations/delivery-points';
import { DeliveryStore } from '../operations/store';
import { Vehicles } from '../operations/vehicles';
import { RESOURCE_BOOKINGS_SQL } from '../operations/route-reservations';
import { calculateRouteTimeline, distanceKm, type RouteTimelineInput } from './calculation';
import { directedRoutePair, RouteDraftInputSchema, withoutRouteDriver, type RouteDraftInput, type RoutePointContext, type RoutePointCoordinates, type RouteTravelEstimate } from './contracts';
import { getDemoRouteEstimates, getLocalDemoRouteEstimates, routeDepots } from './demo-estimates';
import { DestinationEntrances } from './entrances';
import { GoogleRoads } from './google-maps';
import { MAX_GOOGLE_ROUTE_STOPS, RoadRouteError } from './google-routes';
import { RouteJobsQuerySchema, type RouteJob, type RouteRoad, type RouteWarningSchema } from './http-contracts';
import { assessRoute, type RouteFinding, type RouteResources, type RouteWorkAssessment } from './feasibility';
import { suggestRouteOrder } from './suggestion';
import { locationPlanningProblems, locationPoint, locationPointContext, PlanningLocations } from '../planning/locations';
import { PlanningCalendar, resolveRouteCalendar } from '../planning/calendar';
import type { RouteCalendar } from '../planning/calendar-contracts';
import type { RouteLocations } from '../planning/location-contracts';

const RouteDraftRowSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  data: RouteDraftInputSchema,
  createFingerprint: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
type RouteDraftRow = z.infer<typeof RouteDraftRowSchema>;
const draftColumns = 'id, version, data, create_fingerprint AS "createFingerprint", created_at AS "createdAt", updated_at AS "updatedAt"';
const DraftSummaryRowSchema = RouteDraftRowSchema.pick({ id: true, version: true, updatedAt: true }).extend({
  name: z.string(), departAt: InstantSchema, stopCount: z.number().int().nonnegative(),
});

function bookedVisits(delivery: Delivery) {
  return delivery.appointments.filter(({ status }) => status === 'booked');
}

function hasConfirmation(appointment: Delivery['appointments'][number]) {
  return customerConfirmationStatus(appointment) === 'customer_confirmed';
}

function scopeNeedsReview(delivery: Delivery, appointment: Delivery['appointments'][number]) {
  const reason = appointmentScopeReviewReason(delivery, appointment);
  return reason !== null && reason !== 'stock_pending';
}

export function routeJob(delivery: Delivery, entrance?: RoutePointCoordinates, appointmentId?: string,
  addressPoint?: Pick<EffectiveDeliveryPoint, 'point' | 'geocoding'>): RouteJob {
  const { source } = delivery;
  const itemsById = new Map(source.items.map((item) => [item.sourceLineId, item]));
  const ordersById = new Map((source.salesOrders ?? [{ id: source.saleOrderId, name: source.saleOrderName }])
    .map(({ id, name }) => [id, name]));
  const workLines = lineServiceStatuses(delivery);
  const appointment = appointmentId ? delivery.appointments.find(({ id }) => id === appointmentId) : undefined;
  const availableWork = workLines.filter(({ planningBlockedReason }) => planningBlockedReason === null).map(({ sourceLineId, availableDeliveryMilli, availableInstallationMilli, availableCollectionMilli }) => ({
    sourceLineId, deliveryMilli: availableDeliveryMilli, installationMilli: availableInstallationMilli, collectionMilli: availableCollectionMilli,
  }));
  const selectedWork = appointmentId ? appointment?.workScope?.lines ?? [] : availableWork;
  const remaining = selectedWork.flatMap(({ sourceLineId, deliveryMilli, installationMilli, collectionMilli }) => {
    const item = itemsById.get(sourceLineId);
    if (!item || deliveryMilli + installationMilli + collectionMilli === 0) return [];
    return [{
      sourceLineId, orderName: ordersById.get(item.saleOrderId ?? source.saleOrderId) ?? source.saleOrderName,
      productName: item.name, uom: item.uom, deliveryMilli, installationMilli, collectionMilli,
    }];
  });
  const address = source.customer.address?.trim() ?? '';
  const addressKey = destinationAddressKey(source.customer);
  const booked = bookedVisits(delivery);
  const estimate = estimateWorkMinutes(delivery, selectedWork);
  const minutes = (value: number | null) => value !== null && value > 0 && value <= 1440 ? value : null;
  const appointmentOptions = booked.map((visit) => ({
    id: visit.id, startsAt: visit.startsAt, endsAt: visit.endsAt,
    customerConfirmed: hasConfirmation(visit), needsReview: scopeNeedsReview(delivery, visit),
    suggestedWorkMinutes: visit.workScope ? minutes(estimateWorkMinutes(delivery, visit.workScope.lines).minutes) : null,
  }));
  const workReviewReason = appointmentId
    ? !appointment || appointment.status !== 'booked' ? 'appointment_unavailable' : appointmentScopeReviewReason(delivery, appointment)
    : workLines.find(({ planningBlockedReason }) => planningBlockedReason !== null)?.planningBlockedReason ?? null;
  const selectable = remaining.length > 0 || (!appointmentId && appointmentOptions.some(({ needsReview }) => !needsReview));
  const unavailable = !address || !selectable || (appointmentId && workReviewReason !== null && workReviewReason !== 'stock_pending') || delivery.sourceReview || delivery.completedAt !== null
    || delivery.appointments.some(({ status }) => status === 'in_progress');
  const selectedLineIds = new Set(selectedWork.filter(({ deliveryMilli, installationMilli, collectionMilli }) => deliveryMilli + installationMilli + collectionMilli > 0)
    .map(({ sourceLineId }) => sourceLineId));
  const workTimes = delivery.servicePlan?.timeEstimates?.filter(({ sourceLineId }) => selectedLineIds.has(sourceLineId))
    .map(({ sourceLineId, context, deliveryMinutesPerUnit, installationMinutesPerUnit, collectionMinutesPerUnit }) =>
      ({ sourceLineId, context, deliveryMinutesPerUnit, installationMinutesPerUnit, collectionMinutesPerUnit })).sort((a, b) => a.sourceLineId - b.sourceLineId);
  return {
    deliveryId: delivery.id, pickingName: source.pickingName, orderNames: [...ordersById.values()],
    customerName: source.customer.name, address, city: source.customer.city, addressKey, point: entrance ?? addressPoint?.point ?? delivery.routePoint ?? null,
    entranceConfirmed: entrance !== undefined,
    ...(!entrance && addressPoint?.geocoding ? { geocoding: addressPoint.geocoding } : {}),
    distanceKm: null, suggestedWorkMinutes: minutes(estimate.minutes),
    remainingWorkEstimate: estimate,
    remaining,
    workFingerprint: createHash('sha256').update(JSON.stringify({ source: delivery.source, addressKey, remaining, workReviewReason, appointmentId: appointmentId ?? null,
      ...(workTimes?.length ? { workTimes } : {}),
      ...(delivery.workTimeAdjustments ? { workTimeAdjustments: delivery.workTimeAdjustments,
        workTimeAdjustmentContext: workTimeAdjustmentContext(delivery), calculationAlgorithm: estimate.calculation?.algorithmVersion } : {}) })).digest('hex'),
    workBasis: appointmentId ? 'appointment' : 'available_remaining', appointmentId: appointmentId ?? null,
    hasAvailableRemaining: availableWork.some(({ deliveryMilli, installationMilli, collectionMilli }) => deliveryMilli + installationMilli + collectionMilli > 0),
    workReviewReason, appointmentOptions,
    planningStatus: unavailable ? 'unavailable' : appointment ? hasConfirmation(appointment) ? 'confirmed' : 'booked'
      : booked.some(hasConfirmation) ? 'confirmed' : booked.length ? 'booked' : 'unplanned',
  };
}

function selectedWindow(stop: RouteDraftInput['stops'][number]) {
  const window = stop.customerWindow;
  if (window?.kind === 'arrival' || window?.kind === 'work_end') {
    return { windowStart: window.startsAt, windowEnd: window.endsAt, windowStatus: 'confirmed' as const, windowKind: window.kind };
  }
  return { windowStart: null, windowEnd: null, windowStatus: 'none' as const, windowKind: window?.kind ?? 'unknown' as const };
}

function sameContext(left: RoutePointContext, right: RoutePointContext | undefined) {
  return right !== undefined && left.addressKey === right.addressKey
    && left.point?.latitude === right.point?.latitude && left.point?.longitude === right.point?.longitude;
}

function normalizeRouteIdentifiers(input: RouteDraftInput): RouteDraftInput {
  return RouteDraftInputSchema.parse({
    ...input,
    departAt: new Date(input.departAt).toISOString(),
    crewId: input.crewId?.toLowerCase() ?? null,
    vehicleId: input.vehicleId?.toLowerCase() ?? null,
    startPointId: input.startPointId.toLowerCase(),
    endPointId: input.endPointId.toLowerCase(),
    stops: input.stops.map((stop) => ({ ...stop, deliveryId: stop.deliveryId.toLowerCase(),
      ...(stop.appointmentId ? { appointmentId: stop.appointmentId.toLowerCase() } : {}) })),
    manualEstimates: input.manualEstimates.map((estimate) => ({
      ...estimate, fromPointId: estimate.fromPointId.toLowerCase(), toPointId: estimate.toPointId.toLowerCase(),
    })),
    ...(input.planning ? { planning: {
      ...input.planning,
      participantIds: input.planning.participantIds.map((id) => id.toLowerCase()),
      participantAvailability: input.planning.participantAvailability.map((entry) => ({ ...entry, participantId: entry.participantId.toLowerCase() })),
      driver: input.planning.driver.kind === 'participant' ? { ...input.planning.driver, participantId: input.planning.driver.participantId.toLowerCase() } : input.planning.driver,
    } } : {}),
  });
}

export function normalizeRouteDraftInput(input: RouteDraftInput): RouteDraftInput {
  return withoutRouteDriver(normalizeRouteIdentifiers(input));
}

@Injectable()
export class RouteDrafts {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(Participants) private readonly directory: Participants,
    @Inject(Vehicles) private readonly vehicles: Vehicles,
    @Inject(GoogleRoads) private readonly googleRoads: GoogleRoads,
    @Inject(DestinationEntrances) private readonly entrances: DestinationEntrances,
    @Inject(PlanningLocations) private readonly locations: PlanningLocations,
    @Inject(PlanningCalendar) private readonly calendar: PlanningCalendar,
  ) {}

  async list() {
    const drafts = await rows(this.store.db.source.manager, DraftSummaryRowSchema,
      `SELECT d.id,d.version,COALESCE(revision.at,p.created_at,d.updated_at) AS "updatedAt",
      COALESCE(p.data->'draft',d.data)->>'name' AS name,
      COALESCE(p.data->'draft',d.data)->>'departAt' AS "departAt",
      jsonb_array_length(COALESCE(p.data->'draft',d.data)->'stops') AS "stopCount"
      FROM route_draft d LEFT JOIN route_publication p ON p.id=d.id
      LEFT JOIN LATERAL (SELECT max(at) AS at FROM route_revision WHERE route_id=d.id) revision ON true
      ORDER BY "updatedAt" DESC,d.id LIMIT 100`);
    return {
      drafts: drafts.map((draft) => ({ ...draft, updatedAt: draft.updatedAt.toISOString() })),
      points: (await this.locations.list()).locations.flatMap((location) => {
        const point = locationPoint(location);
        return location.enabled && point ? [{ id: location.id, name: location.name, ...point }] : [];
      }), googleMaps: this.googleRoads.browserConfig, roadRoutingEnabled: this.googleRoads.configured,
    };
  }

  async jobs(input: unknown) {
    const query = RouteJobsQuerySchema.parse(input);
    const deliveries = await this.store.all();
    const points = await this.entrances.effectivePointsFor(deliveries);
    const available = deliveries.map((delivery) => {
      const effective = points.get(delivery.id);
      return routeJob(delivery, effective?.pointSource === 'confirmed_entrance' ? effective.point : undefined, undefined, effective);
    })
      .filter((job) => job.planningStatus !== 'unavailable');
    const search = query.search?.toLowerCase() ?? '';
    const matching = available.filter((job) => [job.pickingName, job.customerName, job.address, job.city, ...job.orderNames]
      .join(' ').toLowerCase().includes(search));
    if (!query.anchorId) return { jobs: matching.slice(0, 100), anchorJob: null, anchorHasCoordinates: null };
    const anchor = available.find(({ deliveryId }) => deliveryId === query.anchorId?.toLowerCase());
    if (!anchor) throw new NotFoundException('Anchor job is no longer available for planning');
    const point = anchor.point;
    if (!point) return { jobs: [], anchorJob: anchor, anchorHasCoordinates: false };
    const radius = Number(query.radiusKm ?? '10');
    const jobs = matching.flatMap((job) => {
      if (job.deliveryId === anchor.deliveryId || !job.point) return [];
      const distance = distanceKm(point, job.point);
      return distance <= radius ? [{ ...job, distanceKm: distance }] : [];
    }).sort((a, b) => a.distanceKm - b.distanceKm || a.deliveryId.localeCompare(b.deliveryId)).slice(0, 100)
      .map((job) => ({ ...job, distanceKm: Math.round(job.distanceKm * 100) / 100 }));
    return { jobs, anchorJob: anchor, anchorHasCoordinates: true };
  }

  async get(id: string) {
    const draft = await this.find(this.store.db.source.manager, id);
    if (!draft) throw new NotFoundException('Route draft not found');
    const data = withoutRouteDriver(draft.data);
    return this.detail({ ...draft, data }, await this.evaluate(data, this.store.db.source.manager, false));
  }

  async preview(input: RouteDraftInput, useGoogleRoads = false) {
    return this.store.db.source.transaction('REPEATABLE READ', (manager) => this.evaluate(normalizeRouteDraftInput(input), manager, true, useGoogleRoads));
  }

  /** The caller owns the transaction; projected visits freeze exact publication work without writing it. */
  preparePublication(input: RouteDraftInput, manager: EntityManager, deliveries: Delivery[], ownRouteId?: string) {
    return this.prepare(normalizeRouteDraftInput(input), manager, true, false, deliveries, ownRouteId);
  }

  async calendarDepartureBlocker(manager: EntityManager, input: RouteDraftInput, timeline: { departAt: string; returnAt: string | null }, frozen?: RouteCalendar) {
    if (input.planning?.availabilityMode !== 'shared_calendar') return null;
    const current = await this.calendar.currentSnapshot(manager, input, timeline);
    if (!frozen || JSON.stringify(current) !== JSON.stringify(frozen)) return {
      code: 'ROUTE_CALENDAR_REVIEW_REQUIRED', message: 'Participant calendar entries changed. Review and amend the route before departure.',
    };
    return null;
  }

  async locationDepartureBlocker(manager: EntityManager, input: RouteDraftInput, frozen?: RouteLocations) {
    const current = await this.locations.route(manager, input.startPointId, input.endPointId);
    const problem = locationPlanningProblems(current)[0];
    if (problem) return { code: 'ROUTE_LOCATION_REVIEW_REQUIRED', message: problem.message };
    for (const side of ['start', 'end'] as const) {
      const expected = frozen?.[side];
      const actual = current[side];
      // Legacy publications used only the original four constants; migration preserves them at revision 1.
      const unchanged = expected ? actual.id === expected.id && actual.version === expected.version
        : actual.version === 1 && routeDepots.some(({ id }) => id === actual.id);
      if (!unchanged) return { code: 'ROUTE_LOCATION_REVIEW_REQUIRED', message: 'A departure or return location changed. Review and amend the route before departure.' };
    }
    return null;
  }

  async suggest(input: RouteDraftInput, objective: 'travel_minutes' | 'return_time') {
    const command = normalizeRouteDraftInput(input);
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const prepared = await this.prepare(command, manager, true);
      return suggestRouteOrder(command, objective, prepared);
    });
  }

  async create(requestId: string, input: RouteDraftInput, principal: OperatorActor) {
    const normalized = normalizeRouteIdentifiers(input);
    const command = withoutRouteDriver(normalized);
    // Preserve idempotent retries from older clients, including drafts that recorded a driver.
    const { useLocalEstimates, ...legacyCommand } = normalized;
    const fingerprint = createHash('sha256').update(JSON.stringify(useLocalEstimates ? normalized : legacyCommand)).digest('hex');
    return this.store.db.source.transaction(async (manager) => {
      // Follow the scheduling lock so the validated delivery state cannot change during the save.
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const existing = await this.find(manager, requestId);
      if (existing) {
        if (existing.createFingerprint !== fingerprint) throw new ConflictException('Request ID reused with different input');
        const data = withoutRouteDriver(existing.data);
        return this.detail({ ...existing, data }, await this.evaluate(data, manager, false));
      }
      const preview = await this.evaluateForSave(command, manager);
      const [created] = await rows(manager, RouteDraftRowSchema,
        `INSERT INTO route_draft (id, version, data, create_fingerprint) VALUES ($1, 1, $2::jsonb, $3) RETURNING ${draftColumns}`,
        [requestId, JSON.stringify(command), fingerprint]);
      if (!created) throw new Error('Route draft insert did not return a record');
      await this.store.audit(manager, principal, 'route.draft_created', { routeId: created.id, version: created.version });
      return this.detail(created, preview);
    });
  }

  async update(id: string, version: number, input: RouteDraftInput, principal: OperatorActor) {
    const command = normalizeRouteDraftInput(input);
    return this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const existing = await this.find(manager, id);
      if (!existing) throw new NotFoundException('Route draft not found');
      const [publication] = await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM route_publication WHERE id=$1', [id]);
      if (publication) throw new ConflictException({code:'ROUTE_CHANGE_REQUIRED',message:'A published route cannot be changed as a draft. Use the route amendment workflow.'});
      if (existing.version !== version) throw new ConflictException('Route draft changed. Reload before editing.');
      const preview = await this.evaluateForSave(command, manager);
      const [updated] = await rows(manager, RouteDraftRowSchema,
        `WITH updated AS (
          UPDATE route_draft SET version=version+1, data=$2::jsonb, updated_at=now() WHERE id=$1 RETURNING ${draftColumns}
        ) SELECT * FROM updated`,
        [id, JSON.stringify(command)]);
      if (!updated) throw new Error('Route draft update did not return a record');
      await this.store.audit(manager, principal, 'route.draft_updated', { routeId: updated.id, version: updated.version });
      return this.detail(updated, preview);
    });
  }

  private async find(manager: EntityManager, id: string) {
    const [draft] = await rows(manager, RouteDraftRowSchema, `SELECT ${draftColumns} FROM route_draft WHERE id=$1`, [id]);
    return draft;
  }

  private detail(draft: RouteDraftRow, preview: Awaited<ReturnType<RouteDrafts['preview']>>) {
    return {
      ...draft.data, ...preview, id: draft.id, version: draft.version,
      createdAt: draft.createdAt.toISOString(), updatedAt: draft.updatedAt.toISOString(),
    };
  }

  private async evaluateForSave(input: RouteDraftInput, manager: EntityManager) {
    if (input.stops.length === 0) throw new BadRequestException('Add at least one stop before saving a route');
    if (input.crewId) {
      const [crew] = await this.directory.crews(manager, [input.crewId]);
      if (!crew?.enabled) throw new ConflictException('The selected crew is disabled or unavailable');
    }
    if (input.vehicleId) await this.vehicles.requireAvailable(manager, input.vehicleId);
    return this.evaluate(input, manager, true);
  }

  private async evaluate(input: RouteDraftInput, manager: EntityManager, validate: boolean, useGoogleRoads = false) {
    return (await this.prepare(input, manager, validate, useGoogleRoads)).preview;
  }

  private async prepare(input: RouteDraftInput, manager: EntityManager, validate: boolean, useGoogleRoads = false, projectedDeliveries?: Delivery[], ownRouteId?: string) {
    const chain = [input.startPointId, ...input.stops.map(({ deliveryId }) => deliveryId), input.endPointId];
    const nodes = new Set(chain);
    const locations = await this.locations.route(manager, input.startPointId, input.endPointId);
    if (input.manualEstimates.some(({ fromPointId, toPointId }) => !nodes.has(fromPointId) || !nodes.has(toPointId))) {
      throw new BadRequestException('Manual travel estimates must link stops or depots in this draft');
    }
    const selected = projectedDeliveries ?? await this.store.getMany(input.stops.map(({ deliveryId }) => deliveryId), manager);
    const deliveries = new Map(selected.map((delivery) => [delivery.id, delivery]));
    const points = await this.entrances.effectivePointsFor(selected, manager);
    const jobs: RouteJob[] = [];
    const work: RouteWorkAssessment[] = [];
    const coordinates = new Map<string, RoutePointCoordinates>();
    const contexts = new Map<string, RoutePointContext>();
    for (const location of [locations.start, locations.end]) {
      const context = locationPointContext(location);
      if (context.point) coordinates.set(location.id, context.point);
      contexts.set(location.id, context);
    }
    const stops = input.stops.map((stop) => {
      const delivery = deliveries.get(stop.deliveryId);
      if (!delivery) throw new NotFoundException('A route stop no longer exists');
      const effective = points.get(stop.deliveryId);
      const entrance = effective?.pointSource === 'confirmed_entrance' ? effective.point : undefined;
      const job = routeJob(delivery, entrance, stop.appointmentId, effective);
      if (validate && (job.planningStatus === 'unavailable' || job.remaining.length === 0)) {
        throw new ConflictException(stop.appointmentId ? 'Review the selected appointment work before planning this route stop'
          : 'No unreserved work is available. Select a reviewed appointment or update the delivery work plan');
      }
      jobs.push(job);
      const source = stop.workDurationSource ?? 'unknown';
      const minutes = source === 'remaining_estimate' ? job.suggestedWorkMinutes : source === 'unknown' && stop.workDurationSource !== undefined ? null : stop.workMinutes;
      work.push({ deliveryId: stop.deliveryId, minutes, source, fingerprint: job.workFingerprint, blockedReason: job.workReviewReason });
      const point = entrance ?? (stop.pin?.addressKey === job.addressKey ? stop.pin : job.point);
      if (point) coordinates.set(stop.deliveryId, { latitude: point.latitude, longitude: point.longitude });
      contexts.set(stop.deliveryId, { point: point ? { latitude: point.latitude, longitude: point.longitude } : null, addressKey: job.addressKey });
      return { ...stop, workMinutes: minutes, pointId: stop.deliveryId, ...selectedWindow(stop) };
    });
    const usedDirections = new Set(chain.slice(1).flatMap((toPointId, index) => {
      const fromPointId = chain[index];
      return fromPointId === undefined ? [] : [directedRoutePair(fromPointId, toPointId)];
    }));
    const warnings: z.infer<typeof RouteWarningSchema>[] = [];
    const manualEstimates = input.manualEstimates.flatMap((estimate): RouteTravelEstimate[] => {
      const { context, fromPointId, toPointId } = estimate;
      if (context && (!sameContext(context.from, contexts.get(fromPointId)) || !sameContext(context.to, contexts.get(toPointId)))) {
        if (usedDirections.has(directedRoutePair(fromPointId, toPointId))) warnings.push({ code: 'manual_estimate_stale', fromPointId, toPointId });
        return [];
      }
      if (!context && usedDirections.has(directedRoutePair(fromPointId, toPointId))) warnings.push({ code: 'manual_estimate_unverified', fromPointId, toPointId });
      return [{ ...estimate, source: 'manual' }];
    });
    const road = useGoogleRoads && input.stops.length ? await this.roadEstimates(chain, coordinates) : undefined;
    const travelEstimates: RouteTimelineInput['travelEstimates'] = [
      ...(road?.estimates ?? []),
      ...(input.useLocalEstimates ? getLocalDemoRouteEstimates(chain, coordinates) : getDemoRouteEstimates(chain, coordinates)),
      ...manualEstimates,
    ];
    const timeline = calculateRouteTimeline({ ...input, stops, travelEstimates });
    const calendarEntries = await this.calendar.routeEntries(manager, input, timeline.returnAt);
    const resolved = resolveRouteCalendar(input, timeline, calendarEntries);
    const resources = await this.resources(manager, input);
    if (resolved.calendar) resources.calendar = resolved.calendar;
    resources.locationRevisions = [...new Map([locations.start, locations.end].map(({ id, version }) => [id, { id, version }])).values()];
    if (ownRouteId) resources.busy = resources.busy.filter(({ routeId }) => routeId !== ownRouteId);
    const extraFindings: RouteFinding[] = warnings.map(({ code, fromPointId, toPointId }) => ({ severity: 'unknown', code, message: `Review travel estimate ${fromPointId} → ${toPointId}; its address context is missing or changed.` }));
    extraFindings.push(...locationPlanningProblems(locations).map((problem) => ({ severity: 'unknown' as const, ...problem })));
    const pointContexts = [...contexts].map(([pointId, context]) => ({ pointId, ...context }));
    const preview = {
      ...(resolved.calendar ? { calendar: resolved.calendar } : {}),
      timeline, jobs, locations,
      pointContexts, warnings,
      ...(road ? { road: road.status } : {}),
      feasibility: assessRoute(resolved.input, timeline, selected, resources, work, extraFindings, pointContexts),
    };
    return { preview, stops, selected, resources, work, coordinates, manualEstimates, extraFindings, calendarEntries };
  }

  private async resources(manager: EntityManager, input: RouteDraftInput): Promise<RouteResources> {
    const participantIds = new Set(input.planning?.participantIds ?? []);
    const resourceIds = [...participantIds].map((id) => `person:${id}`);
    if (input.crewId) resourceIds.push(`crew:${input.crewId}`);
    if (input.vehicleId) resourceIds.push(`vehicle:${input.vehicleId}`);
    const busy = await rows(manager, z.object({ resource: z.string(), appointmentId: IdSchema, routeId: IdSchema.nullable(), bufferMinutes: z.number().int().min(0).max(240), pickingName: z.string(), startsAt: z.date(), endsAt: z.date() }),
      `WITH busy AS (${RESOURCE_BOOKINGS_SQL})
      SELECT b.resource,b.appointment_id AS "appointmentId",b.route_id AS "routeId",b.buffer_minutes AS "bufferMinutes",
        CASE WHEN b.route_id IS NULL THEN d.data->'source'->>'pickingName' ELSE 'Route: '||(rd.data->>'name') END AS "pickingName",b.starts_at AS "startsAt",b.ends_at AS "endsAt"
        FROM busy b JOIN appointment a ON a.id=b.appointment_id JOIN delivery d ON d.id=a.delivery_id
        LEFT JOIN route_draft rd ON rd.id=b.route_id
        WHERE b.resource=ANY($1::text[]) ORDER BY b.appointment_id,b.resource,b.starts_at,b.ends_at LIMIT 10001`, [resourceIds]);
    if (busy.length > 10000) throw new ConflictException('Route availability exceeds the 10000-reservation local demo limit');
    return {
      participants: (await this.directory.list(manager)).filter(({ id }) => participantIds.has(id)),
      crews: await this.directory.crews(manager, input.crewId ? [input.crewId] : []),
      vehicles: (await this.vehicles.list(manager)).filter(({ id }) => id === input.vehicleId),
      disabledSkillIds: (await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM skill WHERE enabled=false ORDER BY id')).map(({ id }) => id),
      busy: busy.map((entry) => ({ ...entry, startsAt: entry.startsAt.toISOString(), endsAt: entry.endsAt.toISOString() })),
    };
  }

  private async roadEstimates(
    chain: readonly string[], coordinates: ReadonlyMap<string, RoutePointCoordinates>,
  ): Promise<{ status: RouteRoad; estimates?: RouteTravelEstimate[] }> {
    if (!this.googleRoads.configured) return { status: { status: 'unconfigured' } };
    if (chain.length - 2 > MAX_GOOGLE_ROUTE_STOPS) return { status: { status: 'too_many_stops' } };
    const points: RoutePointCoordinates[] = [];
    for (const id of chain) {
      const point = coordinates.get(id);
      if (!point) return { status: { status: 'missing_coordinates' } };
      points.push(point);
    }
    try {
      const { legSeconds, encodedPolyline } = await this.googleRoads.compute(points);
      const estimates = legSeconds.flatMap((seconds, index): RouteTravelEstimate[] => {
        const fromPointId = chain[index];
        const toPointId = chain[index + 1];
        return fromPointId && toPointId
          ? [{ fromPointId, toPointId, minutes: Math.ceil(seconds / 60), source: 'google' }]
          : [];
      });
      return { status: { status: 'ready', encodedPolyline }, estimates };
    } catch (error: unknown) {
      if (!(error instanceof RoadRouteError)) throw error;
      return { status: { status: error.reason === 'not_configured' ? 'unconfigured' : 'unavailable' } };
    }
  }
}
