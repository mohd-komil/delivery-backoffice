'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { en as routeMessages } from '@/i18n/messages/route-operations';
import { isRouteBlockerKey } from '@/i18n/route-operations';
import { ApiError, apiRequest, errorMessage, mutate } from '@/lib/api';
import type { Crew, Participant, Vehicle } from '@/lib/contracts';
import type { RoutePoint } from '@/lib/route-drafts';
import type { PublicationReview } from '@/lib/route-publication';
import { routeOperationsSchema, routeRevisionSchema, validateRouteCommand, type RouteCommand, type RouteOperations, type RouteRevision } from '@/lib/route-operations';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Field, Notice, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { DateTimeInput } from './date-time-fields';
import { FrozenPublication, ScopeSummary } from './route-publication-summary';
import { RouteAmendment } from './route-amendment';
import { RouteReconciliation } from './route-reconciliation';
import { RouteAttestations } from './route-operation-fields';
import { RouteRevisionFacts } from './route-revision-facts';

export type RouteOperationCatalogs = { participants: readonly Participant[]; crews: readonly Crew[]; vehicles: readonly Vehicle[]; points: readonly RoutePoint[] };
const historyLabels: Readonly<Partial<Record<string, keyof typeof routeMessages>>> = {
  'route.published': 'event_published', 'route.amended': 'event_amended', 'route.departed': 'event_departed',
  'route.returning': 'event_returning', 'route.aborted': 'event_aborted', 'route.returned': 'event_returned',
  'route.cancelled': 'event_cancelled', 'route.stop_skipped': 'event_skipped', 'route.reconciled': 'event_reconciled',
  'route.warehouse_received': 'event_warehouse_receipt', 'route.closed': 'event_closed',
};

export function RouteOperationsPanel({ routeId, revision, fallbackReview, catalogs, onOpenDelivery }: {
  routeId: string; revision: number; fallbackReview?: PublicationReview; catalogs: RouteOperationCatalogs; onOpenDelivery?: (deliveryId: string) => void;
}) {
  const t = useTranslations('routeOperations');
  const pub = useTranslations('routePublication');
  const locale = useLocale();
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: RouteOperations } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const key = JSON.stringify([routeId, revision, refresh]);
  const currentKey = useRef(key);
  useEffect(() => { currentKey.current = key; }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest(`/routes/${routeId}/operations`, routeOperationsSchema, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setLoaded((previous) => ({ key, value: previous?.value.id === value.id && previous.value.version > value.version ? previous.value : value })); setFailure(null); }
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [routeId, key]);
  const data = loaded?.value;
  const ready = loaded?.key === key && !failure;

  const command: RouteCommand = async (path, body) => {
    if (busy.current || !data || !ready) throw new Error(t('stale'));
    const requestKey = JSON.stringify([routeId, data.version, path, body]);
    if (!request.current || request.current.key !== requestKey) request.current = { key: requestKey, id: crypto.randomUUID() };
    const input = validateRouteCommand(path, { ...body, version: data.version, requestId: request.current.id });
    busy.current = true; setPending(true);
    try {
      const value = await mutate(`/routes/${routeId}/${path}`, routeOperationsSchema, input);
      setLoaded({ key: currentKey.current, value }); setFailure(null);
      return value.version;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) setRefresh((value) => value + 1);
      throw error;
    } finally { busy.current = false; setPending(false); }
  };

  if (!data) return <section className="grid gap-3">
    <Notice>{failure ? t('unavailable') : pub('loading')}</Notice>{failure ? <p className="text-sm text-destructive">{errorMessage(failure, locale)}</p> : null}
    {failure ? <Button type="button" variant="outline" onClick={() => setRefresh((value) => value + 1)}>{t('retry')}</Button> : null}
    {fallbackReview ? <FrozenPublication review={fallbackReview} /> : null}
  </section>;
  return <section className="grid min-w-0 gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="text-xs text-muted-foreground">{t('revision', { version: data.version })}</p><Button type="button" variant="outline" disabled={pending} onClick={() => setRefresh((value) => value + 1)}>{t('refresh')}</Button></div>
    <div className="flex flex-wrap items-center gap-2"><span className={`badge ${data.status === 'cancelled' ? 'warning' : data.status === 'closed' ? 'success' : 'info'}`}>{t(data.status)}</span><strong>{data.name}</strong></div>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('title')}>{(['current', 'history'] as const).map((value) => <Button type="button" key={value} variant={tab === value ? 'default' : 'outline'} aria-pressed={tab === value} onClick={() => setTab(value)}>{t(value)}</Button>)}</div>
    {failure ? <Notice tone="error">{errorMessage(failure, locale)}</Notice> : null}
    <div hidden={tab !== 'current'} className="grid min-w-0 gap-4">
      <p className="text-sm text-muted-foreground">{t('currentHelp')}</p>
      <LiveRouteSummary data={data} onOpenDelivery={onOpenDelivery} />
      {!data.runtime.departed && data.status === 'published' ? <div className="grid gap-3 lg:grid-cols-2">
        <ReasonAction data={data} command={command} path="depart" label={t('depart')} noteLabel={t('departReason')} disabled={!ready || pending || !data.capabilities.canDepart} />
        {data.capabilities.departBlocker ? <Notice>{isRouteBlockerKey(data.capabilities.departBlockerCode) ? t(data.capabilities.departBlockerCode) : data.capabilities.departBlocker}</Notice> : null}
      </div> : null}
      {data.capabilities.canAmend ? <RouteAmendment data={data} catalogs={catalogs} revision={key} disabled={!ready || pending} command={command} /> : null}
      {data.capabilities.canCancel ? <CancelRoute data={data} disabled={!ready || pending} command={command} /> : null}
      {data.status === 'in_progress' || data.status === 'returning' ? <>
        <Notice>{t('noOrdinaryEdits')}</Notice>
        <div className="grid gap-3 lg:grid-cols-2">
          {data.status === 'in_progress' ? <><ReasonAction data={data} command={command} path="returning" label={t('returningAction')} disabled={!ready || pending || !data.capabilities.canReturn} /><ReasonAction data={data} command={command} path="abort" label={t('abort')} disabled={!ready || pending} /></> : null}
          {data.capabilities.returnBlocker ? <Notice>{isRouteBlockerKey(data.capabilities.returnBlockerCode) ? t(data.capabilities.returnBlockerCode) : data.capabilities.returnBlocker}</Notice> : null}
        </div>
      </> : null}
      {['in_progress', 'returning', 'returned'].includes(data.status) ? <div className="grid gap-3 lg:grid-cols-2">{data.stops.filter((stop) => stop.status === 'booked' && !stop.skipped).map((stop) => <details key={stop.appointmentId} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('skip')} · {stop.pickingName}</summary><p className="my-2 text-xs text-muted-foreground">{t('skipHelp')}</p><ReasonAction data={data} command={command} path={`stops/${stop.appointmentId}/skip`} label={t('skip')} disabled={!ready || pending} /></details>)}</div> : null}
      {data.capabilities.canMarkReturned ? <ActualReturn data={data} disabled={!ready || pending} command={command} /> : null}
      {data.capabilities.canReconcile || data.status === 'closed' ? <RouteReconciliation data={data} disabled={!ready || pending || !data.capabilities.canReconcile} command={command} /> : null}
      {data.status === 'returned' ? <CloseRoute data={data} command={command} disabled={!ready || pending} /> : null}
    </div>
    <div hidden={tab !== 'history'}><RouteHistory data={data} /></div>
  </section>;
}

function LiveRouteSummary({ data, onOpenDelivery }: { data: RouteOperations; onOpenDelivery?: (id: string) => void }) {
  const t = useTranslations('routeOperations');
  const pub = useTranslations('routePublication');
  const routes = useTranslations('routes');
  const checks = useTranslations('routeChecks');
  const calendar = useTranslations('calendar');
  const locale = useLocale();
  const driver = data.resources.driver;
  return <>
    <dl className="grid gap-3 rounded-lg border bg-muted/15 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div><dt className="text-muted-foreground">{routes('crew')}</dt><dd>{data.resources.crew.name} · {data.resources.participants.map((person) => person.name).join(', ')}</dd></div>
      <div><dt className="text-muted-foreground">{routes('vehicle')}</dt><dd>{data.resources.vehicle.name}</dd></div>
      <div><dt className="text-muted-foreground">{checks('driver')}</dt><dd>{driver.kind === 'participant' ? driver.person.name : driver.kind === 'external' ? driver.name : '—'}</dd></div>
      <div><dt className="text-muted-foreground">{pub('departure')}</dt><dd>{data.resources.start.name} · {formatDateTime(data.review.timeline.departAt, locale)}</dd></div>
      <div><dt className="text-muted-foreground">{pub('return')}</dt><dd>{data.resources.end.name} · {data.review.timeline.returnAt ? formatDateTime(data.review.timeline.returnAt, locale) : '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('actualDeparture')}</dt><dd>{data.runtime.departed ? formatDateTime(data.runtime.departed.at, locale) : '—'}</dd></div>
      {data.runtime.returned ? <div><dt className="text-muted-foreground">{t('actualReturn')}</dt><dd>{formatDateTime(data.runtime.returned.actualReturnedAt, locale)}</dd></div> : null}
    </dl>
    <p className="text-xs text-info-foreground">{pub('estimate')}</p>
    <ol className="grid gap-3">{data.stops.map((stop) => <li key={stop.appointmentId} className="min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{stop.sequence}. {stop.pickingName}</h4>{['published', 'in_progress'].includes(data.status) && data.nextAppointmentId === stop.appointmentId ? <span className="badge info">{t('nextStop')}</span> : null}<span className="badge neutral">{calendar(stop.status)}</span>{stop.skipped ? <span className="badge warning">{t('skipped')}</span> : null}</div>
      {data.status === 'cancelled' && stop.source === 'attached' && stop.status === 'booked' ? <p className="mt-2 text-xs text-info-foreground">{t('attachedRetained')}</p> : null}
      <p className="mt-1 text-sm text-muted-foreground">{stop.customerName} · {[stop.address, stop.city].filter(Boolean).join(', ')}</p>
      <p className="mt-2 font-mono text-xs">{checks('eta')}: {stop.eta ? formatDateTime(stop.eta, locale) : '—'} · {pub('starts')}: {stop.workStartAt ? formatDateTime(stop.workStartAt, locale) : '—'} · {pub('ends')}: {stop.workEndAt ? formatDateTime(stop.workEndAt, locale) : '—'}</p>
      <div className="my-2 flex flex-wrap gap-2">{stop.confirmationStatus ? <span className={`badge ${stop.confirmationStatus === 'customer_confirmed' ? 'success' : 'warning'}`}>{pub(stop.confirmationStatus)}</span> : null}<span className={`badge ${stop.reported ? 'success' : 'neutral'}`}>{t(stop.reported ? 'reported' : 'reportMissing')}</span></div>
      {stop.startBlocker ? <p className="text-xs text-warning-foreground">{isRouteBlockerKey(stop.startBlockerCode) ? t(stop.startBlockerCode) : stop.startBlocker}</p> : null}
      {stop.workScope ? <details className="mt-2"><summary className="cursor-pointer text-xs font-medium">{pub('selectedWork')}</summary><ScopeSummary scope={stop.workScope} /></details> : null}
      {onOpenDelivery ? <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => onOpenDelivery(stop.deliveryId)}>{t('openDelivery')}</Button> : null}
    </li>)}</ol>
  </>;
}

function ReasonAction({ data, path, label, disabled, command, noteLabel }: { data: RouteOperations; path: string; label: string; disabled: boolean; command: RouteCommand; noteLabel?: string }) {
  const t = useTranslations('routeOperations');
  return <ActionForm dataVersion={data.version} disabled={disabled} submitLabel={label} successMessage={t('saved')} onSubmit={(form) => command(path, { reason: textField(form, 'reason') })}>
    <Field label={noteLabel ?? t('reason')}><Input name="reason" required maxLength={2000} /></Field>
  </ActionForm>;
}

function ActualReturn({ data, disabled, command }: { data: RouteOperations; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  return <section className="rounded-lg border p-4"><h4 className="font-semibold">{t('actualReturn')}</h4><p className="my-2 text-sm text-muted-foreground">{t('returnHelp')}</p>
    <ActionForm dataVersion={data.version} disabled={disabled} submitLabel={t('markReturned')} successMessage={t('saved')} onSubmit={(form) => command('return', { actualReturnedAt: textField(form, 'actualReturnedAt'), ...(textField(form, 'note') ? { note: textField(form, 'note') } : {}) })}>
      <DateTimeInput name="actualReturnedAt" label={t('actualReturn')} /><Field label={t('note')}><Input name="note" maxLength={2000} /></Field>
    </ActionForm>
  </section>;
}

function CancelRoute({ data, disabled, command }: { data: RouteOperations; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  return <details className="rounded-lg border border-destructive/30 p-4"><summary className="cursor-pointer font-semibold">{t('cancel')}</summary><p className="my-3 text-sm text-muted-foreground">{t('cancelHelp')}</p>
    <ActionForm dataVersion={data.version} disabled={disabled} submitLabel={t('cancelAction')} successMessage={t('saved')} onSubmit={(form) => command('cancel', { reason: textField(form, 'reason'), confirmNotDeparted: form.get('notDeparted') === 'on', confirmNotLoaded: form.get('notLoaded') === 'on', cancelAttachedAppointmentIds: form.getAll('cancelAttached') })}>
      <Field label={t('reason')}><Input name="reason" required maxLength={2000} /></Field>
      <RouteAttestations />
      {data.stops.filter((stop) => stop.source === 'attached').map((stop) => <label key={stop.appointmentId} className="my-3 flex items-start gap-2 text-sm"><Input type="checkbox" name="cancelAttached" value={stop.appointmentId} /><span>{t('cancelAttached')} · {stop.pickingName}</span></label>)}
    </ActionForm>
  </details>;
}

function CloseRoute({ data, disabled, command }: { data: RouteOperations; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  const [exception, setException] = useState(false);
  return <section className="rounded-lg border p-4"><h4 className="font-semibold">{t('close')}</h4><p className="my-2 text-sm text-muted-foreground">{t('closeHelp')}</p>
    {data.capabilities.closureIssues?.length ? <ul className="my-3 grid gap-1 text-sm text-warning-foreground">{data.capabilities.closureIssues.map((issue, index) => {
      const line = data.lines.find((entry) => entry.appointmentId === issue.appointmentId && entry.sourceLineId === issue.sourceLineId);
      return <li key={index}>{line ? `${line.orderName} · ${line.productName}: ` : ''}{isRouteBlockerKey(issue.code) ? t(issue.code) : issue.message}</li>;
    })}</ul> : data.capabilities.closureBlockers.length ? <ul className="my-3 grid gap-1 text-sm text-warning-foreground">{data.capabilities.closureBlockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul> : null}
    <ActionForm dataVersion={data.version} disabled={disabled} submitDisabled={data.stops.some((stop) => stop.status === 'booked') || !data.capabilities.canClose && !exception} submitLabel={t('close')} successMessage={t('saved')} onSubmit={(form) => command('close', { reason: textField(form, 'reason'), ...(exception ? { exceptionReason: textField(form, 'exceptionReason') } : {}) })}>
      <Field label={t('closureReason')}><Input name="reason" required maxLength={2000} /></Field>
      <label className="my-3 flex items-start gap-2 text-sm"><Input type="checkbox" checked={exception} onChange={(event) => setException(event.target.checked)} />{t('exception')}</label>
      {exception ? <><p className="text-xs text-muted-foreground">{t('exceptionHelp')}</p><Field label={t('exceptionReason')}><Input name="exceptionReason" required maxLength={2000} /></Field></> : null}
    </ActionForm>
  </section>;
}

function RouteHistory({ data }: { data: RouteOperations }) {
  const t = useTranslations('routeOperations');
  const eventLabel = (action: string) => { const label = historyLabels[action]; return label ? t(label) : action; };
  const locale = useLocale();
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<RouteRevision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  async function view(version: number) {
    if (pending) return;
    setPending(true); setError(null);
    try { const value = await apiRequest(`/routes/${data.id}/revisions/${version}`, routeRevisionSchema); setSnapshot(value); setSelected(version); }
    catch (failure: unknown) { setError(failure); toast.error(errorMessage(failure, locale)); }
    finally { setPending(false); }
  }
  return <section className="grid gap-3">
    <DataTable caption={t('history')} header={<tr><th>{t('historyVersion', { version: '' })}</th><th>{t('current')}</th><th>{t('reason')}</th><th>{t('viewRevision')}</th></tr>} rows={data.history.map((event) => <tr key={event.version}><td>{event.version}<span className="cell-sub">{formatDateTime(event.at, locale)}</span></td><td>{eventLabel(event.action)}<span className="cell-sub">{event.actor.name} · {t(event.status)}</span></td><td className="max-w-lg whitespace-normal">{event.reason ?? '—'}</td><td><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => { void view(event.version); }}>{t('viewRevision')}</Button></td></tr>)} />
    {error ? <Notice tone="error">{errorMessage(error, locale)}</Notice> : null}
    <h4 className="font-semibold">{t('publicationSnapshot')} · {t('historyVersion', { version: selected ?? data.version })}</h4>
    <FrozenPublication review={snapshot?.data.review ?? data.review} confirmationLabel={t('confirmationAtRevision')} />
    {snapshot ? <RouteRevisionFacts snapshot={snapshot} /> : null}
  </section>;
}
