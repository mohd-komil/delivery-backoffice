import type { Delivery, PriorWorkRevision, SourceItem } from './model';

export type PriorWorkScope = Pick<Delivery, 'source' | 'priorWorkRevisions'>;

/** Revisions replace a line's opening balance. They are never summed together. */
export function latestPriorWork(delivery: Pick<Delivery, 'priorWorkRevisions'>) {
  const current = new Map<number, PriorWorkRevision>();
  for (const revision of delivery.priorWorkRevisions ?? []) {
    const previous = current.get(revision.sourceLineId);
    if (previous === undefined || previous.revision < revision.revision) current.set(revision.sourceLineId, revision);
  }
  return current;
}

/** SKU and an order's aggregate qty_delivered cannot establish a physical picking-line identity. */
export function priorWorkMatches(delivery: PriorWorkScope, revision: PriorWorkRevision, item?: SourceItem) {
  const current = item ?? delivery.source.items.find(({ sourceLineId }) => sourceLineId === revision.sourceLineId);
  const previous = revision.sourceItem;
  return current !== undefined && delivery.source.pickingId === revision.pickingId && current.sourceLineId === revision.sourceLineId
    && current.productId === previous.productId && (current.saleOrderId ?? delivery.source.saleOrderId) === revision.saleOrderId
    && (current.saleOrderLineId ?? null) === (previous.saleOrderLineId ?? null)
    && current.uom === previous.uom && (current.uomId ?? null) === (previous.uomId ?? null);
}

export function validPriorWork(delivery: PriorWorkScope) {
  return [...latestPriorWork(delivery).values()].filter((revision) => priorWorkMatches(delivery, revision));
}
