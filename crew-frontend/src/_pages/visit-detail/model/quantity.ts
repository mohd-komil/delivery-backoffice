import type { VisitDetail } from '@/shared/api/contracts';

type Item = VisitDetail['items'][number];
type Operation = 'delivery' | 'installation' | 'collection';
type Service = NonNullable<NonNullable<Item['serviceWork']>['service']>;

const serviceOperations: Record<Service, readonly Operation[]> = {
  delivery_only: ['delivery'],
  delivery_installation: ['delivery', 'installation'],
  installation_only: ['installation'],
  collection_only: ['collection'],
};

export type FinishLineQuantity = {
  sourceLineId: number;
  deliveredMilli: number;
  installedMilli?: number;
  collectedMilli?: number;
};

export function quantityFields(item: Item) {
  const work = item.serviceWork;
  if (!work) return [{ operation: 'delivery' as const, remaining: item.remainingMilli, planned: undefined, limit: item.remainingMilli }];
  if (work.service === null) return [];
  const remaining = { delivery: work.remainingDeliveryMilli, installation: work.remainingInstallationMilli, collection: work.remainingCollectionMilli };
  const planned = { delivery: work.plannedDeliveryMilli, installation: work.plannedInstallationMilli, collection: work.plannedCollectionMilli };
  return serviceOperations[work.service].map((operation) => ({
    operation, remaining: remaining[operation], planned: planned[operation],
    limit: Math.min(remaining[operation], planned[operation] ?? remaining[operation]),
  }));
}

export function quantityFieldName(lineId: number, operation: Operation) {
  return `quantity-${lineId}-${operation}`;
}

export function enteredQuantityMilli(value: FormDataEntryValue | null): number | null {
  if (value === null) return 0;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const [whole, fraction = ''] = trimmed.split(/[.,]/u);
  if (!/^(?:\d+(?:[.,]\d{1,3})?|[.,]\d{1,3})$/u.test(trimmed)) return null;
  const quantity = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  return Number.isSafeInteger(quantity) ? quantity : null;
}

export type QuantityError = { field: 'quantity'; name: string; lineId: number; reason: 'invalid' | 'over'; limit: number };

export function readFinishQuantities(items: readonly Item[], fields: FormData):
  { ok: true; quantities: FinishLineQuantity[] } | { ok: false; error: QuantityError } {
  const quantities: FinishLineQuantity[] = [];
  for (const item of items) {
    const row: FinishLineQuantity = { sourceLineId: item.sourceLineId, deliveredMilli: 0 };
    for (const { operation, limit: plannedLimit } of quantityFields(item)) {
      const name = quantityFieldName(item.sourceLineId, operation);
      const value = enteredQuantityMilli(fields.get(name));
      const limit = operation === 'installation' && item.serviceWork
        ? Math.min(plannedLimit, item.serviceWork.availableInstallationMilli + row.deliveredMilli)
        : plannedLimit;
      if (value === null || value > limit) {
        return { ok: false, error: { field: 'quantity', name, lineId: item.sourceLineId, reason: value === null ? 'invalid' : 'over', limit } };
      }
      if (value === 0) continue;
      if (operation === 'delivery') row.deliveredMilli = value;
      else if (operation === 'installation') row.installedMilli = value;
      else row.collectedMilli = value;
    }
    if (row.deliveredMilli || row.installedMilli || row.collectedMilli) quantities.push(row);
  }
  return { ok: true, quantities: quantities.sort((left, right) => left.sourceLineId - right.sourceLineId) };
}
