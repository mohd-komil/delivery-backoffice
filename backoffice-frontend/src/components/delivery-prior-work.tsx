'use client';

import { useId, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { priorWorkRevisionSchema, type LineService, type PriorWorkLine, type PriorWorkRevision } from '@/lib/contracts';
import { priorQuantityInputSchema, priorWorkInputSchema, priorWorkOperations, type PriorWorkUpdate } from '@/lib/prior-work';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Field, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function DeliveryPriorWork({ line, history, unit, label, version, save }: {
  line: LineService; history: PriorWorkLine; unit: string; label: string; version: number;
  save: (update: PriorWorkUpdate) => Promise<number>;
}) {
  const t = useTranslations('priorWork');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const request = useRef<{ key: string; id: string } | null>(null);
  const statusLabel = history.status === 'needs_review' ? 'needs_review' : history.status === 'confirmed' ? 'confirmed' : 'unknown';
  return <section className="mt-3 rounded-md border border-border bg-muted/25 p-3" aria-label={`${t('title')} · ${label}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h5 className="text-xs font-medium">{t('title')}</h5><span className={`badge mt-1 ${history.status === 'confirmed' ? 'neutral' : 'warning'}`}>{t(statusLabel)}</span></div>
      {history.canEdit || editing ? <Button type="button" size="sm" variant="outline" aria-expanded={editing} aria-controls={editing ? editorId : undefined}
        aria-label={`${t(editing ? 'hide' : 'edit')} · ${label}`} onClick={() => setEditing((value) => !value)}>{t(editing ? 'hide' : 'edit')}</Button> : null}
    </div>
    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">{priorWorkOperations.filter((operation) => line[operation.total] > 0 || history[operation.prior] > 0 || history[operation.crew] > 0).map((operation) => <div key={operation.key}>
      <dt className="font-medium">{t(operation.key)}</dt>
      <dd className="mt-1 text-muted-foreground">{t('prior')}: <span className="tabular-nums">{history.status === 'confirmed' ? `${format.number(history[operation.prior] / 1000)} ${unit}` : '—'}</span></dd>
      <dd className="mt-1 text-muted-foreground">{t('crew')}: <span className="tabular-nums">{format.number(history[operation.crew] / 1000)} {unit}</span></dd>
    </div>)}</dl>
    {history.status === 'unknown' ? <p className="mt-2 text-xs text-muted-foreground">{t('unknownHint')}</p> : null}
    {history.status === 'needs_review' ? <p className="mt-2 text-xs text-warning-foreground" role="status">{t('stale')}</p> : null}
    {history.current ? <PriorWorkRecord record={history.current} compact /> : null}
    {!history.canEdit ? <p className="mt-2 text-xs text-muted-foreground">{t(history.blockedReason ?? 'locked')}</p> : null}
    {editing ? <div id={editorId} className="mt-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{t('intro')}</p>
      <p className="mt-2 rounded-md border border-warning-foreground/25 bg-warning/40 p-2 text-xs text-warning-foreground">{t('warning')}</p>
      <ActionForm dataVersion={version} disabled={!history.canEdit} submitLabel={t('save')} successMessage={t('saved')} secondary onSubmit={async (data) => {
        const body = { version, sourceLineId: line.sourceLineId,
          deliveredMilli: line.totalDeliveryMilli === 0 ? 0 : priorQuantityInputSchema.parse(textField(data, 'deliveredMilli')),
          installedMilli: line.totalInstallationMilli === 0 ? 0 : priorQuantityInputSchema.parse(textField(data, 'installedMilli')),
          collectedMilli: line.totalCollectionMilli === 0 ? 0 : priorQuantityInputSchema.parse(textField(data, 'collectedMilli')),
          sourceReference: textField(data, 'sourceReference'), reason: textField(data, 'reason'),
          acknowledgeCurrentPicking: data.get('acknowledgeCurrentPicking') === 'on',
        };
        const key = JSON.stringify(body);
        if (!request.current || request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
        return save(priorWorkInputSchema.parse({ ...body, requestId: request.current.id }));
      }}>
        <div className="grid gap-x-3 sm:grid-cols-3">{priorWorkOperations.map((operation) => <Field key={operation.key} label={t('quantity', { operation: t(operation.key), unit })}>
          <Input name={operation.input} type="number" inputMode="decimal" min={0} max={line[operation.total] / 1000} step="0.001"
            required disabled={line[operation.total] === 0} defaultValue={line[operation.total] === 0 ? '0' : history.current ? history.current[operation.input] / 1000 : ''}
            aria-label={`${t('quantity', { operation: t(operation.key), unit })} · ${label}`} />
        </Field>)}</div>
        <p className="text-xs text-muted-foreground">{t('zeroHint')}</p>
        <Field label={t('source')} hint={t('sourceHint')}><Input name="sourceReference" required maxLength={1000} defaultValue={history.current?.sourceReference ?? ''} /></Field>
        <Field label={t('reason')} hint={t('reasonHint')}><textarea name="reason" required maxLength={2000} rows={3} defaultValue={history.current?.reason ?? ''} /></Field>
        <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed"><Input name="acknowledgeCurrentPicking" type="checkbox" required className="mt-0.5 shrink-0" />{t('acknowledge')}</label>
      </ActionForm>
    </div> : null}
  </section>;
}

function PriorWorkRecord({ record, compact = false }: { record: PriorWorkRevision; compact?: boolean }) {
  const t = useTranslations('priorWork');
  const format = useFormatter();
  const locale = useLocale();
  return <div className="mt-2 grid gap-2 text-xs [overflow-wrap:anywhere]">
    {!compact ? <><p className="font-medium">{record.sourceItem.name} · {record.saleOrderName}</p><p className="font-mono text-muted-foreground">{record.pickingName} · {t('line', { id: record.sourceLineId })}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-2">{priorWorkOperations.map((operation) => <div key={operation.key}><dt className="font-medium">{t(operation.key)}</dt><dd className="mt-1 tabular-nums text-muted-foreground">{format.number(record[operation.input] / 1000)} {record.sourceItem.uom}</dd></div>)}</dl></> : null}
    <dl className="grid gap-2"><div><dt className="font-medium">{t('source')}</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{record.sourceReference}</dd></div>
      <div><dt className="font-medium">{t('reason')}</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{record.reason}</dd></div></dl>
    <p className="text-muted-foreground">{t('savedBy', { name: record.confirmedBy.name, date: formatDateTime(record.confirmedAt, locale) })}</p>
  </div>;
}

const historyDetailsSchema = z.object({ current: priorWorkRevisionSchema });
export function PriorWorkHistory({ details }: { details: unknown }) {
  const parsed = historyDetailsSchema.safeParse(details);
  return parsed.success ? <PriorWorkRecord record={parsed.data.current} /> : null;
}
