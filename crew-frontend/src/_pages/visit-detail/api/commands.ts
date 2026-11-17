import { request } from '@/shared/api/client';
import { visitDetailSchema } from '@/shared/api/contracts';
import type { FinishEvidence } from '../model/finish-evidence';
import type { IncompleteWork } from '../model/incomplete-work';
import type { ItemCheck } from '../model/item-check';
import type { PhotoPayload } from '../model/photo';
import type { FinishLineQuantity } from '../model/quantity';

export const issueTypes = ['damage', 'missing_parts', 'access', 'other'] as const;
export type IssueType = typeof issueTypes[number];
type VersionedRequest = { version: number; requestId: string };
type IssueRequest = VersionedRequest & {
  type: IssueType;
  description: string;
  itemIds: number[];
  photo: PhotoPayload;
};

export type FinishResult = {
  summary: string;
  quantities: FinishLineQuantity[];
  itemChecks?: ItemCheck[];
  incompleteWork: IncompleteWork[];
  actualStart?: string;
  photos: (PhotoPayload & { sourceLineId?: number })[];
} & FinishEvidence;

function command(visitId: string, path: string, method: 'POST' | 'PATCH', body: VersionedRequest) {
  return request(`/visits/${encodeURIComponent(visitId)}${path}`, visitDetailSchema, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function startVisit(visitId: string, input: VersionedRequest) {
  return command(visitId, '/start', 'POST', input);
}

export function updateChecklist(visitId: string, checklistId: string, input: VersionedRequest & { done: boolean }) {
  return command(visitId, `/checklist/${encodeURIComponent(checklistId)}`, 'PATCH', input);
}

export function reportIssue(visitId: string, input: IssueRequest) {
  return command(visitId, '/issues', 'POST', input);
}

export function finishVisit(visitId: string, input: VersionedRequest & FinishResult) {
  return command(visitId, '/finish', 'POST', input);
}

export function recordFailedAttempt(visitId: string, input: VersionedRequest & { reason: string }) {
  return command(visitId, '/attempt-failure', 'POST', input);
}
