'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { apiRequest, errorMessage } from '@/lib/api';
import { routePreviewSchema, routeSuggestionSchema, type RouteDraftInput, type RoutePreview, type RouteSuggestion } from '@/lib/route-drafts';
import { formatDateTime } from '@/lib/time';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Notice } from './ui';

export function RouteOrderSuggestion({ input, revision, preview, previewStale, pointName, onApply }: {
  input: RouteDraftInput | null; revision: number; preview?: RoutePreview; previewStale: boolean;
  pointName: (id: string) => string; onApply: (ids: string[]) => void;
}) {
  const t = useTranslations('routeChecks');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [record, setRecord] = useState<{ key: string; result: RouteSuggestion } | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; appliedIds: string[] } | null>(null);
  const key = JSON.stringify([input, revision, preview?.feasibility?.fingerprint]);
  const currentKey = useRef(key);
  useEffect(() => { currentKey.current = key; }, [key]);
  const stale = previewStale || record?.key !== key;
  async function suggest() {
    if (!input || pending) return;
    setPending(true); setFailure(null);
    try {
      const result = await apiRequest('/routes/suggest-order', routeSuggestionSchema, { method: 'POST', body: JSON.stringify({ ...input, objective: 'travel_minutes' }) });
      setRecord({ key, result });
    } catch (error: unknown) { setFailure(error); } finally { setPending(false); }
  }
  async function apply() {
    if (!input || !record?.result.suggested || stale || pending) return;
    setPending(true); setFailure(null);
    try {
      const fresh = await apiRequest('/routes/preview', routePreviewSchema, { method: 'POST', body: JSON.stringify(input) });
      if (currentKey.current !== key || !fresh.feasibility || fresh.feasibility.fingerprint !== record.result.current.feasibility?.fingerprint) {
        setRecord(null); toast.error(t('suggestionStale')); return;
      }
      const ids = record.result.deliveryIds;
      if (ids.length !== input.stops.length || new Set(ids).size !== ids.length || !ids.every((id) => input.stops.some((stop) => stop.deliveryId === id))) throw new Error(t('suggestionStale'));
      setUndo({ ids: input.stops.map((stop) => stop.deliveryId), appliedIds: ids });
      onApply(ids); setRecord(null); toast.success(t('applied'));
    } catch (error: unknown) { setFailure(error); } finally { setPending(false); }
  }
  const canUndo = undo && input && undo.appliedIds.length === input.stops.length && undo.appliedIds.every((id, index) => input.stops[index]?.deliveryId === id);
  const result = record?.result;
  return <Card className="grid gap-3 p-4 sm:p-5"><h2 className="text-base font-semibold">{t('comparison')}</h2><p className="text-xs text-muted-foreground">{t('objective')}</p>
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={!input || input.stops.length < 2 || pending || previewStale} onClick={() => { void suggest(); }}>{t(pending ? 'proposing' : 'suggest')}</Button>{canUndo ? <Button type="button" variant="outline" disabled={pending} onClick={() => { onApply(undo.ids); setUndo(null); setRecord(null); toast.success(t('undone')); }}>{t('undo')}</Button> : null}</div>
    {failure ? <Notice tone="error">{errorMessage(failure, locale)}</Notice> : null}
    {result ? <>
      <Notice>{t(stale ? 'suggestionStale' : result.status)}</Notice>
      <p className="text-xs text-muted-foreground">{t('orders', { count: result.evaluatedOrders })}{result.travelMinutesSaved !== null ? ` · ${t('saved', { minutes: result.travelMinutesSaved })}` : ''}</p>
      <div className="grid gap-3 2xl:grid-cols-2"><OrderColumn label={t('current')} preview={result.current} pointName={pointName} />{result.suggested ? <OrderColumn label={t('proposed')} preview={result.suggested} pointName={pointName} /> : null}</div>
      {result.suggested ? <Button type="button" disabled={stale || pending || result.status !== 'suggested'} onClick={() => { void apply(); }}>{t('apply')}</Button> : null}
    </> : null}<p className="text-xs text-muted-foreground">{t('estimated')}</p>
  </Card>;
}

function OrderColumn({ label, preview, pointName }: { label: string; preview: RoutePreview; pointName: (id: string) => string }) {
  const t = useTranslations('routeChecks');
  const locale = useLocale();
  const time = (value: string | null) => value ? formatDateTime(value, locale) : '—';
  return <section className="min-w-0 rounded-md border p-3"><h3 className="font-semibold">{label}</h3><p className="mt-1 text-xs">{t(preview.feasibility?.status ?? 'insufficient_data')}</p><ol className="my-3 grid gap-3">{preview.timeline.stops.map((stop, index) => <li key={stop.deliveryId} className="text-xs"><strong className="break-words">{index + 1}. {pointName(stop.deliveryId)}</strong><dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 font-mono"><dt>{t('eta')}</dt><dd>{time(stop.eta)}</dd><dt>{t('wait')}</dt><dd>{stop.waitMinutes ?? '—'} min</dd><dt>{t('finish')}</dt><dd>{time(stop.workEndAt)}</dd></dl></li>)}</ol><dl className="grid grid-cols-[auto_1fr] gap-x-2 border-t pt-2 text-xs"><dt>{t('return')}</dt><dd>{time(preview.timeline.returnAt)}</dd><dt>{t('travel')}</dt><dd>{preview.timeline.travelMinutes ?? '—'} min</dd><dt>{t('total')}</dt><dd>{preview.timeline.totalMinutes ?? '—'} min</dd></dl>
    {preview.feasibility?.findings.length ? <ul className="mt-3 grid gap-1 text-xs text-warning-foreground">{preview.feasibility.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.message}</li>)}</ul> : null}
  </section>;
}
