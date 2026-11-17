import { z } from 'zod';
import { SignatureStrokesSchema } from './signature-strokes';
import { AddressGeographySchema } from './delivery-geography';

export const IdSchema = z.string().uuid();
export const TextSchema = z.string().trim().min(1).max(2000);
export const InstantSchema = z.string().datetime({ offset: true });
export const NullableTextSchema = z.string().max(4000).nullable();
export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
}).strict();

export const SourceItemSchema = z.object({
  sourceLineId: z.number().int().positive(),
  saleOrderId: z.number().int().positive().optional(),
  // Optional source provenance; physical work remains keyed by stock_move.id (sourceLineId).
  saleOrderLineId: z.number().int().positive().nullable().optional(),
  orderLinkBasis: z.enum(['sale_order_line', 'procurement_group']).optional(),
  productId: z.number().int().positive(),
  sku: z.string().max(200).nullable().optional(),
  name: TextSchema,
  description: NullableTextSchema,
  quantity: z.number().nonnegative().max(1_000_000).refine((value) =>
    Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
  'Quantity supports at most three decimal places'),
  uom: TextSchema,
  uomId: z.number().int().positive().optional(),
  configuration: NullableTextSchema,
  ambient: NullableTextSchema,
  notes: NullableTextSchema,
  photoUrl: z.string().url().nullable(),
}).strict();
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceSchema = z.object({
  pickingId: z.number().int().positive(),
  pickingName: TextSchema,
  saleOrderId: z.number().int().positive(),
  saleOrderName: TextSchema,
  // Optional for immutable snapshots recorded before multi-order pickings were supported.
  salesOrders: z.array(z.object({ id: z.number().int().positive(), name: TextSchema }).strict()).min(1).max(100).optional(),
  sourceState: TextSchema,
  salesTeam: TextSchema,
  customer: z.object({
    id: z.number().int().positive(),
    name: TextSchema,
    address: NullableTextSchema,
    addressSource: z.enum(['picking', 'move_order_shipping']).optional(),
    city: NullableTextSchema,
    postalCode: z.string().max(20).nullable().optional(),
    province: z.string().max(100).nullable().optional(),
    country: NullableTextSchema,
    phones: z.array(TextSchema).max(10),
    email: z.string().email().nullable(),
    contact: NullableTextSchema,
  }).strict(),
  items: z.array(SourceItemSchema).max(500),
  serviceType: NullableTextSchema,
  estimatedMinutes: z.number().int().positive().max(10080).nullable(),
  notes: NullableTextSchema,
}).strict().refine((source) => new Set(source.items.map((item) => item.sourceLineId)).size === source.items.length,
  'Source line IDs must be unique').superRefine((source, context) => {
  if (!source.salesOrders) return;
  const orderIds = new Set(source.salesOrders.map((order) => order.id));
  if (orderIds.size !== source.salesOrders.length || !orderIds.has(source.saleOrderId)) {
    context.addIssue({ code: 'custom', path: ['salesOrders'], message: 'Orders must be unique and include the primary reference' });
  }
  for (const [index, item] of source.items.entries()) {
    if (item.saleOrderId === undefined || !orderIds.has(item.saleOrderId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'saleOrderId'], message: 'Each product line must reference an order in this picking' });
    }
  }
});
export type SourceSnapshot = z.infer<typeof SourceSchema>;

export const SourceRevisionRowSchema = z.object({
  entity: z.string().regex(/^[a-z_]+$/).max(80), id: z.number().int().positive(),
  writeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).nullable(),
  rowHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const SourceEvidenceSchema = z.object({ rows: z.array(SourceRevisionRowSchema).max(10000), readComplete: z.boolean() }).strict();
export const SourceCandidateSchema = z.object({
  id: IdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), firstSeenAt: InstantSchema,
  source: SourceSchema.nullable(), qualifies: z.boolean(), evidence: SourceEvidenceSchema,
  reasons: z.array(z.string().max(100)).max(20),
}).strict();
export const SourceImportStateSchema = z.object({
  acceptedHash: z.string().regex(/^[a-f0-9]{64}$/), acceptedEvidence: SourceEvidenceSchema,
  pending: SourceCandidateSchema.nullable(), keptHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  keptEvidence: SourceEvidenceSchema.nullable(), lastRejectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  eligible: z.boolean(), acceptedEligible: z.boolean(),
}).strict();
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
export type SourceImportState = z.infer<typeof SourceImportStateSchema>;

export const InstructionsSchema = z.object({
  floor: z.number().int().min(-10).max(200).nullable(),
  elevator: z.enum(['unknown', 'yes', 'no']),
  access: NullableTextSchema,
  parking: NullableTextSchema,
  restrictions: NullableTextSchema,
  notes: NullableTextSchema,
}).strict();

export const SkillNameSchema = z.string().trim().min(1).max(200);
export const SkillIdsSchema = z.array(IdSchema).max(100).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Duplicate skill IDs');
export const SkillSnapshotSchema = z.object({ id: IdSchema, name: SkillNameSchema }).strict();
export type SkillSnapshot = z.infer<typeof SkillSnapshotSchema>;
export const PersonSnapshotSchema = z.object({
  id: IdSchema, name: TextSchema, external: z.boolean(),
  skillsSnapshot: z.array(SkillSnapshotSchema).max(100).optional(),
}).strict();
export type PersonSnapshot = z.infer<typeof PersonSnapshotSchema>;
export const SeveritySchema = z.enum(['low', 'medium', 'high']);
export const TaskTemplateSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  title: TextSchema,
  severity: SeveritySchema,
  order: z.number().int().min(0).max(999),
  checklist: z.array(TextSchema).min(1).max(100),
  enabled: z.boolean(),
  requiredSkillIds: SkillIdsSchema.optional(),
}).strict();
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export const WaiverSchema = z.object({ reason: TextSchema, actorId: IdSchema, at: InstantSchema }).strict();
export const ChecklistItemSchema = z.object({
  id: IdSchema, label: TextSchema, done: z.boolean(), waiver: WaiverSchema.nullable(),
}).strict();
export const TaskSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  title: TextSchema,
  severity: SeveritySchema,
  order: z.number().int().min(0).max(999),
  checklist: z.array(ChecklistItemSchema).min(1).max(100),
  requiredSkillsSnapshot: z.array(SkillSnapshotSchema).max(100).optional(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;
export const AssignmentSchema = z.object({
  id: IdSchema,
  crewId: IdSchema,
  crewName: TextSchema,
  people: z.array(PersonSnapshotSchema).min(1).max(100),
  tasks: z.array(TaskSchema).min(1).max(100),
}).strict();
export type Assignment = z.infer<typeof AssignmentSchema>;

export const VehicleOwnershipSchema = z.enum(['company', 'external']);
export const VehicleOperationalStatusSchema = z.enum(['available', 'maintenance', 'out_of_service']);
export const VehicleNameSchema = z.string().trim().min(1).max(200);
export const VehiclePlateSchema = z.string().trim().toUpperCase().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9 -]*$/u);
export const VehicleSnapshotSchema = z.object({
  id: IdSchema, version: z.number().int().positive(), ownership: VehicleOwnershipSchema,
  name: VehicleNameSchema, plate: VehiclePlateSchema,
  providerName: VehicleNameSchema.nullable(), providerContact: z.string().trim().min(1).max(500).nullable(),
}).strict();
export const TransportDriverSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('participant'), person: PersonSnapshotSchema }).strict(),
  z.object({ kind: z.literal('external'), name: VehicleNameSchema, phone: z.string().trim().min(1).max(200) }).strict(),
]);
export const OperatorSnapshotSchema = z.object({ id: IdSchema, name: TextSchema }).strict();
export const TransportAllocationSchema = z.object({
  id: IdSchema, vehicle: VehicleSnapshotSchema, driver: TransportDriverSnapshotSchema,
  reserveFrom: InstantSchema, reserveTo: InstantSchema,
  status: z.enum(['active', 'replaced', 'cancelled']),
  createdAt: InstantSchema, createdBy: OperatorSnapshotSchema,
  replacesAllocationId: IdSchema.nullable(),
  retiredAt: InstantSchema.nullable(), retiredBy: OperatorSnapshotSchema.nullable(), retirementReason: NullableTextSchema,
}).strict();
export type TransportAllocation = z.infer<typeof TransportAllocationSchema>;

export const CrewDrawingInputSchema = z.object({ strokes: SignatureStrokesSchema }).strict();
export const CustomerDrawingInputSchema = CrewDrawingInputSchema.extend({
  signerName: TextSchema.max(200).refine((value) => !/\p{Cc}/u.test(value), 'Signer name cannot contain control characters'),
});
export type CrewDrawingInput = z.infer<typeof CrewDrawingInputSchema>;
export type CustomerDrawingInput = z.infer<typeof CustomerDrawingInputSchema>;

const DrawnSignatureSchema = CrewDrawingInputSchema.extend({
  status: z.literal('signed'), capture: z.literal('drawn'), signerName: TextSchema, at: InstantSchema,
});
export const SignatureSchema = z.union([
  DrawnSignatureSchema,
  z.object({ status: z.literal('signed'), signerName: TextSchema, text: TextSchema.startsWith('DEMO'), at: InstantSchema }).strict(),
  z.object({ status: z.literal('refused'), signerName: TextSchema, reason: TextSchema, at: InstantSchema }).strict(),
  z.object({ status: z.literal('unavailable'), reason: TextSchema, at: InstantSchema }).strict(),
]);
export type Signature = z.infer<typeof SignatureSchema>;
export const ServiceTypeSchema = z.enum(['delivery_only', 'delivery_installation', 'installation_only', 'collection_only']);
export type ServiceType = z.infer<typeof ServiceTypeSchema>;
/** Exact teaching-source codes only. Real Odoo's mapping must be agreed before connecting it. */
export function mappedSourceService(value: SourceSnapshot['serviceType']): ServiceType | null {
  const canonical = ServiceTypeSchema.safeParse(value);
  if (canonical.success) return canonical.data;
  if (value === 'delivery') return 'delivery_only';
  if (value === 'delivery_and_assembly') return 'delivery_installation';
  return null;
}
const WorkMilliSchema = z.number().int().min(0).max(1_000_000_000);
const OperationQuantitiesSchema = z.object({
  deliveryMilli: WorkMilliSchema,
  installationMilli: WorkMilliSchema,
  collectionMilli: WorkMilliSchema,
}).strict();
export const RequiredWorkInputSchema = z.object({
  sourceLineId: SourceItemSchema.shape.sourceLineId,
  quantities: OperationQuantitiesSchema.nullable(),
  reason: TextSchema,
}).strict();
export type RequiredWorkInput = z.infer<typeof RequiredWorkInputSchema>;

const LineRequiredQuantitiesSchema = RequiredWorkInputSchema.extend({
  quantities: OperationQuantitiesSchema,
  updatedAt: InstantSchema,
  updatedBy: OperatorSnapshotSchema,
});
export const QuantityResultSchema = z.object({
  sourceLineId: z.number().int().positive(),
  deliveredMilli: WorkMilliSchema,
  installedMilli: WorkMilliSchema.optional(),
  collectedMilli: WorkMilliSchema.optional(),
}).strict();
export const PriorWorkRevisionSchema = z.object({
  id: IdSchema, revision: z.number().int().positive(),
  sourceLineId: SourceItemSchema.shape.sourceLineId,
  pickingId: z.number().int().positive(), pickingName: TextSchema,
  saleOrderId: z.number().int().positive(), saleOrderName: TextSchema,
  sourceItem: SourceItemSchema, service: ServiceTypeSchema,
  deliveredMilli: WorkMilliSchema, installedMilli: WorkMilliSchema, collectedMilli: WorkMilliSchema,
  sourceReference: TextSchema, reason: TextSchema, acknowledgeCurrentPicking: z.literal(true),
  confirmedAt: InstantSchema, confirmedBy: OperatorSnapshotSchema,
}).strict();
export type PriorWorkRevision = z.infer<typeof PriorWorkRevisionSchema>;
export const PriorWorkStatusSchema = z.object({
  reviewRequired: z.boolean(),
  lines: z.array(z.object({
    sourceLineId: SourceItemSchema.shape.sourceLineId,
    status: z.enum(['unknown', 'confirmed', 'needs_review']), canEdit: z.boolean(),
    blockedReason: z.enum(['delivery_closed', 'source_review', 'unknown_service', 'line_removed', 'planned_work', 'recorded_work']).nullable(),
    priorDeliveredMilli: WorkMilliSchema, priorInstalledMilli: WorkMilliSchema, priorCollectedMilli: WorkMilliSchema,
    crewDeliveredMilli: WorkMilliSchema, crewInstalledMilli: WorkMilliSchema, crewCollectedMilli: WorkMilliSchema,
    current: PriorWorkRevisionSchema.nullable(),
  }).strict()).max(1000),
}).strict();
export const IssueTypeSchema = z.enum(['damage', 'missing_parts', 'access', 'other']);
export const ItemChecksSchema = z.array(z.object({
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  status: z.enum(['ok', 'problem']),
  note: z.string().trim().min(1).max(500).nullable(),
  linkedIssueId: IdSchema.optional(),
  problemType: IssueTypeSchema.optional(),
}).strict().refine(({ status, linkedIssueId, problemType }) => status === 'problem' || (linkedIssueId === undefined && problemType === undefined),
  'Only a product problem can link an operational issue')).max(500).refine((checks) => new Set(checks.map(({ sourceLineId }) => sourceLineId)).size === checks.length,
  'Report each product line check once');
export const ResultIssueLinksSchema = z.array(z.object({
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  issueId: IdSchema,
}).strict()).max(500);
export const IncompleteWorkSchema = z.array(z.object({
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  operation: z.enum(['delivery', 'installation', 'collection']),
  reason: z.enum(['missing_goods_or_parts', 'damage', 'access', 'customer_refused', 'time_shortage', 'other']),
  note: z.string().trim().max(500).nullable(),
}).strict().refine(({ reason, note }) => reason !== 'other' || (note !== null && note.length > 0),
  'Explain the other reason for incomplete work')).max(1500).refine(
  (entries) => new Set(entries.map(({ sourceLineId, operation }) => `${sourceLineId}:${operation}`)).size === entries.length,
  'Report each incomplete source-line operation once');
export const WorkTimeRatesSchema = z.object({
  deliveryMinutesPerUnit: z.number().int().min(1).max(1440).nullable(),
  installationMinutesPerUnit: z.number().int().min(1).max(1440).nullable(),
  collectionMinutesPerUnit: z.number().int().min(1).max(1440).nullable(),
}).strict();
export type WorkTimeRates = z.infer<typeof WorkTimeRatesSchema>;
export const WorkTimeStandardSnapshotSchema = z.object({
  id: IdSchema, version: z.number().int().positive(), name: z.string().trim().min(1).max(200),
  service: ServiceTypeSchema, unit: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(200).nullable(), rates: WorkTimeRatesSchema,
  basis: z.literal('elapsed_team_minutes'), assumptions: z.string().max(2000),
  exclusions: z.string().max(2000), examples: z.string().max(2000), sourceReference: z.string().trim().min(1).max(2000),
}).strict();
export const LineWorkTimeSchema = WorkTimeRatesSchema.extend({
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  context: z.object({ productId: z.number().int().positive(), saleOrderId: z.number().int().positive(),
    uom: z.string(), uomId: z.number().int().positive().nullable(), addressKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  updatedAt: InstantSchema, updatedBy: OperatorSnapshotSchema,
  timeStandard: WorkTimeStandardSnapshotSchema.optional(),
}).strict();
export type LineWorkTime = z.infer<typeof LineWorkTimeSchema>;
export const ServicePlanSchema = z.object({
  defaultService: ServiceTypeSchema.nullable(),
  defaultOrigin: z.enum(['source', 'local']).optional(),
  overrides: z.array(z.object({ sourceLineId: QuantityResultSchema.shape.sourceLineId, service: ServiceTypeSchema,
    origin: z.enum(['source', 'local']).optional() }).strict()).max(500),
  timeEstimates: z.array(LineWorkTimeSchema).max(500).refine((lines) => new Set(lines.map(({ sourceLineId }) => sourceLineId)).size === lines.length,
    'Work times must identify distinct source lines').optional(),
  requiredQuantities: z.array(LineRequiredQuantitiesSchema).max(500).refine((lines) => new Set(lines.map(({ sourceLineId }) => sourceLineId)).size === lines.length,
    'Required quantities must identify distinct source lines').optional(),
}).strict().refine(({ overrides }) => new Set(overrides.map(({ sourceLineId }) => sourceLineId)).size === overrides.length,
  'Service overrides must identify distinct source lines');
export const LineServiceStatusSchema = z.object({
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  service: ServiceTypeSchema.nullable(),
  serviceOrigin: z.enum(['source', 'local', 'unknown']).optional(),
  inherited: z.boolean(),
  locked: z.boolean(),
  requiredQuantitiesCustomized: z.boolean().optional(),
  canEditRequiredQuantities: z.boolean().optional(),
  deliveredMilli: z.number().int().nonnegative(),
  installedMilli: z.number().int().nonnegative(),
  collectedMilli: z.number().int().nonnegative(),
  remainingDeliveryMilli: WorkMilliSchema,
  remainingInstallationMilli: WorkMilliSchema,
  remainingCollectionMilli: WorkMilliSchema,
  totalDeliveryMilli: WorkMilliSchema,
  totalInstallationMilli: WorkMilliSchema,
  totalCollectionMilli: WorkMilliSchema,
  reservedDeliveryMilli: z.number().int().nonnegative(),
  reservedInstallationMilli: z.number().int().nonnegative(),
  reservedCollectionMilli: z.number().int().nonnegative(),
  availableDeliveryMilli: WorkMilliSchema,
  availableInstallationMilli: WorkMilliSchema,
  availableCollectionMilli: WorkMilliSchema,
  planningBlockedReason: z.enum(['source_review', 'prior_work_review', 'unknown_service', 'legacy_scope_review', 'scope_outdated', 'over_reserved', 'damage_hold']).nullable(),
}).strict();
export const WorkLineInputSchema = z.object({
  sourceLineId: SourceItemSchema.shape.sourceLineId,
  ...OperationQuantitiesSchema.shape,
  customerStockConfirmed: z.boolean().optional(),
}).strict().refine((line) => line.deliveryMilli + line.installationMilli + line.collectionMilli > 0, 'Select at least one operation for each planned line');
export const WorkLinesInputSchema = z.array(WorkLineInputSchema).min(1).max(500)
  .refine((lines) => new Set(lines.map((line) => line.sourceLineId)).size === lines.length, 'Plan each source line once');
export type WorkLineInput = z.infer<typeof WorkLineInputSchema>;
export const VisitWorkScopeSchema = z.object({
  revision: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  confirmedAt: InstantSchema,
  confirmedBy: OperatorSnapshotSchema,
  lines: z.array(WorkLineInputSchema.safeExtend({ service: ServiceTypeSchema, sourceItem: SourceItemSchema })).min(1).max(500),
}).strict();
export type VisitWorkScope = z.infer<typeof VisitWorkScopeSchema>;
export const ScopeReviewReasonSchema = z.enum(['missing_scope', 'source_review', 'source_changed', 'work_changed', 'stock_pending', 'damage_hold']).nullable();
export const RemainingWorkEstimateSchema = z.object({
  minutes: z.number().int().min(0).max(10080).nullable(),
  basis: z.enum(['proportional_remaining_operations', 'local_operation_rates', 'mixed_operation_rates', 'no_remaining_work', 'unknown']),
  sourceMinutes: z.number().int().positive().max(10080).nullable(),
  missingSourceLineIds: z.array(z.number().int().positive()).optional(),
  staleSourceLineIds: z.array(z.number().int().positive()).optional(),
  exceedsLimit: z.boolean().optional(),
}).strict();
export type RemainingWorkEstimate = z.infer<typeof RemainingWorkEstimateSchema>;
export const LineWorkTimeStatusSchema = WorkTimeRatesSchema.extend({
  sourceLineId: QuantityResultSchema.shape.sourceLineId, stale: z.boolean(),
  missingOperations: z.array(z.enum(['delivery', 'installation', 'collection'])),
  remainingMinutes: z.number().int().min(0).max(10080).nullable(),
  basis: z.enum(['source_total_proportion', 'local', 'mixed', 'unknown']),
  localSavedAt: InstantSchema.nullable(), localSavedBy: OperatorSnapshotSchema.nullable(), canEdit: z.boolean(),
}).strict();
export const EvidenceReferenceSchema = z.object({
  id: IdSchema,
  type: z.enum(['assembly', 'damage', 'missing_parts', 'document', 'photo']),
  itemIds: z.array(z.number().int().positive()).max(500),
}).strict();
export const MAX_VISIT_EVIDENCE = 100;
export const SignatureRefusalSchema = z.object({
  reason: TextSchema,
  noPhotoReason: TextSchema.optional(),
}).strict();
const ApprovedSignatureRefusalSchema = z.object({ decision: z.literal('approved'), reason: TextSchema }).strict();
const CorrectedSignatureRefusalSchema = z.object({
  decision: z.literal('corrected'),
  reason: TextSchema,
  quantities: z.array(QuantityResultSchema).min(1).max(500),
}).strict();
export const SignatureRefusalReviewDecisionSchema = z.discriminatedUnion('decision', [
  ApprovedSignatureRefusalSchema, CorrectedSignatureRefusalSchema,
]);
const SignatureRefusalReviewMetadata = z.object({
  resultId: IdSchema,
  reviewedAt: InstantSchema,
  reviewedBy: OperatorSnapshotSchema,
});
export const SignatureRefusalReviewSchema = z.discriminatedUnion('decision', [
  ApprovedSignatureRefusalSchema.extend(SignatureRefusalReviewMetadata.shape),
  CorrectedSignatureRefusalSchema.extend(SignatureRefusalReviewMetadata.shape),
]);
export type SignatureRefusalReviewDecision = z.infer<typeof SignatureRefusalReviewDecisionSchema>;
export const DocumentSnapshotSchema = z.object({
  id: IdSchema,
  name: z.string(),
  mime: z.string(),
  itemId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  documentPurpose: z.enum(['general', 'instruction', 'drawing']).nullable(),
  documentVersion: z.number().int().positive().nullable(),
  documentSource: z.literal('local_upload').nullable(),
  supersedesFileId: IdSchema.nullable(),
  uploadedBy: z.object({ id: IdSchema, name: z.string() }).nullable(),
}).strict();
export const VisitResultSchema = z.object({
  id: IdSchema,
  appointmentId: IdSchema,
  source: z.literal('crew_frontoffice').optional(),
  // Existing original results predate corrective versions; absence unambiguously means an original.
  supersedesResultId: IdSchema.nullable().default(null),
  correctionReason: NullableTextSchema.default(null),
  receivedAt: InstantSchema,
  actualStart: InstantSchema,
  actualEnd: InstantSchema,
  summary: TextSchema,
  actor: z.object({ kind: z.literal('crew'), id: IdSchema, name: TextSchema }).strict(),
  responsiblePersonId: IdSchema,
  quantities: z.array(QuantityResultSchema).max(500),
  itemChecks: ItemChecksSchema.optional(),
  incompleteWork: IncompleteWorkSchema.optional(),
  // Generated from validated checks; old signed results retain their historical representation.
  issueLinks: ResultIssueLinksSchema.optional(),
  documentSnapshot: z.array(DocumentSnapshotSchema).max(200).optional(),
  completedChecklistIds: z.array(IdSchema).max(1000),
  evidence: z.array(EvidenceReferenceSchema).max(MAX_VISIT_EVIDENCE),
  customerSignature: SignatureSchema.nullable(),
  crewSignature: SignatureSchema.nullable(),
  signatureRefusal: SignatureRefusalSchema.optional(),
  sourceSnapshot: SourceSchema,
  instructionsSnapshot: InstructionsSchema,
  assignmentsSnapshot: z.array(AssignmentSchema).max(30),
  servicePlanSnapshot: ServicePlanSchema.optional(),
  workScopeSnapshot: VisitWorkScopeSchema.optional(),
  // Optional without a default: old signed results retain their exact historical representation.
  transportSnapshot: z.array(TransportAllocationSchema).max(20).optional(),
}).strict();
export type VisitResult = z.infer<typeof VisitResultSchema>;

export const CustomerConfirmationSchema = z.object({
  confirmedAt: InstantSchema,
  confirmedBy: OperatorSnapshotSchema,
}).strict();

export const ResponsibleParticipantSchema = PersonSnapshotSchema.pick({ id: true, name: true });

export const FailedAttemptSchema = z.object({
  reason: TextSchema,
  at: InstantSchema,
  actor: ResponsibleParticipantSchema,
}).strict();

export const AppointmentSchema = z.object({
  id: IdSchema,
  startsAt: InstantSchema,
  endsAt: InstantSchema,
  status: z.enum(['booked', 'in_progress', 'completed', 'cancelled', 'failed']),
  cancellationReason: NullableTextSchema,
  returnRequestId: IdSchema.nullable(),
  assignments: z.array(AssignmentSchema).max(30),
  results: z.array(VisitResultSchema).max(100),
  workScope: VisitWorkScopeSchema.optional(),
  responsibleParticipant: ResponsibleParticipantSchema.optional(),
  actualStartedAt: InstantSchema.optional(),
  failedAttempt: FailedAttemptSchema.optional().describe('A customer-absent attempt with no goods handed over or work completed.'),
  signatureRefusalReview: SignatureRefusalReviewSchema.optional(),
  transportAllocations: z.array(TransportAllocationSchema).max(200).optional(),
  customerConfirmation: CustomerConfirmationSchema.optional().describe(
    'The operator who recorded the customer’s agreement to the current visit window. An assigned booked visit without this record is awaiting customer confirmation.',
  ),
}).strict();
export type Appointment = z.infer<typeof AppointmentSchema>;

export const IssueSchema = z.object({
  id: IdSchema,
  type: IssueTypeSchema,
  description: TextSchema,
  itemIds: z.array(z.number().int().positive()).max(500),
  photoIds: z.array(IdSchema).max(100),
  notes: NullableTextSchema,
  status: z.enum(['open', 'resolved']),
  createdAt: InstantSchema,
  authorId: IdSchema,
  authorName: TextSchema,
  source: z.enum(['operator', 'crew']),
  appointmentId: IdSchema.optional(),
  originResultId: IdSchema.optional(),
  resolution: NullableTextSchema,
  resolvedAt: InstantSchema.nullable(),
  resolvedBy: IdSchema.nullable(),
}).strict();
export type Issue = z.infer<typeof IssueSchema>;
export const IssueInputSchema = IssueSchema.pick({ id: true, type: true, description: true, itemIds: true, photoIds: true, notes: true });
export type IssueInput = z.infer<typeof IssueInputSchema>;
export const ReturnRequestSchema = z.object({
  id: IdSchema,
  originAppointmentId: IdSchema,
  reason: TextSchema,
  remainingWork: TextSchema,
  notes: NullableTextSchema,
  photoIds: z.array(IdSchema).max(100),
  issueIds: z.array(IdSchema).max(100),
  status: z.enum(['requested', 'planned', 'resolved']),
  appointmentId: IdSchema.nullable(),
  createdAt: InstantSchema,
  resolvedAt: InstantSchema.nullable(),
  resolution: NullableTextSchema,
}).strict();
export type ReturnRequest = z.infer<typeof ReturnRequestSchema>;
export const ReturnInputSchema = ReturnRequestSchema.pick({
  id: true, originAppointmentId: true, reason: true, remainingWork: true, notes: true, photoIds: true, issueIds: true,
});
export type ReturnInput = z.infer<typeof ReturnInputSchema>;

export const CompletionSchema = z.object({
  id: IdSchema, at: InstantSchema, actorId: IdSchema, actorName: TextSchema,
  sourceSnapshot: SourceSchema,
  resultIds: z.array(IdSchema),
  priorWorkSnapshot: z.array(PriorWorkRevisionSchema).max(500).optional(),
  reopenedAt: InstantSchema.nullable(),
  reopenReason: NullableTextSchema,
}).strict();
export const WorkHoldSchema = z.object({
  id: IdSchema,
  sourceLineId: QuantityResultSchema.shape.sourceLineId,
  reason: z.literal('damage'),
  appointmentId: IdSchema.optional(),
  resultId: IdSchema.optional(),
  issueId: IdSchema.optional(),
  createdAt: InstantSchema,
  createdBy: OperatorSnapshotSchema,
  release: z.object({ at: InstantSchema, by: OperatorSnapshotSchema, note: TextSchema }).strict().optional(),
}).strict();
export const DeliverySchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  source: SourceSchema,
  sourceReview: z.boolean(),
  sourceChanged: z.boolean(),
  sourceImport: SourceImportStateSchema.optional(),
  sourceWarnings: z.array(TextSchema).max(100),
  servicePlan: ServicePlanSchema.optional(),
  priorWorkRevisions: z.array(PriorWorkRevisionSchema).max(5000).optional(),
  routePoint: GeoPointSchema.optional(),
  addressGeography: AddressGeographySchema.optional(),
  instructions: InstructionsSchema,
  appointments: z.array(AppointmentSchema).max(500),
  issues: z.array(IssueSchema).max(500),
  workHolds: z.array(WorkHoldSchema).max(1500).optional(),
  returnRequests: z.array(ReturnRequestSchema).max(500),
  completions: z.array(CompletionSchema).max(100),
  completedAt: InstantSchema.nullable(),
}).strict();
export type Delivery = z.infer<typeof DeliverySchema>;

export const ExecutionInputSchema = z.object({
  id: IdSchema,
  appointmentId: IdSchema,
  supersedesResultId: IdSchema.nullable(),
  correctionReason: NullableTextSchema,
  actualStart: InstantSchema,
  actualEnd: InstantSchema,
  summary: TextSchema,
  responsiblePersonId: IdSchema,
  quantities: z.array(QuantityResultSchema).max(500),
  itemChecks: ItemChecksSchema.optional(),
  incompleteWork: IncompleteWorkSchema.optional(),
  documentSnapshot: z.array(DocumentSnapshotSchema).max(200).optional(),
  completedChecklistIds: z.array(IdSchema).max(1000),
  evidence: z.array(EvidenceReferenceSchema).max(MAX_VISIT_EVIDENCE),
  customerSignature: SignatureSchema.nullable(),
  crewSignature: SignatureSchema.nullable(),
}).strict();
export type ExecutionInput = z.infer<typeof ExecutionInputSchema>;
export type CrewActor = { kind: 'crew'; id: string; name: string };
export type OperatorActor = { id: string; name: string; role: 'admin' | 'operator' };

export const ViewSchema = z.enum(['inbox', 'planned', 'assigned', 'in_progress', 'partially_completed', 'return_required', 'issues', 'completed']);
export type DeliveryView = z.infer<typeof ViewSchema>;

export function createDelivery(source: SourceSnapshot, id: string): Delivery {
  const service = mappedSourceService(source.serviceType);
  return DeliverySchema.parse({
    id, version: 1, source, sourceReview: false, sourceChanged: false, sourceWarnings: [],
    ...(service === null ? {} : { servicePlan: { defaultService: service, defaultOrigin: 'source' as const, overrides: [] } }),
    instructions: { floor: null, elevator: 'unknown', access: null, parking: null, restrictions: null, notes: null },
    appointments: [], issues: [], returnRequests: [], completions: [], completedAt: null,
  });
}
