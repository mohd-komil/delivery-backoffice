import { z } from 'zod';

export const serviceTypeSchema = z.enum(['delivery_only', 'delivery_installation', 'installation_only', 'collection_only']);
export type ServiceType = z.infer<typeof serviceTypeSchema>;

export function operationApplies(service: ServiceType | null, operation: 'delivery' | 'installation' | 'collection'): boolean {
  if (operation === 'delivery') return service === 'delivery_only' || service === 'delivery_installation';
  if (operation === 'installation') return service === 'installation_only' || service === 'delivery_installation';
  return service === 'collection_only';
}
