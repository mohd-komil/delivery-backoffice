import { z } from 'zod';
import { GeoPointSchema, IdSchema, InstantSchema, RemainingWorkEstimateSchema } from '../domain/model';
import { RouteAddressKeySchema, RouteDraftInputSchema, RoutePointContextSchema, RoutePointIdSchema, RouteTimelineSchema } from './contracts';
import { RouteFeasibilitySchema } from './feasibility';
import { GeocodingMetadataSchema } from './geocoding-contracts';
import { RouteLocationsSchema } from '../planning/location-contracts';
import { RouteCalendarSchema } from '../planning/calendar-contracts';

export const RouteJobsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  anchorId: IdSchema.optional(),
  radiusKm: z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).refine((value) => Number(value) >= 1 && Number(value) <= 50).optional(),
}).strict().refine(({ radiusKm, anchorId }) => radiusKm === undefined || anchorId !== undefined, 'A radius requires an anchor');

const RouteStopWorkSchema = z.object({
  sourceLineId: z.number().int().positive(),
  orderName: z.string(),
  productName: z.string(),
  uom: z.string(),
  deliveryMilli: z.number().int().nonnegative(),
  installationMilli: z.number().int().nonnegative(),
  collectionMilli: z.number().int().nonnegative(),
});

const RouteWorkReviewReasonSchema = z.enum([
  'source_review', 'prior_work_review', 'unknown_service', 'legacy_scope_review', 'scope_outdated', 'over_reserved',
  'missing_scope', 'source_changed', 'work_changed', 'appointment_unavailable', 'stock_pending', 'damage_hold',
]);
const RouteAppointmentOptionSchema = z.object({
  id: IdSchema, startsAt: InstantSchema, endsAt: InstantSchema,
  customerConfirmed: z.boolean(), needsReview: z.boolean(),
  suggestedWorkMinutes: z.number().int().positive().nullable(),
});

export const RouteJobSchema = z.object({
  deliveryId: IdSchema,
  pickingName: z.string(),
  orderNames: z.array(z.string()),
  customerName: z.string(),
  address: z.string(),
  city: z.string().nullable(),
  point: GeoPointSchema.nullable(),
  entranceConfirmed: z.boolean(),
  geocoding: GeocodingMetadataSchema.optional(),
  addressKey: RouteAddressKeySchema,
  distanceKm: z.number().nonnegative().nullable(),
  suggestedWorkMinutes: z.number().int().positive().nullable(),
  remainingWorkEstimate: RemainingWorkEstimateSchema.optional(),
  remaining: z.array(RouteStopWorkSchema),
  workFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  workBasis: z.enum(['available_remaining', 'appointment']),
  hasAvailableRemaining: z.boolean(),
  appointmentId: IdSchema.nullable(),
  workReviewReason: RouteWorkReviewReasonSchema.nullable(),
  appointmentOptions: z.array(RouteAppointmentOptionSchema),
  planningStatus: z.enum(['unplanned', 'booked', 'confirmed', 'unavailable']),
});
export type RouteJob = z.infer<typeof RouteJobSchema>;
export const RouteJobsSchema = z.object({
  jobs: z.array(RouteJobSchema),
  anchorJob: RouteJobSchema.nullable(),
  anchorHasCoordinates: z.boolean().nullable(),
});
export const RouteRoadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), encodedPolyline: z.string().min(1).max(500_000) }),
  z.object({ status: z.enum(['unconfigured', 'missing_coordinates', 'too_many_stops', 'unavailable']) }),
]);
export type RouteRoad = z.infer<typeof RouteRoadSchema>;
export const RouteWarningSchema = z.object({
  code: z.enum(['manual_estimate_stale', 'manual_estimate_unverified']),
  fromPointId: RoutePointIdSchema, toPointId: RoutePointIdSchema,
}).strict();
export const RoutePreviewSchema = z.object({
  calendar: RouteCalendarSchema.optional(),
  timeline: RouteTimelineSchema, jobs: z.array(RouteJobSchema), road: RouteRoadSchema.optional(),
  pointContexts: z.array(RoutePointContextSchema.extend({ pointId: RoutePointIdSchema })).max(32),
  warnings: z.array(RouteWarningSchema).max(31),
  feasibility: RouteFeasibilitySchema,
  locations: RouteLocationsSchema.optional(),
});
export const RouteSuggestionSchema = z.object({
  status: z.enum(['suggested', 'no_improvement_found', 'insufficient_data']),
  objective: z.enum(['travel_minutes', 'return_time']),
  current: RoutePreviewSchema,
  suggested: RoutePreviewSchema.nullable(),
  deliveryIds: z.array(IdSchema).max(30),
  travelMinutesSaved: z.number().nullable(), totalMinutesSaved: z.number().nullable(),
  evaluatedOrders: z.number().int().nonnegative(),
  explanation: z.string(),
});
const DraftMetadataSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});
export const RouteDetailSchema = RouteDraftInputSchema.extend({ ...DraftMetadataSchema.shape, ...RoutePreviewSchema.shape });
export const RouteDraftListSchema = z.object({
  drafts: z.array(DraftMetadataSchema.omit({ createdAt: true }).extend({
    name: z.string(), departAt: InstantSchema, stopCount: z.number().int().nonnegative(),
  })),
  points: z.array(GeoPointSchema.extend({ id: RoutePointIdSchema, name: z.string() })),
  googleMaps: z.object({ key: z.string(), mapId: z.string().optional() }).nullable(),
  roadRoutingEnabled: z.boolean(),
});
