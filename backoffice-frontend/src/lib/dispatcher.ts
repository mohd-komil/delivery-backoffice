import { z } from 'zod';

const key = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(2000);
const instant = z.iso.datetime({ offset: true });
export const dispatcherOwnerSchema = z.object({ id: z.uuid(), name: text });
export const dispatcherKindSchema = z.enum(['source_review', 'address_review', 'issue', 'signature_refusal', 'evidence', 'cargo']);
export const dispatcherFactsSchema = z.object({
  key, kind: dispatcherKindSchema, fingerprint: key, title: text, description: text,
  origin: z.object({ deliveryId: z.uuid().nullable(), routeId: z.uuid().nullable(), appointmentId: z.uuid().nullable(),
    sourceLineId: z.number().int().positive().nullable(), issueId: z.uuid().nullable(), resultId: z.uuid().nullable(), cargoKind: z.enum(['collection', 'undelivered']).nullable() }),
  pickingName: text.nullable(), customerName: text.nullable(), orderName: text.nullable(), productName: text.nullable(),
  quantityMilli: z.number().int().nonnegative().nullable(), uom: text.nullable(), reasons: z.array(z.string().min(1).max(100)).max(100),
  facts: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().max(4000) })).max(100),
  sourceOwner: dispatcherOwnerSchema.nullable(), sourceAction: z.string().max(2000).nullable(),
  target: z.object({ section: z.enum(['deliveries', 'routes']), deliveryId: z.uuid().nullable(), routeId: z.uuid().nullable(),
    tab: z.enum(['overview', 'visits', 'issues', 'history']).nullable() }),
});
export const dispatcherCaseSchema = dispatcherFactsSchema.extend({
  status: z.enum(['open', 'resolved']), version: z.number().int().nonnegative(), owner: dispatcherOwnerSchema.nullable(),
  ownerSource: z.enum(['coordination', 'source', 'unassigned']), nextAction: z.string().max(2000).nullable(), note: z.string().max(2000).nullable(),
  updatedAt: instant.nullable(), updatedBy: dispatcherOwnerSchema.nullable(), coordinationStale: z.boolean(),
});
export const dispatcherDetailSchema = z.object({ item: dispatcherCaseSchema, history: z.array(z.object({
  version: z.number().int().positive(), at: instant, actor: dispatcherOwnerSchema, owner: dispatcherOwnerSchema.nullable(),
  nextAction: text, note: text, snapshot: dispatcherFactsSchema,
})) });
export const dispatcherListSchema = z.object({ items: z.array(dispatcherCaseSchema).max(10), total: z.number().int().nonnegative(),
  page: z.number().int().positive(), pageSize: z.literal(10), counts: z.object({ open: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(),
    kinds: z.object({ source_review: z.number().int().nonnegative(), address_review: z.number().int().nonnegative(), issue: z.number().int().nonnegative(),
      signature_refusal: z.number().int().nonnegative().default(0), evidence: z.number().int().nonnegative(), cargo: z.number().int().nonnegative() }) }) });
export const dispatcherUpdateSchema = z.object({ version: z.number().int().nonnegative(), requestId: z.uuid(), fingerprint: key,
  ownerUserId: z.uuid().nullable(), nextAction: text, note: text }).strict();
export type DispatcherCase = z.infer<typeof dispatcherCaseSchema>;
export type DispatcherDetail = z.infer<typeof dispatcherDetailSchema>;
export type DispatcherList = z.infer<typeof dispatcherListSchema>;
export type DispatcherOwner = z.infer<typeof dispatcherOwnerSchema>;
export type DispatcherUpdate = z.infer<typeof dispatcherUpdateSchema>;
export type DispatcherChange = Omit<DispatcherUpdate, 'requestId'>;
export type DispatcherFacts = z.infer<typeof dispatcherFactsSchema>;
export const dispatcherFiltersSchema = z.object({ status: z.enum(['open', 'resolved', 'all']), kind: dispatcherKindSchema.or(z.literal('all')),
  owner: z.union([z.enum(['all', 'unassigned', 'mine']), z.uuid()]), page: z.number().int().positive().max(100000) });
export type DispatcherFilters = z.infer<typeof dispatcherFiltersSchema>;
export function dispatcherQuery(filters: DispatcherFilters): string {
  const valid = dispatcherFiltersSchema.parse(filters);
  return new URLSearchParams({ status: valid.status, kind: valid.kind, owner: valid.owner, page: String(valid.page) }).toString();
}
