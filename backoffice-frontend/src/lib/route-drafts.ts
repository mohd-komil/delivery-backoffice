import { z } from 'zod';
import { remainingWorkEstimateSchema } from './contracts';
import { coordinateFromText, mapCoordinatesSchema as coordinates } from './map-coordinates';

const instant = z.iso.datetime({ offset: true });
const nullableMinutes = z.number().nonnegative().nullable();
const pointId = z.string().min(1).max(80);
const addressKey = z.string().regex(/^[a-f0-9]{64}$/);
const pin = coordinates.extend({ addressKey });
const point = coordinates.extend({ id: pointId, name: z.string() });
const interval = z.object({ startsAt: instant, endsAt: instant }).refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), 'End must follow start.');
export const routeWindowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['unknown', 'unrestricted']) }),
  z.object({ kind: z.enum(['arrival', 'work_end']), startsAt: instant, endsAt: instant }),
]);
export type RouteWindow = z.infer<typeof routeWindowSchema>;
export const routePlanningSchema = z.object({
  participantIds: z.array(z.uuid()),
  participantAvailability: z.array(z.object({ participantId: z.uuid(), workingIntervals: z.array(interval),
    unavailableIntervals: z.array(z.object({ startsAt: instant, endsAt: instant, kind: z.enum(['break', 'absence']) })) })),
  vehicleAvailability: interval.nullable(),
  driver: z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }),
    z.object({ kind: z.literal('participant'), participantId: z.uuid() }),
    z.object({ kind: z.literal('external'), name: z.string().min(1), availability: interval.nullable() })]),
  transferBufferMinutes: z.number().int().nonnegative().nullable(),
});
export type RoutePlanning = z.infer<typeof routePlanningSchema>;
const stop = z.object({ deliveryId: z.uuid(), appointmentId: z.uuid().optional(), workMinutes: z.number().int().min(1).max(1440).nullable(),
  workDurationSource: z.enum(['manual', 'remaining_estimate', 'unknown']).optional(), workFingerprint: addressKey.optional(), customerWindow: routeWindowSchema.optional(), pin: pin.optional() });
const pointContext = z.object({ point: coordinates.nullable(), addressKey: addressKey.nullable() });
const manualContext = z.object({ from: pointContext, to: pointContext });
const manualEstimate = z.object({ fromPointId: pointId, toPointId: pointId, minutes: z.number().int().min(0).max(1440), context: manualContext.optional() });
export type RouteManualContext = z.infer<typeof manualContext>;

export type RoutePinFields = { latitude: string; longitude: string; addressKey: string };

export function parseRoutePin(fields: RoutePinFields | undefined) {
  if (!fields || (!fields.latitude.trim() && !fields.longitude.trim())) return { success: true, data: undefined } as const;
  return pin.safeParse({
    latitude: coordinateFromText(fields.latitude), longitude: coordinateFromText(fields.longitude), addressKey: fields.addressKey,
  });
}

export const routeDraftInputSchema = z.object({
  name: z.string().trim().min(1).max(120), departAt: instant, crewId: z.uuid().nullable(), vehicleId: z.uuid().nullable(),
  useLocalEstimates: z.boolean().default(false),
  startPointId: pointId, endPointId: pointId, stops: z.array(stop).min(1).max(30),
  manualEstimates: z.array(manualEstimate).max(100),
  planning: routePlanningSchema.optional(),
});
export type RouteDraftInput = z.infer<typeof routeDraftInputSchema>;
export const routeJobSchema = z.object({
  deliveryId: z.uuid(), pickingName: z.string(), orderNames: z.array(z.string()), customerName: z.string(),
  address: z.string().nullable(), city: z.string().nullable(), point: coordinates.nullable(), addressKey: addressKey.optional(), distanceKm: z.number().nonnegative().nullable(),
  entranceConfirmed: z.boolean().optional(),
  remainingWorkEstimate: remainingWorkEstimateSchema.optional(),
  workFingerprint: addressKey.optional(),
  workBasis: z.enum(['available_remaining', 'appointment']).optional(),
  hasAvailableRemaining: z.boolean().optional(),
  appointmentId: z.uuid().nullable().optional(),
  workReviewReason: z.enum(['source_review', 'unknown_service', 'legacy_scope_review', 'scope_outdated', 'over_reserved',
    'missing_scope', 'source_changed', 'work_changed', 'appointment_unavailable', 'stock_pending', 'damage_hold']).nullable().optional(),
  appointmentOptions: z.array(z.object({ id: z.uuid(), startsAt: instant, endsAt: instant, customerConfirmed: z.boolean(),
    needsReview: z.boolean(), suggestedWorkMinutes: z.number().int().positive().nullable() })).optional(),
  suggestedWorkMinutes: z.number().int().positive().nullable(), planningStatus: z.enum(['unplanned', 'booked', 'confirmed', 'unavailable']),
  remaining: z.array(z.object({
    sourceLineId: z.number().int().positive(), orderName: z.string().nullable(), productName: z.string(), uom: z.string(),
    deliveryMilli: z.number().int().nonnegative(), installationMilli: z.number().int().nonnegative(), collectionMilli: z.number().int().nonnegative(),
  })),
});
export type RouteJob = z.infer<typeof routeJobSchema>;
export const routeJobsSchema = z.object({ jobs: z.array(routeJobSchema), anchorJob: routeJobSchema.nullable().optional(), anchorHasCoordinates: z.boolean().nullable() });
export type RouteJobs = z.infer<typeof routeJobsSchema>;
export const nearbyRadiusSchema = z.string().trim().transform((value) => value.replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/)).transform(Number).pipe(z.number().min(1).max(50));

export function routeWorkMinutes(job: RouteJob) { return job.suggestedWorkMinutes; }

const travelSource = z.enum(['demo', 'local_demo', 'manual', 'google']).nullable();
const timeline = z.object({
  departAt: instant, startPointId: pointId, endPointId: pointId, returnDepartAt: instant.nullable(),
  stops: z.array(z.object({
    deliveryId: z.uuid(), eta: instant.nullable(), workStartAt: instant.nullable(), workEndAt: instant.nullable(),
    fromPointId: pointId, travelStartAt: instant.nullable(), workMinutes: z.number().int().positive().nullable(),
    windowStart: instant.nullable(), windowEnd: instant.nullable(), windowStatus: z.enum(['none', 'confirmed', 'ambiguous']),
    waitMinutes: nullableMinutes, late: z.boolean().nullable(), travelMinutes: nullableMinutes, travelSource,
    windowKind: z.enum(['unknown', 'unrestricted', 'arrival', 'work_end']).optional(),
  })),
  returnAt: instant.nullable(), returnTravelMinutes: nullableMinutes, returnTravelSource: travelSource,
  travelMinutes: nullableMinutes, workMinutes: nullableMinutes, waitingMinutes: nullableMinutes, totalMinutes: nullableMinutes,
});

const road = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), encodedPolyline: z.string().min(1).max(500_000) }),
  z.object({ status: z.enum(['unconfigured', 'missing_coordinates', 'too_many_stops', 'unavailable']) }),
]);
export const routePreviewSchema = z.object({
  timeline, jobs: z.array(routeJobSchema), road: road.optional(),
  pointContexts: z.array(pointContext.extend({ pointId })),
  warnings: z.array(z.object({ code: z.enum(['manual_estimate_stale', 'manual_estimate_unverified']), fromPointId: pointId, toPointId: pointId })),
  feasibility: z.object({ status: z.enum(['conflict', 'insufficient_data', 'feasible_estimate']), checkedAt: instant, fingerprint: z.string(),
    findings: z.array(z.object({ severity: z.enum(['conflict', 'unknown']), code: z.string(), message: z.string(),
      deliveryId: z.uuid().optional(), resourceId: z.string().optional(), startsAt: instant.optional(), endsAt: instant.optional() })),
    workDurations: z.array(z.object({ deliveryId: z.uuid(), minutes: nullableMinutes, source: z.enum(['manual', 'remaining_estimate', 'unknown']) })),
  }).optional(),
});
export type RoutePreview = z.infer<typeof routePreviewSchema>;
export const routeSuggestionSchema = z.object({
  status: z.enum(['suggested', 'no_improvement_found', 'insufficient_data']), objective: z.enum(['travel_minutes', 'return_time']),
  current: routePreviewSchema, suggested: routePreviewSchema.nullable(), deliveryIds: z.array(z.uuid()),
  travelMinutesSaved: z.number().nullable(), totalMinutesSaved: z.number().nullable(), evaluatedOrders: z.number().int().nonnegative(),
});
export type RouteSuggestion = z.infer<typeof routeSuggestionSchema>;
export const routeDraftSchema = routeDraftInputSchema.extend({
  id: z.uuid(), version: z.number().int().positive(), createdAt: instant, updatedAt: instant,
  ...routePreviewSchema.shape,
});
export type RouteDraft = z.infer<typeof routeDraftSchema>;
export const routeListSchema = z.object({
  drafts: z.array(z.object({ id: z.uuid(), name: z.string(), departAt: instant, version: z.number().int().positive(), stopCount: z.number().int().nonnegative(), updatedAt: instant })),
  points: z.array(point),
  googleMaps: z.object({ key: z.string().min(1), mapId: z.string().optional() }).nullable().optional(),
  roadRoutingEnabled: z.boolean().optional(),
});
export type RoutePoint = z.infer<typeof point>;
export type RouteList = z.infer<typeof routeListSchema>;

/** Choose a provisional departure only; this does not estimate driving distance or travel time. */
export function nearestRoutePoint(points: readonly RoutePoint[], destination: RouteJob['point']): RoutePoint | undefined {
  if (!destination) return points[0];
  const radians = Math.PI / 180;
  const proximity = (point: RoutePoint) => Math.sin((point.latitude - destination.latitude) * radians / 2) ** 2
    + Math.cos(point.latitude * radians) * Math.cos(destination.latitude * radians)
      * Math.sin((point.longitude - destination.longitude) * radians / 2) ** 2;
  return points.reduce<RoutePoint | undefined>((nearest, candidate) =>
    !nearest || proximity(candidate) < proximity(nearest) ? candidate : nearest, undefined);
}

