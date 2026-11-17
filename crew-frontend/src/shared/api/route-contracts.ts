import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const person = z.object({ id: z.uuid(), name: z.string() });
const quantity = z.number().int().nonnegative();
export const routeStatusSchema = z.enum(['published', 'in_progress', 'returning', 'returned', 'closed', 'cancelled']);
export const routeReferenceSchema = z.object({ id: z.uuid(), name: z.string(), version: z.number().int().positive(), status: routeStatusSchema });
const event = z.object({ at: instant, actor: person, note: z.string().nullable() });
const customerWindow = z.union([
  z.object({ kind: z.enum(['unknown', 'unrestricted']) }),
  z.object({ kind: z.enum(['arrival', 'work_end']), startsAt: instant, endsAt: instant }),
]);
const geocodingMetadata = z.object({
  provider: z.literal('geoapify'),
  precision: z.enum(['building', 'amenity', 'street', 'suburb', 'district', 'postcode', 'city', 'county', 'state', 'country', 'unknown']),
  confidence: z.number().min(0).max(1).nullable(),
  attribution: z.string().min(1).max(2048),
  acceptance: z.enum(['automatic', 'operator']),
}).strict();

export const routeStopSchema = z.object({
  deliveryId: z.uuid(), appointmentId: z.uuid(), sequence: z.number().int().positive(), source: z.enum(['created', 'attached']),
  pickingName: z.string(), customerName: z.string(), address: z.string().nullable(), city: z.string().nullable(),
  entrance: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), addressKey: z.string() }).nullable(),
  geocoding: geocodingMetadata.optional(),
  customerWindow: customerWindow.nullable(), eta: instant.nullable(), workStartAt: instant.nullable(), workEndAt: instant.nullable(),
  status: z.enum(['booked', 'in_progress', 'completed', 'failed', 'cancelled']),
  confirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']).nullable(),
  responsibleParticipant: person.nullable(), canStart: z.boolean(), startBlocker: z.string().nullable(), startBlockerCode: z.string().nullable(), skipped: z.boolean(), reported: z.boolean(),
});

export const crewRouteSchema = routeReferenceSchema.extend({
  draft: z.object({
    departAt: instant, startPointId: z.string(), endPointId: z.string(),
    stops: z.array(z.object({ deliveryId: z.uuid(), workMinutes: z.number().int().positive().nullable() })),
    planning: z.object({ transferBufferMinutes: z.number().int().nonnegative().nullable() }).optional(),
  }),
  review: z.object({ timeline: z.object({ departAt: instant, returnAt: instant.nullable(), returnTravelMinutes: z.number().nonnegative().nullable() }) }),
  runtime: z.object({
    departed: event.nullable(), returning: event.nullable(), returned: event.extend({ actualReturnedAt: instant }).nullable(),
    aborted: event.nullable(), cancelled: event.nullable(), closed: event.nullable(),
    skipped: z.array(event.extend({ appointmentId: z.uuid() })),
  }),
  resources: z.object({
    crew: person, vehicle: person.extend({ plate: z.string() }),
    driver: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('participant'), person }),
      z.object({ kind: z.literal('external'), name: z.string(), phone: z.string() }),
    ]),
    participants: z.array(person), start: z.object({ id: z.string(), name: z.string() }), end: z.object({ id: z.string(), name: z.string() }),
  }),
  routeResponsible: person, nextAppointmentId: z.uuid().nullable(), stops: z.array(routeStopSchema),
  lines: z.array(z.object({
    deliveryId: z.uuid(), appointmentId: z.uuid(), sourceLineId: z.number().int().positive(), orderName: z.string(), productName: z.string(), uom: z.string(),
    plannedDeliveryMilli: quantity, plannedInstallationMilli: quantity, plannedCollectionMilli: quantity,
    deliveredMilli: quantity, installedMilli: quantity, collectedMilli: quantity,
    remainingDeliveryMilli: quantity, remainingInstallationMilli: quantity, remainingCollectionMilli: quantity,
    reportMissing: z.boolean(), incompleteWork: z.array(z.object({ operation: z.enum(['delivery', 'installation', 'collection']), reason: z.string(), note: z.string().nullable() })),
  })),
  capabilities: z.object({
    canDepart: z.boolean(), canReturn: z.boolean(), canMarkReturned: z.boolean(),
    departBlocker: z.string().nullable(), returnBlocker: z.string().nullable(), departBlockerCode: z.string().nullable(), returnBlockerCode: z.string().nullable(),
  }),
});

export const crewRoutesSchema = z.object({ routes: z.array(crewRouteSchema) });
export type CrewRoute = z.infer<typeof crewRouteSchema>;
export type RouteStop = z.infer<typeof routeStopSchema>;
export type RouteStatus = z.infer<typeof routeStatusSchema>;

export const routeActionSchema = z.object({ version: z.number().int().positive(), requestId: z.uuid() }).strict();
export const routeReturnSchema = routeActionSchema.extend({ actualReturnedAt: instant, note: z.string().trim().min(1).max(2000).optional() });
