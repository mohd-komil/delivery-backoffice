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
  source: z.enum(['synthetic_fixture', 'odoo']).nullable(),
}).strict();
export type DeliveryGeography = z.infer<typeof DeliveryGeographySchema>;

export type GeographyDelivery = Pick<Delivery, 'addressGeography'> & { source: Pick<Delivery['source'], 'customer'> };

export function deliveryGeography(delivery: GeographyDelivery): DeliveryGeography {
  const { customer } = delivery.source;
  if (customer.province !== undefined || customer.postalCode !== undefined) {
    const province = customer.province?.trim() || null;
    const postalCode = customer.postalCode?.trim() || null;
    return { city: customer.city?.trim() || null, province, postalCode, source: province || postalCode ? 'odoo' : null };
  }
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
