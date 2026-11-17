import { z } from 'zod';
import { DestinationAddressKeySchema } from '../domain/destination-address';
import { GeoPointSchema, IdSchema, InstantSchema } from '../domain/model';

export const RoutePointIdSchema = z.string().trim().min(1).max(80);
export const RoutePointCoordinatesSchema = GeoPointSchema;
export type RoutePointCoordinates = z.infer<typeof RoutePointCoordinatesSchema>;
export const RouteAddressKeySchema = DestinationAddressKeySchema;
export const RoutePinSchema = GeoPointSchema.extend({ addressKey: RouteAddressKeySchema });

export function directedRoutePair(fromPointId: string, toPointId: string) {
  return JSON.stringify([fromPointId, toPointId]);
}

export const RoutePointContextSchema = z.object({
  point: GeoPointSchema.nullable(),
  addressKey: RouteAddressKeySchema.nullable(),
}).strict();
export type RoutePointContext = z.infer<typeof RoutePointContextSchema>;
export const RouteManualEstimateSchema = z.object({
  fromPointId: RoutePointIdSchema,
  toPointId: RoutePointIdSchema,
  minutes: z.number().int().min(0).max(1440),
  context: z.object({ from: RoutePointContextSchema, to: RoutePointContextSchema }).strict().optional(),
}).strict();
export const RouteTravelSourceSchema = z.enum(['demo', 'local_demo', 'manual', 'google']);
export const RouteTravelEstimateSchema = RouteManualEstimateSchema.extend({ source: RouteTravelSourceSchema });
export type RouteTravelEstimate = z.infer<typeof RouteTravelEstimateSchema>;

export const RouteIntervalSchema = z.object({ startsAt: InstantSchema, endsAt: InstantSchema }).strict()
  .refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt), 'The interval must end after it starts');
export const RouteCustomerWindowSchema = z.union([
  z.object({ kind: z.enum(['unknown', 'unrestricted']) }).strict(),
  z.object({ kind: z.enum(['arrival', 'work_end']), startsAt: InstantSchema, endsAt: InstantSchema }).strict()
    .refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt), 'The customer window must end after it starts'),
]);
export const RouteWorkDurationSourceSchema = z.enum(['manual', 'remaining_estimate', 'unknown']);
export const RoutePlanningSchema = z.object({
  availabilityMode: z.enum(['manual', 'shared_calendar']).optional(),
  participantIds: z.array(IdSchema).max(100).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Select each participant once'),
  participantAvailability: z.array(z.object({
    participantId: IdSchema,
    workingIntervals: z.array(RouteIntervalSchema).max(30),
    unavailableIntervals: z.array(z.object({ startsAt: InstantSchema, endsAt: InstantSchema, kind: z.enum(['break', 'absence']) }).strict()
      .refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt), 'The interval must end after it starts')).max(60),
  }).strict()).max(100).refine((entries) => new Set(entries.map(({ participantId }) => participantId.toLowerCase())).size === entries.length,
    'Enter availability once per participant'),
  vehicleAvailability: RouteIntervalSchema.nullable(),
  driver: z.union([
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('unknown') }).strict(),
    z.object({ kind: z.literal('participant'), participantId: IdSchema }).strict(),
    z.object({ kind: z.literal('external'), name: z.string().trim().min(1).max(200), availability: RouteIntervalSchema.nullable() }).strict(),
  ]).default({ kind: 'none' }),
  transferBufferMinutes: z.number().int().min(0).max(240).nullable(),
}).strict();
export const RouteSuggestionObjectiveSchema = z.enum(['travel_minutes', 'return_time']);

export const RouteDraftInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  departAt: InstantSchema.refine((value) => Number.isFinite(Date.parse(value)), 'Departure must be a valid timestamp'),
  crewId: IdSchema.nullable(),
  vehicleId: IdSchema.nullable(),
  startPointId: RoutePointIdSchema,
  endPointId: RoutePointIdSchema,
  stops: z.array(z.object({
    deliveryId: IdSchema,
    appointmentId: IdSchema.optional(),
    workMinutes: z.number().int().min(1).max(1440).nullable(),
    workDurationSource: RouteWorkDurationSourceSchema.optional(),
    workFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    customerWindow: RouteCustomerWindowSchema.optional(),
    pin: RoutePinSchema.optional(),
  }).strict()).max(30).refine((stops) => new Set(stops.map(({ deliveryId }) => deliveryId.toLowerCase())).size === stops.length,
    'Add each delivery only once'),
  manualEstimates: z.array(RouteManualEstimateSchema).max(100).refine((estimates) =>
    new Set(estimates.map(({ fromPointId, toPointId }) => directedRoutePair(fromPointId, toPointId))).size === estimates.length,
  'Enter only one manual estimate for each directed leg'),
  useLocalEstimates: z.boolean().default(false),
  planning: RoutePlanningSchema.optional(),
}).strict();
export type RouteDraftInput = z.infer<typeof RouteDraftInputSchema>;

/** Legacy snapshots keep their driver. Current planning always reserves the vehicle and actual crew. */
export function withoutRouteDriver(input: RouteDraftInput): RouteDraftInput {
  return input.planning ? { ...input, planning: { ...input.planning, driver: { kind: 'none' } } } : input;
}

export const RouteCreateInputSchema = RouteDraftInputSchema.extend({ requestId: IdSchema });
export const RouteUpdateInputSchema = RouteDraftInputSchema.extend({ version: z.number().int().positive() });
export const RoutePreviewInputSchema = RouteDraftInputSchema.extend({ useGoogleRoads: z.boolean().optional() });
export const RouteSuggestInputSchema = RoutePreviewInputSchema.extend({ objective: RouteSuggestionObjectiveSchema });

const NullableMinutes = z.number().nonnegative().nullable();
export const RouteTimelineSchema = z.object({
  departAt: InstantSchema,
  startPointId: RoutePointIdSchema,
  endPointId: RoutePointIdSchema,
  stops: z.array(z.object({
    deliveryId: IdSchema,
    fromPointId: RoutePointIdSchema,
    travelStartAt: InstantSchema.nullable(),
    workMinutes: z.number().int().min(1).max(1440).nullable(),
    windowKind: z.enum(['unknown', 'unrestricted', 'arrival', 'work_end']).optional(),
    windowStart: InstantSchema.nullable(),
    windowEnd: InstantSchema.nullable(),
    windowStatus: z.enum(['none', 'confirmed', 'ambiguous']),
    eta: InstantSchema.nullable(),
    workStartAt: InstantSchema.nullable(),
    workEndAt: InstantSchema.nullable(),
    waitMinutes: NullableMinutes,
    late: z.boolean().nullable(),
    travelMinutes: NullableMinutes,
    travelSource: RouteTravelSourceSchema.nullable(),
  }).strict()).max(30),
  returnDepartAt: InstantSchema.nullable(),
  returnAt: InstantSchema.nullable(),
  returnTravelMinutes: NullableMinutes,
  returnTravelSource: RouteTravelSourceSchema.nullable(),
  travelMinutes: NullableMinutes,
  workMinutes: z.number().int().nonnegative().nullable(),
  waitingMinutes: NullableMinutes,
  totalMinutes: NullableMinutes,
}).strict();
export type RouteTimeline = z.infer<typeof RouteTimelineSchema>;
