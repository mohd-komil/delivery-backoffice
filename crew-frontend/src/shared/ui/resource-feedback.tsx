'use client';

import { useTranslations } from 'next-intl';
import { Button } from './button';
import { Notice } from './feedback';
import { Icon } from './icon';

export function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  const t = useTranslations('crew');
  return <Button variant="secondary" aria-label={t('refresh')} aria-disabled={refreshing} onClick={onRefresh}>
    <span className={refreshing ? 'spinning-icon' : undefined}><Icon name="refresh" size={16} /></span>
    {t('refresh')}
    <span className="sr-only" role="status">{refreshing ? t('refreshing') : ''}</span>
  </Button>;
}

export function ResourceError({ status, retry }: { status: number; retry?: () => void }) {
  const t = useTranslations('crew');
  if (status === 401) return null;
  return <Notice>
    <p>{status === 429 ? t('rateLimited') : t('loadError')}</p>
    {retry ? <Button variant="secondary" className="mt-2" onClick={retry}>{t('retry')}</Button> : null}
  </Notice>;
}
