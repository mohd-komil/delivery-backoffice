'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { VisitConfirmationState } from '@/lib/visit-confirmation';

export function VisitConfirmationBadge({ state, className }: { state: VisitConfirmationState | null; className?: string }) {
  const t = useTranslations('common');
  if (!state) return null;
  const label = t(state);
  const tone = state === 'customerConfirmed' ? 'success' : 'warning';
  return <span className={cn('badge max-w-full whitespace-normal', tone, className)} title={label}>{label}</span>;
}
