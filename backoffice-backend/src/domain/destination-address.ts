import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SourceSnapshot } from './model';

export const DestinationAddressKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

type Destination = Pick<SourceSnapshot['customer'], 'address' | 'city' | 'country' | 'province' | 'postalCode'>;

/** Missing new fields must not invalidate historical address keys or visit plans. */
export function destinationAreaIdentity({ province, postalCode }: Pick<Destination, 'province' | 'postalCode'>): readonly (string | null)[] {
  const area = [province?.trim() || null, postalCode?.trim() || null];
  return area.some((value) => value !== null) ? area : [];
}

export function destinationAddressKey(destination: Destination): string {
  const { address, city, country } = destination;
  // Keep the existing draft address identity stable, including for saved manual pins.
  return createHash('sha256').update(JSON.stringify([address?.trim() ?? '', city, country, ...destinationAreaIdentity(destination)])).digest('hex');
}
