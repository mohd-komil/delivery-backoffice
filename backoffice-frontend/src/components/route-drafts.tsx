'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { crewSchema, participantSchema, vehicleSchema, type Crew, type Participant, type Vehicle } from '@/lib/contracts';
import { nearestRoutePoint, parseRoutePin, routeWorkMinutes, routeDraftInputSchema, routeDraftSchema, routeJobsSchema, routeListSchema, routePreviewSchema, type RouteDraft, type RouteJob, type RouteList, type RouteManualContext, type RoutePinFields, type RoutePreview } from '@/lib/route-drafts';
import { formatDateTime } from '@/lib/time';
import type { EntranceReviewData } from '@/lib/delivery-entrance';
import { DateTimeInput } from './date-time-fields';
import { NearbyWork, RouteStops, RouteTimeline } from './route-planning-panels';
import { RouteMap, type RouteMapPoint } from './route-map';
import { PageHeadingTitle } from './page-help';
import { ActionForm, Empty, Field, Notice, Pending } from './ui';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { emptyRoutePlanning, RouteFeasibility, RouteResourceFields } from './route-planning-controls';
import { RouteOrderSuggestion } from './route-order-suggestion';
import { RoutePublication } from './route-publication';
import type { RoutePlanning, RouteWindow } from '@/lib/route-drafts';

type Catalogs = { list: RouteList; jobs: RouteJob[]; crews: Crew[]; vehicles: Vehicle[]; participants: Participant[] };
type LoadedDraft = { id: string; value?: RouteDraft; error?: unknown };
type RouteFields = {
  name: string;
  departAt: string;
  crewId: string;
  vehicleId: string;
  startPointId: string;
  endPointId: string;
  useLocalEstimates: boolean;
  stops: { deliveryId: string; appointmentId?: string; workMinutes: string; workDurationSource?: 'manual' | 'remaining_estimate' | 'unknown'; workFingerprint?: string; customerWindow?: RouteWindow; pin?: RoutePinFields }[];
  planning: RoutePlanning;
  estimates: { fromPointId: string; toPointId: string; minutes: string; context?: RouteManualContext }[];
};

function legKey(from: string, to: string) {
  return JSON.stringify([from, to]);
}

function draftFields(catalogs: Catalogs, draft?: RouteDraft): RouteFields {
  const warehouse = catalogs.list.points[0]?.id ?? '';
  return {
    name: draft?.name ?? '',
    departAt: draft?.departAt ?? '',
    crewId: draft?.crewId ?? '',
    vehicleId: draft?.vehicleId ?? '',
    startPointId: draft?.startPointId ?? warehouse,
    endPointId: draft?.endPointId ?? warehouse,
    useLocalEstimates: draft?.useLocalEstimates ?? true,
    stops: draft?.stops.map(({ deliveryId, appointmentId, workMinutes, workDurationSource, workFingerprint, customerWindow, pin }) => ({
      deliveryId, appointmentId, workMinutes: workMinutes === null ? '' : String(workMinutes), workDurationSource, workFingerprint, customerWindow,
      ...(pin ? { pin: { latitude: String(pin.latitude), longitude: String(pin.longitude), addressKey: pin.addressKey } } : {}),
    })) ?? [],
    estimates: draft?.manualEstimates.map((leg) => ({ ...leg, minutes: String(leg.minutes) })) ?? [],
    planning: draft?.planning ?? emptyRoutePlanning,
  };
}

export function RouteDrafts({ initialDraftId = '', onOpenDelivery }: { initialDraftId?: string; onOpenDelivery?: (deliveryId: string) => void } = {}) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const [selectedId, setSelectedId] = useState(initialDraftId);
  const [editorKey, setEditorKey] = useState(0);
  const [loadedDraft, setLoadedDraft] = useState<LoadedDraft | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      apiRequest('/routes', routeListSchema, options),
      apiRequest('/routes/jobs', routeJobsSchema, options),
      apiRequest('/crews', z.array(crewSchema), options),
      apiRequest('/vehicles', z.array(vehicleSchema), options),
      apiRequest('/participants', z.array(participantSchema), options),
    ]).then(([list, work, crews, vehicles, participants]) => {
      if (controller.signal.aborted) return;
      setCatalogs({ list, jobs: work.jobs, crews, vehicles, participants });
      setCatalogError(null);
      setLoadedRevision(revision);
    }, (failure: unknown) => {
      if (controller.signal.aborted) return;
      setCatalogError(failure);
      setLoadedRevision(revision);
    });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void apiRequest(`/routes/${selectedId}`, routeDraftSchema, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setLoadedDraft((previous) => previous?.id === value.id && previous.value && previous.value.version > value.version ? previous : { id: value.id, value });
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadedDraft((previous) => ({ id: selectedId, value: previous?.id === selectedId ? previous.value : undefined, error }));
    });
    return () => controller.abort();
  }, [selectedId, revision]);

  const current = selectedId && loadedDraft?.id === selectedId ? loadedDraft : null;

  function saved(value: RouteDraft) {
    setSelectedId(value.id);
    setLoadedDraft({ id: value.id, value });
    setCatalogs((previous) => previous && ({
      ...previous,
      list: { ...previous.list, drafts: [{
        id: value.id, name: value.name, departAt: value.departAt, version: value.version, stopCount: value.stops.length, updatedAt: value.updatedAt,
      }, ...previous.list.drafts.filter((draft) => draft.id !== value.id)] },
    }));
  }

  function refresh() { setRevision((value) => value + 1); }

  function entranceChanged(deliveryId: string, value: EntranceReviewData) {
    const { entrance, addressKey } = value;
    if (!entrance) return;
    const useEntrance = (job: RouteJob): RouteJob => job.deliveryId === deliveryId && job.addressKey === addressKey
      ? { ...job, point: entrance.point, entranceConfirmed: true } : job;
    setCatalogs((previous) => previous && { ...previous, jobs: previous.jobs.map(useEntrance) });
    setLoadedDraft((previous) => previous?.value
      ? { ...previous, value: { ...previous.value, jobs: previous.value.jobs.map(useEntrance) } }
      : previous);
    refresh();
  }

  return <>
    <div className="page-heading flex-wrap"><div><p className="eyebrow">{t('planning')}</p><PageHeadingTitle title={t('title')} topic="routes" /><p className="subtitle">{t('description')}</p></div>
      <Button type="button" variant="outline" disabled={loadedRevision !== revision} onClick={refresh}>{t('refresh')}</Button>
    </div>
    {catalogError ? <Notice tone="error">{errorMessage(catalogError, locale)}</Notice> : null}
    {catalogs ? <>
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4 [&_.field]:my-0">
        <div className="min-w-0 flex-1"><Field label={t('draft')}>
          <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setEditorKey((value) => value + 1); }}>
            <option value="">{t('unsavedDraft')}</option>
            {catalogs.list.drafts.map((draft) => <option key={draft.id} value={draft.id}>{t('draftOption', { name: draft.name, count: draft.stopCount })} · {formatDateTime(draft.departAt, locale)}</option>)}
          </select>
        </Field></div>
        <Button type="button" variant="outline" onClick={() => { setSelectedId(''); setEditorKey((value) => value + 1); }}>{t('newDraft')}</Button>
      </Card>
      {current?.error ? <Notice tone="error">{errorMessage(current.error, locale)}</Notice> : null}
      {!selectedId || current?.value ? <RouteEditor key={editorKey} catalogs={catalogs} revision={revision} route={current?.value} onSaved={saved} onEntranceChanged={entranceChanged} onOpenDelivery={onOpenDelivery} /> : !current?.error ? <Pending /> : null}
    </> : !catalogError ? <Pending /> : <Empty title={t('unavailable')} />}
  </>;
}

function RouteEditor({ catalogs, revision, route, onSaved, onEntranceChanged, onOpenDelivery }: {
  catalogs: Catalogs;
  revision: number;
  route?: RouteDraft;
  onSaved: (draft: RouteDraft) => void;
  onEntranceChanged: (deliveryId: string, value: EntranceReviewData) => void;
  onOpenDelivery?: (deliveryId: string) => void;
}) {
  const t = useTranslations('routes');
  const [fields, setFields] = useState(() => draftFields(catalogs, route));
  const [addedJobs, setAddedJobs] = useState<RouteJob[]>([]);
  const [roadRetry, setRoadRetry] = useState(0);
  const [googleRequested, setGoogleRequested] = useState(false);
  const [published, setPublished] = useState(false);
  const markPublished = useCallback(() => setPublished(true), []);
  const pointsChosen = useRef(Boolean(route));
  const requestId = useRef<{ key: string; id: string } | null>(null);
  const geometryKey = JSON.stringify([
    fields.startPointId, fields.endPointId,
    ...fields.stops.map(({ deliveryId, pin }) => [deliveryId, pin]),
  ]);
  const [previewState, setPreviewState] = useState<{ key: string; geometryKey: string; revision: number; roadRetry: number; value?: RoutePreview; error?: unknown }>(
    () => ({ key: '', geometryKey, revision, roadRetry, value: route }),
  );
  const latestPreviewJobs = previewState.revision === revision ? previewState.value?.jobs ?? [] : [];
  const jobs = new Map([...addedJobs, ...(route?.jobs ?? []), ...catalogs.jobs, ...latestPreviewJobs].map((job) => [job.deliveryId, job]));
  // Retain the selected visit's work while Refresh updates the catalog and its coordinates.
  // Otherwise the unbound catalog briefly replaces it and collapses the open work details.
  if (previewState.revision !== revision) {
    for (const stop of fields.stops) {
      const previous = previewState.value?.jobs.find((job) => job.deliveryId === stop.deliveryId && job.appointmentId === stop.appointmentId);
      const current = jobs.get(stop.deliveryId);
      if (!stop.appointmentId || !previous || !current) continue;
      const option = current.appointmentOptions?.find(({ id }) => id === stop.appointmentId);
      jobs.set(stop.deliveryId, { ...current, workBasis: 'appointment', appointmentId: stop.appointmentId,
        remaining: previous.remaining, suggestedWorkMinutes: previous.suggestedWorkMinutes,
        workReviewReason: !option ? 'appointment_unavailable' : option.needsReview ? 'scope_outdated' : previous.workReviewReason });
    }
  }
  const { points } = catalogs.list;
  const pointIds = [fields.startPointId, ...fields.stops.map((stop) => stop.deliveryId), fields.endPointId];
  const legs = pointIds.slice(1).map((to, index) => ({ from: pointIds[index] ?? '', to })).filter((leg) => leg.from && leg.to);
  const manualEstimates = fields.estimates
    .filter(({ fromPointId, toPointId, minutes }) => pointIds.includes(fromPointId) && pointIds.includes(toPointId) && minutes.trim())
    .map((leg) => ({ ...leg, minutes: Number(leg.minutes) }));
  const stopPins = new Map(fields.stops.map(({ deliveryId, pin }) => {
    const job = jobs.get(deliveryId);
    const superseded = job?.entranceConfirmed || (job?.addressKey && pin?.addressKey !== job.addressKey);
    return [deliveryId, parseRoutePin(superseded ? undefined : pin)];
  }));
  const input = routeDraftInputSchema.safeParse({
    ...fields, crewId: fields.crewId || null, vehicleId: fields.vehicleId || null,
    stops: fields.stops.map(({ deliveryId, appointmentId, workMinutes, workDurationSource, workFingerprint, customerWindow }) => {
      const pin = stopPins.get(deliveryId);
      return { deliveryId, appointmentId, workMinutes: workMinutes === '' ? null : Number(workMinutes), workDurationSource, workFingerprint, customerWindow, pin: pin?.success ? pin.data : undefined };
    }), manualEstimates,
  });
  const inputValid = input.success && [...stopPins.values()].every(({ success }) => success);
  const useGoogleRoads = googleRequested && catalogs.list.roadRoutingEnabled === true && !!catalogs.list.googleMaps;
  const saveKey = input.success && inputValid ? JSON.stringify(input.data) : '';
  const previewKey = input.success && inputValid
    ? JSON.stringify(useGoogleRoads ? { ...input.data, useGoogleRoads: true } : input.data) : '';
  useEffect(() => {
    if (!previewKey || published) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiRequest('/routes/preview', routePreviewSchema, { method: 'POST', body: previewKey, signal: controller.signal }).then((value) => {
        if (!controller.signal.aborted) setPreviewState({ key: previewKey, geometryKey, revision, roadRetry, value });
      }, (error: unknown) => {
        if (!controller.signal.aborted) setPreviewState((previous) => ({ ...previous, key: previewKey, revision, roadRetry, error }));
      });
    }, useGoogleRoads ? 550 : 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [previewKey, geometryKey, revision, roadRetry, useGoogleRoads, published]);

  const pointName = (id: string) => {
    const job = jobs.get(id);
    return points.find((point) => point.id === id)?.name ?? (job ? [job.customerName, job.pickingName].filter(Boolean).join(' · ') : t('unknownStop'));
  };
  const mapPoints: RouteMapPoint[] = [
    { id: fields.startPointId, label: pointName(fields.startPointId), point: points.find(({ id }) => id === fields.startPointId) ?? null, kind: 'start' },
    ...fields.stops.map(({ deliveryId }): RouteMapPoint => {
      const job = jobs.get(deliveryId);
      const parsed = stopPins.get(deliveryId);
      const pin = parsed?.success && parsed.data?.addressKey === job?.addressKey ? parsed.data : undefined;
      const point = job?.entranceConfirmed ? job.point : pin ?? job?.point ?? null;
      return { id: deliveryId, label: job?.pickingName ?? t('unknownStop'), point, kind: 'stop' };
    }),
    { id: fields.endPointId, label: pointName(fields.endPointId), point: points.find(({ id }) => id === fields.endPointId) ?? null, kind: 'return' },
  ];
  const previewCurrent = !!previewKey && previewState.key === previewKey && previewState.revision === revision && previewState.roadRetry === roadRetry;
  const road = previewCurrent && !previewState.error ? previewState.value?.road : undefined;
  const previewJobs = new Map(previewState.value?.jobs.map((job) => [job.deliveryId, job]));
  const matchingGeometry = previewState.geometryKey === geometryKey && fields.stops.every(({ deliveryId }) => {
    const previous = previewJobs.get(deliveryId);
    const current = jobs.get(deliveryId);
    return previous?.addressKey === current?.addressKey
      && Boolean(previous?.entranceConfirmed) === Boolean(current?.entranceConfirmed)
      && previous?.point?.latitude === current?.point?.latitude && previous?.point?.longitude === current?.point?.longitude;
  });
  const mapRoad = matchingGeometry && useGoogleRoads && inputValid ? previewState.value?.road : undefined;
  const manualContextReady = matchingGeometry && previewState.revision === revision;

  function updateManual(from: string, to: string, minutes: string) {
    const fromContext = previewState.value?.pointContexts.find(({ pointId }) => pointId === from);
    const toContext = previewState.value?.pointContexts.find(({ pointId }) => pointId === to);
    if (!manualContextReady || !fromContext || !toContext) return;
    const context = {
      from: { point: fromContext.point, addressKey: fromContext.addressKey },
      to: { point: toContext.point, addressKey: toContext.addressKey },
    };
    setFields((previous) => ({ ...previous, estimates: [
      ...previous.estimates.filter((leg) => leg.fromPointId !== from || leg.toPointId !== to),
      ...(minutes ? [{ fromPointId: from, toPointId: to, minutes, context }] : []),
    ] }));
  }

  function update<K extends keyof RouteFields>(key: K, value: RouteFields[K]) {
    setFields((previous) => ({ ...previous, [key]: value }));
  }

  function addStop(job: RouteJob) {
    setAddedJobs((previous) => [...previous.filter((item) => item.deliveryId !== job.deliveryId), job]);
    const nearest = !route && fields.stops.length === 0 && !pointsChosen.current ? nearestRoutePoint(points, job.point) : undefined;
    setFields((previous) => previous.stops.length >= 30 || previous.stops.some((stop) => stop.deliveryId === job.deliveryId) ? previous : ({
      ...previous,
      ...(nearest ? { startPointId: nearest.id, endPointId: nearest.id } : {}),
      stops: [...previous.stops, { deliveryId: job.deliveryId, workMinutes: routeWorkMinutes(job)?.toString() ?? '', workDurationSource: 'remaining_estimate', workFingerprint: job.workFingerprint }],
    }));
  }

  function moveStop(index: number, direction: -1 | 1) {
    const stops = [...fields.stops];
    const stop = stops[index];
    if (!stop || !stops[index + direction]) return;
    stops.splice(index, 1);
    stops.splice(index + direction, 0, stop);
    update('stops', stops);
  }

  function changeAppointment(deliveryId: string, appointmentId: string) {
    const job = jobs.get(deliveryId);
    const option = job?.appointmentOptions?.find(({ id }) => id === appointmentId);
    const unbound = catalogs.jobs.find((candidate) => candidate.deliveryId === deliveryId);
    const estimate = appointmentId ? option?.suggestedWorkMinutes : unbound?.suggestedWorkMinutes;
    setFields((previous) => ({ ...previous, stops: previous.stops.map((stop) => stop.deliveryId !== deliveryId ? stop : {
      ...stop, appointmentId: appointmentId || undefined,
      workMinutes: stop.workDurationSource === 'manual' ? stop.workMinutes : estimate?.toString() ?? '',
      workFingerprint: undefined,
    }) }));
  }

  function changeCoordinate(deliveryId: string, axis: 'latitude' | 'longitude', value: string) {
    const addressKey = jobs.get(deliveryId)?.addressKey;
    if (!addressKey) return;
    setFields((previous) => ({
      ...previous,
      stops: previous.stops.map((stop) => {
        if (stop.deliveryId !== deliveryId) return stop;
        const pin = stop.pin?.addressKey === addressKey ? stop.pin : { addressKey, latitude: '', longitude: '' };
        return { ...stop, pin: { ...pin, [axis]: value } };
      }),
    }));
  }

  function entranceSaved(deliveryId: string, value: EntranceReviewData) {
    const { entrance, addressKey } = value;
    if (!entrance) return;
    setAddedJobs((previous) => previous.map((job) => job.deliveryId === deliveryId && job.addressKey === addressKey
      ? { ...job, point: entrance.point, entranceConfirmed: true } : job));
    setPreviewState((previous) => ({ ...previous, geometryKey: '', value: undefined }));
    onEntranceChanged(deliveryId, value);
  }

  async function save() {
    if (!input.success || !saveKey) return;
    if (!requestId.current || requestId.current.key !== saveKey) requestId.current = { key: saveKey, id: crypto.randomUUID() };
    const result = route
      ? await mutate(`/routes/${route.id}`, routeDraftSchema, { ...input.data, version: route.version }, 'PATCH')
      : await mutate('/routes', routeDraftSchema, { ...input.data, requestId: requestId.current.id });
    if (!useGoogleRoads) setPreviewState({ key: previewKey, geometryKey, revision, roadRetry, value: result });
    onSaved(result);
    return result.version;
  }

  const selectedIds = fields.stops.map((stop) => stop.deliveryId);
  const visiblePreview = previewState.value;
  const previewStale = !previewCurrent || !inputValid || !!previewState.error;
  const savedInput = route ? routeDraftInputSchema.safeParse(route) : null;
  const publicationDirty = !inputValid || !savedInput?.success || JSON.stringify(savedInput.data) !== saveKey;
  return <><div hidden={published}><ActionForm disabled={published} dataVersion={route?.version} onResetDraft={() => setFields(draftFields(catalogs, route))} submitLabel={t('save')} successMessage={t('saved')} submitDisabled={!inputValid} onSubmit={save}>
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] [&_.field]:my-0">
      <div className="grid min-w-0 content-start gap-4">
        <Card className="grid gap-4 p-4 sm:p-5">
          <h2 className="text-base font-semibold">{t('setup')}</h2>
          <Field label={t('name')}><Input value={fields.name} maxLength={120} required onChange={(event) => update('name', event.target.value)} /></Field>
          <DateTimeInput name="departAt" label={t('departure')} initialInstant={route?.departAt} onInstantChange={(value) => update('departAt', value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('start')}><select required value={fields.startPointId} onChange={(event) => { pointsChosen.current = true; update('startPointId', event.target.value); }}>{points.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></Field>
            <Field label={t('returnWarehouse')}><select required value={fields.endPointId} onChange={(event) => { pointsChosen.current = true; update('endPointId', event.target.value); }}>{points.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></Field>
            <Field label={t('crew')}><select value={fields.crewId} onChange={(event) => update('crewId', event.target.value)}><option value="">{t('unassigned')}</option>{catalogs.crews.filter((crew) => crew.enabled || crew.id === fields.crewId).map((crew) => <option key={crew.id} value={crew.id}>{crew.name}</option>)}</select></Field>
            <Field label={t('vehicle')}><select value={fields.vehicleId} onChange={(event) => update('vehicleId', event.target.value)}><option value="">{t('unassigned')}</option>{catalogs.vehicles.filter((vehicle) => (vehicle.enabled && vehicle.operationalStatus === 'available') || vehicle.id === fields.vehicleId).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('pointHelp')}</p>
          <div className="grid gap-2 rounded-md border border-info-foreground/30 bg-info p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm font-medium"><Input className="mt-0.5" type="checkbox" checked={fields.useLocalEstimates} onChange={(event) => update('useLocalEstimates', event.target.checked)} />{t('localEstimates')}</label>
            <p className="text-xs text-muted-foreground">{t('localEstimateHelp')}</p>
            <p className="text-xs text-muted-foreground">{t('draftOnly')}</p>
          </div>
          {catalogs.list.googleMaps && catalogs.list.roadRoutingEnabled ? <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"><Input type="checkbox" checked={googleRequested} onChange={(event) => setGoogleRequested(event.target.checked)} />{t('googleOptIn')}</label> : null}
        </Card>
        <RouteResourceFields value={fields.planning} onChange={(value) => update('planning', value)} participants={catalogs.participants} crew={catalogs.crews.find((crew) => crew.id === fields.crewId)} />
        <RouteStops stops={fields.stops} jobs={jobs} onMove={moveStop} onAppointment={changeAppointment} onCoordinate={changeCoordinate} onEntranceSaved={entranceSaved}
          onRemove={(id) => update('stops', fields.stops.filter((stop) => stop.deliveryId !== id))}
          onDuration={(id, workMinutes) => update('stops', fields.stops.map((stop) => stop.deliveryId === id ? { ...stop, workMinutes, workDurationSource: workMinutes ? 'manual' : 'unknown', workFingerprint: jobs.get(id)?.workFingerprint } : stop))}
          onDurationSource={(id, workDurationSource) => update('stops', fields.stops.map((stop) => stop.deliveryId === id ? { ...stop, workDurationSource, workMinutes: workDurationSource === 'unknown' ? '' : workDurationSource === 'remaining_estimate' ? jobs.get(id)?.suggestedWorkMinutes?.toString() ?? '' : stop.workMinutes, workFingerprint: jobs.get(id)?.workFingerprint } : stop))}
          onReview={(id) => update('stops', fields.stops.map((stop) => stop.deliveryId === id ? { ...stop, workFingerprint: jobs.get(id)?.workFingerprint } : stop))}
          onWindow={(id, customerWindow) => update('stops', fields.stops.map((stop) => stop.deliveryId === id ? { ...stop, customerWindow } : stop))} />
        {fields.stops.length ? <Card className="p-4 sm:p-5"><details>
          <summary className="cursor-pointer text-sm font-medium">{t('manual')}</summary>
          <p className="mt-2 text-xs text-muted-foreground">{t('manualHelp')}</p>
          {!manualContextReady ? <p className="mt-2 text-xs text-muted-foreground" role="status">{t('manualAwaitingPoints')}</p> : null}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{legs.map(({ from, to }) => {
            const manual = fields.estimates.find((leg) => leg.fromPointId === from && leg.toPointId === to);
            const warning = previewCurrent ? previewState.value?.warnings.find((entry) => entry.fromPointId === from && entry.toPointId === to) : undefined;
            return <div key={legKey(from, to)} className="grid content-start gap-2"><Field label={t('leg', { from: pointName(from), to: pointName(to) })}><Input
              type="number" min={0} max={1440} step={1} disabled={!manualContextReady} value={manual?.minutes ?? ''}
              onChange={(event) => updateManual(from, to, event.target.value)}
            /></Field>{warning && manual ? <div className="grid gap-2"><p className="text-xs text-warning-foreground">{t(warning.code === 'manual_estimate_stale' ? 'manualStale' : 'manualUnverified')}</p><Button type="button" variant="outline" size="sm" disabled={!manualContextReady} onClick={() => updateManual(from, to, manual.minutes)}>{t('confirmManualPoints')}</Button></div> : null}</div>;
          })}</div>
        </details></Card> : null}
      </div>
      <div className="grid min-w-0 content-start gap-4">
        <RouteFeasibility preview={visiblePreview} stale={previewStale} pointName={pointName} />
        <RouteOrderSuggestion input={input.success && inputValid ? input.data : null} revision={revision} preview={visiblePreview} previewStale={previewStale} pointName={pointName} onApply={(ids) => {
          const stopsById = new Map(fields.stops.map((stop) => [stop.deliveryId, stop]));
          const reordered = ids.flatMap((id) => { const stop = stopsById.get(id); return stop ? [stop] : []; });
          if (reordered.length === fields.stops.length) update('stops', reordered);
        }} />
        <RouteTimeline preview={visiblePreview} pointName={pointName} stale={previewStale}
          loading={!!previewKey && !previewCurrent}
          roadLoading={useGoogleRoads}
          roadStatus={road?.status}
          onRoadRetry={() => setRoadRetry((value) => value + 1)}
          error={previewCurrent ? previewState.error : undefined}
        />
        {useGoogleRoads ? <RouteMap config={catalogs.list.googleMaps ?? null} points={mapPoints} encodedPolyline={mapRoad?.status === 'ready' ? mapRoad.encodedPolyline : null} /> : null}
        <NearbyWork jobs={catalogs.jobs} revision={revision} selectedIds={selectedIds} onAdd={addStop} />
      </div>
    </div>
  </ActionForm></div><RoutePublication route={route} dirty={publicationDirty} revision={revision} participants={catalogs.participants} operationCatalogs={{ participants: catalogs.participants, crews: catalogs.crews, vehicles: catalogs.vehicles, points: catalogs.list.points }} onPublished={markPublished} onOpenDelivery={onOpenDelivery} vehicleName={catalogs.vehicles.find((vehicle) => vehicle.id === route?.vehicleId)?.name} /></>;
}

