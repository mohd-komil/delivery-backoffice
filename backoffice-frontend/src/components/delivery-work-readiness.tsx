'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Delivery } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Field, textField } from './ui';

export function DeliveryWorkReadiness({ delivery, release }: { delivery: Delivery; release?: (sourceLineId: number, note: string) => Promise<number> }) {
  const t = useTranslations('operationsFlow');
  const locale = useLocale();
  const holds = delivery.workHolds ?? [];
  if (!holds.length) return null;
  const lines = [...new Set(holds.map((hold) => hold.sourceLineId))];
  return <section className="my-4 grid gap-3" aria-label={t('readiness')}><h3 className="font-semibold">{t('readiness')}</h3><p className="text-xs text-muted-foreground">{t('holdHelp')}</p>
    {lines.map((sourceLineId) => {
      const lineHolds = holds.filter((hold) => hold.sourceLineId === sourceLineId);
      const blocked = lineHolds.some((hold) => !hold.release);
      const item = delivery.source.items.find((line) => line.sourceLineId === sourceLineId);
      return <article key={sourceLineId} className={`grid gap-2 rounded-md border p-3 ${blocked ? 'border-warning-foreground/30 bg-warning/40' : 'border-border'}`}>
        <h4 className="text-sm font-medium">{item ? sourceLineLabel(delivery.source, item, locale) : `#${sourceLineId}`}</h4>
        <span className={`badge ${blocked ? 'warning' : 'success'}`}>{t(blocked ? 'held' : 'released')}</span>
        {lineHolds.map((hold) => <div key={hold.id} className="grid gap-1 text-xs"><p className="text-muted-foreground">{t('holdOrigin', { name: hold.createdBy.name, date: formatDateTime(hold.createdAt, locale) })}</p>
          {hold.issueId ? <a className="underline underline-offset-4" href={`#issue-${hold.issueId}`}>{t('linkedIssue', { id: hold.issueId.slice(0, 8) })}</a> : null}
          {hold.release ? <><p>{t('releaseRecord', { name: hold.release.by.name, date: formatDateTime(hold.release.at, locale) })}</p><p className="whitespace-pre-wrap break-words">{hold.release.note}</p></> : null}
        </div>)}
        {blocked && release && !delivery.completedAt ? <ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('release')} successMessage={t('releaseSaved')} onSubmit={async (data) => release(sourceLineId, textField(data, 'readinessNote'))}><Field label={t('releaseNote')}><textarea name="readinessNote" required minLength={1} maxLength={2000} rows={2} /></Field></ActionForm> : null}
      </article>;
    })}
  </section>;
}

export function ResultIssueLinks({ result }: { result: Delivery['appointments'][number]['results'][number] }) {
  const t = useTranslations('operationsFlow');
  const locale = useLocale();
  if (!result.issueLinks?.length) return null;
  return <section className="my-3 rounded-md border border-warning-foreground/30 p-3"><h4 className="text-sm font-semibold">{t('issueLinks')}</h4><ul className="mt-2 grid gap-2 text-xs">{result.issueLinks.map((link) => {
    const item = result.sourceSnapshot.items.find((line) => line.sourceLineId === link.sourceLineId);
    return <li key={`${link.sourceLineId}-${link.issueId}`}><span className="block">{item ? sourceLineLabel(result.sourceSnapshot, item, locale) : `#${link.sourceLineId}`}</span><span className="font-mono text-muted-foreground">{t('linkedIssue', { id: link.issueId.slice(0, 8) })}</span></li>;
  })}</ul></section>;
}
