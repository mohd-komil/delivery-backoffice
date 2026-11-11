import { z } from 'zod';
import { routeReferenceSchema } from './route-contracts';

export const crewUserSchema = z.object({ id: z.uuid(), name: z.string(), role: z.literal('crew') });
export const signedOutSchema = z.object({ ok: z.literal(true) });
export type CrewUser = z.infer<typeof crewUserSchema>;

const crewSchema = z.object({ id: z.uuid(), name: z.string() });
const destinationSchema = z.object({
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
});
const remainingQuantitySchema = z.number().int().nonnegative();
const serviceSchema = z.enum(['delivery_only', 'delivery_installation', 'installation_only', 'collection_only']);
const serviceWorkSchema = z.object({
  service: serviceSchema.nullable(),
  remainingDeliveryMilli: remainingQuantitySchema,
  remainingInstallationMilli: remainingQuantitySchema,
  remainingCollectionMilli: remainingQuantitySchema,
  availableInstallationMilli: remainingQuantitySchema,
  plannedDeliveryMilli: remainingQuantitySchema.optional(),
  plannedInstallationMilli: remainingQuantitySchema.optional(),
  plannedCollectionMilli: remainingQuantitySchema.optional(),
});

const visitSchema = z.object({
  id: z.uuid(),
  pickingName: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  status: z.enum(['booked', 'in_progress', 'completed', 'failed']),
  confirmationStatus: z.enum(['awaiting_customer_confirmation', 'customer_confirmed']).nullable(),
  destination: destinationSchema,
  crews: z.array(crewSchema),
  vehicles: z.array(crewSchema.extend({ plate: z.string() })),
  route: routeReferenceSchema.nullable().optional(),
  routeStartBlocker: z.string().nullable().optional(),
});

export const visitsSchema = z.object({ visits: z.array(visitSchema) });
export const visitDetailSchema = visitSchema.extend({
  version: z.number().int().positive(),
  responsibleParticipant: crewSchema.nullable(),
  canFinish: z.boolean(),
  canStart: z.boolean(),
  scopeReviewReason: z.enum(['missing_scope', 'source_review', 'source_changed', 'work_changed', 'stock_pending','damage_hold']).nullable(),
  workScope: z.object({
    revision: z.number().int().positive(),
    confirmedAt: z.iso.datetime({ offset: true }),
    lines: z.array(z.object({
      sourceLineId: z.number().int().positive(),
      deliveryMilli: remainingQuantitySchema,
      installationMilli: remainingQuantitySchema,
      collectionMilli: remainingQuantitySchema,
      customerStockConfirmed: z.boolean().optional(),
      service: serviceSchema,
    })),
  }).nullable(),
  actualStartedAt: z.iso.datetime({ offset: true }).nullable(),
  failedAttempt: z.object({
    reason: z.string(),
    at: z.iso.datetime({ offset: true }),
    actor: crewSchema,
  }).optional(),
  unfinishedChecklistCount: z.number().int().nonnegative(),
  customer: z.object({ name: z.string(), contact: z.string().nullable(), phones: z.array(z.string()) }),
  instructions: z.object({
    floor: z.number().nullable(),
    elevator: z.enum(['unknown', 'yes', 'no']),
    access: z.string().nullable(),
    parking: z.string().nullable(),
    restrictions: z.string().nullable(),
    notes: z.string().nullable(),
  }),
  items: z.array(z.object({
    sourceLineId: z.number().int().positive(),
    name: z.string(),
    quantity: z.number(),
    remainingMilli: remainingQuantitySchema,
    uom: z.string(),
    configuration: z.string().nullable(),
    notes: z.string().nullable(),
    orderName: z.string().optional(),
    serviceWork: serviceWorkSchema.optional(),
  })),
  documents: z.array(z.object({ id: z.uuid(), name: z.string(), mime: z.string(), itemId: z.number().int().positive().nullable(),
    createdAt:z.string(),documentPurpose:z.enum(['general','instruction','drawing']).nullable(),documentVersion:z.number().int().positive().nullable(),
    documentSource:z.literal('local_upload').nullable(),supersedesFileId:z.uuid().nullable(),uploadedBy:crewSchema.nullable(),
  })).optional(),
  issues:z.array(z.object({id:z.uuid(),type:z.enum(['damage','missing_parts','access','other']),description:z.string(),itemIds:z.array(z.number().int().positive()),
    appointmentId:z.uuid().optional(),status:z.enum(['open','resolved']),})).optional(),
  tasks: z.array(z.object({
    id: z.uuid(),
    title: z.string(),
    checklist: z.array(z.object({ id: z.uuid(), label: z.string(), done: z.boolean(), waived: z.boolean() })),
  })),
});

export type VisitSummary = z.infer<typeof visitSchema>;
export type VisitDetail = z.infer<typeof visitDetailSchema>;
