import { z } from 'zod';
import { DestinationAddressKeySchema, destinationAddressKey } from './destination-address';
import type { Delivery } from './model';

// Local teaching metadata. It is separate from the read-only Odoo snapshot.
export const AddressGeographySchema = z.object({
  addressKey: DestinationAddressKeySchema,
  sourceCustomerId: z.number().int().positive(),
  province: z.string().trim().min(1).max(100).nullable(),
  postalCode: z.string().trim().min(1).max(20).nullable(),
  source: z.literal('synthetic_fixture'),
}).strict();

export const DeliveryGeographySchema = z.object({
  city: z.string().nullable(),
  province: z.string().nullable(),
  postalCode: z.string().nullable(),
  source: z.literal('synthetic_fixture').nullable(),
}).strict();
export type DeliveryGeography = z.infer<typeof DeliveryGeographySchema>;

export function deliveryGeography(delivery: Delivery): DeliveryGeography {
  const { customer } = delivery.source;
  const local = delivery.addressGeography;
  const current = local?.sourceCustomerId === customer.id
    && local.addressKey === destinationAddressKey(customer) ? local : undefined;
  return {
    city: customer.city?.trim() || null,
    province: current?.province ?? null,
    postalCode: current?.postalCode ?? null,
    source: current?.source ?? null,
  };
}
