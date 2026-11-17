'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { RoutePreview } from '@/lib/route-drafts';
import { formatDateTime } from '@/lib/time';
import { LocationSnapshot } from './planning-locations';

export function RouteReferenceFacts({ preview }: { preview: Pick<RoutePreview, 'calendar' | 'locations'> }) {
  const t = useTranslations('planning'); const locale = useLocale();
  return <div className="grid gap-3 text-xs">
    {preview.calendar ? <details className="rounded-md border border-border bg-muted/20 p-3"><summary className="cursor-pointer font-medium">{t('calendarSnapshot')} · {t('calendarEntries', { count: preview.calendar.entries.length })}</summary><p className="mt-2">{formatDateTime(preview.calendar.startsAt, locale)} → {preview.calendar.endsAt ? formatDateTime(preview.calendar.endsAt, locale) : '—'}</p>{!preview.calendar.entries.length ? <p className="mt-2 text-warning-foreground">{t('noShift')}</p> : <p className="mt-2 text-muted-foreground">{t('calendarModeHelp')}</p>}</details> : null}
    {preview.locations ? <details className="rounded-md border border-border bg-muted/20 p-3"><summary className="cursor-pointer font-medium">{t('routeLocations')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><LocationSnapshot item={preview.locations.start} /><LocationSnapshot item={preview.locations.end} /></div></details> : null}
  </div>;
}
