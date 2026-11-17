import { z } from 'zod';
import { IdSchema, InstantSchema, ResponsibleParticipantSchema, TextSchema } from '../domain/model';

export const DispatcherOwnerSchema = ResponsibleParticipantSchema;
export const DispatcherKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DispatcherKindSchema = z.enum(['source_review', 'address_review', 'issue', 'evidence', 'cargo', 'signature_refusal']);
export const DispatcherOriginSchema = z.object({
  deliveryId: IdSchema.nullable(), routeId: IdSchema.nullable(), appointmentId: IdSchema.nullable(),
  sourceLineId: z.number().int().positive().nullable(), issueId: IdSchema.nullable(), resultId: IdSchema.nullable(),
  cargoKind: z.enum(['collection', 'undelivered']).nullable(),
}).strict();
export const DispatcherFactsSchema = z.object({
  key: DispatcherKeySchema, kind: DispatcherKindSchema, fingerprint: DispatcherKeySchema,
  title: TextSchema, description: TextSchema, origin: DispatcherOriginSchema,
  pickingName: TextSchema.nullable(), customerName: TextSchema.nullable(), orderName: TextSchema.nullable(), productName: TextSchema.nullable(),
  quantityMilli: z.number().int().nonnegative().nullable(), uom: TextSchema.nullable(),
  reasons: z.array(z.string().min(1).max(100)).max(100),
  facts: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().max(4000) }).strict()).max(100),
  sourceOwner: DispatcherOwnerSchema.nullable(), sourceAction: z.string().max(2000).nullable(),
  target: z.object({ section: z.enum(['deliveries', 'routes']), deliveryId: IdSchema.nullable(), routeId: IdSchema.nullable(),
    tab: z.enum(['overview', 'visits', 'issues', 'history']).nullable() }).strict(),
}).strict();
export type DispatcherFacts = z.infer<typeof DispatcherFactsSchema>;
export const DispatcherCaseSchema = DispatcherFactsSchema.extend({
  status: z.enum(['open', 'resolved']), version: z.number().int().nonnegative(),
  owner: DispatcherOwnerSchema.nullable(), ownerSource: z.enum(['coordination', 'source', 'unassigned']),
  nextAction: z.string().max(2000).nullable(), note: z.string().max(2000).nullable(),
  updatedAt: InstantSchema.nullable(), updatedBy: DispatcherOwnerSchema.nullable(),
  coordinationStale: z.boolean(),
}).strict();
export const DispatcherHistorySchema = z.object({
  version: z.number().int().positive(), at: InstantSchema, actor: DispatcherOwnerSchema,
  owner: DispatcherOwnerSchema.nullable(), nextAction: TextSchema, note: TextSchema,
  snapshot: DispatcherFactsSchema,
}).strict();
export const DispatcherDetailSchema = z.object({ item: DispatcherCaseSchema, history: z.array(DispatcherHistorySchema) }).strict();
export const DispatcherUpdateSchema = z.object({
  version: z.number().int().nonnegative(), requestId: IdSchema.toLowerCase(), fingerprint: DispatcherKeySchema,
  ownerUserId: IdSchema.toLowerCase().nullable(), nextAction: TextSchema, note: TextSchema,
}).strict();
export const DispatcherQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'), kind: DispatcherKindSchema.or(z.literal('all')).default('all'),
  owner: z.union([z.enum(['all', 'unassigned', 'mine']), IdSchema.toLowerCase()]).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict();
export const DispatcherListSchema = z.object({
  items: z.array(DispatcherCaseSchema).max(10), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.literal(10),
  counts: z.object({ open: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(),
    kinds: z.object({ source_review: z.number().int().nonnegative(), address_review: z.number().int().nonnegative(),
      issue: z.number().int().nonnegative(), evidence: z.number().int().nonnegative(), cargo: z.number().int().nonnegative(),
      signature_refusal: z.number().int().nonnegative() }).strict() }).strict(),
}).strict();
