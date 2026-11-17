import { createHash } from 'node:crypto';
import { SourceSchema, type Delivery, type SourceEvidence, type SourceSnapshot } from './model';
import { destinationAddressKey } from './destination-address';

export type ImportGuardScope = Pick<Delivery, 'sourceImport'>;
export function sourceUpdatePending(delivery: ImportGuardScope): boolean { return delivery.sourceImport?.pending !== null && delivery.sourceImport?.pending !== undefined; }
export function sourcePlanningBlocked(delivery: ImportGuardScope): boolean { return sourceUpdatePending(delivery) || delivery.sourceImport?.eligible === false; }

/** Retire only the legacy import warnings, preserving unrelated diagnostics. */
export function acknowledgeSourceReview(delivery: Delivery): void {
  const legacy = new Set([
    'Source picking no longer qualifies or is missing; new planning requires source review',
    'Source record is invalid; previous source snapshot retained for review',
    'Source address, orders or quantities changed after booking; review the remaining work',
  ]);
  delivery.sourceReview = false;
  delivery.sourceChanged = false;
  delivery.sourceWarnings = delivery.sourceWarnings.filter((warning) => !legacy.has(warning));
}

/** Canonical validated business content; neither SQL row order nor observation time is a source revision. */
export function sourceHash(source: SourceSnapshot | null): string {
  if (source === null) return createHash('sha256').update('null').digest('hex');
  const valid = SourceSchema.parse(source);
  valid.items.sort((a, b) => a.sourceLineId - b.sourceLineId);
  valid.salesOrders?.sort((a, b) => a.id - b.id);
  valid.customer.phones = [...new Set(valid.customer.phones)].sort();
  return createHash('sha256').update(JSON.stringify(valid)).digest('hex');
}

export function candidateHash(source: SourceSnapshot | null, qualifies: boolean): string {
  return createHash('sha256').update(`${sourceHash(source)}:${String(qualifies)}`).digest('hex');
}

export function revisionCoverage(evidence: SourceEvidence): 'complete' | 'partial' | 'unavailable' {
  const known = evidence.rows.filter(({ writeDate }) => writeDate !== null).length;
  return known === 0 ? 'unavailable' : known === evidence.rows.length ? 'complete' : 'partial';
}

export type RevisionOrder = 'same' | 'newer' | 'older' | 'conflict' | 'unverified';
export function sourceRevisionRegresses(previous: SourceEvidence, next: SourceEvidence): boolean {
  const before = new Map(previous.rows.map((row) => [`${row.entity}:${row.id}`, row]));
  return next.rows.some((row) => { const old = before.get(`${row.entity}:${row.id}`);
    return old?.writeDate !== null && old?.writeDate !== undefined && row.writeDate !== null && row.writeDate < old.writeDate; });
}
export function compareSourceEvidence(previous: SourceEvidence, next: SourceEvidence): RevisionOrder {
  if (!previous.readComplete || !next.readComplete || previous.rows.length === 0 || next.rows.length === 0) return 'unverified';
  const before = new Map(previous.rows.map((row) => [`${row.entity}:${row.id}`, row]));
  let newer = false;
  let older = false;
  let uncertain = before.size !== next.rows.length;
  let inconsistent = false;
  for (const row of next.rows) {
    const old = before.get(`${row.entity}:${row.id}`);
    if (!old) { uncertain = true; continue; }
    if (old.writeDate !== null && row.writeDate !== null) {
      newer ||= row.writeDate > old.writeDate;
      older ||= row.writeDate < old.writeDate;
      inconsistent ||= old.writeDate === row.writeDate && old.rowHash !== row.rowHash;
    } else if (old.rowHash !== row.rowHash) uncertain = true;
  }
  if (older && !newer) return 'older';
  if (inconsistent || older && newer) return 'conflict';
  if (uncertain) return 'unverified';
  return newer ? 'newer' : 'same';
}

export type SourceChange = { kind: string; sourceLineId: number | null; before: string | null; after: string | null };
export function sourceChanges(previous: SourceSnapshot, next: SourceSnapshot | null): SourceChange[] {
  if (!next) return [{ kind: 'source_missing', sourceLineId: null, before: previous.pickingName, after: null }];
  const changes: SourceChange[] = [];
  const add = (kind: string, before: unknown, after: unknown, sourceLineId: number | null = null) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ kind, sourceLineId, before: before === null ? null : JSON.stringify(before), after: after === null ? null : JSON.stringify(after) });
  };
  add('destination', previous.customer, next.customer);
  add('status', previous.sourceState, next.sourceState);
  add('service', [previous.serviceType, previous.estimatedMinutes], [next.serviceType, next.estimatedMinutes]);
  add('orders', previous.salesOrders ?? [{ id: previous.saleOrderId, name: previous.saleOrderName }], next.salesOrders ?? [{ id: next.saleOrderId, name: next.saleOrderName }]);
  const current = new Map(next.items.map((item) => [item.sourceLineId, item]));
  for (const item of previous.items) {
    const match = current.get(item.sourceLineId);
    if (!match) { add('line_removed', item, null, item.sourceLineId); continue; }
    add('line_identity', [item.productId, item.saleOrderId ?? previous.saleOrderId, item.saleOrderLineId ?? null, item.uom, item.uomId ?? null],
      [match.productId, match.saleOrderId ?? next.saleOrderId, match.saleOrderLineId ?? null, match.uom, match.uomId ?? null], item.sourceLineId);
    add('quantity', item.quantity, match.quantity, item.sourceLineId);
    add('line_details', [item.name, item.sku, item.description, item.configuration, item.ambient, item.notes, item.photoUrl],
      [match.name, match.sku, match.description, match.configuration, match.ambient, match.notes, match.photoUrl], item.sourceLineId);
    current.delete(item.sourceLineId);
  }
  for (const item of current.values()) add('line_added', null, item, item.sourceLineId);
  if (changes.length === 0 && sourceHash(previous) !== sourceHash(next)) add('other', previous, next);
  return changes;
}

/** Keep dispatcher's optional quantities attached to the accepted physical order line. */
export function requiredWorkSourceConflicts(delivery: Delivery, proposed: SourceSnapshot,
  changes: readonly SourceChange[] = sourceChanges(delivery.source, proposed)): number[] {
  const changedIdentity = new Set(changes.filter(({ kind }) => kind === 'line_identity' || kind === 'line_removed')
    .map(({ sourceLineId }) => sourceLineId));
  const units = new Map(proposed.items.map(({ sourceLineId, quantity }) => [sourceLineId, Math.round(quantity * 1000)]));
  return (delivery.servicePlan?.requiredQuantities ?? []).filter(({ sourceLineId, quantities }) => {
    const quantity = units.get(sourceLineId);
    return changedIdentity.has(sourceLineId) || quantity === undefined
      || Math.max(quantities.deliveryMilli, quantities.installationMilli, quantities.collectionMilli) > quantity;
  }).map(({ sourceLineId }) => sourceLineId);
}

/** Acceptance changes only current source input; operational decisions remain separately owned. */
export function acceptSourceSnapshot(delivery: Delivery, source: SourceSnapshot): void {
  const before = delivery.source.customer;
  const after = source.customer;
  if (before.id !== after.id || destinationAddressKey(before) !== destinationAddressKey(after)) {
    delete delivery.routePoint;
    delete delivery.addressGeography;
  }
  if (delivery.source.serviceType !== source.serviceType && delivery.servicePlan) {
    // The review explicitly retains existing choices; these no longer describe the new source default.
    delivery.servicePlan = { ...delivery.servicePlan,
      ...(delivery.servicePlan.defaultOrigin === 'source' ? { defaultOrigin: 'local' as const } : {}),
      overrides: delivery.servicePlan.overrides.map((entry) => entry.origin === 'source' ? { ...entry, origin: 'local' as const } : entry) };
  }
  delivery.source = source;
}
