import { z } from 'zod';
import { quantityMilli } from './visit-work';

const milli = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const priorWorkInputSchema = z.object({
  version: z.number().int().positive(), requestId: z.uuid(), sourceLineId: z.number().int().positive(),
  deliveredMilli: milli, installedMilli: milli, collectedMilli: milli,
  sourceReference: z.string().trim().min(1).max(1000), reason: z.string().trim().min(1).max(2000),
  acknowledgeCurrentPicking: z.literal(true),
}).strict();
export type PriorWorkUpdate = z.infer<typeof priorWorkInputSchema>;

export const priorQuantityInputSchema = z.string().trim().min(1).transform(quantityMilli).pipe(milli);

export const priorWorkOperations = [
  { key: 'delivery', input: 'deliveredMilli', prior: 'priorDeliveredMilli', crew: 'crewDeliveredMilli', total: 'totalDeliveryMilli' },
  { key: 'installation', input: 'installedMilli', prior: 'priorInstalledMilli', crew: 'crewInstalledMilli', total: 'totalInstallationMilli' },
  { key: 'collection', input: 'collectedMilli', prior: 'priorCollectedMilli', crew: 'crewCollectedMilli', total: 'totalCollectionMilli' },
] as const;
