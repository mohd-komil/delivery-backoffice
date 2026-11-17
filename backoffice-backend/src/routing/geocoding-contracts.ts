import { z } from 'zod';
import { GeoPointSchema } from '../domain/model';

export const GeoapifyPrecisionSchema = z.enum(['building', 'amenity', 'street', 'suburb', 'district', 'postcode', 'city', 'county', 'state', 'country', 'unknown']);
export const GeoapifyCandidateSchema = z.object({
  point: GeoPointSchema,
  formattedAddress: z.string().min(1).max(2000),
  precision: GeoapifyPrecisionSchema,
  confidence: z.number().min(0).max(1).nullable(),
  matchType: z.string().max(80).nullable(),
  attribution: z.string().min(1).max(2048),
}).strict();
export type GeoapifyCandidate = z.infer<typeof GeoapifyCandidateSchema>;

export const GeocodingMetadataSchema = z.object({
  provider: z.literal('geoapify'),
  precision: GeoapifyPrecisionSchema,
  confidence: z.number().min(0).max(1).nullable(),
  attribution: z.string().min(1).max(2048),
  acceptance: z.enum(['automatic', 'operator']),
}).strict();
