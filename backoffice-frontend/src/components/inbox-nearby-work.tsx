'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { nearestRoutePoint, nearbyRadiusSchema, routeDraftInputSchema, routeDraftSchema, routeJobsSchema, routeListSchema, routeWorkMinutes, type RouteDraftInput, type RouteJob, type RouteJobs, type RoutePoint } from '@/lib/route-drafts';
import { JobRemaining, JobSummary } from './route-planning-panels';
import { DetailIcon } from './delivery-detail-presentation';
import { Field, Notice } from './ui';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

type SearchResult = { query: string; revision: string; retry: number; data?: { work: RouteJobs; points: RoutePoint[] }; error?: unknown };
type SaveIntent = { key: string; body: RouteDraftInput & { requestId: string } };

function hasUnreservedWork(job: RouteJob) {
  return job.planningStatus !== 'unavailable' && job.hasAvailableRemaining !== false && job.remaining.length > 0;
}

export function InboxNearbyWork({ deliveryId, revision, onOpenDraft }: { deliveryId: string; revision: string; onOpenDraft: (id: string) => void }) {
  const t = useTranslations('inboxNearby');
  const routes = useTranslations('routes');
  const locale = useLocale();
  const radiusHintId = useId();
  const [radius, setRadius] = useState('10');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ key: string; id: string; name: string } | null>(null);
  const intent = useRef<SaveIntent | null>(null);
  const saveLock = useRef(false);
  const parsedRadius = nearbyRadiusSchema.safeParse(radius);
  const query = parsedRadius.success ? new URLSearchParams({ anchorId: deliveryId, radiusKm: String(parsedRadius.data) }).toString() : '';

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const options = { signal: controller.signal };
      void Promise.all([
        apiRequest(`/routes/jobs?${query}`, routeJobsSchema, options),
        apiRequest('/routes', routeListSchema, options),
      ]).then(([work, catalog]) => {
        if (controller.signal.aborted) return;
        setResult({ query, revision, retry, data: { work, points: catalog.points } });
        const available = new Set(work.jobs.filter(hasUnreservedWork).map((job) => job.deliveryId));
        setSelectedIds((previous) => previous.filter((id) => available.has(id)));
      }, (error: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({ query, revision, retry, error, data: previous?.query === query ? previous.data : undefined }));
      });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, revision, retry]);

  const current = !!query && result?.query === query && result.revision === revision && result.retry === retry;
  const searching = !!query && !current;
  const data = result?.data;
  const anchor = data?.work.anchorJob;
  const jobs = data?.work.jobs ?? [];
  const availableJobs = jobs.filter(hasUnreservedWork);
  const selectedJobs = availableJobs.filter((job) => selectedIds.includes(job.deliveryId));
  const point = data ? nearestRoutePoint(data.points, anchor?.point ?? null) : undefined;
  const ready = current && !result?.error && data?.work.anchorHasCoordinates === true && anchor && hasUnreservedWork(anchor) && point;
  const stops = anchor ? [anchor, ...selectedJobs].map((job) => ({ deliveryId: job.deliveryId, workMinutes: routeWorkMinutes(job), workDurationSource: 'remaining_estimate' as const, workFingerprint: job.workFingerprint })) : [];
  const selectionKey = JSON.stringify({ deliveryId, startPointId: point?.id, stops });
  const alreadySaved = saved?.key === selectionKey;
  const canSave = !!ready && !saving && !alreadySaved && stops.length > 0 && stops.length <= 30;
  const locked = !ready || saving;

  async function createDraft() {
    if (!canSave || saveLock.current || !anchor || !point) return;
    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // Freeze the whole intent: a network retry must reuse both requestId and departure.
      if (intent.current?.key !== selectionKey) intent.current = {
        key: selectionKey,
        body: {
          ...routeDraftInputSchema.parse({
            name: t('draftName', { picking: anchor.pickingName }).slice(0, 120),
            departAt: new Date().toISOString(), crewId: null, vehicleId: null,
            startPointId: point.id, endPointId: point.id, stops, manualEstimates: [], useLocalEstimates: true,
          }),
          requestId: crypto.randomUUID(),
        },
      };
      const created = await mutate('/routes', routeDraftSchema, intent.current.body);
      setSaved({ key: selectionKey, id: created.id, name: created.name });
      toast.success(t('saved'), { action: { label: t('openDraft'), onClick: () => onOpenDraft(created.id) } });
    } catch (error) {
      setSaveError(error);
      toast.error(errorMessage(error, locale));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  return <Card className="mb-5 gap-0 overflow-hidden border-info-foreground/30 py-0" role="region" aria-label={t('title')}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-info p-4">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><span className="detail-heading-icon info"><DetailIcon name="location" /></span>{t('title')}</h3>
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <div className="w-28 shrink-0 [&_.field]:my-0"><Field label={routes('radius')}>
        <Input inputMode="decimal" maxLength={5} value={radius} disabled={saving} aria-describedby={radiusHintId} aria-invalid={!parsedRadius.success || undefined} onChange={(event) => setRadius(event.target.value)} />
      </Field></div>
      <p id={radiusHintId} className={`basis-full text-xs ${parsedRadius.success ? 'text-muted-foreground' : 'text-destructive'}`}>{parsedRadius.success ? t('distanceHint') : routes('invalidRadius')}</p>
    </div>
    <div className="grid gap-3 p-4">
      {anchor ? <div className="rounded-md border border-border bg-muted/35 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-info-foreground"><span aria-hidden="true">✓</span>{t('included')}</p>
        <JobSummary job={anchor} />
        <WorkKinds job={anchor} />
        <JobRemaining job={anchor} />
      </div> : null}
      <div className="flex min-h-5 items-center justify-between gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span>{searching ? t('searching') : current && !result?.error ? routes('matches', { count: jobs.length }) : ''}</span>
        {availableJobs.length > 0 ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setSelectedIds(selectedJobs.length ? [] : availableJobs.slice(0, 29).map((job) => job.deliveryId))}>{selectedJobs.length ? t('clearSelection') : t('selectNearest', { count: Math.min(29, availableJobs.length) })}</Button> : null}
      </div>
      {current && result?.error ? <Notice tone="error">{errorMessage(result.error, locale)} <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button></Notice> : null}
      {current && !result?.error && data?.work.anchorHasCoordinates === false ? <Notice>{t('missingCoordinates')}</Notice> : null}
      {current && !result?.error && (!anchor || anchor.planningStatus === 'unavailable') ? <Notice>{t('unavailable')}</Notice> : null}
      {current && !result?.error && anchor?.hasAvailableRemaining === false ? <Notice>{t('reservedWork')}</Notice> : null}
      {current && !result?.error && !point ? <Notice>{t('missingDepot')}</Notice> : null}
      {jobs.length ? <ul className="grid max-h-80 gap-2 overflow-y-auto overscroll-contain p-0.5" aria-label={t('results')} aria-busy={searching}>
        {jobs.map((job) => {
          const checked = selectedIds.includes(job.deliveryId);
          return <li key={job.deliveryId} className={`rounded-md border p-3 transition-colors ${checked ? 'border-info-foreground/60 bg-info' : 'border-border bg-card'}`}>
            <div className="flex items-start gap-3">
              <label className="grid size-7 shrink-0 cursor-pointer place-items-center"><input type="checkbox" className="size-4 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" aria-label={t('selectJob', { picking: job.pickingName })} checked={checked} disabled={locked || !hasUnreservedWork(job) || (!checked && selectedJobs.length >= 29)} onChange={(event) => {
                const selected = event.target.checked;
                setSelectedIds((previous) => selected ? [...previous, job.deliveryId] : previous.filter((id) => id !== job.deliveryId));
              }} /></label>
              <div className="grid min-w-0 flex-1 gap-2"><div><JobSummary job={job} /></div><WorkKinds job={job} /><JobRemaining job={job} />{job.hasAvailableRemaining === false ? <p className="text-xs text-muted-foreground">{t('reservedWork')}</p> : null}</div>
            </div>
          </li>;
        })}
      </ul> : current && !result?.error && data?.work.anchorHasCoordinates ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
      {selectedJobs.some((job) => job.planningStatus === 'booked' || job.planningStatus === 'confirmed') ? <Notice>{t('bookedWarning')}</Notice> : null}
      {selectedJobs.length >= 29 ? <p className="text-xs text-muted-foreground">{t('limit')}</p> : null}
      {saveError ? <Notice tone="error">{errorMessage(saveError, locale)}</Notice> : null}
      <div className="grid gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">{t('draftHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!canSave} onClick={() => { void createDraft(); }}>{saving ? t('saving') : alreadySaved ? t('saved') : t('createDraft', { count: stops.length || 1 })}</Button>
          {saved ? <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}><Button type="button" variant="outline" onClick={() => onOpenDraft(saved.id)}>{t('openDraft')}</Button></motion.div> : null}
        </div>
        {saved ? <p className="break-words text-xs text-[var(--success-foreground)]">{saved.name}</p> : null}
      </div>
    </div>
  </Card>;
}

function WorkKinds({ job }: { job: RouteJob }) {
  const t = useTranslations('inboxNearby');
  const routes = useTranslations('routes');
  return <div className="my-2 flex flex-wrap items-center gap-1.5 text-xs">
    {job.remaining.some((line) => line.deliveryMilli > 0) ? <span className="badge info">{routes('deliveryWork')}</span> : null}
    {job.remaining.some((line) => line.installationMilli > 0) ? <span className="badge warning">{routes('installationWork')}</span> : null}
    {job.remaining.some((line) => line.collectionMilli > 0) ? <span className="badge neutral">{routes('collectionWork')}</span> : null}
    <span className="text-muted-foreground">{job.suggestedWorkMinutes ? t('workMinutes', { count: job.suggestedWorkMinutes }) : t('unknownDuration')}</span>
  </div>;
}
