'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ApiError, ApiResult } from '@/shared/api/client';
import type { VisitDetail } from '@/shared/api/contracts';

export type Action = 'start' | 'checklist' | 'issue' | 'finish' | 'attemptFailure';

const successMessages = {
  start: 'visitStarted',
  checklist: 'checklistSaved',
  issue: 'issueSent',
  finish: 'finishSuccess',
  attemptFailure: 'attemptFailureResult',
} as const;

function failureMessage(error: ApiError, action: Action) {
  if (error.code === 'CUSTOMER_CONFIRMATION_REQUIRED') return 'awaitingDescription';
  if (error.code === 'VISIT_NOT_IN_PROGRESS') return 'visitNotInProgress';
  if (error.code === 'CHECKLIST_WAIVED') return 'checklistWaived';
  if (error.code === 'NOT_VISIT_RESPONSIBLE') return 'finishNotResponsible';
  if (error.code === 'VISIT_RESPONSIBLE_REQUIRED') return 'finishNoResponsible';
  if (error.code === 'ACTUAL_START_REQUIRED') return 'finishStartRequired';
  if (error.code === 'INVALID_INTERVAL') return 'finishInvalidInterval';
  if (error.code === 'EXCESS_DELIVERY' || error.code === 'EXCESS_INSTALLATION' || error.code === 'EXCESS_COLLECTION'
    || error.code === 'INSTALLATION_REQUIRES_DELIVERY') return 'finishRemainingChanged';
  if (error.code === 'INCOMPLETE_WORK_REASON_REQUIRED' || error.code === 'UNEXPECTED_INCOMPLETE_WORK_REASON') return 'incompleteReviewReasons';
  if (error.code === 'SIGNATURES_NOT_DISTINCT') return 'signatureDistinct';
  if (error.code === 'SIGNATURE_REFUSAL_REQUIRES_WORK') return 'signatureRefusalRequiresWork';
  if (error.code === 'COMPLETION_PHOTO_REQUIRED') return 'photoRequired';
  if (error.code === 'PHOTO_READ_FAILED') return 'photoReadFailed';
  if (error.status === 403 || error.status === 404) return 'actionUnavailable';
  if (error.status === 409) return 'visitChanged';
  if (error.status === 429) return 'rateLimited';
  if (error.status === 413 && action === 'finish') return 'finishPhotoBodySize';
  if (error.status === 413 && action === 'issue') return 'photoSize';
  if (error.status === 400 && action === 'issue') return 'invalidIssue';
  return 'actionFailed';
}

export function useVisitActions(publish: (data: VisitDetail) => void, revalidate: () => Promise<void>) {
  const t = useTranslations('crew');
  const locked = useRef(false);
  const [busy, setBusy] = useState<Action | null>(null);

  async function run(action: Action, send: () => Promise<ApiResult<VisitDetail>>) {
    if (locked.current) return false;

    locked.current = true;
    setBusy(action);
    const notification = { id: `crew-${action}` };

    try {
      const result = await send();
      if (result.ok) {
        publish(result.data);
        toast.success(t(successMessages[action]), notification);
        return true;
      }

      if (result.status === 401) window.location.replace('/login');
      else toast.error(t(failureMessage(result, action)), notification);
      if ([401, 403, 404, 409].includes(result.status)) await revalidate();
      return false;
    } catch {
      toast.error(t('actionFailed'), notification);
      return false;
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }

  return { busy, run };
}

export type VisitActions = ReturnType<typeof useVisitActions>;
