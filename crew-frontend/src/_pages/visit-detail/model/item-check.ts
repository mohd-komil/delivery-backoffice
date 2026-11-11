import type { VisitDetail } from '@/shared/api/contracts';
import { z } from 'zod';

export const itemNoteMaxLength = 500;

const problemTypeSchema=z.enum(['damage','missing_parts','access','other']);
export type ItemCheck = { sourceLineId: number; status: 'ok' | 'problem'; note: string | null; problemType?:z.infer<typeof problemTypeSchema>;linkedIssueId?:string };
export type ItemCheckError = { field: 'itemCheck'; lineId: number; reason: 'status' | 'note' };

export function itemCheckFieldName(lineId: number, field: 'status' | 'note' | 'problemType' | 'linkedIssueId') {
  return `check-${field}-${lineId}`;
}

export function readItemChecks(items: readonly VisitDetail['items'][number][], fields: FormData):
  { ok: true; itemChecks: ItemCheck[] } | { ok: false; error: ItemCheckError } {
  const itemChecks: ItemCheck[] = [];
  for (const { sourceLineId } of items) {
    const status = fields.get(itemCheckFieldName(sourceLineId, 'status'));
    const noteValue = fields.get(itemCheckFieldName(sourceLineId, 'note'));
    const note = typeof noteValue === 'string' ? noteValue.trim() : '';
    if (status !== 'ok' && status !== 'problem') {
      if (note) return { ok: false, error: { field: 'itemCheck', lineId: sourceLineId, reason: 'status' } };
      continue;
    }
    if (note.length > itemNoteMaxLength) {
      return { ok: false, error: { field: 'itemCheck', lineId: sourceLineId, reason: 'note' } };
    }
    const problemType=problemTypeSchema.safeParse(fields.get(itemCheckFieldName(sourceLineId,'problemType')));
    const linkedIssueId=z.uuid().safeParse(fields.get(itemCheckFieldName(sourceLineId,'linkedIssueId')));
    itemChecks.push({ sourceLineId, status, note: note || null,
      ...(status==='problem'&&problemType.success?{problemType:problemType.data}:{}),
      ...(status==='problem'&&linkedIssueId.success?{linkedIssueId:linkedIssueId.data}:{}),
    });
  }
  return { ok: true, itemChecks };
}
