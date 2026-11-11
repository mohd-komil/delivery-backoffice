'use client';

import { useTranslations } from 'next-intl';
import type { VisitSummary } from '@/shared/api/contracts';
import { visitStatus } from '@/shared/lib/visit-display';
import { Icon } from './icon';

export function VisitStatus({ visit }: { visit: VisitSummary }) {
  const t = useTranslations('crew');
  const status = visitStatus(visit);
  return <span className={`status-badge status-${status.tone}`}><Icon name={status.icon} size={14} />{t(status.label)}</span>;
}
