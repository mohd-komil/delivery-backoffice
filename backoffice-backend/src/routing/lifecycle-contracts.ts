import { z } from 'zod';
import { AppointmentSchema, IdSchema, InstantSchema, ResponsibleParticipantSchema as OperatorSnapshotSchema, QuantityResultSchema, TextSchema, TransportAllocationSchema } from '../domain/model';
import { RouteDraftInputSchema, RoutePinSchema } from './contracts';
import { PublicationReviewSchema, PublicationSnapshotSchema, PublicationStatusSchema } from './publication-contracts';

const Id = IdSchema.toLowerCase();
const WorkMilliSchema = QuantityResultSchema.shape.deliveredMilli;
export const RouteActionInputSchema = z.object({ version: z.number().int().positive(), requestId: Id }).strict();
export const RouteReasonInputSchema = RouteActionInputSchema.extend({ reason: TextSchema });
export const RouteReturnInputSchema = RouteActionInputSchema.extend({ actualReturnedAt: InstantSchema, note: TextSchema.optional() });
export const RouteCancelInputSchema = RouteReasonInputSchema.extend({
  confirmNotDeparted: z.literal(true), confirmNotLoaded: z.literal(true),
  cancelAttachedAppointmentIds: z.array(Id).max(30).default([]),
});
export const RouteAmendReviewInputSchema = z.object({
  version: z.number().int().positive(), reason: TextSchema,
  confirmNotDeparted: z.literal(true), confirmNotLoaded: z.literal(true), plan: RouteDraftInputSchema,
  responsibleParticipants: z.array(z.object({ appointmentId: Id, participantId: Id }).strict()).min(1).max(30),
  externalDriverPhone: z.string().trim().min(1).max(200).optional(),
}).strict();
export const RouteAmendInputSchema = RouteAmendReviewInputSchema.extend({ requestId: Id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeEstimates: z.literal(true) });
export const CargoKindSchema = z.enum(['collection', 'undelivered']);
export const CargoLocationSchema = z.enum(['unknown', 'warehouse', 'vehicle', 'awaiting_receipt', 'customer', 'awaiting_replacement']);
export const WorkOperationSchema = z.enum(['delivery', 'installation', 'collection']);
export const RouteNextActionSchema = z.object({
  operation: WorkOperationSchema, action: z.enum(['ready_for_repeat', 'installation_visit', 'await_replacement', 'await_customer', 'manual_review', 'already_planned']),
  ownerUserId: Id, note: TextSchema, followUpAppointmentId: Id.nullable().default(null),
}).strict();
export const CargoDeclarationSchema = z.object({ kind: CargoKindSchema, location: CargoLocationSchema, quantityMilli: WorkMilliSchema.nullable(), note: TextSchema }).strict();
export const RouteReconciliationLineInputSchema = z.object({
  appointmentId: Id, sourceLineId: z.number().int().positive(), ownerUserId: Id,
  nextActions: z.array(RouteNextActionSchema).max(3), cargo: z.array(CargoDeclarationSchema).max(2), note: TextSchema,
}).strict();
export const RouteReconcileInputSchema = RouteReasonInputSchema.extend({ lines: z.array(RouteReconciliationLineInputSchema).min(1).max(15000) });
export const RouteWarehouseReceiptInputSchema = RouteReasonInputSchema.extend({
  items: z.array(z.object({ appointmentId: Id, sourceLineId: z.number().int().positive(), kind: CargoKindSchema, quantityMilli: WorkMilliSchema.refine((n) => n > 0), note: TextSchema }).strict()).min(1).max(15000),
});
export const RouteCloseInputSchema = RouteReasonInputSchema.extend({ exceptionReason: TextSchema.optional() });
export const RouteEventSchema = z.object({ at: InstantSchema, actor: OperatorSnapshotSchema, note: z.string().nullable() }).strict();
export const RouteRuntimeSchema = z.object({
  departed: RouteEventSchema.nullable().default(null), returning: RouteEventSchema.nullable().default(null),
  returned: RouteEventSchema.extend({ actualReturnedAt: InstantSchema }).nullable().default(null),
  aborted: RouteEventSchema.nullable().default(null), cancelled: RouteEventSchema.nullable().default(null), closed: RouteEventSchema.nullable().default(null),
  skipped: z.array(RouteEventSchema.extend({ appointmentId: IdSchema })).default([]),
  reconciliation: z.object({ at: InstantSchema, actor: OperatorSnapshotSchema, reason: TextSchema, lines: z.array(RouteReconciliationLineInputSchema) }).nullable().default(null),
  warehouseReceipts: z.array(z.object({ id: IdSchema, at: InstantSchema, actor: OperatorSnapshotSchema, reason: TextSchema, items: RouteWarehouseReceiptInputSchema.shape.items }).strict()).default([]),
  closureException: TextSchema.nullable().default(null),
}).strict();
export type RouteRuntime = z.infer<typeof RouteRuntimeSchema>;
export const RouteLiveStopSchema = z.object({
  deliveryId: IdSchema, appointmentId: IdSchema, sequence: z.number().int().positive(), source: z.enum(['created', 'attached']),
  pickingName: z.string(), customerName: z.string(), address: z.string().nullable(), city: z.string().nullable(),
  entrance: RoutePinSchema.nullable(), customerWindow: RouteDraftInputSchema.shape.stops.element.shape.customerWindow.nullable(),
  eta: InstantSchema.nullable(), workStartAt: InstantSchema.nullable(), workEndAt: InstantSchema.nullable(),
  status: AppointmentSchema.shape.status, confirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']).nullable(),
  responsibleParticipant: AppointmentSchema.shape.responsibleParticipant.nullable(),
  workScope: AppointmentSchema.shape.workScope.nullable(), canStart: z.boolean(), startBlocker: z.string().nullable(), startBlockerCode: z.string().nullable(),
  skipped: z.boolean(), reported: z.boolean(),
}).strict();
export const RouteLineStatusSchema = z.object({
  deliveryId: IdSchema, appointmentId: IdSchema, sourceLineId: z.number().int().positive(), orderName: z.string(), productName: z.string(), uom: z.string(),
  plannedDeliveryMilli: WorkMilliSchema, plannedInstallationMilli: WorkMilliSchema, plannedCollectionMilli: WorkMilliSchema,
  deliveredMilli: WorkMilliSchema, installedMilli: WorkMilliSchema, collectedMilli: WorkMilliSchema,
  remainingDeliveryMilli: WorkMilliSchema, remainingInstallationMilli: WorkMilliSchema, remainingCollectionMilli: WorkMilliSchema,
  remainingBasis: z.enum(['current_delivery', 'visit_snapshot_source_missing']),
  availableDeliveryMilli: WorkMilliSchema, availableInstallationMilli: WorkMilliSchema, availableCollectionMilli: WorkMilliSchema,
  planningBlockedReason: z.string().nullable(), reportMissing: z.boolean(),
  incompleteWork: z.array(z.object({ operation: WorkOperationSchema, reason: z.string(), note: z.string().nullable() })),
  warehouseReceivedCollectionMilli: WorkMilliSchema, warehouseReceivedUndeliveredMilli: WorkMilliSchema,
  declaration: RouteReconciliationLineInputSchema.nullable(), packagingStatus: z.literal('unknown'),
}).strict();
export const RouteCapabilitiesSchema = z.object({
  canDepart: z.boolean(), canReturn: z.boolean(), canMarkReturned: z.boolean(), canAmend: z.boolean(), canCancel: z.boolean(), canReconcile: z.boolean(), canClose: z.boolean(),
  departBlocker: z.string().nullable(), departBlockerCode: z.string().nullable(), returnBlocker: z.string().nullable(), returnBlockerCode: z.string().nullable(), closureBlockers: z.array(z.string()),
  closureIssues: z.array(z.object({ code: z.string(), message: z.string(), appointmentId: IdSchema.nullable(), sourceLineId: z.number().int().positive().nullable() }).strict()),
}).strict();
export const RouteOperationsSchema = z.object({
  id: IdSchema, version: z.number().int().positive(), status: PublicationStatusSchema, name: z.string(),
  draft: RouteDraftInputSchema, review: PublicationReviewSchema, runtime: RouteRuntimeSchema,
  externalDriverPhone: z.string().nullable(),
  resources: z.object({ crew: z.object({ id: IdSchema, name: z.string() }), vehicle: TransportAllocationSchema.shape.vehicle,
    driver: TransportAllocationSchema.shape.driver, participants: z.array(OperatorSnapshotSchema),
    start: z.object({ id: z.string(), name: z.string() }), end: z.object({ id: z.string(), name: z.string() }) }).strict(),
  routeResponsible: OperatorSnapshotSchema, nextAppointmentId: IdSchema.nullable(), stops: z.array(RouteLiveStopSchema), lines: z.array(RouteLineStatusSchema),
  capabilities: RouteCapabilitiesSchema,
  history: z.array(z.object({ version: z.number().int().positive(), action: z.string(), actor: OperatorSnapshotSchema, at: InstantSchema, reason: z.string().nullable(), status: PublicationStatusSchema }).strict()),
}).strict();
export const RouteAmendReviewSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), review: PublicationReviewSchema,
  confirmationResetAppointmentIds: z.array(IdSchema) }).strict();
export const RouteRevisionSchema = z.object({ version: z.number().int().positive(), status: PublicationStatusSchema, data: PublicationSnapshotSchema, runtime: RouteRuntimeSchema }).strict();
