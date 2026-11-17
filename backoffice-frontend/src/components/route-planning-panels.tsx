'use client';

import { Combobox } from './ui/combobox';


import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { motion, MotionConfig } from 'motion/react';
import { apiRequest, errorMessage } from '@/lib/api';
import { nearbyRadiusSchema, parseRoutePin, routeJobsSchema, type RouteJob, type RoutePinFields, type RoutePreview } from '@/lib/route-drafts';
import type { EntranceReviewData } from '@/lib/delivery-entrance';
import { formatDateTime } from '@/lib/time';
import { Field, Notice } from './ui';
import { EntranceReviewAction } from './entrance-review-action';
import { GeocodingAttribution } from './delivery-geocoding';
import { WorkEstimateProvenance } from './delivery-work-time';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { RouteWindowFields } from './route-planning-controls';
import type { RouteWindow } from '@/lib/route-drafts';

type StopField = { deliveryId: string; appointmentId?: string; workMinutes: string; workDurationSource?: 'manual' | 'remaining_estimate' | 'unknown'; workFingerprint?: string; customerWindow?: RouteWindow; pin?: RoutePinFields };

export function RouteStops({ stops, jobs, onMove, onRemove, onDuration, onAppointment, onCoordinate, onEntranceSaved, onWindow, onDurationSource, onReview }: {
  stops: StopField[];
  jobs: ReadonlyMap<string, RouteJob>;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onDuration: (id: string, minutes: string) => void;
  onAppointment: (id: string, appointmentId: string) => void;
  onCoordinate: (id: string, axis: 'latitude' | 'longitude', value: string) => void;
  onEntranceSaved: (id: string, value: EntranceReviewData) => void;
  onWindow: (id: string, value: RouteWindow) => void;
  onDurationSource: (id: string, value: 'manual' | 'remaining_estimate' | 'unknown') => void;
  onReview: (id: string) => void;
}) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const entranceText = useTranslations('entranceReview');
  const checkText = useTranslations('routeChecks');
  const workText = useTranslations('workPlan');
  return <Card className="grid gap-4 p-4 sm:p-5">
    <h2 className="text-base font-semibold">{t('stops')}</h2>
    {stops.length === 0 ? <p className="text-sm text-muted-foreground">{t('emptyStops')}</p> : <MotionConfig reducedMotion="user"><ol className="grid gap-3">
      {stops.map(({ deliveryId, appointmentId, workMinutes, workDurationSource, workFingerprint, customerWindow, pin }, index) => {
        const job = jobs.get(deliveryId);
        const appointments = job?.appointmentOptions ?? [];
        const workMatches = (job?.appointmentId ?? undefined) === appointmentId;
        const stale = !!pin && pin.addressKey !== job?.addressKey;
        const currentPin = stale ? undefined : pin;
        const invalid = !parseRoutePin(currentPin).success;
        return <motion.li key={deliveryId} layout="position" initial={false} transition={{ duration: 0.15 }} className="grid min-w-0 gap-3 rounded-md border border-border p-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-xs">{index + 1}</span>
            <div className="min-w-0 flex-1">{job ? <JobSummary job={job} /> : <p className="text-sm font-medium">{t('unknownStop')}</p>}</div>
          </div>
          {job ? <>
            <Field label={t('workSelection')}><Combobox value={appointmentId ?? ''} onChange={(event) => onAppointment(deliveryId, event.target.value)}>
              <option value="" disabled={job.hasAvailableRemaining === false}>{t('availableWork')}</option>
              {appointmentId && !appointments.some(({ id }) => id === appointmentId) ? <option value={appointmentId} disabled>{t('unavailableAppointment')}</option> : null}
              {appointments.map((appointment) => <option key={appointment.id} value={appointment.id} disabled={appointment.needsReview}>
                {t('appointmentWorkOption', { start: formatDateTime(appointment.startsAt, locale), end: formatDateTime(appointment.endsAt, locale) })}
                {appointment.needsReview ? ` · ${t('scopeNeedsReview')}` : ''}
              </option>)}
            </Combobox></Field>
            <p className="text-xs text-muted-foreground">{t('workSelectionHelp')}</p>
            {!workMatches ? <p role="status" className="text-xs text-muted-foreground">{t('updatingWork')}</p> : <JobRemaining job={job} />}
            {job.workReviewReason ? <Notice>{job.workReviewReason === 'prior_work_review' ? workText('prior_work_review') : t(job.workReviewReason === 'stock_pending' ? 'stockPendingHelp' : 'reviewWorkHelp')}</Notice> : null}
            {!appointmentId && job.hasAvailableRemaining === false ? <Notice>{t('chooseAppointmentWork')}</Notice> : null}
          </> : null}
          {job?.suggestedWorkMinutes === null ? <p className="rounded-md border border-warning-foreground/25 bg-warning px-3 py-2 text-xs text-warning-foreground"><strong>{t('reviewDuration')}</strong> {t('reviewDurationHelp')}</p> : null}
          {job?.addressKey ? <div className="flex flex-wrap items-center gap-2">
            <EntranceReviewAction deliveryId={deliveryId} onSaved={(value) => onEntranceSaved(deliveryId, value)} />
            {job.entranceConfirmed ? <span className="badge success">{entranceText('saved')}</span> : null}
          </div> : null}
          {job?.geocoding ? <div className="space-y-1"><GeocodingAttribution /><p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{job.geocoding.attribution}</p></div> : null}
          {job?.addressKey && !job.entranceConfirmed ? <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t('stopCoordinates')}</summary>
            <div className="mt-2 grid gap-2">
              <p className="text-muted-foreground">{t('coordinateHelp')}</p>
              {stale ? <Notice>{t('staleCoordinates')}</Notice> : null}
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('latitude')}><Input inputMode="decimal" maxLength={20} value={currentPin?.latitude ?? ''} placeholder={job.point ? String(job.point.latitude) : undefined} aria-invalid={invalid || undefined} onChange={(event) => onCoordinate(deliveryId, 'latitude', event.target.value)} /></Field>
                <Field label={t('longitude')}><Input inputMode="decimal" maxLength={20} value={currentPin?.longitude ?? ''} placeholder={job.point ? String(job.point.longitude) : undefined} aria-invalid={invalid || undefined} onChange={(event) => onCoordinate(deliveryId, 'longitude', event.target.value)} /></Field>
              </div>
              {invalid ? <p role="status" className="text-destructive">{t('invalidCoordinates')}</p> : null}
            </div>
          </details> : null}
          <div className="flex flex-wrap items-end justify-between gap-2">
            <Field label={t('duration')}><Input className="w-28" type="number" min={1} max={1440} step={1} value={workDurationSource === 'remaining_estimate' ? job?.suggestedWorkMinutes ?? '' : workMinutes} onChange={(event) => onDuration(deliveryId, event.target.value)} /></Field>
            <div className="flex flex-wrap gap-1">
              <Button type="button" size="sm" variant="outline" disabled={index === 0} onClick={() => onMove(index, -1)}>{t('moveUp')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={index === stops.length - 1} onClick={() => onMove(index, 1)}>{t('moveDown')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(deliveryId)}>{t('remove')}</Button>
            </div>
          </div>
          <Field label={checkText('durationSource')}><Combobox value={workDurationSource ?? (workMinutes ? 'manual' : 'unknown')} onChange={(event) => { const source = event.target.value; if (source === 'manual' || source === 'remaining_estimate' || source === 'unknown') onDurationSource(deliveryId, source); }}>{(['remaining_estimate', 'manual', 'unknown'] as const).map((source) => <option key={source} value={source}>{checkText(source)}</option>)}</Combobox></Field>
          {job?.workFingerprint && workFingerprint !== job.workFingerprint ? <div className="grid gap-2"><p className="text-xs text-warning-foreground">{checkText('workChanged')}</p><Button type="button" variant="outline" size="sm" disabled={!workMatches} onClick={() => onReview(deliveryId)}>{checkText('review')}</Button></div> : null}
          <RouteWindowFields value={customerWindow} initialWindow={appointments.find(({ id }) => id === appointmentId)} onChange={(value) => onWindow(deliveryId, value)} />
        </motion.li>;
      })}
    </ol></MotionConfig>}
  </Card>;
}

export function JobSummary({ job }: { job: RouteJob }) {
  const t = useTranslations('routes');
  const f = useFormatter();
  return <>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <strong className="text-sm font-medium">{job.customerName || job.pickingName}</strong>
      <span className={job.planningStatus === 'unavailable' ? 'badge danger' : job.planningStatus === 'confirmed' ? 'badge success' : 'badge neutral'}>{t(job.planningStatus)}</span>
    </div>
    <p className="mt-1 break-words text-xs text-muted-foreground">{[job.address, job.city].filter(Boolean).join(', ') || t('missingAddress')}</p>
    <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{[job.pickingName, ...job.orderNames].join(' · ')}</p>
    {job.distanceKm !== null ? <p className="mt-1 text-xs text-muted-foreground">{t('distance', { km: f.number(job.distanceKm, { maximumFractionDigits: 1 }) })}</p> : null}
    {job.remainingWorkEstimate ? <WorkEstimateProvenance basis={job.remainingWorkEstimate.basis} estimate={job.remainingWorkEstimate} /> : null}
  </>;
}

export function JobRemaining({ job }: { job: RouteJob }) {
  const t = useTranslations('routes');
  const f = useFormatter();
  return job.remaining.length ? <details className="text-xs">
    <summary className="cursor-pointer text-muted-foreground">{t(job.workBasis === 'appointment' ? 'plannedWork' : 'remaining', { count: job.remaining.length })}</summary>
    <ul className="mt-2 grid gap-2 border-l border-border pl-3">{job.remaining.map((line) => {
      const amounts = [
        { label: t('deliveryWork'), quantity: line.deliveryMilli },
        { label: t('installationWork'), quantity: line.installationMilli },
        { label: t('collectionWork'), quantity: line.collectionMilli },
      ];
      return <li key={line.sourceLineId} className="grid gap-0.5">
        <p className="break-words font-medium">{line.productName}</p>
        <p className="break-words font-mono text-muted-foreground">{line.orderName ? `${line.orderName} · ` : ''}{t('sourceLine', { id: line.sourceLineId })}</p>
        <p className="break-words text-muted-foreground">{amounts.filter(({ quantity }) => quantity > 0).map(({ label, quantity }) => t('quantity', { label, quantity: f.number(quantity / 1000, { maximumFractionDigits: 3 }), uom: line.uom })).join(' · ')}</p>
      </li>;
    })}</ul>
  </details> : null;
}

export function NearbyWork({ jobs, revision, selectedIds, onAdd }: { jobs: RouteJob[]; revision: number; selectedIds: string[]; onAdd: (job: RouteJob) => void }) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const [search, setSearch] = useState('');
  const [selectedAnchor, setSelectedAnchor] = useState<RouteJob | null>(null);
  const [radius, setRadius] = useState('10');
  const [limit, setLimit] = useState(6);
  const [result, setResult] = useState<{ query: string; revision: number; jobs: RouteJob[]; hasCoordinates?: boolean | null; error?: unknown } | null>(null);
  const anchorId = selectedAnchor?.deliveryId ?? '';
  const parsedRadius = nearbyRadiusSchema.safeParse(radius);
  const validRadius = !anchorId || parsedRadius.success;
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (anchorId) {
    params.set('anchorId', anchorId);
    if (parsedRadius.success) params.set('radiusKm', String(parsedRadius.data));
  }
  const query = validRadius ? params.toString() : '';
  const anchorJobs = new Map([...(selectedAnchor ? [selectedAnchor] : []), ...jobs, ...(result?.jobs ?? [])].map((job) => [job.deliveryId, job]));
  const anchor = anchorJobs.get(anchorId);

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiRequest(`/routes/jobs?${query}`, routeJobsSchema, { signal: controller.signal }).then(
        (value) => { if (!controller.signal.aborted) setResult({ query, revision, jobs: value.jobs, hasCoordinates: value.anchorHasCoordinates }); },
        (error: unknown) => {
          if (!controller.signal.aborted) setResult((previous) => ({ query, revision, jobs: previous?.query === query ? previous.jobs : [], error }));
        },
      );
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, revision]);

  const searching = !!query && (result?.query !== query || result.revision !== revision);
  const choices = !validRadius ? [] : query ? result?.jobs ?? [] : jobs;
  const current = result?.query === query && result.revision === revision ? result : null;

  function addButton(job: RouteJob, label: string) {
    const alreadyAdded = selectedIds.includes(job.deliveryId);
    return <Button type="button" size="sm" variant="outline" disabled={searching || !!current?.error || alreadyAdded || selectedIds.length >= 30 || job.planningStatus === 'unavailable'} onClick={() => onAdd(job)}>{alreadyAdded ? t('added') : label}</Button>;
  }

  return <Card className="grid min-w-0 gap-4 p-4 sm:p-5">
    <div><h2 className="text-base font-semibold">{t('nearby')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('nearbyHelp')}</p></div>
    <Field label={t('search')}><Input type="search" value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setLimit(6); }} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} /></Field>
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
      <Field label={t('anchor')}><Combobox value={anchorId} onChange={(event) => { setSelectedAnchor(anchorJobs.get(event.target.value) ?? null); setLimit(6); }}>
        <option value="">{t('anyLocation')}</option>
        {[...anchorJobs.values()].map((job) => <option key={job.deliveryId} value={job.deliveryId}>{job.customerName} · {job.pickingName}</option>)}
      </Combobox></Field>
      <Field label={t('radius')}><Input inputMode="decimal" value={radius} aria-invalid={!validRadius || undefined} disabled={!anchorId} onChange={(event) => { setRadius(event.target.value); setLimit(6); }} /></Field>
    </div>
    {anchor ? <div className="grid gap-2 rounded-md border border-border bg-muted/45 p-3">
      <p className="text-xs font-medium text-muted-foreground">{t('anchor')}</p>
      <JobSummary job={anchor} /><JobRemaining job={anchor} />
      <div>{addButton(anchor, t('addAnchor'))}</div>
    </div> : null}
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
      <span>{searching ? t('searching') : t('matches', { count: choices.length })}</span>
    </div>
    {current?.error ? <Notice tone="error">{errorMessage(current.error, locale)}</Notice> : null}
    {anchor && current?.hasCoordinates === false ? <Notice>{t('missingCoordinates')}</Notice> : null}
    {!validRadius ? <Notice>{t('invalidRadius')}</Notice> : null}
    {choices.length ? <ul className="grid gap-2" aria-busy={searching}>
      {choices.slice(0, limit).map((job) => <li key={job.deliveryId} className="grid min-w-0 gap-2 rounded-md border border-border p-3">
        <JobSummary job={job} /><JobRemaining job={job} />
        <div>{addButton(job, t('addStop'))}</div>
      </li>)}
    </ul> : !searching && !current?.error ? <p className="text-sm text-muted-foreground">{t('noMatches')}</p> : null}
    {choices.length > limit ? <div><Button type="button" variant="ghost" size="sm" onClick={() => setLimit((value) => value + 6)}>{t('showMore')}</Button></div> : null}
  </Card>;
}

const roadMessages = {
  ready: 'roadReady',
  unconfigured: 'roadNotConfigured',
  missing_coordinates: 'roadMissingCoordinates',
  too_many_stops: 'roadTooManyStops',
  unavailable: 'roadUnavailable',
} as const;

export function RouteTimeline({ preview, pointName, stale, loading, roadLoading, roadStatus, onRoadRetry, error }: {
  preview?: RoutePreview;
  pointName: (id: string) => string;
  stale: boolean;
  loading: boolean;
  roadLoading: boolean;
  roadStatus?: keyof typeof roadMessages;
  onRoadRetry: () => void;
  error: unknown;
}) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const timeline = preview?.timeline;
  const time = (instant: string | null) => instant ? formatDateTime(instant, locale) : '—';
  const minutes = (count: number | null) => count === null ? '—' : t('minutes', { count });
  const travel = (count: number | null, source: 'demo' | 'local_demo' | 'manual' | 'google' | null) => {
    if (source === 'google') return <>{minutes(count)} · <span translate="no" className="whitespace-nowrap">{t('roadAttribution')}</span></>;
    if (source) return `${minutes(count)} · ${t(source === 'manual' ? 'manualEstimate' : source === 'local_demo' ? 'localDemo' : 'demo')}`;
    return count === null ? t('unknownTravel') : minutes(count);
  };

  return <Card className="grid min-w-0 gap-4 border-info-foreground/30 p-4 sm:p-5" aria-busy={loading} data-route-timeline>
    <div><h2 className="text-base font-semibold">{t('timeline')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('estimateHelp')}</p></div>
    {error ? <Notice tone="error">{errorMessage(error, locale)}</Notice> : null}
    <div className="flex min-h-4 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <p role="status">{loading ? t(roadLoading ? 'roadLoading' : 'calculating') : roadStatus ? t(roadMessages[roadStatus]) : null}</p>
      {!loading && roadStatus === 'unavailable' ? <Button type="button" size="sm" variant="outline" onClick={onRoadRetry}>{t('roadRetry')}</Button> : null}
    </div>
    {timeline ? <>
      {stale ? <p role="status" className="rounded-md border border-warning-foreground/25 bg-warning px-3 py-2 text-xs text-warning-foreground">{t('previousTimeline')}</p> : null}
      {timeline.totalMinutes === null && !stale ? <Notice>{t('missingLegHelp')}</Notice> : null}
      {!stale && preview?.warnings.length ? <Notice><ul className="grid gap-2 text-xs">{preview.warnings.map((warning) => <li key={JSON.stringify([warning.fromPointId, warning.toPointId])}>
        <p className="break-words font-medium">{pointName(warning.fromPointId)} → {pointName(warning.toPointId)}</p>
        <p>{t(warning.code === 'manual_estimate_stale' ? 'manualStale' : 'manualUnverified')}</p>
      </li>)}</ul></Notice> : null}
      <div className="grid gap-3 rounded-md border border-info-foreground/30 bg-info p-3 sm:grid-cols-2">
        <div><p className="text-xs font-medium text-info-foreground">{t('departure')}</p><p className="mt-1 break-words text-xs">{pointName(timeline.startPointId)}</p><time dateTime={timeline.departAt} className="mt-1 block font-mono text-sm font-medium tabular-nums">{time(timeline.departAt)}</time></div>
        <div><p className="text-xs font-medium text-info-foreground">{t('estimatedReturn')}</p><p className="mt-1 break-words text-xs">{pointName(timeline.endPointId)}</p><time dateTime={timeline.returnAt ?? undefined} className="mt-1 block font-mono text-sm font-medium tabular-nums">{time(timeline.returnAt)}</time></div>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: t('total'), value: minutes(timeline.totalMinutes) },
          { label: t('travel'), value: minutes(timeline.travelMinutes) },
          { label: t('onsite'), value: minutes(timeline.workMinutes) },
          { label: t('waiting'), value: minutes(timeline.waitingMinutes) },
        ].map(({ label, value }) => <div key={label} className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-sm font-medium tabular-nums">{value}</dd>
        </div>)}
      </dl>
      <p className="text-xs text-muted-foreground">{t('totalFormula')}</p>
      <ol className="grid gap-2">{timeline.stops.map((stop, index) => <li key={stop.deliveryId} className="grid gap-1 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-medium">{index + 1}. {pointName(stop.deliveryId)}</strong>{stop.late ? <span className="badge danger">{t('late')}</span> : null}</div>
        <p className="break-words text-xs text-muted-foreground">{t('travelFrom', { name: pointName(stop.fromPointId) })}</p>
        <dl className="grid gap-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{t('legDeparture')}</dt><dd className="font-mono tabular-nums">{time(stop.travelStartAt)}</dd>
          <dt className="text-muted-foreground">{t('travel')}</dt><dd>{travel(stop.travelMinutes, stop.travelSource)}</dd>
          <dt className="text-muted-foreground">{t('eta')}</dt><dd className="font-mono tabular-nums">{time(stop.eta)}</dd>
          <dt className="text-muted-foreground">{t('onsite')}</dt><dd>{minutes(stop.workMinutes)}</dd>
          <dt className="text-muted-foreground">{t('workStarts')}</dt><dd className="font-mono tabular-nums">{time(stop.workStartAt)}</dd>
          <dt className="text-muted-foreground">{t('workEnds')}</dt><dd className="font-mono tabular-nums">{time(stop.workEndAt)}</dd>
          {stop.waitMinutes ? <><dt className="text-muted-foreground">{t('waiting')}</dt><dd>{minutes(stop.waitMinutes)}</dd></> : null}
          {stop.windowStatus === 'confirmed' ? <><dt className="text-muted-foreground">{t('confirmedWindow')}</dt><dd>{time(stop.windowStart)} → {time(stop.windowEnd)}</dd></> : null}
        </dl>
        {stop.windowStatus === 'ambiguous' ? <p className="mt-1 text-xs text-warning-foreground">{t('ambiguousWindow')}</p> : null}
      </li>)}</ol>
      <div className="rounded-md border border-border p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('returnLeg')}</p>
        <p className="mt-1 text-xs">{t('lastWorkEnds')} · <time dateTime={timeline.returnDepartAt ?? undefined} className="font-mono tabular-nums">{time(timeline.returnDepartAt)}</time></p>
        <p className="mt-1 text-xs text-muted-foreground">{travel(timeline.returnTravelMinutes, timeline.returnTravelSource)}</p>
        <p className="mt-1 break-words text-sm font-medium">{pointName(timeline.endPointId)} · <time dateTime={timeline.returnAt ?? undefined} className="font-mono tabular-nums">{time(timeline.returnAt)}</time></p>
      </div>
      <p className="text-xs text-muted-foreground">{t('windowHelp')}</p>
    </> : !loading && !error ? <p className="text-sm text-muted-foreground">{t('emptyTimeline')}</p> : null}
  </Card>;
}

