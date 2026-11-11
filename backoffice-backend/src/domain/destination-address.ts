import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SourceSnapshot } from './model';

export const DestinationAddressKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

export function destinationAddressKey({ address, city, country }: Pick<SourceSnapshot['customer'], 'address' | 'city' | 'country'>): string {
  // Keep the existing draft address identity stable, including for saved manual pins.
  return createHash('sha256').update(JSON.stringify([address?.trim() ?? '', city, country])).digest('hex');
}
