import { z } from 'zod';
import { AppointmentSchema, ChecklistItemSchema, CrewDrawingInputSchema, CustomerDrawingInputSchema, DeliverySchema, IdSchema, IncompleteWorkSchema, InstantSchema, InstructionsSchema, IssueInputSchema, ItemChecksSchema, LineServiceStatusSchema, MAX_VISIT_EVIDENCE, QuantityResultSchema, ResponsibleParticipantSchema, ScopeReviewReasonSchema, ServiceTypeSchema, SignatureRefusalSchema, SourceItemSchema, SourceSchema, TaskSchema, TextSchema, VehicleSnapshotSchema, WorkLineInputSchema } from '../domain/model';
import { CrewDocumentSchema, FilePayloadSchema } from '../evidence/files';
import { ParticipantSchema, VersionSchema } from '../operations/contracts';

export const CrewLoginInput = z.object({
  login: ParticipantSchema.shape.login.unwrap(),
  password: z.string().min(1).max(256),
}).strict();
export const CrewLogoutInput = z.object({}).strict();
export const CrewLogoutResult = z.object({ ok: z.literal(true) }).strict();
export const CrewProfileSchema = z.object({ id: IdSchema, name: TextSchema, role: z.literal('crew') }).strict();
export type CrewProfile = z.infer<typeof CrewProfileSchema>;

export const CrewStartInput = VersionSchema.extend({ requestId: IdSchema }).strict();
export const CrewAttemptFailureInput = CrewStartInput.extend({ reason: TextSchema });
export const CrewChecklistInput = CrewStartInput.extend({ done: z.boolean() });
export const CrewIssueInput = CrewStartInput.extend({
  type: IssueInputSchema.shape.type,
  description: IssueInputSchema.shape.description,
  itemIds: IssueInputSchema.shape.itemIds.refine((ids) => new Set(ids).size === ids.length, 'Item IDs must be distinct'),
  photo: FilePayloadSchema,
});
export const CREW_FINISH_PHOTOS_MAX_BYTES = 20 * 1024 * 1024;
export const CREW_FINISH_JSON_MAX_BYTES = 32 * 1024 * 1024;
const CompletionPhotos = z.array(FilePayloadSchema.extend({ sourceLineId: SourceItemSchema.shape.sourceLineId.optional() }))
  .max(MAX_VISIT_EVIDENCE)
  // This measures canonical base64 without allocating decoded buffers. File inspection rejects noncanonical data.
  .refine((photos) => photos.reduce((total, { base64 }) => total + Buffer.byteLength(base64, 'base64'), 0)
    <= CREW_FINISH_PHOTOS_MAX_BYTES, 'Combined photos must not exceed 20 MiB');

export const CrewFinishInput = CrewStartInput.extend({
  summary: TextSchema,
  quantities: z.array(QuantityResultSchema).max(500),
  itemChecks: ItemChecksSchema.optional(),
  incompleteWork: IncompleteWorkSchema.optional(),
  actualStart: InstantSchema.optional(),
  customerSignature: CustomerDrawingInputSchema.optional(),
  signatureRefusal: SignatureRefusalSchema.optional(),
  crewSignature: CrewDrawingInputSchema,
  photos: CompletionPhotos,
}).refine(({ customerSignature, signatureRefusal }) => customerSignature !== undefined || signatureRefusal !== undefined,
  { path: ['customerSignature'], message: 'Capture the customer signature or report the reason for refusal' })
  .refine(({ photos, signatureRefusal }) => photos.length > 0 || signatureRefusal !== undefined,
    { path: ['photos'], message: 'Add at least one photo of the completed work' });

const Customer = SourceSchema.shape.customer;
const CrewVisitSummarySchema = AppointmentSchema.pick({ id: true, startsAt: true, endsAt: true }).extend({
  pickingName: SourceSchema.shape.pickingName,
  status: AppointmentSchema.shape.status.exclude(['cancelled']),
  confirmationStatus: z.enum(['awaiting_customer_confirmation', 'customer_confirmed']).nullable(),
  destination: Customer.pick({ address: true, city: true, country: true }),
  crews: z.array(z.object({ id: IdSchema, name: TextSchema }).strict()),
  vehicles: z.array(VehicleSnapshotSchema.pick({ id: true, name: true, plate: true })),
  route: z.object({ id: IdSchema, name: z.string(), status: z.enum(['published', 'in_progress', 'returning', 'returned', 'closed']), version: z.number().int().positive() }).nullable().optional(),
  routeStartBlocker: z.string().nullable().optional(),
});
export const CREW_VISIT_LIST_LIMIT = 200;
export const CrewVisitListSchema = z.object({ visits: z.array(CrewVisitSummarySchema).max(CREW_VISIT_LIST_LIMIT) }).strict();
export const CrewVisitDetailSchema = CrewVisitSummarySchema.extend({
  version: DeliverySchema.shape.version,
  responsibleParticipant: ResponsibleParticipantSchema.nullable(),
  canFinish: z.boolean(),
  canStart: z.boolean(),
  signatureRefusalStatus: z.enum(['pending', 'approved', 'corrected']).optional(),
  scopeReviewReason: ScopeReviewReasonSchema,
  workScope: z.object({revision:z.number().int().positive(),confirmedAt:InstantSchema,
    lines:z.array(WorkLineInputSchema.safeExtend({service:ServiceTypeSchema})).min(1).max(500)}).strict().nullable(),
  failedAttempt: AppointmentSchema.shape.failedAttempt,
  actualStartedAt: InstantSchema.nullable(),
  unfinishedChecklistCount: z.number().int().nonnegative(),
  customer: Customer.pick({ name: true, contact: true, phones: true }),
  instructions: InstructionsSchema,
  documents: z.array(CrewDocumentSchema.omit({size:true}).strict()).max(200).optional(),
  issues:z.array(DeliverySchema.shape.issues.element.pick({id:true,type:true,description:true,itemIds:true,appointmentId:true,status:true})).optional(),
  items: z.array(SourceItemSchema.pick({ sourceLineId: true, name: true, quantity: true, uom: true, configuration: true, notes: true }).extend({
    orderName: SourceSchema.shape.saleOrderName.optional(),
    remainingMilli: QuantityResultSchema.shape.deliveredMilli,
    serviceWork: LineServiceStatusSchema.pick({
      service: true, remainingDeliveryMilli: true, remainingInstallationMilli: true, remainingCollectionMilli: true,
    }).extend({ availableInstallationMilli: QuantityResultSchema.shape.deliveredMilli,
      plannedDeliveryMilli:QuantityResultSchema.shape.deliveredMilli,plannedInstallationMilli:QuantityResultSchema.shape.deliveredMilli,
      plannedCollectionMilli:QuantityResultSchema.shape.deliveredMilli }).optional(),
  })),
  tasks: z.array(TaskSchema.pick({ id: true, title: true }).extend({
    checklist: z.array(ChecklistItemSchema.pick({ id: true, label: true, done: true }).extend({ waived: z.boolean() })),
  })),
});

export type CrewVisitSummary = z.infer<typeof CrewVisitSummarySchema>;
export type CrewVisitDetail = z.infer<typeof CrewVisitDetailSchema>;
