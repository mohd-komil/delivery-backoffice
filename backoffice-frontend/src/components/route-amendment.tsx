'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ApiError, errorMessage, mutate } from '@/lib/api';
import type { Crew, Participant, Vehicle } from '@/lib/contracts';
import type { RouteDraftInput, RoutePoint } from '@/lib/route-drafts';
import { routeAmendReviewInputSchema, routeAmendReviewSchema, type RouteAmendReview, type RouteAmendReviewInput, type RouteCommand, type RouteOperations } from '@/lib/route-operations';
import { Field, Notice } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DateTimeInput } from './date-time-fields';
import { RouteAttestations } from './route-operation-fields';
import { emptyRoutePlanning, RouteResourceFields, RouteWindowFields, RouteFeasibility } from './route-planning-controls';
import { RouteTimeline } from './route-planning-panels';

type Catalogs = { participants: readonly Participant[]; crews: readonly Crew[]; vehicles: readonly Vehicle[]; points: readonly RoutePoint[] };

function amendmentPlan(data: RouteOperations): RouteDraftInput {
  return { ...data.draft, stops: data.draft.stops.map((stop) => ({ ...stop, appointmentId: data.stops.find((entry) => entry.deliveryId === stop.deliveryId)?.appointmentId })) };
}
function responsibility(data: RouteOperations): Record<string, string> {
  return Object.fromEntries(data.stops.map((stop) => [stop.appointmentId, stop.responsibleParticipant?.id ?? '']));
}

export function RouteAmendment({ data, catalogs, revision, disabled, command }: { data: RouteOperations; catalogs: Catalogs; revision: string; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  const routes = useTranslations('routes');
  const pub = useTranslations('routePublication');
  const common = useTranslations('common');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState(() => amendmentPlan(data));
  const [responsible, setResponsible] = useState(() => responsibility(data));
  const [baseVersion, setBaseVersion] = useState(data.version);
  const [phone, setPhone] = useState(data.externalDriverPhone ?? '');
  const [reason, setReason] = useState('');
  const [attest, setAttest] = useState({ notDeparted: false, notLoaded: false });
  const [review, setReview] = useState<{ key: string; input: RouteAmendReviewInput; result: RouteAmendReview } | null>(null);
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [resetCount, setResetCount] = useState(0);
  const busy = useRef(false);
  const input = routeAmendReviewInputSchema.safeParse({ version: baseVersion, reason, confirmNotDeparted: attest.notDeparted, confirmNotLoaded: attest.notLoaded, plan,
    responsibleParticipants: data.stops.map((stop) => ({ appointmentId: stop.appointmentId, participantId: responsible[stop.appointmentId] ?? '' })),
    ...(plan.planning?.driver.kind === 'external' ? { externalDriverPhone: phone } : {}) });
  const key = JSON.stringify([input.success ? input.data : null, revision, data.version]);
  const currentKey = useRef(key);
  useEffect(() => { currentKey.current = key; }, [key]);
  const changed = baseVersion !== data.version;
  const currentReview = !!review && review.key === key && !changed && !disabled;
  const actualPeople = catalogs.participants.filter((person) => plan.planning?.participantIds.includes(person.id));
  const responsibleValid = data.stops.every((stop) => actualPeople.some((person) => person.id === responsible[stop.appointmentId]));

  function reset() {
    setPlan(amendmentPlan(data)); setResponsible(responsibility(data)); setBaseVersion(data.version); setPhone(data.externalDriverPhone ?? '');
    setAttest({ notDeparted: false, notLoaded: false }); setReview(null); setAcknowledgedKey(null); setFailure(null); setResetCount((value) => value + 1);
  }
  function move(index: number, offset: -1 | 1) {
    setPlan((previous) => {
      const stops = [...previous.stops]; const current = stops[index]; const other = stops[index + offset];
      if (!current || !other) return previous;
      stops[index] = other; stops[index + offset] = current;
      return { ...previous, stops };
    });
  }
  async function check() {
    if (!input.success || busy.current || disabled || changed || !responsibleValid) return;
    busy.current = true; setPending(true); setFailure(null); setAcknowledgedKey(null);
    try {
      const result = await mutate(`/routes/${data.id}/amend-review`, routeAmendReviewSchema, input.data);
      if (key !== currentKey.current) { toast.error(t('amendStale')); return; }
      setReview({ key, input: input.data, result }); toast.success(t('reviewUpdated'));
    } catch (error: unknown) { setFailure(error); toast.error(errorMessage(error, locale)); }
    finally { busy.current = false; setPending(false); }
  }
  async function apply() {
    if (!review || !currentReview || acknowledgedKey !== key || busy.current || review.result.review.feasibility.status !== 'feasible_estimate') return;
    busy.current = true; setPending(true); setFailure(null);
    try {
      const version = await command('amend', { ...review.input, fingerprint: review.result.fingerprint, acknowledgeEstimates: true });
      setBaseVersion(version); setReview(null); setAcknowledgedKey(null); setOpen(false); toast.success(t('saved'));
    } catch (error: unknown) { if (error instanceof ApiError && error.status === 409) setAcknowledgedKey(null); setFailure(error); toast.error(errorMessage(error, locale)); }
    finally { busy.current = false; setPending(false); }
  }
  const preview = review ? { timeline: review.result.review.timeline, feasibility: review.result.review.feasibility, jobs: [], warnings: [], pointContexts: [] } : undefined;
  const pointName = (id: string) => catalogs.points.find((point) => point.id === id)?.name ?? data.stops.find((stop) => stop.deliveryId === id)?.pickingName ?? id;

  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="min-w-0 rounded-lg border p-4">
    <summary className="cursor-pointer font-semibold">{t('amend')}</summary><p className="my-3 text-sm text-muted-foreground">{t('amendHelp')}</p>
    {changed ? <Notice>{common('newerRecord')} <Button type="button" variant="outline" disabled={pending} onClick={reset}>{common('latestData')}</Button></Notice> : null}
    <fieldset key={resetCount} disabled={disabled || pending || changed} className="grid min-w-0 gap-4">
      <div className="grid gap-3 sm:grid-cols-2"><DateTimeInput name="amendedDeparture" label={pub('departure')} initialInstant={plan.departAt} onInstantChange={(departAt) => setPlan((value) => ({ ...value, departAt }))} />
        <Field label={routes('vehicle')}><select value={plan.vehicleId ?? ''} onChange={(event) => setPlan((value) => ({ ...value, vehicleId: event.target.value || null }))}><option value="">{routes('unassigned')}</option>{catalogs.vehicles.filter((vehicle) => vehicle.enabled || vehicle.id === plan.vehicleId).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></Field>
        <Field label={routes('crew')}><select value={plan.crewId ?? ''} onChange={(event) => setPlan((value) => ({ ...value, crewId: event.target.value || null }))}><option value="">{routes('unassigned')}</option>{catalogs.crews.filter((crew) => crew.enabled || crew.id === plan.crewId).map((crew) => <option key={crew.id} value={crew.id}>{crew.name}</option>)}</select></Field>
      </div>
      <RouteResourceFields value={plan.planning ?? emptyRoutePlanning} onChange={(planning) => setPlan((value) => ({ ...value, planning }))} participants={catalogs.participants} crew={catalogs.crews.find((crew) => crew.id === plan.crewId)} />
      {plan.planning?.driver.kind === 'external' ? <Field label={pub('phone')}><Input type="tel" maxLength={200} value={phone} onChange={(event) => setPhone(event.target.value)} /></Field> : null}
      <ol className="grid gap-3">{plan.stops.map((stop, index) => {
        const live = data.stops.find((entry) => entry.deliveryId === stop.deliveryId);
        if (!live) return null;
        return <li key={stop.deliveryId} className="grid min-w-0 gap-3 rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{index + 1}. {live.pickingName}</strong><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>{routes('moveUp')}</Button><Button type="button" variant="outline" size="sm" disabled={index === plan.stops.length - 1} onClick={() => move(index, 1)}>{routes('moveDown')}</Button></div></div>
          <div className="grid gap-3 sm:grid-cols-2"><Field label={routes('duration')}><Input type="number" min={1} max={1440} step={1} value={stop.workMinutes ?? ''} onChange={(event) => setPlan((value) => ({ ...value, stops: value.stops.map((entry) => entry.deliveryId === stop.deliveryId ? { ...entry, workMinutes: event.target.value === '' ? null : Number(event.target.value), workDurationSource: 'manual' } : entry) }))} /></Field>
            <Field label={t('responsible')}><select value={responsible[live.appointmentId] ?? ''} onChange={(event) => setResponsible((value) => ({ ...value, [live.appointmentId]: event.target.value }))}><option value="">{t('noResponsible')}</option>{responsible[live.appointmentId] && !actualPeople.some((person) => person.id === responsible[live.appointmentId]) ? <option value={responsible[live.appointmentId]} disabled>{pub('personMissing')}</option> : null}{actualPeople.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field></div>
          <RouteWindowFields value={stop.customerWindow} onChange={(customerWindow) => setPlan((value) => ({ ...value, stops: value.stops.map((entry) => entry.deliveryId === stop.deliveryId ? { ...entry, customerWindow } : entry) }))} />
        </li>;
      })}</ol>
      <Field label={t('reason')}><Input value={reason} required maxLength={2000} onChange={(event) => setReason(event.target.value)} /></Field>
      <RouteAttestations value={attest} onChange={setAttest} />
      <div><Button type="button" variant="outline" disabled={!input.success || !responsibleValid} onClick={() => { void check(); }}>{t('amendReview')}</Button></div>
    </fieldset>
    {failure ? <Notice tone="error">{errorMessage(failure, locale)}</Notice> : null}
    {review ? <div className="mt-4 grid gap-3">
      {!currentReview ? <Notice>{t('amendStale')}</Notice> : null}
      <RouteFeasibility preview={preview} stale={!currentReview} pointName={pointName} /><RouteTimeline preview={preview} pointName={pointName} stale={!currentReview} loading={false} roadLoading={false} onRoadRetry={() => undefined} error={undefined} />
      <Notice>{review.result.confirmationResetAppointmentIds.length ? <>{t('confirmationReset')}<ul>{review.result.confirmationResetAppointmentIds.map((id) => <li key={id}>{data.stops.find((stop) => stop.appointmentId === id)?.pickingName ?? id}</li>)}</ul></> : t('noConfirmationReset')}</Notice>
      <label className="flex items-start gap-2 text-sm"><Input type="checkbox" disabled={!currentReview || pending} checked={currentReview && acknowledgedKey === key} onChange={(event) => setAcknowledgedKey(event.target.checked ? key : null)} />{pub('acknowledge')}</label>
      <div><Button type="button" disabled={!currentReview || pending || acknowledgedKey !== key || review.result.review.feasibility.status !== 'feasible_estimate'} onClick={() => { void apply(); }}>{t('amendApply')}</Button></div>
    </div> : null}
  </details>;
}
