import { z } from 'zod';
import { inboxMapAreaResultSchema } from './inbox-map-area';

// Browser-owned runtime contracts mirror the HTTP API; no backend runtime is imported.
const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable();
export const serviceTypeSchema = z.enum(['delivery_only', 'delivery_installation', 'installation_only', 'collection_only']);
export type ServiceType = z.infer<typeof serviceTypeSchema>;
const servicePlanSchema = z.object({
  defaultService: serviceTypeSchema.nullable(),
  overrides: z.array(z.object({ sourceLineId: z.number().int().positive(), service: serviceTypeSchema })),
});
const milli = z.number().int().nonnegative();
export const lineServiceSchema = z.object({
  sourceLineId: z.number().int().positive(), service: serviceTypeSchema.nullable(), inherited: z.boolean(), locked: z.boolean(),
  deliveredMilli: milli, installedMilli: milli, collectedMilli: milli,
  remainingDeliveryMilli: milli, remainingInstallationMilli: milli, remainingCollectionMilli: milli,
  totalDeliveryMilli: milli, totalInstallationMilli: milli, totalCollectionMilli: milli,
  reservedDeliveryMilli: milli, reservedInstallationMilli: milli, reservedCollectionMilli: milli,
  availableDeliveryMilli: milli, availableInstallationMilli: milli, availableCollectionMilli: milli,
  planningBlockedReason: z.enum(['source_review', 'unknown_service', 'legacy_scope_review', 'scope_outdated', 'over_reserved', 'damage_hold']).nullable(),
});
export type LineService = z.infer<typeof lineServiceSchema>;
export const skillSnapshotSchema = z.object({ id, name: z.string().trim().min(1).max(200) });
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export const skillSchema = z.object({ id, version: z.number().int().positive(), name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable(), enabled: z.boolean() });
export type Skill = z.infer<typeof skillSchema>;
export const personSchema = z.object({ id, name: z.string().trim().min(1).max(2000), external: z.boolean(), skillsSnapshot: z.array(skillSnapshotSchema).optional() });
export const userSchema = z.object({ id, name: z.string(), role: z.enum(['admin', 'operator']) });
export type User = z.infer<typeof userSchema>;

const itemSchema = z.object({
  sourceLineId: z.number().int().positive(), productId: z.number().int().positive(), name: z.string(),
  description: nullableText, quantity: z.number().nonnegative(), uom: z.string(), configuration: nullableText,
  ambient: nullableText, notes: nullableText, photoUrl: z.url().nullable(),
  saleOrderId: z.number().int().positive().optional(),
});
export const workLineSchema = z.object({
  sourceLineId: z.number().int().positive(), deliveryMilli: milli, installationMilli: milli, collectionMilli: milli,
  customerStockConfirmed: z.boolean().optional(),
});
export type WorkLine = z.infer<typeof workLineSchema>;
export const workScopeSchema = z.object({
  revision: z.number().int().positive(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), confirmedAt: instant,
  confirmedBy: z.object({ id, name: z.string() }),
  lines: z.array(workLineSchema.extend({ service: serviceTypeSchema, sourceItem: itemSchema })).min(1).max(500),
}).superRefine((scope, context) => {
  if (new Set(scope.lines.map((line) => line.sourceLineId)).size !== scope.lines.length) context.addIssue({ code: 'custom', path: ['lines'], message: 'Work lines must be unique.' });
  for (const [index, line] of scope.lines.entries()) {
    if (line.sourceLineId !== line.sourceItem.sourceLineId) context.addIssue({ code: 'custom', path: ['lines', index], message: 'A work line must retain its source identity.' });
    if (line.deliveryMilli + line.installationMilli + line.collectionMilli === 0) context.addIssue({ code: 'custom', path: ['lines', index], message: 'A work line must include an operation.' });
  }
});
export type WorkScope = z.infer<typeof workScopeSchema>;
const sourceSchema = z.object({
  pickingId: z.number().int().positive(), pickingName: z.string(), saleOrderId: z.number().int().positive(),
  saleOrderName: z.string(), sourceState: z.string(), salesTeam: z.string(),
  salesOrders: z.array(z.object({ id: z.number().int().positive(), name: z.string() })).min(1).max(100).optional(),
  customer: z.object({ id: z.number(), name: z.string(), address: nullableText, city: nullableText, country: nullableText,
    phones: z.array(z.string()), email: z.email().nullable(), contact: nullableText }),
  items: z.array(itemSchema), serviceType: nullableText, estimatedMinutes: z.number().nullable(), notes: nullableText,
}).superRefine((source, context) => {
  if (!source.salesOrders) return;
  const orderIds = new Set(source.salesOrders.map((order) => order.id));
  if (orderIds.size !== source.salesOrders.length || !orderIds.has(source.saleOrderId)) context.addIssue({ code: 'custom', path: ['salesOrders'], message: 'Orders must be unique and include the primary reference.' });
  for (const [index, item] of source.items.entries()) if (item.saleOrderId === undefined || !orderIds.has(item.saleOrderId)) context.addIssue({ code: 'custom', path: ['items', index, 'saleOrderId'], message: 'Each product line must reference an order in this picking.' });
});
export const instructionsSchema = z.object({ floor: z.number().int().nullable(), elevator: z.enum(['unknown', 'yes', 'no']), access: nullableText, parking: nullableText, restrictions: nullableText, notes: nullableText });
export const templateSchema = z.object({ id, version: z.number().int(), title: z.string(), severity: z.enum(['low', 'medium', 'high']), order: z.number().int(), checklist: z.array(z.string()), enabled: z.boolean(), requiredSkillIds: z.array(id) });
export type TaskTemplate = z.infer<typeof templateSchema>;
const checklistSchema = z.object({ id, label: z.string(), done: z.boolean(), waiver: z.object({ reason: z.string(), actorId: id, at: instant }).nullable() });
const taskSchema = z.object({ id, templateId: id, title: z.string(), severity: z.enum(['low', 'medium', 'high']), order: z.number(), checklist: z.array(checklistSchema), requiredSkillsSnapshot: z.array(skillSnapshotSchema).optional() });
const assignmentSchema = z.object({ id, crewId: id, crewName: z.string(), people: z.array(personSchema), tasks: z.array(taskSchema) });
const vehicleSnapshotSchema = z.object({ id, version: z.number().int().positive(), ownership: z.enum(['company', 'external']), name: z.string().trim().min(1).max(200), plate: z.string().trim().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9 -]*$/u), providerName: z.string().min(1).max(200).nullable(), providerContact: z.string().min(1).max(500).nullable() });
export const transportAllocationSchema = z.object({
  id, vehicle: vehicleSnapshotSchema, driver: z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }), z.object({ kind: z.literal('participant'), person: personSchema }), z.object({ kind: z.literal('external'), name: z.string().min(1).max(200), phone: z.string().min(1).max(200) })]),
  reserveFrom: instant, reserveTo: instant, status: z.enum(['active', 'replaced', 'cancelled']), createdAt: instant, createdBy: z.object({ id, name: z.string() }), replacesAllocationId: id.nullable(), retiredAt: instant.nullable(), retiredBy: z.object({ id, name: z.string() }).nullable(), retirementReason: nullableText,
});
export type TransportAllocation = z.infer<typeof transportAllocationSchema>;
const signatureCoordinate = z.number().int().min(0).max(1000);
const signaturePoint = z.object({ x: signatureCoordinate, y: signatureCoordinate }).strict();
const signatureDrawing = z.array(z.array(signaturePoint).min(1).max(256)).min(1).max(32)
  .refine((strokes) => strokes.reduce((count, stroke) => count + stroke.length, 0) <= 2048);
const signatureSchema = z.union([
  z.object({ status: z.literal('signed'), capture: z.literal('drawn'), signerName: z.string().min(1).max(2000), strokes: signatureDrawing, at: instant }).strict(),
  z.object({ status: z.literal('signed'), signerName: z.string(), text: z.string().startsWith('DEMO'), at: instant }).strict(),
  z.object({ status: z.literal('refused'), signerName: z.string(), reason: z.string(), at: instant }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string(), at: instant }).strict(),
]);
export const documentSnapshotSchema=z.object({id,name:z.string(),mime:z.string(),itemId:z.number().int().positive().nullable(),createdAt:z.string(),
  documentPurpose:z.enum(['general','instruction','drawing']).nullable(),documentVersion:z.number().int().positive().nullable(),
  documentSource:z.literal('local_upload').nullable(),supersedesFileId:id.nullable(),uploadedBy:z.object({id,name:z.string()}).nullable(),
});
const resultSchema = z.object({
  id, appointmentId: id, receivedAt: instant, actualStart: instant, actualEnd: instant, summary: z.string(),
  source: z.literal('crew_frontoffice').optional(),
  supersedesResultId: id.nullable(), correctionReason: nullableText,
  actor: z.object({ kind: z.literal('crew'), id, name: z.string() }), responsiblePersonId: id,
  quantities: z.array(z.object({ sourceLineId: z.number(), deliveredMilli: milli, installedMilli: milli.optional(), collectedMilli: milli.optional() })),
  itemChecks: z.array(z.object({ sourceLineId: z.number().int().positive(), status: z.enum(['ok', 'problem']), note: z.string().trim().max(500).nullable(),
    linkedIssueId: id.optional(), problemType: z.enum(['damage', 'missing_parts', 'access', 'other']).optional() })).max(500).optional(),
  issueLinks: z.array(z.object({ sourceLineId: z.number().int().positive(), issueId: id })).optional(),
  incompleteWork: z.array(z.object({
    sourceLineId: z.number().int().positive(), operation: z.enum(['delivery', 'installation', 'collection']),
    reason: z.enum(['missing_goods_or_parts', 'damage', 'access', 'customer_refused', 'time_shortage', 'other']),
    note: z.string().trim().max(500).nullable(),
  }).refine((entry) => entry.reason !== 'other' || Boolean(entry.note), 'Other requires a note.')).max(1500).optional(),
  evidence: z.array(z.object({ id, type: z.enum(['assembly', 'damage', 'missing_parts', 'document', 'photo']), itemIds: z.array(z.number()) })),
  customerSignature: signatureSchema.nullable(), crewSignature: signatureSchema.nullable(),
  sourceSnapshot: sourceSchema, instructionsSnapshot: instructionsSchema, assignmentsSnapshot: z.array(assignmentSchema),
  transportSnapshot: z.array(transportAllocationSchema).max(20).optional(),
  workScopeSnapshot: workScopeSchema.optional(),
  documentSnapshot:z.array(documentSnapshotSchema).max(200).optional(),
});
const customerConfirmationSchema = z.object({
  confirmedAt: instant,
  confirmedBy: z.object({ id, name: z.string() }),
});
export const appointmentSchema = z.object({ id, startsAt: instant, endsAt: instant,
  status: z.enum(['booked', 'in_progress', 'completed', 'cancelled', 'failed']), cancellationReason: nullableText,
  returnRequestId: id.nullable(), assignments: z.array(assignmentSchema), results: z.array(resultSchema),
  customerConfirmation: customerConfirmationSchema.optional(),
  responsibleParticipant: z.object({ id, name: z.string() }).optional(),
  failedAttempt: z.object({ reason: z.string().trim().min(1).max(2000), at: instant, actor: z.object({ id, name: z.string() }) }).optional(),
  transportAllocations: z.array(transportAllocationSchema).max(200).optional(),
  workScope: workScopeSchema.optional(),
});
export type Appointment = z.infer<typeof appointmentSchema>;
const issueSchema = z.object({ id, type: z.enum(['damage', 'missing_parts', 'access', 'other']), description: z.string(), itemIds: z.array(z.number()), photoIds: z.array(id), notes: nullableText,
  status: z.enum(['open', 'resolved']), createdAt: instant, authorId: id, authorName: z.string(), source: z.enum(['operator', 'crew']), resolution: nullableText, resolvedAt: instant.nullable(), resolvedBy: id.nullable(), appointmentId: id.optional(), originResultId: id.optional() });
const returnSchema = z.object({ id, originAppointmentId: id, reason: z.string(), remainingWork: z.string(), notes: nullableText, photoIds: z.array(id), issueIds: z.array(id), status: z.enum(['requested', 'planned', 'resolved']), appointmentId: id.nullable(), createdAt: instant, resolvedAt: instant.nullable(), resolution: nullableText });
export const deliverySchema = z.object({
  id, version: z.number().int().positive(), source: sourceSchema, sourceReview: z.boolean(), sourceChanged: z.boolean(),
  sourceWarnings: z.array(z.string()), instructions: instructionsSchema, appointments: z.array(appointmentSchema),
  servicePlan: servicePlanSchema.optional(),
  issues: z.array(issueSchema), returnRequests: z.array(returnSchema),
  workHolds: z.array(z.object({ id, sourceLineId: z.number().int().positive(), reason: z.literal('damage'), appointmentId: id.optional(), resultId: id.optional(), issueId: id.optional(),
    createdAt: instant, createdBy: z.object({ id, name: z.string() }), release: z.object({ at: instant, by: z.object({ id, name: z.string() }), note: z.string() }).optional() })).optional(),
  completions: z.array(z.object({ id, at: instant, actorId: id, actorName: z.string(), sourceSnapshot: sourceSchema, resultIds: z.array(id), reopenedAt: instant.nullable(), reopenReason: nullableText })),
  completedAt: instant.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const crewSchema = z.object({ id, name: z.string(), classification: z.enum(['indoor', 'outdoor']), area: z.string(), enabled: z.boolean(), people: z.array(personSchema), version: z.number().int() });
export type Crew = z.infer<typeof crewSchema>;
export const participantSchema = z.object({
  id, version: z.number().int().positive(), name: z.string(), firstName: nullableText, lastName: nullableText,
  preferredName: nullableText, phoneNumber: nullableText, address: nullableText, login: nullableText,
  external: z.boolean(), enabled: z.boolean(), hasPassword: z.boolean(), skillIds: z.array(id),
});
export type Participant = z.infer<typeof participantSchema>;
export const appointmentParticipantsSchema = z.object({ people: z.array(z.object({
  id, name: z.string(), external: z.boolean(), enabled: z.boolean(), busy: z.boolean(), skillIds: z.array(id),
  conflicts: z.array(z.object({ appointmentId: id, pickingName: z.string(), startsAt: instant, endsAt: instant })),
})) });
export type AvailableParticipant = z.infer<typeof appointmentParticipantsSchema>['people'][number];
export const vehicleSchema = vehicleSnapshotSchema.extend({ operationalStatus: z.enum(['available', 'maintenance', 'out_of_service']), enabled: z.boolean(), notes: z.string().max(4000).nullable() }).refine((vehicle) => vehicle.ownership === 'external' ? vehicle.providerName !== null : vehicle.providerName === null && vehicle.providerContact === null, 'External vehicles require a provider; company vehicles have no provider fields');
export type Vehicle = z.infer<typeof vehicleSchema>;
const resourceConflictSchema = z.object({ appointmentId: id, pickingName: z.string(), startsAt: instant, endsAt: instant });
export const transportAvailabilitySchema = z.object({ vehicles: z.array(vehicleSchema.safeExtend({ busy: z.boolean(), conflicts: z.array(resourceConflictSchema) })), people: z.array(z.object({ id, name: z.string(), external: z.boolean(), enabled: z.boolean(), busy: z.boolean(), conflicts: z.array(resourceConflictSchema) })) });
export type TransportAvailability = z.infer<typeof transportAvailabilitySchema>;
export const participantCalendarSchema = z.object({
  participant: participantSchema.omit({ login: true, hasPassword: true, skillIds: true }),
  routeReservations: z.array(z.object({ routeId: id, name: z.string(), status: z.enum(['published', 'in_progress', 'returning', 'returned', 'closed']),
    startsAt: instant, endsAt: instant, bufferMinutes: z.number().int().min(0).max(240) })).optional(),
  entries: z.array(z.object({
    deliveryId: id, pickingName: z.string(), customerName: z.string(), appointmentId: id,
    startsAt: instant, endsAt: instant, status: appointmentSchema.shape.status,
    customerConfirmation: appointmentSchema.shape.customerConfirmation,
    assignment: assignmentSchema, returnVisit: z.boolean(),
  })),
});
export type ParticipantCalendarData = z.infer<typeof participantCalendarSchema>;
export const workspaceSections = ['deliveries', 'routes', 'calendar', 'staffing', 'directory', 'imports', 'skills', 'vehicles'] as const;
export type WorkspaceSection = typeof workspaceSections[number];
export const views = [
  { id: 'inbox', icon: '◫' },
  { id: 'planned', icon: '▦' },
  { id: 'assigned', icon: '↗' },
  { id: 'in_progress', icon: '◷' },
  { id: 'partially_completed', icon: '◐' },
  { id: 'return_required', icon: '↶' },
  { id: 'issues', icon: '⚑' },
  { id: 'completed', icon: '✓' },
] as const;
export type View = typeof views[number]['id'];
export const geographySchema = z.object({ city: nullableText, province: nullableText, postalCode: nullableText, source: z.literal('synthetic_fixture').nullable() });
const geographyFacetSchema = z.object({ value: nullableText, count: z.number().int().nonnegative() });
const geographyFacetsSchema = z.object({ cities: z.array(geographyFacetSchema), provinces: z.array(geographyFacetSchema), postalCodes: z.array(geographyFacetSchema) });
const deliveryProgressSchema = z.enum(['inbox', 'planned', 'assigned', 'in_progress', 'partially_completed', 'awaiting_closure', 'completed']);
export const remainingWorkEstimateSchema = z.object({
  minutes: z.number().int().nonnegative().nullable(),
  sourceMinutes: z.number().int().nonnegative().nullable(),
  basis: z.enum(['proportional_remaining_operations', 'no_remaining_work', 'unknown']),
});
export const deliveryPlanningSchema = z.object({
  status: deliveryProgressSchema,
  activeVisits: z.array(z.object({
    id, status: z.enum(['booked', 'in_progress']), startsAt: instant, endsAt: instant,
    crews: z.array(z.object({ id, name: z.string() })),
  })),
  remainingWorkEstimate: remainingWorkEstimateSchema,
});
export const deliveryListSchema = z.object({
  items: z.array(deliverySchema.extend({ geography: geographySchema.optional(), planning: deliveryPlanningSchema.optional() })),
  total: z.number(), page: z.number(), pageSize: z.number(), counts: z.record(z.string(), z.number()),
  geographyFacets: geographyFacetsSchema.optional(),
  matchingGeographyFacets: geographyFacetsSchema.optional(),
  area: inboxMapAreaResultSchema.nullable().optional(),
});
export type DeliveryList = z.infer<typeof deliveryListSchema>;
export const calendarSchema = z.array(z.object({ deliveryId: id, pickingName: z.string(), customerName: z.string(), appointment: appointmentSchema }));
export type CalendarEntry = z.infer<typeof calendarSchema>[number];

const databaseTime = z.string().refine((value) => Number.isFinite(new Date(value).getTime()), 'Invalid timestamp');
export const fileSchema = documentSnapshotSchema.extend({ deliveryId: id, size: z.number(), kind: z.enum(['document', 'photo', 'evidence']), appointmentId: id.nullable(), issueId: id.nullable(), status: z.enum(['pending', 'ready', 'failed']), createdAt: databaseTime });
export const auditSchema = z.object({ id, actorId: id, at: databaseTime, actorName: z.string(), action: z.string(), details: z.unknown() });
export const appointmentPlanningSchema = z.object({ appointmentId: id, reviewReason: z.enum(['missing_scope', 'source_review', 'source_changed', 'work_changed', 'stock_pending', 'damage_hold']).nullable(), canEdit: z.boolean() });
export type AppointmentPlanning = z.infer<typeof appointmentPlanningSchema>;
export const detailSchema = z.object({ delivery: deliverySchema, views: z.array(z.string()), progress: z.enum(['inbox', 'planned', 'assigned', 'in_progress', 'partially_completed', 'awaiting_closure', 'completed']), coverage: z.object({ assigned: z.number().int(), total: z.number().int() }), deliveredQuantities: z.array(z.object({ sourceLineId: z.number().int(), deliveredMilli: z.number().int() })), lineServices: z.array(lineServiceSchema).optional(), appointmentPlanning: z.array(appointmentPlanningSchema).optional(), closureBlockers: z.array(z.string()), files: z.array(fileSchema), history: z.array(auditSchema) });
export type DeliveryDetail = z.infer<typeof detailSchema>;
export const importSchema = z.object({ id, status: z.string(), startedAt: databaseTime, finishedAt: databaseTime.nullable(), processed: z.number(), error: nullableText, details: z.array(z.string()) });
export type ImportRun = z.infer<typeof importSchema>;
export const logoutSchema = z.object({ ok: z.literal(true) });
