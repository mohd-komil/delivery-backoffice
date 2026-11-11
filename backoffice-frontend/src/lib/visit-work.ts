import type { LineService, WorkLine, WorkScope } from './contracts';

export const workOperations = [
  { key: 'deliveryMilli', label: 'delivery', total: 'totalDeliveryMilli', done: 'deliveredMilli', remaining: 'remainingDeliveryMilli', reserved: 'reservedDeliveryMilli', available: 'availableDeliveryMilli' },
  { key: 'installationMilli', label: 'installation', total: 'totalInstallationMilli', done: 'installedMilli', remaining: 'remainingInstallationMilli', reserved: 'reservedInstallationMilli', available: 'availableInstallationMilli' },
  { key: 'collectionMilli', label: 'collection', total: 'totalCollectionMilli', done: 'collectedMilli', remaining: 'remainingCollectionMilli', reserved: 'reservedCollectionMilli', available: 'availableCollectionMilli' },
] as const;
export type WorkOperation = (typeof workOperations)[number];
export type WorkDraft = { sourceLineId: number; deliveryMilli: string; installationMilli: string; collectionMilli: string; customerStockConfirmed: boolean };

export function workCapacity(line: LineService, operation: WorkOperation, scope?: WorkScope): number {
  if (!scope) return line[operation.available];
  const own = scope.lines.find((entry) => entry.sourceLineId === line.sourceLineId)?.[operation.key] ?? 0;
  // Release only this visit's reservation; availability may already be clamped after a source reduction.
  return Math.max(0, line[operation.remaining] - Math.max(0, line[operation.reserved] - own));
}

export function workLineBlocked(line: LineService, editing: boolean): boolean {
  return line.service === null || line.planningBlockedReason === 'source_review' || line.planningBlockedReason === 'damage_hold' || (!editing && line.planningBlockedReason !== null);
}

export function initialWorkDrafts(lines: readonly LineService[], scope?: WorkScope, editing = false): WorkDraft[] {
  return lines.map((line) => {
    const existing = scope?.lines.find((entry) => entry.sourceLineId === line.sourceLineId);
    const delivery = existing?.deliveryMilli ?? (editing && scope ? 0 : line.availableDeliveryMilli);
    const installation = existing?.installationMilli ?? (editing && scope ? 0 : line.availableInstallationMilli);
    const collection = existing?.collectionMilli ?? (editing && scope ? 0 : line.availableCollectionMilli);
    const blocked = workLineBlocked(line, editing);
    return { sourceLineId: line.sourceLineId, deliveryMilli: String(blocked ? 0 : delivery / 1000), installationMilli: String(blocked ? 0 : installation / 1000), collectionMilli: String(blocked ? 0 : collection / 1000), customerStockConfirmed: existing?.customerStockConfirmed ?? false };
  });
}

function quantityMilli(value: string): number | null {
  if (value.trim() === '') return 0;
  if (!/^\d+(?:\.\d{0,3})?$/u.test(value)) return null;
  const milli = Math.round(Number(value) * 1000);
  return Number.isSafeInteger(milli) && milli >= 0 ? milli : null;
}

export type WorkValidation = { lines: WorkLine[]; error: null | 'noneSelected' | 'invalidQuantity' | 'exceedsAvailable' | 'stockRequired' };
export function validateWorkDrafts(drafts: readonly WorkDraft[], available: readonly LineService[], scope?: WorkScope, editing = false): WorkValidation {
  const selected: WorkLine[] = [];
  for (const draft of drafts) {
    const deliveryMilli = quantityMilli(draft.deliveryMilli);
    const installationMilli = quantityMilli(draft.installationMilli);
    const collectionMilli = quantityMilli(draft.collectionMilli);
    if (deliveryMilli === null || installationMilli === null || collectionMilli === null) return { lines: [], error: 'invalidQuantity' };
    if (deliveryMilli + installationMilli + collectionMilli === 0) continue;
    const line = available.find((candidate) => candidate.sourceLineId === draft.sourceLineId);
    if (!line || workLineBlocked(line, editing)) return { lines: [], error: 'exceedsAvailable' };
    const work = { sourceLineId: draft.sourceLineId, deliveryMilli, installationMilli, collectionMilli };
    if (workOperations.some((operation) => work[operation.key] > workCapacity(line, operation, scope))) return { lines: [], error: 'exceedsAvailable' };
    if (line.service === 'installation_only' && installationMilli > 0 && !draft.customerStockConfirmed) return { lines: [], error: 'stockRequired' };
    selected.push({ ...work, ...(line.service === 'installation_only' && installationMilli > 0 ? { customerStockConfirmed: true } : {}) });
  }
  return { lines: selected, error: selected.length === 0 ? 'noneSelected' : null };
}
