'use client';

import { useTranslations } from 'next-intl';
import type { RouteStatus as Status } from '@/shared/api/route-contracts';
import { Icon } from './icon';

const presentation = {
  published: { tone: 'info', icon: 'calendar' }, in_progress: { tone: 'info', icon: 'truck' },
  returning: { tone: 'warning', icon: 'truck' }, returned: { tone: 'warning', icon: 'clock' },
  closed: { tone: 'success', icon: 'check' }, cancelled: { tone: 'neutral', icon: 'alert' },
} as const;

export function RouteStatus({ status }: { status: Status }) {
  const t = useTranslations('routes');
  const display = presentation[status];
  return <span className={`status-badge status-${display.tone}`}><Icon name={display.icon} size={14} />{t(status)}</span>;
}
