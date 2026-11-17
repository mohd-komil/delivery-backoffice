'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { z } from 'zod';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { formatDateTime } from '@/lib/time';
import { Empty, Field, Notice, Pending } from './ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, useDialogClose } from './ui/dialog';

// Lists and history share read semantics; business fields and validation stay with each catalogue.
export function usePlanningRead<T>(path: string | null, schema: z.ZodType<T>, active = true, refreshKey = 0) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data: T } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [activation, setActivation] = useState({ active, revision: 0 });
  if (activation.active !== active) setActivation({ active, revision: activation.revision + 1 });
  const key = `${path}:${revision}:${refreshKey}:${activation.revision}`;
  useEffect(() => {
    if (!path || !active) return;
    const controller = new AbortController();
    void apiRequest(path, schema, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) { setLoaded({ key, data }); setFailure(null); }
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [path, schema, key, active]);
  return { data: loaded?.data ?? null, failure, loading: path !== null && loaded?.key !== key && failure === null,
    ready: path === null || loaded?.key === key && failure === null,
    refresh: () => { setFailure(null); setRevision((value) => value + 1); } };
}

export function usePlanningCommand() {
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  return async function command<T>(path: string, schema: z.ZodType<T>, body: Readonly<Record<string, unknown>>, method = 'POST') {
    const key = JSON.stringify({ path, method, body });
    if (!pending.current || pending.current.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    return mutate(path, schema, { ...body, requestId: pending.current.requestId }, method);
  };
}

export function PlanningReadState({ data, failure, loading, retry }: { data: boolean; failure: unknown; loading: boolean; retry: () => void }) {
  const t = useTranslations('planning'); const locale = useLocale();
  return <div className="my-3 min-h-8 text-xs" role="status">{failure ? <Notice tone="error">{errorMessage(failure, locale)} {data ? t('previous') : ''} <Button type="button" variant="outline" size="sm" onClick={retry}>{t('retry')}</Button></Notice>
    : loading ? data ? <span className="text-muted-foreground">{t('refreshing')}</span> : <Pending>{t('loading')}</Pending> : null}</div>;
}

export function PlanningEditor({ title, onClose, refresh, loading, children }: { title: string; onClose: () => void; refresh?: () => void; loading?: boolean; children: ReactNode }) {
  const t = useTranslations('planning');
  const dialog = useDialogClose(onClose);
  return <Dialog open={dialog.open} onOpenChange={(open) => { if (!open) dialog.close(); }}><DialogContent className="dialog max-h-[88vh] overflow-y-auto sm:max-w-3xl" aria-describedby={undefined}>
    <div className="section-title"><DialogTitle>{title}</DialogTitle><div className="flex items-center gap-2">{refresh ? <Button type="button" variant="outline" size="sm" disabled={loading} onClick={refresh}>{t('refresh')}</Button> : null}<Button type="button" variant="ghost" size="icon" onClick={dialog.close} aria-label={t('close')}>×</Button></div></div>{children}
  </DialogContent></Dialog>;
}

export function PlanningReason() {
  const t = useTranslations('planning');
  return <Field label={t('reason')} hint={t('reasonHelp')}><textarea name="reason" rows={2} required maxLength={2000} /></Field>;
}

export function PlanningHistory({ entries }: { entries: readonly { version: number; at: string; actor: { name: string } | null; reason: string; snapshot: ReactNode }[] }) {
  const t = useTranslations('planning'); const locale = useLocale();
  return <details className="mt-4 rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('history')} ({entries.length})</summary><div className="mt-3">{entries.length ? <ol className="grid gap-3">{entries.map((entry) => <li key={entry.version} className="rounded-md border border-border bg-muted/20 p-3 text-xs">
    <p className="font-medium">{t('revision', { version: entry.version })}</p><p className="mt-1 text-muted-foreground">{t('recorded', { name: entry.actor?.name ?? t('system'), date: formatDateTime(entry.at, locale) })}</p><p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.reason}</p>
    <details className="mt-2"><summary className="cursor-pointer">{t('snapshot')}</summary><div className="mt-2">{entry.snapshot}</div></details>
  </li>)}</ol> : <Empty title={t('noHistory')} />}</div></details>;
}
