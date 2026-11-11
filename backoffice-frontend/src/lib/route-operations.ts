import { z } from 'zod';
import { appointmentSchema, transportAllocationSchema } from './contracts';
import { routeDraftInputSchema, routeWindowSchema } from './route-drafts';
import { publicationReviewSchema, publicationSummarySchema } from './route-publication';
import { mapCoordinatesSchema } from './map-coordinates';
import { quantityMilli } from './visit-work';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(2000);
const milli = z.number().int().min(0).max(1_000_000_000);
const person = z.object({ id, name: z.string() });
const version = z.number().int().positive();
export const cargoKinds = ['collection', 'undelivered'] as const;
export const cargoLocations = ['unknown', 'warehouse', 'vehicle', 'awaiting_receipt', 'customer', 'awaiting_replacement'] as const;
export const routeWorkOperations = ['delivery', 'installation', 'collection'] as const;
export const nextActionKinds = ['ready_for_repeat', 'installation_visit', 'await_replacement', 'await_customer', 'manual_review', 'already_planned'] as const;
const actionHeader = z.object({ version, requestId: id });
export const routeReasonInputSchema = actionHeader.extend({ reason: text });
export const routeReturnInputSchema = actionHeader.extend({ actualReturnedAt: instant, note: text.optional() });
export const routeCancelInputSchema = routeReasonInputSchema.extend({ confirmNotDeparted: z.literal(true), confirmNotLoaded: z.literal(true), cancelAttachedAppointmentIds: z.array(id).max(30) });
export const routeAmendReviewInputSchema = z.object({ version, reason: text, confirmNotDeparted: z.literal(true), confirmNotLoaded: z.literal(true),
  plan: routeDraftInputSchema, responsibleParticipants: z.array(z.object({ appointmentId: id, participantId: id })).min(1).max(30), externalDriverPhone: z.string().trim().min(1).max(200).optional() });
export const routeAmendInputSchema = routeAmendReviewInputSchema.extend({ requestId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), acknowledgeEstimates: z.literal(true) });
const nextAction = z.object({ operation: z.enum(routeWorkOperations), action: z.enum(nextActionKinds), ownerUserId: id, note: text, followUpAppointmentId: id.nullable() });
const cargo = z.object({ kind: z.enum(cargoKinds), location: z.enum(cargoLocations), quantityMilli: milli.nullable(), note: text });
export const reconciliationLineInputSchema = z.object({ appointmentId: id, sourceLineId: z.number().int().positive(), ownerUserId: id, nextActions: z.array(nextAction).max(3), cargo: z.array(cargo).max(2), note: text });
export const routeReconcileInputSchema = routeReasonInputSchema.extend({ lines: z.array(reconciliationLineInputSchema).min(1).max(15000) });
export const warehouseReceiptItemSchema = z.object({ appointmentId: id, sourceLineId: z.number().int().positive(), kind: z.enum(cargoKinds), quantityMilli: milli.positive(), note: text });
export const routeWarehouseReceiptInputSchema = routeReasonInputSchema.extend({ items: z.array(warehouseReceiptItemSchema).min(1).max(15000) });
export const routeCloseInputSchema = routeReasonInputSchema.extend({ exceptionReason: text.optional() });
const event = z.object({ at: instant, actor: person, note: z.string().nullable() });
export const routeRuntimeSchema = z.object({
  departed: event.nullable(), returning: event.nullable(), returned: event.extend({ actualReturnedAt: instant }).nullable(),
  aborted: event.nullable(), cancelled: event.nullable(), closed: event.nullable(), skipped: z.array(event.extend({ appointmentId: id })),
  reconciliation: z.object({ at: instant, actor: person, reason: text, lines: z.array(reconciliationLineInputSchema) }).nullable(),
  warehouseReceipts: z.array(z.object({ id, at: instant, actor: person, reason: text, items: z.array(warehouseReceiptItemSchema) })), closureException: text.nullable(),
});
const liveStop = z.object({
  deliveryId: id, appointmentId: id, sequence: z.number().int().positive(), source: z.enum(['created', 'attached']), pickingName: z.string(), customerName: z.string(), address: z.string().nullable(), city: z.string().nullable(),
  entrance: mapCoordinatesSchema.extend({ addressKey: z.string().regex(/^[a-f0-9]{64}$/u) }).nullable(), customerWindow: routeWindowSchema.nullable().optional(),
  eta: instant.nullable(), workStartAt: instant.nullable(), workEndAt: instant.nullable(), status: appointmentSchema.shape.status,
  confirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']).nullable(), responsibleParticipant: appointmentSchema.shape.responsibleParticipant.nullable(),
  workScope: appointmentSchema.shape.workScope.nullable(), canStart: z.boolean(), startBlocker: z.string().nullable(), startBlockerCode: z.string().nullable().optional(), skipped: z.boolean(), reported: z.boolean(),
});
export const routeLineStatusSchema = z.object({
  deliveryId: id, appointmentId: id, sourceLineId: z.number().int().positive(), orderName: z.string(), productName: z.string(), uom: z.string(),
  plannedDeliveryMilli: milli, plannedInstallationMilli: milli, plannedCollectionMilli: milli,
  deliveredMilli: milli, installedMilli: milli, collectedMilli: milli,
  remainingDeliveryMilli: milli, remainingInstallationMilli: milli, remainingCollectionMilli: milli,
  availableDeliveryMilli: milli, availableInstallationMilli: milli, availableCollectionMilli: milli,
  planningBlockedReason: z.string().nullable(), reportMissing: z.boolean(),
  remainingBasis: z.enum(['current_delivery', 'visit_snapshot_source_missing']).default('current_delivery'),
  incompleteWork: z.array(z.object({ operation: z.enum(routeWorkOperations), reason: z.string(), note: z.string().nullable() })),
  warehouseReceivedCollectionMilli: milli, warehouseReceivedUndeliveredMilli: milli,
  declaration: reconciliationLineInputSchema.nullable(), packagingStatus: z.literal('unknown'),
});
export const routeOperationsSchema = z.object({
  id, version, status: publicationSummarySchema.shape.status, name: z.string(), draft: routeDraftInputSchema, review: publicationReviewSchema, runtime: routeRuntimeSchema,
  externalDriverPhone: z.string().nullable(), routeResponsible: person, nextAppointmentId: id.nullable(), stops: z.array(liveStop), lines: z.array(routeLineStatusSchema),
  resources: z.object({ crew: person, vehicle: transportAllocationSchema.shape.vehicle,
    driver: transportAllocationSchema.shape.driver, participants: z.array(person),
    start: z.object({ id: z.string(), name: z.string() }), end: z.object({ id: z.string(), name: z.string() }) }),
  capabilities: z.object({ canDepart: z.boolean(), canReturn: z.boolean(), canMarkReturned: z.boolean(), canAmend: z.boolean(), canCancel: z.boolean(), canReconcile: z.boolean(), canClose: z.boolean(),
    departBlocker: z.string().nullable(), departBlockerCode: z.string().nullable().optional(), returnBlocker: z.string().nullable(), returnBlockerCode: z.string().nullable().optional(), closureBlockers: z.array(z.string()),
    closureIssues: z.array(z.object({ code: z.string(), message: z.string(), appointmentId: id.nullable(), sourceLineId: z.number().int().positive().nullable() })).optional() }),
  history: z.array(z.object({ version, action: z.string(), actor: person, at: instant, reason: z.string().nullable(), status: publicationSummarySchema.shape.status })),
});
export const reconciliationOwnersSchema = z.array(person);
export const routeAmendReviewSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), review: publicationReviewSchema, confirmationResetAppointmentIds: z.array(id) });
export const routeRevisionSchema = z.object({ version, status: publicationSummarySchema.shape.status,
  data: z.object({ draft: routeDraftInputSchema, review: publicationReviewSchema, publishedAt: instant, publishedBy: person,
    appointments: z.array(z.object({ deliveryId: id, appointment: appointmentSchema })).default([]) }), runtime: routeRuntimeSchema });
export type RouteOperations = z.infer<typeof routeOperationsSchema>;
export type RouteLineStatus = z.infer<typeof routeLineStatusSchema>;
export type ReconciliationLineInput = z.infer<typeof reconciliationLineInputSchema>;
export type RouteAmendReviewInput = z.infer<typeof routeAmendReviewInputSchema>;
export type RouteAmendReview = z.infer<typeof routeAmendReviewSchema>;
export type RouteRevision = z.infer<typeof routeRevisionSchema>;
export type ReconciliationOwner = z.infer<typeof person>;
export type RouteCommand = (path: string, body: object) => Promise<number>;

export function validateRouteCommand(path: string, value: unknown): object {
  if (['depart', 'returning', 'abort'].includes(path) || /^stops\/[0-9a-f-]+\/skip$/u.test(path)) return routeReasonInputSchema.parse(value);
  if (path === 'return') return routeReturnInputSchema.parse(value);
  if (path === 'cancel') return routeCancelInputSchema.parse(value);
  if (path === 'amend') return routeAmendInputSchema.parse(value);
  if (path === 'reconcile') return routeReconcileInputSchema.parse(value);
  if (path === 'warehouse-receipts') return routeWarehouseReceiptInputSchema.parse(value);
  if (path === 'close') return routeCloseInputSchema.parse(value);
  throw new Error('Unknown route action.');
}

export function routeLineKey(line: { appointmentId: string; sourceLineId: number }) { return `${line.appointmentId}:${line.sourceLineId}`; }

/** Keep user input exact to thousandths; an empty cargo amount means unknown, not zero. */
export function cargoQuantityMilli(value: string): number | null | undefined {
  if (value.trim() === '') return null;
  const amount = quantityMilli(value);
  if (amount === null) return undefined;
  return milli.safeParse(amount).success ? amount : undefined;
}
