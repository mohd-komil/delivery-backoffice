import { z } from 'zod';
import { sourceSchema } from './contracts';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionCoverage = z.enum(['complete', 'partial', 'unavailable']);
export const sourceChangeSchema = z.object({ kind: z.string(), sourceLineId: z.number().int().positive().nullable(), before: z.string().nullable(), after: z.string().nullable() });
export const sourceReviewSchema = z.object({
  deliveryVersion: z.number().int().positive(), status: z.enum(['current', 'needs_reconciliation']), revisionCoverage,
  documentCoverage: z.literal('not_mapped'), acceptedHash: hash,
  candidate: z.object({ id: z.uuid(), hash, firstSeenAt: z.iso.datetime({ offset: true }), source: sourceSchema.nullable(),
    qualifies: z.boolean(), readComplete: z.boolean(), revisionCoverage, reasons: z.array(z.string()), changes: z.array(sourceChangeSchema) }).nullable(),
  canAccept: z.boolean(), canKeepAccepted: z.boolean(),
  blockers: z.array(z.object({ code: z.string(), message: z.string(), sourceLineId: z.number().int().positive().nullable(),
    appointmentId: z.uuid().nullable(), routeId: z.uuid().nullable() })),
});
export type SourceReview = z.infer<typeof sourceReviewSchema>;
export const sourceReviewInputSchema = z.object({
  version: z.number().int().positive(), requestId: z.uuid(), candidateId: z.uuid(), candidateHash: hash,
  action: z.enum(['accept', 'keep_accepted']), reason: z.string().trim().min(1).max(2000),
}).strict();
export type SourceReviewUpdate = z.infer<typeof sourceReviewInputSchema>;
export const sourceReviewAuditKeys = new Map([
  ['source.candidate_detected', 'eventDetected'], ['source.candidate_accepted', 'eventAccepted'],
  ['source.candidate_kept', 'eventKept'], ['source.revision_rejected', 'eventRejected'],
] as const);
export function sourceReviewAuditKey(action: string) {
  for (const [name, key] of sourceReviewAuditKeys) if (name === action) return key;
  return undefined;
}

export function sourceChangeValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) ?? value;
  } catch {
    return value;
  }
}
