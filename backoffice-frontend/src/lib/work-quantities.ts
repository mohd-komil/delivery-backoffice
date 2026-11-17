import { z } from 'zod';

const milli = z.number().int().min(0).max(1_000_000_000);
const workQuantitiesSchema = z.object({ deliveryMilli: milli, installationMilli: milli, collectionMilli: milli });

export const workQuantitiesUpdateSchema = z.strictObject({
  version: z.number().int().positive(),
  sourceLineId: z.number().int().positive(),
  quantities: workQuantitiesSchema.nullable(),
  reason: z.string().trim().min(1).max(2000),
});
export type WorkQuantitiesUpdate = z.infer<typeof workQuantitiesUpdateSchema>;

export const workQuantitiesHistorySchema = z.object({
  sourceLineId: z.number().int().positive(),
  previous: workQuantitiesSchema,
  current: workQuantitiesSchema,
  reason: z.string(),
  sourceItem: z.object({ name: z.string(), uom: z.string() }).nullish(),
});
