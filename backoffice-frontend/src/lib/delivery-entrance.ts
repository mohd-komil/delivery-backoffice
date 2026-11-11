import { z } from 'zod';
import { mapCoordinatesSchema } from './map-coordinates';

const addressKey = z.string().regex(/^[a-f0-9]{64}$/);
export const entrancePointSchema = mapCoordinatesSchema;
export type EntrancePoint = z.infer<typeof entrancePointSchema>;

export const entranceReviewSchema = z.object({
  addressKey,
  deliveryVersion: z.number().int().positive(),
  entrance: z.object({
    point: entrancePointSchema,
    version: z.number().int().positive(),
    confirmedAt: z.iso.datetime({ offset: true }),
    confirmedBy: z.object({ id: z.uuid(), name: z.string() }),
  }).nullable(),
  stale: z.boolean(),
  address: z.object({ street: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable() }),
  referencePoint: entrancePointSchema.nullable(),
  mapConfig: z.object({ key: z.string().min(1), mapId: z.string().optional() }).nullable().default(null),
});
export type EntranceReviewData = z.infer<typeof entranceReviewSchema>;

export type EntranceReviewSave = {
  addressKey: string;
  deliveryVersion: number;
  version: number | null;
  point: EntrancePoint;
  confirmed: true;
};

export const entranceSuggestionSchema = z.object({ addressKey }).and(z.union([
  z.object({
    status: z.enum(['exact', 'approximate']),
    point: entrancePointSchema,
    source: z.enum(['google', 'source']),
  }),
  z.object({
    status: z.enum(['ambiguous', 'not_found', 'unconfigured', 'unavailable', 'rate_limited', 'missing_address', 'outside_demo']),
    point: z.null(),
    source: z.null(),
  }),
]));
export type EntranceSuggestion = z.infer<typeof entranceSuggestionSchema>;
