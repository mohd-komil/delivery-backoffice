import type { Delivery } from '../src/domain/model';

export const importedDemoSourceInstance = 'odoo_mock';

/** Exact identity gate shared by additive demo address enrichments. */
export function matchDemoAddress(sourceId: number, delivery: Delivery):
  { customerId: number } | { reason: 'fixture_changed' | 'incomplete_address' } {
  if (!Number.isInteger(sourceId) || sourceId < 1 || sourceId > 20) return { reason: 'fixture_changed' };
  const customerId = sourceId === 2 ? 1 : ((sourceId - 1) % 12) + 1;
  const customer = delivery.source.customer;
  const expectedStreet = customerId === 12 ? null : `Via Dimostrativa ${customerId}`;
  if (delivery.source.pickingId !== sourceId
    || delivery.source.pickingName !== `DEMO/OUT/${String(sourceId).padStart(4, '0')}`
    || customer.id !== customerId
    || customer.name !== `DEMO Customer ${String(customerId).padStart(2, '0')}`
    || customer.address !== expectedStreet
    || customer.city !== (customerId % 2 === 0 ? 'Messina' : 'Catania')
    || customer.country !== 'IT') return { reason: 'fixture_changed' };
  return expectedStreet === null ? { reason: 'incomplete_address' } : { customerId };
}
