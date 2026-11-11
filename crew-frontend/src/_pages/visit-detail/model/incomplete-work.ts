import type { VisitDetail } from '@/shared/api/contracts';
import { quantityFields, type FinishLineQuantity } from './quantity';

export const incompleteWorkReasons = ['missing_goods_or_parts', 'damage', 'access', 'customer_refused', 'time_shortage', 'other'] as const;
export const incompleteWorkNoteMaxLength = 500;
export type WorkOperation = 'delivery' | 'installation' | 'collection';
export type IncompleteWorkReason = typeof incompleteWorkReasons[number];
export type IncompleteWork = { sourceLineId: number; operation: WorkOperation; reason: IncompleteWorkReason; note: string | null };
export type IncompleteWorkError = {
  field: 'incompleteWork'; lineId: number; operation: WorkOperation; name: string;
  reason: 'reasonRequired' | 'noteRequired' | 'noteTooLong';
};

export const incompleteReasonMessages = {
  missing_goods_or_parts: 'incompleteMissingGoods', damage: 'incompleteDamage', access: 'incompleteAccess',
  customer_refused: 'incompleteCustomerRefused', time_shortage: 'incompleteTimeShortage', other: 'incompleteOther',
} as const;

export function incompleteWorkFieldName(lineId: number, operation: WorkOperation, field: 'reason' | 'note') {
  return `incomplete-${lineId}-${operation}-${field}`;
}

export function readIncompleteWork(items: readonly VisitDetail['items'][number][], quantities: readonly FinishLineQuantity[], fields: FormData):
  { ok: true; incompleteWork: IncompleteWork[] } | { ok: false; error: IncompleteWorkError } {
  const incompleteWork: IncompleteWork[] = [];
  const actualByLine = new Map(quantities.map((quantity) => [quantity.sourceLineId, quantity]));
  for (const item of items) {
    const actual = actualByLine.get(item.sourceLineId);
    for (const { operation, planned } of quantityFields(item)) {
      const done = operation === 'delivery' ? actual?.deliveredMilli ?? 0
        : operation === 'installation' ? actual?.installedMilli ?? 0 : actual?.collectedMilli ?? 0;
      if (planned === undefined || planned === 0 || done >= planned) continue;
      const reasonName = incompleteWorkFieldName(item.sourceLineId, operation, 'reason');
      const reasonValue = fields.get(reasonName);
      const reason = incompleteWorkReasons.find((candidate) => candidate === reasonValue);
      if (!reason) return { ok: false, error: { field: 'incompleteWork', lineId: item.sourceLineId, operation, name: reasonName, reason: 'reasonRequired' } };
      const noteName = incompleteWorkFieldName(item.sourceLineId, operation, 'note');
      const noteValue = fields.get(noteName);
      const note = typeof noteValue === 'string' ? noteValue.trim() : '';
      const noteError = note.length > incompleteWorkNoteMaxLength ? 'noteTooLong' : reason === 'other' && !note ? 'noteRequired' : null;
      if (noteError) return { ok: false, error: { field: 'incompleteWork', lineId: item.sourceLineId, operation, name: noteName, reason: noteError } };
      incompleteWork.push({ sourceLineId: item.sourceLineId, operation, reason, note: note || null });
    }
  }
  return { ok: true, incompleteWork };
}
