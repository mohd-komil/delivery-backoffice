import { z } from 'zod';
import { AppointmentSchema, AssignmentSchema, IdSchema, InstantSchema, ResponsibleParticipantSchema, VisitWorkScopeSchema, WorkLinesInputSchema } from '../domain/model';
import { RouteDraftInputSchema, RouteTimelineSchema } from './contracts';
import { RouteFeasibilitySchema } from './feasibility';
import { RouteLocationsSchema } from '../planning/location-contracts';
import { RouteCalendarSchema } from '../planning/calendar-contracts';

const NormalId = IdSchema.toLowerCase();
const StopFields = { deliveryId: NormalId, responsibleParticipantId: NormalId };
export const PublicationStopInputSchema = z.discriminatedUnion('mode', [
  z.object({ ...StopFields, mode: z.literal('create'), workLines: WorkLinesInputSchema,
    templateIds: z.array(NormalId).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, 'Choose every task template once'),
    returnRequestId: NormalId.optional(),
  }).strict(),
  z.object({ ...StopFields, mode: z.literal('attach'), appointmentId: NormalId }).strict(),
]);
export const PublicationReviewInputSchema = z.object({
  version: z.number().int().positive(),
  stops: z.array(PublicationStopInputSchema).min(1).max(30).refine((stops) => new Set(stops.map(({ deliveryId }) => deliveryId)).size === stops.length, 'Choose each delivery once'),
  externalDriverPhone: z.string().trim().min(1).max(200).optional(),
}).strict();
export type PublicationReviewInput = z.infer<typeof PublicationReviewInputSchema>;
export const PublishInputSchema = PublicationReviewInputSchema.extend({
  requestId: NormalId,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeEstimates: z.boolean(),
});
export type PublishInput = z.infer<typeof PublishInputSchema>;
export const PublicationStatusSchema = z.enum(['published', 'in_progress', 'returning', 'returned', 'closed', 'cancelled']);
export const PublicationReviewStopSchema = z.object({
  deliveryId: IdSchema, pickingName: z.string(), mode: z.enum(['create', 'attach']), appointmentId: IdSchema,
  startsAt: InstantSchema, endsAt: InstantSchema,
  workScope: VisitWorkScopeSchema, assignments: z.array(AssignmentSchema), responsibleParticipant: ResponsibleParticipantSchema,
  customerConfirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']),
}).strict();
export const PublicationReviewSchema = z.object({
  calendar: RouteCalendarSchema.optional(),
  routeId: IdSchema, draftVersion: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  publicationEnabled: z.boolean(), timeline: RouteTimelineSchema, feasibility: RouteFeasibilitySchema,
  locations: RouteLocationsSchema.optional(),
  stops: z.array(PublicationReviewStopSchema).min(1).max(30),
}).strict();
export const PublicationSummarySchema = z.object({
  id: IdSchema, version: z.number().int().positive(), status: PublicationStatusSchema, draftVersion: z.number().int().positive(),
  publishedAt: InstantSchema,
  stops: z.array(z.object({ deliveryId: IdSchema, appointmentId: IdSchema, source: z.enum(['created', 'attached']) }).strict()).min(1).max(30),
}).strict();
export const PublicationDetailSchema = PublicationSummarySchema.extend({ review: PublicationReviewSchema });
export const PublicationSnapshotSchema = z.object({
  draft: RouteDraftInputSchema, command: PublicationReviewInputSchema,
  review: PublicationReviewSchema, publishedBy: ResponsibleParticipantSchema,
  publishedAt: InstantSchema, estimateAcknowledged: z.literal(true),
  appointments: z.array(z.object({ deliveryId: IdSchema, appointment: AppointmentSchema }).strict()).min(1).max(30),
}).strict();
