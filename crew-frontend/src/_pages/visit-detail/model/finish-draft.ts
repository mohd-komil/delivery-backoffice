import type { VisitDetail } from '@/shared/api/contracts';
import type { FinishEvidenceError } from './finish-evidence';
import { readIncompleteWork, type IncompleteWorkError } from './incomplete-work';
import { readItemChecks, type ItemCheckError } from './item-check';
import { readFinishQuantities, type QuantityError } from './quantity';

export const finishSteps = ['work', 'photos', 'signatures'] as const;
export type FinishStep = typeof finishSteps[number];
export type FinishWorkError = { field: 'summary' | 'actualStart' } | QuantityError | ItemCheckError | IncompleteWorkError;
export type FinishDraftError = FinishWorkError | FinishEvidenceError;

export function readFinishWork(visit: Pick<VisitDetail, 'items' | 'actualStartedAt'>, fields: FormData) {
  const rawSummary = fields.get('summary');
  const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
  const actualStart = fields.get('actualStart');
  if (!summary) return { ok: false, error: { field: 'summary' } } as const;
  if (visit.actualStartedAt === null && (typeof actualStart !== 'string' || !actualStart)) {
    return { ok: false, error: { field: 'actualStart' } } as const;
  }

  const quantities = readFinishQuantities(visit.items, fields);
  if (!quantities.ok) return quantities;
  const incomplete = readIncompleteWork(visit.items, quantities.quantities, fields);
  if (!incomplete.ok) return incomplete;
  const checks = readItemChecks(visit.items, fields);
  if (!checks.ok) return checks;

  return { ok: true, work: {
    summary, quantities: quantities.quantities, incompleteWork: incomplete.incompleteWork, itemChecks: checks.itemChecks,
    ...(visit.actualStartedAt === null && typeof actualStart === 'string' ? { actualStart } : {}),
  } } as const;
}

export function finishErrorStep(error: FinishDraftError): FinishStep {
  switch (error.field) {
    case 'photos':
    case 'refusalReason':
    case 'noPhotoReason':
    case 'refusalPhotoConflict':
      return 'photos';
    case 'customerName':
    case 'signature':
    case 'signatureDuplicate':
      return 'signatures';
    default:
      return 'work';
  }
}
