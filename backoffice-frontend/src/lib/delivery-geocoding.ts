import { z } from 'zod';
import { mapCoordinatesSchema } from './map-coordinates';
import type { EntranceSuggestion } from './delivery-entrance';

export const geocodingPrecisionSchema = z.enum(['building', 'amenity', 'street', 'suburb', 'district', 'postcode', 'city', 'county', 'state', 'country', 'unknown']);
export const geocodingMetadataSchema = z.object({
  provider: z.literal('geoapify'), precision: geocodingPrecisionSchema,
  confidence: z.number().min(0).max(1).nullable(), attribution: z.string().min(1).max(2048),
  acceptance: z.enum(['automatic', 'operator']),
});
export const deliveryGeocodingSchema = z.object({
  provider: z.literal('geoapify'), configured: z.boolean(),
  addressKey: z.string().regex(/^[a-f0-9]{64}$/u), deliveryVersion: z.number().int().positive(),
  recordVersion: z.number().int().positive().nullable(),
  status: z.enum(['not_requested', 'pending', 'accepted', 'review_required', 'not_found', 'failed', 'invalid_address', 'not_configured', 'rate_limited', 'quota_exceeded']),
  reason: z.string().max(100).nullable(), retryAt: z.iso.datetime({ offset: true }).nullable(),
  candidate: z.object({
    point: mapCoordinatesSchema, formattedAddress: z.string().min(1).max(2000), precision: geocodingPrecisionSchema,
    confidence: z.number().min(0).max(1).nullable(), matchType: z.string().max(80).nullable(),
    attribution: z.string().min(1).max(2048),
  }).nullable(),
  acceptance: z.enum(['automatic', 'operator']).nullable(),
}).superRefine((value, context) => {
  if ((value.status === 'accepted' || value.status === 'review_required') && (!value.candidate || value.recordVersion === null)) {
    context.addIssue({ code: 'custom', message: 'A saved or reviewable location requires a stored candidate and version' });
  }
  if (value.status === 'accepted' && value.acceptance === null) {
    context.addIssue({ code: 'custom', message: 'An accepted location requires its acceptance method' });
  }
});
export type DeliveryGeocoding = z.infer<typeof deliveryGeocodingSchema>;

export function entranceSuggestionFromGeocoding(record: DeliveryGeocoding): EntranceSuggestion {
  if (record.candidate && (record.status === 'accepted' || record.status === 'review_required')) {
    return { addressKey: record.addressKey, status: record.status === 'accepted' && record.acceptance === 'automatic' && record.candidate.precision === 'building' ? 'exact' : 'approximate',
      point: record.candidate.point, source: 'geoapify', attribution: record.candidate.attribution };
  }
  const status = {
    not_requested: 'not_requested', pending: 'pending', accepted: 'unavailable', review_required: 'unavailable',
    not_found: 'not_found', failed: 'unavailable', invalid_address: 'invalid_address', not_configured: 'unconfigured',
    rate_limited: 'rate_limited', quota_exceeded: 'quota_exceeded',
  } as const;
  return { addressKey: record.addressKey, status: status[record.status], point: null, source: null };
}
