import { z } from 'zod';
import { AddressGeographySchema, deliveryGeography, DeliveryGeographySchema, type GeographyDelivery } from '../domain/delivery-geography';
import { IdSchema, SourceSchema, TextSchema } from '../domain/model';

export const CalendarFilterCrewSchema = z.object({ id: IdSchema, name: TextSchema, enabled: z.boolean() }).strict();
export const CalendarDestinationOptionSchema = DeliveryGeographySchema.omit({ source: true }).extend({ count: z.number().int().positive() });
export const CalendarFilterOptionsSchema = z.object({
  destinations: z.array(CalendarDestinationOptionSchema),
  crews: z.array(CalendarFilterCrewSchema),
}).strict();
export const CalendarGeographyRowSchema = z.object({
  source: z.object({ customer: SourceSchema.shape.customer }).strict(),
  addressGeography: AddressGeographySchema.nullable(),
}).strict();

/** All local delivery destinations, independent of appointment dates and list pagination. */
export function calendarDestinationOptions(deliveries: readonly GeographyDelivery[]) {
  const destinations = new Map<string, z.infer<typeof CalendarDestinationOptionSchema>>();
  for (const delivery of deliveries) {
    const geography = deliveryGeography(delivery);
    const values = {
      city: geography.city?.trim() || null,
      province: geography.province?.trim() || null,
      postalCode: geography.postalCode?.trim() || null,
    };
    const key = JSON.stringify([values.city?.toLowerCase() ?? null, values.province?.toLowerCase() ?? null, values.postalCode?.toLowerCase() ?? null]);
    const existing = destinations.get(key);
    if (existing) existing.count += 1;
    else destinations.set(key, { ...values, count: 1 });
  }
  return [...destinations].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([, value]) => value);
}
