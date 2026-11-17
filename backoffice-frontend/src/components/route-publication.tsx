'use client';

import { Combobox } from './ui/combobox';


import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { motion, MotionConfig } from 'motion/react';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError, apiRequest, errorMessage, mutate } from '@/lib/api';
import { detailSchema, templateSchema, type DeliveryDetail, type Participant, type TaskTemplate } from '@/lib/contracts';
import type { RouteDraft } from '@/lib/route-drafts';
import { publicationCapabilitySchema, publicationDetailSchema, publicationRequestSchema, publicationReviewSchema, publicationSummarySchema, type PublicationDetail, type PublicationRequest, type PublicationReview, type PublicationSummary } from '@/lib/route-publication';
import { initialWorkDrafts, validateWorkDrafts, type WorkDraft } from '@/lib/visit-work';
import { formatDateTime } from '@/lib/time';
import { Field, Notice } from './ui';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { WorkScopeFields } from './visit-work';
import { ScopeSummary } from './route-publication-summary';
import { RouteOperationsPanel, type RouteOperationCatalogs } from './route-operations';

type Selection = { drafts: WorkDraft[]; templateIds: string[]; responsibleParticipantId: string; returnRequestId: string };
type Loaded = { revision: number; details: DeliveryDetail[]; templates: TaskTemplate[]; enabled: boolean };
const stopKey = (stop: RouteDraft['stops'][number]) => `${stop.deliveryId}:${stop.appointmentId ?? 'new'}`;

export function RoutePublication({ route, dirty, revision, participants, onPublished, onOpenDelivery, vehicleName, operationCatalogs }: {
  route?: RouteDraft; dirty: boolean; revision: number; participants: readonly Participant[]; onPublished: (summary: PublicationSummary) => void;
  onOpenDelivery?: (deliveryId: string) => void;
  vehicleName?: string;
  operationCatalogs?: RouteOperationCatalogs;
}) {
  const t = useTranslations('routePublication');
  const operations = useTranslations('routeOperations');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [summary, setSummary] = useState<PublicationDetail | null>(null);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const routeId = route?.id;
  useEffect(() => {
    if (!routeId) return;
    const controller = new AbortController();
    void apiRequest(`/routes/${routeId}/publication`, publicationDetailSchema.nullable(), { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSummary(value); setSummaryError(null);
      if (value) onPublished(value);
    }, (error: unknown) => { if (!controller.signal.aborted) setSummaryError(error); });
    return () => controller.abort();
  }, [routeId, revision, onPublished]);
  return <Card className="mt-4 grid gap-3 border-info-foreground/25 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{summary ? operations('title') : t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{summary ? operations('currentHelp') : t('intro')}</p></div>
      {!summary ? <Button type="button" variant="outline" disabled={!route} aria-expanded={open} onClick={() => { setOpened(true); setOpen((value) => !value); }}>{t(open ? 'hide' : 'open')}</Button> : null}</div>
    {!route ? <p className="text-xs text-muted-foreground">{t('saveFirst')}</p> : null}
    {summary ? <p className="text-xs text-muted-foreground">{t('alreadyPublished')} {t('publishedHelp')}</p> : null}
    {summary ? <RouteOperationsPanel routeId={summary.id} revision={revision} fallbackReview={summary.review} catalogs={operationCatalogs ?? { participants, crews: [], vehicles: [], points: [] }} onOpenDelivery={onOpenDelivery} /> : null}
    {summaryError && open ? <Notice tone="error">{errorMessage(summaryError, locale)}</Notice> : null}
    {route && opened && !summary ? <MotionConfig reducedMotion="user"><motion.div hidden={!open} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <PublicationForm key={route.id} route={route} dirty={dirty || !!summaryError} revision={revision} participants={participants} onPublished={(value) => { setSummary(value); onPublished(value); }} onOpenDelivery={onOpenDelivery} vehicleName={vehicleName} />
    </motion.div></MotionConfig> : null}
  </Card>;
}

function PublicationForm({ route, dirty, revision, participants, onPublished, onOpenDelivery, vehicleName }: {
  route: RouteDraft; dirty: boolean; revision: number; participants: readonly Participant[]; onPublished: (summary: PublicationDetail) => void;
  onOpenDelivery?: (deliveryId: string) => void;
  vehicleName?: string;
}) {
  const t = useTranslations('routePublication');
  const work = useTranslations('workPlan');
  const deliveryText = useTranslations('delivery');
  const routeText = useTranslations('routes');
  const routeChecks = useTranslations('routeChecks');
  const locale = useLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState<'review' | 'publish' | null>(null);
  const [review, setReview] = useState<{ key: string; input: PublicationRequest; result: PublicationReview } | null>(null);
  const [acceptedKey, setAcceptedKey] = useState<string | null>(null);
  const [published, setPublished] = useState<PublicationSummary | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const busy = useRef(false);
  const selectedPeople = participants.filter((person) => route.planning?.participantIds.includes(person.id));
  const scopeKey = JSON.stringify(route.stops.map((stop) => ({ deliveryId: stop.deliveryId, appointmentId: stop.appointmentId })));
  const personIdsKey = JSON.stringify(route.planning?.participantIds ?? []);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      apiRequest('/routes/publication-capability', publicationCapabilitySchema, options),
      apiRequest('/templates', z.array(templateSchema), options),
      ...route.stops.map((stop) => apiRequest(`/deliveries/${stop.deliveryId}`, detailSchema, options)),
    ]).then((values) => {
      if (controller.signal.aborted) return;
      const capability = publicationCapabilitySchema.parse(values[0]);
      const templates = z.array(templateSchema).parse(values[1]);
      const details = z.array(detailSchema).parse(values.slice(2));
      setLoaded({ revision, details, templates, enabled: capability.enabled });
      setLoadError(null);
      setSelections((previous) => {
        const next = { ...previous };
        for (const stop of route.stops) {
          const key = stopKey(stop);
          if (next[key]) continue;
          const detail = details.find((entry) => entry.delivery.id === stop.deliveryId);
          const appointment = detail?.delivery.appointments.find(({ id }) => id === stop.appointmentId);
          next[key] = { drafts: initialWorkDrafts(detail?.lineServices ?? []), templateIds: [], returnRequestId: '',
            responsibleParticipantId: appointment?.responsibleParticipant?.id ?? (route.planning?.participantIds.length === 1 ? route.planning.participantIds[0] ?? '' : '') };
        }
        return next;
      });
    }, (error: unknown) => { if (!controller.signal.aborted) setLoadError(error); });
    return () => controller.abort();
  }, [route.id, scopeKey, personIdsKey, revision, retry, route.stops, route.planning?.participantIds]);

  const dataReady = loaded?.revision === revision && !loadError;
  const inputResult = publicationInput();
  const commandKey = inputResult.input ? JSON.stringify([route.id, inputResult.input, revision]) : '';
  const currentKey = useRef(commandKey);
  useEffect(() => { currentKey.current = commandKey; }, [commandKey]);
  const currentReview = !!review && review.key === commandKey && !dirty && dataReady;
  const accepted = currentReview && acceptedKey === commandKey;

  function publicationInput(): { input: PublicationRequest | null; message: string | null } {
    if (!loaded) return { input: null, message: null };
    const stops: PublicationRequest['stops'] = [];
    for (const stop of route.stops) {
      const detail = loaded.details.find((entry) => entry.delivery.id === stop.deliveryId);
      const selection = selections[stopKey(stop)];
      if (!detail || !selection) return { input: null, message: t('invalid') };
      if (stop.appointmentId) {
        const appointment = detail.delivery.appointments.find(({ id }) => id === stop.appointmentId);
        if (!appointment?.workScope || !appointment.responsibleParticipant) return { input: null, message: t('missingScope') };
        stops.push({ mode: 'attach', deliveryId: stop.deliveryId, appointmentId: stop.appointmentId, responsibleParticipantId: appointment.responsibleParticipant.id });
      } else {
        const result = validateWorkDrafts(selection.drafts, detail.lineServices ?? []);
        if (result.error) return { input: null, message: `${detail.delivery.source.pickingName}: ${work(result.error)}` };
        if (!selection.templateIds.length || !selection.responsibleParticipantId) return { input: null, message: t('invalid') };
        if (!route.planning?.participantIds.includes(selection.responsibleParticipantId)) return { input: null, message: t('personMissing') };
        stops.push({ mode: 'create', deliveryId: stop.deliveryId, workLines: result.lines, templateIds: selection.templateIds, responsibleParticipantId: selection.responsibleParticipantId,
          ...(selection.returnRequestId ? { returnRequestId: selection.returnRequestId } : {}) });
      }
    }
    const parsed = publicationRequestSchema.safeParse({ version: route.version, stops });
    return parsed.success ? { input: parsed.data, message: null } : { input: null, message: t('invalid') };
  }

  function change(stop: RouteDraft['stops'][number], values: Partial<Selection>) {
    setSelections((previous) => {
      const existing = previous[stopKey(stop)];
      return existing ? { ...previous, [stopKey(stop)]: { ...existing, ...values } } : previous;
    });
  }

  async function check() {
    if (busy.current || dirty || !dataReady || !inputResult.input) return;
    busy.current = true; setPending('review'); setFailure(null); setAcceptedKey(null);
    try {
      const result = await mutate(`/routes/${route.id}/publication-review`, publicationReviewSchema, inputResult.input);
      if (currentKey.current !== commandKey) { toast.error(t('freshNeeded')); return; }
      setReview({ key: commandKey, input: inputResult.input, result });
      setAcceptedKey(null);
      toast.success(t('reviewComplete'));
    } catch (error: unknown) { setFailure(error); toast.error(errorMessage(error, locale)); }
    finally { busy.current = false; setPending(null); }
  }

  async function publish() {
    if (busy.current || !review || !currentReview || !accepted || !loaded?.enabled || !review.result.publicationEnabled || published) return;
    if (!request.current || request.current.key !== commandKey) request.current = { key: commandKey, id: crypto.randomUUID() };
    busy.current = true; setPending('publish'); setFailure(null);
    try {
      const result = await mutate(`/routes/${route.id}/publish`, publicationSummarySchema, { ...review.input,
        requestId: request.current.id, fingerprint: review.result.fingerprint, acknowledgeEstimates: true });
      setPublished(result); onPublished({ ...result, review: review.result }); toast.success(t('published'));
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) { setAcceptedKey(null); setReview((previous) => previous && { ...previous, key: '' }); }
      setFailure(error); toast.error(errorMessage(error, locale));
    }
    finally { busy.current = false; setPending(null); }
  }

  if (published) return <Notice tone="success"><strong>{t('published')}</strong><p>{t('snapshot', { version: published.version })}</p><p>{t('publishedHelp')}</p></Notice>;
  return <div className="grid gap-4">
    {dirty ? <Notice>{t('unsaved')}</Notice> : null}
    {loaded && !loaded.enabled ? <Notice><strong>{t('gated')}</strong><p className="mt-1 text-xs">{t('gateHelp')}</p></Notice> : null}
    {loadError ? <Notice tone="error">{t('loadFailed')} {errorMessage(loadError, locale)} <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button></Notice> : null}
    {!loaded && !loadError ? <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p> : null}
    {loaded ? <>
      <fieldset disabled={pending !== null} className="grid min-w-0 gap-4">
        {route.stops.map((stop, index) => {
          const detail = loaded.details.find((entry) => entry.delivery.id === stop.deliveryId);
          const selection = selections[stopKey(stop)];
          const appointment = detail?.delivery.appointments.find(({ id }) => id === stop.appointmentId);
          if (!detail || !selection) return null;
          return <section key={stopKey(stop)} className="min-w-0 rounded-lg border bg-muted/15 p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{index + 1}. {detail.delivery.source.pickingName}</h3><p className="text-sm text-muted-foreground">{detail.delivery.source.customer.name}</p></div><span className={`badge ${stop.appointmentId ? 'info' : 'neutral'}`}>{t(stop.appointmentId ? 'attach' : 'create')}</span></div>
            {stop.appointmentId ? <>
              <p className="mb-2 text-xs text-muted-foreground">{t('linkedHelp')}</p>
              {appointment?.workScope ? <ScopeSummary scope={appointment.workScope} source={detail.delivery.source} /> : null}
              <p className="mt-2 text-sm">{t('responsible')}: {appointment?.responsibleParticipant?.name ?? '—'}</p>
              <span className={`badge ${appointment?.customerConfirmation ? 'success' : 'warning'}`}>{t(appointment?.customerConfirmation ? 'customer_confirmed' : 'awaiting_customer_confirmation')}</span>
              {onOpenDelivery ? <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => onOpenDelivery(stop.deliveryId)}>{t('deliveryDetails')}</Button> : null}
            </> : <>
              <WorkScopeFields source={detail.delivery.source} lines={detail.lineServices ?? []} drafts={selection.drafts} onChange={(drafts) => change(stop, { drafts })} />
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Field label={t('responsible')}><Combobox value={selection.responsibleParticipantId} onChange={(event) => change(stop, { responsibleParticipantId: event.target.value })}><option value="">{t('selectResponsible')}</option>{selectedPeople.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Combobox></Field>
                <fieldset className="grid content-start gap-2"><legend className="mb-2 text-sm font-medium">{t('tasks')}</legend>{loaded.templates.filter((template) => template.enabled).map((template) => <label key={template.id} className="flex items-start gap-2 text-sm"><Input type="checkbox" checked={selection.templateIds.includes(template.id)} onChange={(event) => change(stop, { templateIds: event.target.checked ? [...selection.templateIds, template.id] : selection.templateIds.filter((id) => id !== template.id) })} />{template.title}</label>)}{!loaded.templates.some((template) => template.enabled) ? <p className="text-xs text-muted-foreground">{t('noTemplates')}</p> : null}</fieldset>
              </div>
              {detail.delivery.returnRequests.some((entry) => entry.status === 'requested') ? <Field label={deliveryText('returnRequest')}><Combobox value={selection.returnRequestId} onChange={(event) => change(stop, { returnRequestId: event.target.value })}><option value="">{deliveryText('regularVisit')}</option>{detail.delivery.returnRequests.filter((entry) => entry.status === 'requested').map((entry) => <option key={entry.id} value={entry.id}>{entry.reason} · {entry.remainingWork}</option>)}</Combobox></Field> : null}
            </>}
          </section>;
        })}
      </fieldset>
      {inputResult.message ? <p className="text-sm text-warning-foreground">{inputResult.message}</p> : null}
      <div><Button type="button" variant="outline" disabled={pending !== null || dirty || !dataReady || !inputResult.input} onClick={() => { void check(); }}>{t(pending === 'review' ? 'reviewing' : 'review')}</Button></div>
    </> : null}
    {failure ? <Notice tone="error">{errorMessage(failure, locale)}</Notice> : null}
    {review ? <section className="grid gap-3 rounded-lg border border-info-foreground/30 bg-info/30 p-3 sm:p-4">
      <h3 className="font-semibold">{t('selectedWork')}</h3>
      {!currentReview ? <Notice>{t('stale')}</Notice> : null}
      <p className="text-xs font-medium text-info-foreground">{t('estimate')}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('departure')}</dt><dd className="font-mono text-xs">{formatDateTime(review.result.timeline.departAt, locale)}</dd></div><div><dt className="text-muted-foreground">{t('return')}</dt><dd className="font-mono text-xs">{review.result.timeline.returnAt ? formatDateTime(review.result.timeline.returnAt, locale) : '—'}</dd></div></dl>
      <p className="text-sm">{t('resources')}: {selectedPeople.map((person) => person.name).join(', ')}</p>
      <dl className="text-sm"><div><dt className="text-muted-foreground">{routeText('vehicle')}</dt><dd>{vehicleName ?? routeText('unassigned')}</dd></div></dl>
      <p className="text-xs text-muted-foreground">{t('routeBuffer', { minutes: route.planning?.transferBufferMinutes ?? 0 })}</p>
      {review.result.feasibility.findings.length ? <ul className="grid gap-1 text-sm text-warning-foreground">{review.result.feasibility.findings.map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message}</li>)}</ul> : null}
      <ol className="grid gap-3">{review.result.stops.map((stop, index) => <li key={stop.deliveryId} className="rounded-md border bg-background p-3">
        <h4 className="font-medium">{index + 1}. {stop.pickingName}</h4>
        <p className="text-xs text-muted-foreground">{t(stop.mode === 'attach' ? 'attach' : 'create')} · {formatDateTime(stop.startsAt, locale)} — {formatDateTime(stop.endsAt, locale)}</p>
        <p className="mt-1 text-xs">{routeChecks('eta')}: {review.result.timeline.stops.find((entry) => entry.deliveryId === stop.deliveryId)?.eta ? formatDateTime(review.result.timeline.stops.find((entry) => entry.deliveryId === stop.deliveryId)?.eta ?? '', locale) : '—'}</p>
        <p className="mt-1 text-xs">{stop.assignments.map((assignment) => `${assignment.crewName} · ${assignment.tasks.map((task) => task.title).join(', ')}`).join(' · ')}</p>
        <p className="my-2 text-sm">{t('responsible')}: {stop.responsibleParticipant.name}</p>
        <span className={`badge ${stop.customerConfirmationStatus === 'customer_confirmed' ? 'success' : 'warning'}`}>{t(stop.customerConfirmationStatus)}</span>
        <ScopeSummary scope={stop.workScope} source={loaded?.details.find((entry) => entry.delivery.id === stop.deliveryId)?.delivery.source} />
      </li>)}</ol>
      <p className="text-xs text-muted-foreground">{t('awaitingHelp')}</p>
      <label className="flex items-start gap-2 text-sm"><Input type="checkbox" checked={accepted} disabled={!currentReview || pending !== null} onChange={(event) => setAcceptedKey(event.target.checked ? commandKey : null)} />{t('acknowledge')}</label>
      <div><Button type="button" disabled={!accepted || pending !== null || !loaded?.enabled || !review.result.publicationEnabled || review.result.feasibility.status !== 'feasible_estimate'} onClick={() => { void publish(); }}>{t(pending === 'publish' ? 'publishing' : 'publish')}</Button></div>
    </section> : null}
  </div>;
}
