'use client';

import { useTranslations } from 'next-intl';
import type { VisitDetail } from '@/shared/api/contracts';
import { Notice } from '@/shared/ui/feedback';

const reasons = {
  missing_scope: 'scopeMissing',
  source_review: 'scopeSourceReview',
  source_changed: 'scopeSourceChanged',
  work_changed: 'scopeWorkChanged',
  stock_pending: 'scopeStockPending',
  damage_hold:'scopeDamageHold',
} as const;

export function WorkScopeNotice({ reason }: { reason: VisitDetail['scopeReviewReason'] }) {
  const t = useTranslations('crew');
  if (!reason) return null;
  return <Notice tone="info"><strong>{t(reason === 'stock_pending' ? 'scopeStockTitle' : 'scopeReviewTitle')}</strong><p>{t(reasons[reason])}</p></Notice>;
}
