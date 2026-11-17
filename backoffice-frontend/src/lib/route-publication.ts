import { z } from 'zod';
import { appointmentSchema, workLineSchema, workScopeSchema } from './contracts';
import { routePreviewSchema } from './route-drafts';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const createStop = z.object({
  mode: z.literal('create'), deliveryId: id, workLines: z.array(workLineSchema).min(1).max(500),
  templateIds: z.array(id).min(1), responsibleParticipantId: id, returnRequestId: id.optional(),
}).strict();
const attachStop = z.object({
  mode: z.literal('attach'), deliveryId: id, appointmentId: id, responsibleParticipantId: id,
}).strict();
export const publicationRequestSchema = z.object({
  version: z.number().int().positive(), stops: z.array(z.discriminatedUnion('mode', [createStop, attachStop])).min(1).max(30),
  externalDriverPhone: z.string().trim().min(1).max(200).optional(),
}).strict();
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;
export const publicationCapabilitySchema = z.object({ enabled: z.boolean(), reason: z.string().nullable() });
export const publicationSummarySchema = z.object({
  id, version: z.number().int().positive(), status: z.enum(['published', 'in_progress', 'returning', 'returned', 'closed', 'cancelled']),
  draftVersion: z.number().int().positive(), publishedAt: instant,
  stops: z.array(z.object({ deliveryId: id, appointmentId: id, source: z.enum(['created', 'attached']) })),
});
export type PublicationSummary = z.infer<typeof publicationSummarySchema>;
export const publicationReviewSchema = z.object({
  calendar: routePreviewSchema.shape.calendar, locations: routePreviewSchema.shape.locations,
  routeId: id, draftVersion: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  publicationEnabled: z.boolean(), timeline: routePreviewSchema.shape.timeline,
  feasibility: routePreviewSchema.shape.feasibility.unwrap(),
  stops: z.array(z.object({
    deliveryId: id, pickingName: z.string(), mode: z.enum(['create', 'attach']), appointmentId: id,
    startsAt: instant, endsAt: instant, workScope: workScopeSchema,
    assignments: appointmentSchema.shape.assignments,
    responsibleParticipant: z.object({ id, name: z.string() }),
    customerConfirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']),
  })),
});
export type PublicationReview = z.infer<typeof publicationReviewSchema>;
export const publicationDetailSchema = publicationSummarySchema.extend({ review: publicationReviewSchema.optional() });
export type PublicationDetail = z.infer<typeof publicationDetailSchema>;
