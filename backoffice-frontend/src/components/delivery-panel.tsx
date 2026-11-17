'use client';

import { Combobox } from './ui/combobox';

import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Dialog, DialogContent, DialogTitle, useDialogClose } from './ui/dialog';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, MotionConfig } from 'motion/react';
import { z } from 'zod';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { InitialAssignmentForm } from './initial-assignment-form';
import { AppointmentBookingForm } from './appointment-booking-form';
import { DateTimeFields, dateTimeField } from './date-time-fields';
import { API_URL, apiRequest, errorMessage, mutate } from '@/lib/api';
import { crewSchema, detailSchema, skillSchema, templateSchema, vehicleSchema, type Appointment, type Crew, type Delivery, type DeliveryDetail, type DeliveryFocus, type DeliveryTab, type Skill, type TaskTemplate, type User, type Vehicle } from '@/lib/contracts';
import { RecordedSkillBadges } from './skill-choices';
import { sourceOrders, sourceLineLabel, sourceServiceLabel, sourceStateLabel } from '@/lib/source';
import { VisitTransport, TransportReadout } from './visit-transport';
import { formatDateTime } from '@/lib/time';
import { visitConfirmationState } from '@/lib/visit-confirmation';
import { ActionForm, ChoiceGroup, Empty, Field, Notice, Pending, optionalText, textField } from './ui';
import { DetailHeading, DetailIcon, ProgressBadge, deliveryAuditLabel, deliveryNoticeLabel, deliveryStatusLabel } from './delivery-detail-presentation';
import { VisitConfirmationBadge } from './visit-confirmation-badge';
import { DeliveryProductLines } from './delivery-product-lines';
import { DeliveryDetailCard } from './delivery-detail-card';
import { PriorWorkHistory } from './delivery-prior-work';
import { DeliverySourceReview, SourceReviewHistory } from './delivery-source-review';
import { sourceReviewAuditKey } from '@/lib/source-review';
import { DeliveryResultEvidence } from './delivery-result-evidence';
import { DeliveryResultWork } from './delivery-result-work';
import { EntranceReviewAction } from './entrance-review-action';
import { DeliveryGeocoding } from './delivery-geocoding';
import { PageHelp } from './page-help';
import { VisitWorkEditor, VisitWorkSnapshot } from './visit-work';
import { InboxNearbyWork } from './inbox-nearby-work';
import { DeliveryWorkReadiness, ResultIssueLinks } from './delivery-work-readiness';
import { DeliveryFiles, DeliveryResultDocuments } from './delivery-files';
import { TimeStandardHistory } from './delivery-time-standard';
import { WorkQuantitiesHistory } from './delivery-work-quantities';
import { DeliveryWorkEstimate, WorkTimeAdjustmentsHistory } from './delivery-work-estimate';
import { SignatureRefusalReview } from './delivery-signature-refusal';

export function DeliveryPanel({ id, user, onClose, onChanged, onOpenRouteDraft, refreshKey = 0, initialTab = 'overview', initialFocus }: { id: string; user: User; onClose: () => void; onChanged: () => void; onOpenRouteDraft?: (id: string) => void; refreshKey?: number; initialTab?: DeliveryTab; initialFocus?: DeliveryFocus }) {
  const t = useTranslations('delivery');
  const dialog = useDialogClose(onClose);
  const priorText = useTranslations('priorWork');
  const refusalText = useTranslations('signatureRefusal');
  const locale = useLocale();
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [crews, setCrews] = useState<Crew[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [requestLoading, setLoading] = useState(true);
  const [settledRefreshKey, setSettledRefreshKey] = useState(refreshKey);
  const loading = requestLoading || settledRefreshKey !== refreshKey;
  const [tab, setTab] = useState<DeliveryTab>(initialTab);
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const readGeneration = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const focusedOrigin = useRef(false);
  const hasDetail = detail !== null;
  const originAnchor = reviewTarget ? `result-${reviewTarget}`
    : initialTab === 'history' && initialFocus?.resultId ? `result-${initialFocus.resultId}`
    : initialTab === 'issues' && initialFocus?.issueId ? `issue-${initialFocus.issueId}`
    : (initialTab === 'visits' || initialTab === 'history') && initialFocus?.appointmentId ? `visit-${initialFocus.appointmentId}`
    : initialTab === 'overview' && initialFocus?.sourceLineId ? `product-line-${initialFocus.sourceLineId}` : null;
  useEffect(() => {
    if (!hasDetail || !originAnchor || focusedOrigin.current) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(originAnchor);
      if (!target) return;
      focusedOrigin.current = true;
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hasDetail, originAnchor, tab]);
  // Geocoding updates its own cache without changing delivery.version.
  const locationRevision = `${refreshKey}:${revision}:${detail?.delivery.version ?? 0}`;
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++readGeneration.current;
    pendingRead.current = controller;
    void Promise.all([
      apiRequest(`/deliveries/${id}`, detailSchema, { signal: controller.signal }),
      apiRequest('/crews', z.array(crewSchema), { signal: controller.signal }),
      apiRequest('/templates', z.array(templateSchema), { signal: controller.signal }),
      apiRequest('/skills', z.array(skillSchema), { signal: controller.signal }),
      apiRequest('/vehicles', z.array(vehicleSchema), { signal: controller.signal }),
    ]).then(([result, nextCrews, nextTemplates, nextSkills, nextVehicles]) => { if (controller.signal.aborted || generation !== readGeneration.current) return; setDetail((previous) => previous && previous.delivery.version > result.delivery.version ? previous : result); setCrews(nextCrews); setTemplates(nextTemplates); setSkills(nextSkills); setVehicles(nextVehicles); setError(null); setLoading(false); setSettledRefreshKey(refreshKey); }, (failure: unknown) => { if (!controller.signal.aborted && generation === readGeneration.current) { setError(errorMessage(failure, locale)); setLoading(false); setSettledRefreshKey(refreshKey); } });
    return () => controller.abort();
  }, [id, revision, refreshKey, locale]);
  const refresh = useCallback(() => { setLoading(true); setRevision((value) => value + 1); }, []);
  async function command(path: string, body: unknown, method = 'POST') {
    const updated = await mutate(`/deliveries/${id}${path}`, detailSchema, body, method);
    ++readGeneration.current;
    pendingRead.current?.abort();
    setDetail((previous) => previous && previous.delivery.version > updated.delivery.version ? previous : updated); setError(null); setLoading(false); setSettledRefreshKey(refreshKey); onChanged();
    return updated.delivery.version;
  }
  const pendingRefusal = detail?.delivery.appointments.flatMap((appointment) => appointment.results.filter((result) =>
    result.signatureRefusal && appointment.signatureRefusalReview?.resultId !== result.id
      && !appointment.results.some((candidate) => candidate.supersedesResultId === result.id)))[0];
  return <MotionConfig reducedMotion="user" transition={{ duration: 0.16, ease: 'easeOut' }}><Dialog open={dialog.open} onOpenChange={(open) => { if (!open) dialog.close(); }}><DialogContent
    className="delivery-panel"
    aria-describedby={undefined}
    onOpenAutoFocus={(event) => {
      if (heading.current) {
        event.preventDefault();
        heading.current.focus({ preventScroll: true });
      }
    }}
  ><header className="panel-header"><div className="panel-identity"><span className="detail-heading-icon info panel-symbol"><DetailIcon name="package" /></span><div className="min-w-0 [overflow-wrap:anywhere]"><p className="eyebrow">{t('eyebrow')}</p><div className="flex flex-wrap items-center gap-x-1.5"><DialogTitle asChild><h2 ref={heading} tabIndex={-1}>{detail?.delivery.source.pickingName ?? t('loadingDelivery')}</h2></DialogTitle><PageHelp title={t('eyebrow')} topic="deliveryDetails" /></div><span className="muted">{detail ? sourceOrders(detail.delivery.source).map((order) => order.name).join(', ') : t('sourcePicking')}</span></div></div><div className="panel-header-actions"><button className="button secondary small" disabled={loading} onClick={refresh}>{t('refresh')}</button><button className="icon-button" onClick={dialog.close} aria-label={t('closeDetails')}>×</button></div></header>
      {detail ? <div className="panel-meta"><ProgressBadge progress={detail.progress} /><span className="badge neutral"><DetailIcon name="crew" />{t('visitsStaffed', { assigned: detail.coverage.assigned, total: detail.coverage.total })}</span>{detail.views.filter((view) => view !== detail.progress).map((view) => <ProgressBadge progress={view} key={view} />)}<span className="badge neutral mono">v{detail.delivery.version}</span><span className="muted small">{detail.delivery.source.salesTeam}</span></div> : null}
      <nav className="tabbar panel-tabs" aria-label={t('details')}>{([{ id: 'overview', label: t('overview'), icon: 'customer' }, { id: 'visits', label: t('visitsTasks'), icon: 'calendar' }, { id: 'issues', label: t('issuesReturns'), icon: 'alert' }, { id: 'files', label: t('documentsEvidence'), icon: 'file' }, { id: 'history', label: t('history'), icon: 'history' }] as const).map((entry) => <button className={tab === entry.id ? 'active' : ''} aria-pressed={tab === entry.id} key={entry.id} onClick={() => setTab(entry.id)}><DetailIcon name={entry.icon} />{entry.label}</button>)}</nav>
      <div className="panel-body" aria-busy={loading}>{error ? <Notice tone="error">{error} {detail ? t('staleData') : ''}</Notice> : null}{loading && !detail ? <Pending>{t('loadingCurrent')}</Pending> : null}
        {detail ? <>
          {onOpenRouteDraft ? <div hidden={tab !== 'overview'}><InboxNearbyWork deliveryId={id} revision={locationRevision} onOpenDraft={onOpenRouteDraft} /></div> : null}
          {detail.delivery.sourceReview ? <Notice tone="error">{t('sourceReview')}</Notice> : null}
          {detail.priorWork?.reviewRequired ? <Notice tone="error">{priorText('stale')}</Notice> : null}
          {pendingRefusal && tab !== 'history' ? <Notice>
            <span>{refusalText('pendingNotice')}</span>
            <Button type="button" size="sm" variant="outline" className="ms-2" onClick={() => {
              focusedOrigin.current = false;
              setReviewTarget(pendingRefusal.id);
              setTab('history');
            }}>{refusalText('openHistory')}</Button>
          </Notice> : null}
          {detail.delivery.sourceWarnings.map((warning) => <Notice key={warning}>{deliveryNoticeLabel(t, warning)}</Notice>)}
          <motion.div key={tab} className={`detail-tab-content detail-tab-${tab}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>{tab === 'overview' ? <Overview detail={detail} command={command} refresh={() => { refresh(); onChanged(); }} locationRevision={locationRevision} /> : tab === 'visits' ? <Visits detail={detail} crews={crews} templates={templates} skills={skills} vehicles={vehicles} refreshKey={revision} command={command} /> : tab === 'issues' ? <Issues delivery={detail.delivery} files={detail.files} command={command} /> : tab === 'files' ? <DeliveryFiles detail={detail} command={command} /> : <History detail={detail} command={command} />}</motion.div>
          <section className="close-section detail-section" data-state={detail.delivery.completedAt ? 'complete' : detail.closureBlockers.length ? 'blocked' : 'ready'}><div className="section-title"><DetailHeading icon="shield" tone={detail.delivery.completedAt || !detail.closureBlockers.length ? 'success' : 'warning'}>{detail.delivery.completedAt ? t('deliveryCompleted') : t('completionReview')}</DetailHeading><span className={detail.delivery.completedAt ? 'badge success' : 'badge neutral'}>{detail.delivery.completedAt ? formatDateTime(detail.delivery.completedAt, locale) : t('operatorCommand')}</span></div>{detail.delivery.completedAt ? <><p>{t('reopenHint')}</p><ActionForm dataVersion={detail.delivery.version} submitLabel={t('reopen')} secondary onSubmit={async (data) => command('/reopen', { version: detail.delivery.version, reason: textField(data, 'reason') })}><Field label={t('reopenReason')}><Input name="reason" required maxLength={2000} /></Field></ActionForm></> : <><p className="muted">{t('completionHint')}</p>{detail.closureBlockers.length > 0 ? <ul className="blocker-list">{detail.closureBlockers.map((reason, index) => <li key={`${index}:${reason}`}>{deliveryNoticeLabel(t, reason)}</li>)}</ul> : <Notice tone="success">{t('completionReady')}</Notice>}<ActionForm disabled={detail.closureBlockers.length > 0} submitLabel={t('complete')} onSubmit={async () => command('/complete', { version: detail.delivery.version })}><fieldset disabled={detail.closureBlockers.length > 0}><p className="small">{t('completionChecks')}</p></fieldset></ActionForm></>}{user.role === 'admin' ? <p className="small muted">{t('completionHistory')}</p> : null}</section>
        </> : null}
      </div>
    </DialogContent></Dialog></MotionConfig>;
}

type Command = (path: string, body: unknown, method?: string) => Promise<number>;

function InProgressVisitResponsibility({ detail, command }: { detail: DeliveryDetail; command: Command }) {
  const delivery = detail.delivery;
  const t = useTranslations('delivery');
  const locale = useLocale();
  const activeVisits = delivery.appointments.map((appointment, index) => ({ appointment, index }))
    .filter(({ appointment }) => appointment.status === 'in_progress');
  if (delivery.completedAt || activeVisits.length === 0) return null;

  return <section className="detail-section mb-5" aria-label={t('activeVisitResults')}>
    <DetailHeading icon="crew">{t('activeVisitResults')}</DetailHeading>
    {activeVisits.map(({ appointment, index }) => <div className="section-gap" key={appointment.id}>
      <p className="small muted">{t('visitNumber', { number: index + 1 })} · {formatDateTime(appointment.startsAt, locale)}</p>
      <VisitResponsibleForm appointment={appointment} version={delivery.version} command={command} />
      <VisitWorkEditor detail={detail} appointment={appointment} planning={detail.appointmentPlanning?.find((entry) => entry.appointmentId === appointment.id)} command={command} />
    </div>)}
  </section>;
}

function Overview({ detail, command, refresh, locationRevision }: { detail: DeliveryDetail; command: Command; refresh: () => void; locationRevision: string }) {
  const t = useTranslations('delivery');
  const timeText = useTranslations('workTimes');
  const locale = useLocale();
  const delivery = detail.delivery;
  const source = delivery.source;
  return <>
    <InProgressVisitResponsibility detail={detail} command={command} />
    <DeliverySourceReview delivery={delivery} refreshKey={locationRevision} onRefreshDelivery={refresh} save={(input) => command('/source-review', input)} />
    <DeliveryDetailCard title={t('customerDestination')} icon="customer" badge={t('sourceData')}><div className="customer-card"><span className="customer-avatar">{source.customer.name.slice(0, 1)}</span><div><h2>{source.customer.name}</h2><p>{source.customer.address ?? t('addressMissing')}</p><p>{[source.customer.city, source.customer.province, source.customer.postalCode, source.customer.country].filter(Boolean).join(', ') || t('cityCountryMissing')}</p></div></div>


      <dl className="detail-grid"><div><dt>{t('contactPerson')}</dt><dd>{source.customer.contact ?? t('notProvided')}</dd></div><div><dt>{t('telephone')}</dt><dd>{source.customer.phones.length ? source.customer.phones.join(' / ') : t('notProvided')}</dd></div><div><dt>{t('email')}</dt><dd>{source.customer.email ?? t('notProvided')}</dd></div><div><dt>{t('salesOrdersPicking')}</dt><dd>{sourceOrders(source).map((order) => order.name).join(', ')}</dd></div><div><dt>{t('service')}</dt><dd>{source.serviceType === null ? t('notProvided') : sourceServiceLabel(source.serviceType, locale)}</dd></div><div><dt>{timeText('sourceTotal')}</dt><dd>{source.estimatedMinutes ? t('minutes', { count: source.estimatedMinutes }) : t('notProvided')}</dd></div><div><dt>{t('sourceState')}</dt><dd>{sourceStateLabel(source.sourceState, locale)} {t('sourceStateNote')}</dd></div></dl>{source.notes ? <p className="source-note">{source.notes}</p> : null}
      <DeliveryGeocoding key={delivery.id} deliveryId={delivery.id} revision={locationRevision} onChanged={refresh} />
      <div className="mt-3"><EntranceReviewAction deliveryId={delivery.id} onSaved={refresh} onLocated={refresh} /></div></DeliveryDetailCard>
    <DeliveryProductLines detail={detail} saveService={(update) => command('/services', update, 'PATCH')} saveWorkTimes={(update) => command('/work-times', update, 'PATCH')} savePriorWork={(update) => command('/prior-work', update, 'PATCH')} applyTimeStandard={(update) => command('/work-times/standard', update)}
      saveWorkQuantities={(update) => command('/work-quantities', update, 'PATCH')} />
    {detail.remainingWorkEstimate ? <DeliveryWorkEstimate delivery={delivery} estimate={detail.remainingWorkEstimate} save={(update) => command('/work-time-adjustments', update, 'PATCH')} /> : null}
    <DeliveryDetailCard title={t('accessInstructions')} icon="instructions" badge={t('backofficeOwned')}><ActionForm dataVersion={delivery.version} submitLabel={t('saveInstructions')} onSubmit={async (data) => {
      const floorText = textField(data, 'floor');
      const floor = floorText === '' ? null : z.coerce.number().int().min(-10).max(200).parse(floorText);
      return command('/instructions', { version: delivery.version, floor, elevator: z.enum(['unknown', 'yes', 'no']).parse(textField(data, 'elevator')), access: optionalText(data, 'access'), parking: optionalText(data, 'parking'), restrictions: optionalText(data, 'restrictions'), notes: optionalText(data, 'notes') }, 'PATCH');
    }}><div className="form-grid"><Field label={t('floor')} hint={t('floorHint')}><Input name="floor" type="number" min={-10} max={200} defaultValue={delivery.instructions.floor ?? ''} /></Field><Field label={t('elevator')}><Combobox name="elevator" defaultValue={delivery.instructions.elevator}><option value="unknown">{t('unknown')}</option><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option></Combobox></Field><Field label={t('access')}><Input name="access" defaultValue={delivery.instructions.access ?? ''} /></Field><Field label={t('parking')}><Input name="parking" defaultValue={delivery.instructions.parking ?? ''} /></Field></div><Field label={t('restrictions')}><Input name="restrictions" defaultValue={delivery.instructions.restrictions ?? ''} /></Field><Field label={t('localNotes')}><textarea name="notes" rows={3} defaultValue={delivery.instructions.notes ?? ''} /></Field></ActionForm></DeliveryDetailCard>
  </>;
}

function Visits({ detail, crews, templates, skills, vehicles, refreshKey, command }: { detail: DeliveryDetail; crews: Crew[]; templates: TaskTemplate[]; skills: Skill[]; vehicles: Vehicle[]; refreshKey: number; command: Command }) {
  const t = useTranslations('delivery');
  const delivery = detail.delivery;
  const bookedVisits = delivery.appointments.map((appointment, index) => ({ appointment, index })).filter(({ appointment }) => appointment.status === 'booked');
  return <>
    <InProgressVisitResponsibility detail={detail} command={command} />
    <DeliveryDetailCard title={t('visitsCrews')} icon="calendar" badge={t('bookedCount', { count: bookedVisits.length })}><p className="muted small">{t('schedulingHint')}</p></DeliveryDetailCard>
    {bookedVisits.length === 0 ? <Empty title={t('noBooked')}>{t('noBookedHint')}</Empty> : bookedVisits.map(({ appointment, index }) => <Visit key={appointment.id} detail={detail} appointment={appointment} index={index} crews={crews} templates={templates} skills={skills} vehicles={vehicles} refreshKey={refreshKey} command={command} />)}
    <AppointmentBookingForm delivery={delivery} lineServices={detail.lineServices} command={command} />
  </>;
}

function VisitAssignments({ appointment, crews }: { appointment: Appointment; crews?: Crew[] }) {
  const t = useTranslations('delivery');
  if (appointment.assignments.length === 0) return <p className="muted">{t('noCrew')}</p>;

  return appointment.assignments.map((assignment) => <div className="assignment" key={assignment.id}>
    <h4>
      <DetailIcon name="crew" className="text-info-foreground" />{assignment.crewName}
      {crews?.find((crew) => crew.id === assignment.crewId)?.enabled === false ? <span className="badge warning">{t('disabledReview')}</span> : null}
    </h4>
    <p className="muted small">{t('assignedPeople', { people: assignment.people.map((person) => person.external ? t('externalName', { name: person.name }) : person.name).join(', ') })}</p>
    {assignment.tasks.slice().sort((left, right) => left.order - right.order).map((task) => <div className="task" key={task.id}>
      <div className="card-topline">
        <strong>{task.title}</strong>
        <span className={task.severity === 'high' ? 'badge warning' : 'badge neutral'}>{t('taskSeverityOrder', { severity: deliveryStatusLabel(t, task.severity), order: task.order })}</span>
      </div>
      <RecordedSkillBadges skills={task.requiredSkillsSnapshot} />
      <ul className="task-checklist">
        {task.checklist.map((checkpoint) => <li key={checkpoint.id}>
          <span className={checkpoint.done || checkpoint.waiver ? 'check done' : 'check'} aria-label={checkpoint.done ? t('checkpointCompleted') : checkpoint.waiver ? t('checkpointWaived') : t('checkpointPending')}>{checkpoint.done ? '✓' : checkpoint.waiver ? '−' : ''}</span>
          <div>{checkpoint.label}{checkpoint.waiver ? <small className="cell-sub">{t('waivedReason', { reason: checkpoint.waiver.reason })}</small> : null}</div>
        </li>)}
      </ul>
    </div>)}
  </div>);
}

function VisitResponsibleForm({ appointment, version, command }: { appointment: Appointment; version: number; command: Command }) {
  const t = useTranslations('delivery');
  const candidates = new Map(appointment.assignments.flatMap((assignment) => assignment.people.map((person) =>
    [person.id, { name: person.name, crewName: assignment.crewName }] as const)));
  if (candidates.size === 0) return null;

  const current = appointment.responsibleParticipant;
  const onlyCandidate = candidates.size === 1 ? candidates.keys().next().value : undefined;

  return <DeliveryDetailCard title={t('visitResultResponsibility')} icon="customer" tone={current ? 'success' : 'warning'}>

    {current ? <p>{t('currentVisitResponsible', { name: current.name })}</p> : null}
    <ActionForm dataVersion={version} submitLabel={t('saveVisitResponsible')} successMessage={t('visitResponsibleSaved')} secondary onSubmit={(data) =>
      command(`/appointments/${appointment.id}/responsible`, { version, participantId: z.uuid().parse(textField(data, 'participantId')) }, 'PATCH')}>
      <Field label={t('chooseVisitResponsible')} hint={t('visitResponsibleHint')}>
        <Combobox name="participantId" required defaultValue={current?.id ?? onlyCandidate ?? ''}>
          <option value="" disabled>{t('selectVisitParticipant')}</option>
          {Array.from(candidates, ([id, person]) => <option value={id} key={id}>{person.name} · {person.crewName}</option>)}
        </Combobox>
      </Field>
    </ActionForm>
  </DeliveryDetailCard>;
}

function Visit({ detail, appointment, index, crews, templates, skills, vehicles, refreshKey, command }: { detail: DeliveryDetail; appointment: Appointment; index: number; crews: Crew[]; templates: TaskTemplate[]; skills: Skill[]; vehicles: Vehicle[]; refreshKey: number; command: Command }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const schedulingTrigger = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const delivery = detail.delivery;
  const active = appointment.status === 'booked';
  return <article id={`visit-${appointment.id}`} tabIndex={-1} className="visit-card visit-planning-card scroll-mt-4"><div className="section-title"><DetailHeading icon="calendar">{t('visitNumber', { number: index + 1 })}{appointment.returnRequestId ? ` ${t('returnVisitSuffix')}` : ''}</DetailHeading><span className={appointment.status === 'completed' ? 'badge success' : 'badge info'}>{deliveryStatusLabel(t, appointment.status)}</span></div><p className="visit-time"><DetailIcon name="clock" />{formatDateTime(appointment.startsAt, locale)}<span>→ {formatDateTime(appointment.endsAt, locale)}</span></p>{appointment.cancellationReason ? <Notice>{t('cancellationText', { reason: appointment.cancellationReason })}</Notice> : null}
    <VisitWorkEditor detail={detail} appointment={appointment} planning={detail.appointmentPlanning?.find((entry) => entry.appointmentId === appointment.id)} command={command} />
    <DeliveryDetailCard title={t('crews')} icon="crew" badge={appointment.assignments.length}><VisitAssignments appointment={appointment} crews={crews} />
    {active && !delivery.completedAt ? <><button ref={schedulingTrigger} className="text-button scheduling-trigger" aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing((value) => !value)}>{editing ? t('hideScheduling') : t('manageScheduling')}</button><Dialog open={editing} onOpenChange={setEditing}><DialogContent id={editorId} className="dialog visit-editor visit-scheduling-dialog" aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); schedulingTrigger.current?.focus(); }}><div className="section-title"><DialogTitle asChild><h2>{t('assignSnapshots')}</h2></DialogTitle><button type="button" className="icon-button" aria-label={t('hideScheduling')} onClick={() => setEditing(false)}>×</button></div><InitialAssignmentForm deliveryId={delivery.id} version={delivery.version} appointment={appointment} crews={crews} templates={templates} skills={skills} refreshKey={refreshKey} command={command} onAssigned={() => { setEditing(false); schedulingTrigger.current?.focus(); }} /><details className="section-gap"><summary>{t('reschedule')}</summary>{appointment.transportAllocations?.some((allocation) => allocation.status === 'active') ? <Notice>{t('rescheduleTransport')}</Notice> : null}<ActionForm dataVersion={delivery.version} submitLabel={t('saveNewTime')} submitDisabled={appointment.transportAllocations?.some((allocation) => allocation.status === 'active')} onSubmit={async (data) => command(`/appointments/${appointment.id}`, { version: delivery.version, startsAt: dateTimeField(data, 'startsAt', t), endsAt: dateTimeField(data, 'endsAt', t) }, 'PATCH')}><DateTimeFields startsAt={appointment.startsAt} endsAt={appointment.endsAt} /></ActionForm></details><details className="section-gap"><summary>{t('cancelThisVisit')}</summary><ActionForm dataVersion={delivery.version} submitLabel={t('cancelVisit')} secondary onSubmit={async (data) => command(`/appointments/${appointment.id}/cancel`, { version: delivery.version, reason: textField(data, 'reason') })}><Field label={t('cancellationReason')}><Input name="reason" required /></Field></ActionForm></details></DialogContent></Dialog></> : null}
</DeliveryDetailCard>
    {!delivery.completedAt ? <VisitResponsibleForm appointment={appointment} version={delivery.version} command={command} /> : null}
    <VisitCustomerConfirmation
      appointment={appointment}
      onConfirm={active && !delivery.completedAt ? () => command(`/appointments/${appointment.id}/confirm-customer`, { version: delivery.version }) : undefined}
    />
    <VisitTransport deliveryId={delivery.id} version={delivery.version} appointment={appointment} vehicles={vehicles} closed={delivery.completedAt !== null} refreshKey={refreshKey} command={command} />
    {appointment.results.map((result) => <ResultCard key={result.id} result={result} deliveryId={delivery.id} superseded={appointment.results.some((candidate) => candidate.supersedesResultId === result.id)} />)}
    {appointment.status !== 'completed' && appointment.status !== 'cancelled' && !delivery.completedAt ? <WaiverForm delivery={delivery} appointment={appointment} command={command} /> : null}

  </article>;
}

function VisitCustomerConfirmation({ appointment, onConfirm }: { appointment: Appointment; onConfirm?: () => Promise<number> }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const confirmation = appointment.customerConfirmation;
  const state = confirmation ? 'customerConfirmed' : visitConfirmationState(appointment, appointment.assignments.length > 0);
  if (!state) return null;

  return <DeliveryDetailCard title={t('visitCustomerConfirmation')} icon="check" tone={confirmation ? 'success' : 'warning'}>
    <div className="flex flex-wrap items-center gap-2">

      <span role="status"><VisitConfirmationBadge state={state} /></span>
    </div>
    {confirmation ? (
      <p className="small muted mt-2">{t('recordedBy', { name: confirmation.confirmedBy.name, date: formatDateTime(confirmation.confirmedAt, locale) })}</p>
    ) : onConfirm ? (
      <ActionForm submitLabel={t('recordCustomerConfirmation')} secondary onSubmit={onConfirm}>
        <p className="small muted">{t('recordCustomerConfirmationHint')}</p>
      </ActionForm>
    ) : null}
  </DeliveryDetailCard>;
}

type VisitResult = Appointment['results'][number];

function SignatureReadout({ signature }: { signature: VisitResult['customerSignature'] }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  if (!signature) return <span>{t('missing')}</span>;
  if (signature.status === 'signed') return <span className="block min-w-0">
    {'capture' in signature ? <svg
      role="img"
      aria-label={t('drawnSignatureLabel', { name: signature.signerName })}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      className="mb-2 block aspect-[2/1] w-full max-w-72 rounded-md border border-border bg-background text-foreground"
    >
      {signature.strokes.map((stroke, index) => {
        const first = stroke[0];
        if (!first) return null;
        if (stroke.length === 1) return <circle key={index} cx={first.x} cy={first.y} r={6} fill="currentColor" />;
        const points = stroke.map(({ x, y }) => `${x},${y}`).join(' ');
        return <polyline key={index} points={points} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
      })}
    </svg> : signature.text}
    <small className="cell-sub">{signature.signerName} · {formatDateTime(signature.at, locale)}</small>
  </span>;
  return <span>{deliveryStatusLabel(t, signature.status)}: {signature.reason}{signature.status === 'refused' ? ` · ${signature.signerName}` : ''}<small className="cell-sub">{formatDateTime(signature.at, locale)}</small></span>;
}

function ResultCard({ result, deliveryId, superseded, review, reviewAction }: {
  result: VisitResult; deliveryId: string; superseded: boolean; review?: Appointment['signatureRefusalReview'];
  reviewAction?: { version: number; save: (body: unknown) => Promise<number> };
}) {
  const t = useTranslations('delivery');
  const refusalText = useTranslations('signatureRefusal');
  const locale = useLocale();
  const format = useFormatter();
  return <div id={`result-${result.id}`} tabIndex={-1} className="scroll-mt-4"><DeliveryDetailCard className="result-card" title={t('receivedResult')} icon="file" tone={superseded ? 'neutral' : 'info'} badge={<>{superseded ? t('superseded') : t('currentResult')} · {result.source === 'crew_frontoffice' ? t('crewAppResult') : 'DEMO'}</>}><p>{result.summary}</p>{result.correctionReason ? <Notice>{t('correction', { reason: result.correctionReason })}</Notice> : null}<dl className="detail-grid"><div><dt>{t('actualWork')}</dt><dd>{formatDateTime(result.actualStart, locale)} → {formatDateTime(result.actualEnd, locale)}</dd></div><div><dt>{t(result.source === 'crew_frontoffice' ? 'resultSubmittedBy' : 'recordedCrew')}</dt><dd>{result.actor.name}</dd></div><div><dt>{t('customerSignature')}</dt><dd>{result.signatureRefusal ? refusalText('customerRefused') : <SignatureReadout signature={result.customerSignature} />}</dd></div><div><dt>{t('crewSignature')}</dt><dd><SignatureReadout signature={result.crewSignature} /></dd></div></dl>{result.signatureRefusal ? <SignatureRefusalReview result={result} refusal={result.signatureRefusal} review={review} reviewAction={reviewAction} /> : null}<VisitWorkSnapshot scope={result.workScopeSnapshot} source={result.sourceSnapshot} historical />{result.source === 'crew_frontoffice' || result.workScopeSnapshot ? <DeliveryResultWork result={result} /> : null}<details><summary>{t('resultSnapshot')}</summary><p>{result.sourceSnapshot.customer.name} · {result.sourceSnapshot.customer.address ?? t('noAddress')}</p><p className="small">{t('salesOrdersList', { orders: sourceOrders(result.sourceSnapshot).map((order) => order.name).join(', ') })}</p><ul>{result.sourceSnapshot.items.map((item) => <li key={item.sourceLineId}>{sourceLineLabel(result.sourceSnapshot, item, locale)} · {format.number(item.quantity)} {item.uom}</li>)}</ul><dl className="detail-grid"><div><dt>{t('floorElevator')}</dt><dd>{result.instructionsSnapshot.floor ?? t('unknown')} / {deliveryStatusLabel(t, result.instructionsSnapshot.elevator)}</dd></div><div><dt>{t('accessParking')}</dt><dd>{result.instructionsSnapshot.access ?? t('unknown')} / {result.instructionsSnapshot.parking ?? t('unknown')}</dd></div><div><dt>{t('restrictions')}</dt><dd>{result.instructionsSnapshot.restrictions ?? t('notProvided')}</dd></div><div><dt>{t('instructions')}</dt><dd>{result.instructionsSnapshot.notes ?? t('notProvided')}</dd></div></dl>{result.assignmentsSnapshot.map((assignment) => <div key={assignment.id}><strong>{assignment.crewName}</strong><p className="small muted">{assignment.people.map((person) => person.name).join(', ')}</p><ul className="small">{assignment.tasks.map((task) => <li key={task.id}>{task.title}{task.requiredSkillsSnapshot?.length ? ` · ${t('requiredSkills', { skills: task.requiredSkillsSnapshot.map((skill) => skill.name).join(', ') })}` : ''} · {t('taskOrder', { severity: deliveryStatusLabel(t, task.severity), order: task.order })} · {task.checklist.map((checkpoint) => `${checkpoint.label}: ${checkpoint.done ? t('checklistDone') : checkpoint.waiver ? t('checklistWaived', { reason: checkpoint.waiver.reason }) : t('checklistPending')}`).join('; ')}</li>)}</ul></div>)}{result.transportSnapshot ? <TransportReadout allocations={result.transportSnapshot} title={t('resultTransport')} /> : <p className="small muted">{t('noResultTransport')}</p>}<p className="small muted">{t('snapshotHint')}</p></details><ResultIssueLinks result={result} /><DeliveryResultEvidence result={result} deliveryId={deliveryId} /><DeliveryResultDocuments result={result} deliveryId={deliveryId} /></DeliveryDetailCard></div>;
}

function WaiverForm({ delivery, appointment, command }: { delivery: Delivery; appointment: Appointment; command: Command }) {
  const t = useTranslations('delivery');
  const pending = appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.filter((checkpoint) => !checkpoint.done && !checkpoint.waiver).map((checkpoint) => ({ ...checkpoint, crewName: assignment.crewName, taskTitle: task.title }))));
  if (pending.length === 0) return null;
  return <details className="section-gap"><summary>{t('waiveCheckpoint')}</summary><p className="small muted">{t('waiverHint')}</p><ActionForm dataVersion={delivery.version} submitLabel={t('recordWaiver')} secondary onSubmit={async (data) => command(`/appointments/${appointment.id}/checklist/${textField(data, 'checkpointId')}/waive`, { version: delivery.version, reason: textField(data, 'reason') })}><Field label={t('checkpoint')}><Combobox name="checkpointId" required>{pending.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.crewName} · {checkpoint.taskTitle} · {checkpoint.label}</option>)}</Combobox></Field><Field label={t('reason')}><textarea name="reason" rows={2} required maxLength={2000} /></Field></ActionForm></details>;
}

function Issues({ delivery, files, command }: { delivery: Delivery; files: DeliveryDetail['files']; command: Command }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const workedVisits = delivery.appointments.filter((visit) => visit.status === 'completed' && visit.results.length > 0);
  const openIssues = delivery.issues.filter((issue) => issue.status === 'open').length;
  return <>
    <DeliveryDetailCard title={t('issues')} icon="alert" tone={openIssues ? 'warning' : 'neutral'} badge={t('openCount', { count: openIssues })}>
    {delivery.issues.length > 0 && openIssues === 0 ? <Notice tone="success">{t('allIssuesResolved')}</Notice> : null}
    <DeliveryWorkReadiness delivery={delivery} release={async (sourceLineId, note) => command(`/work-readiness/${sourceLineId}`, { version: delivery.version, note }, 'PATCH')} />
    {delivery.issues.length === 0 ? <Empty title={t('noIssues')} /> : delivery.issues.map((issue) => <IssueCard key={issue.id} issue={issue} delivery={delivery} files={files} command={command} />)}
    {!delivery.completedAt ? <details className="section-gap"><summary>{t('registerIssue')}</summary>
      <ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('createIssue')} onSubmit={async (data) => command('/issues', {
        version: delivery.version, type: z.enum(['damage', 'missing_parts', 'access', 'other']).parse(textField(data, 'type')),
        description: textField(data, 'description'), notes: optionalText(data, 'notes'),
        itemIds: data.getAll('itemIds').map((value) => z.coerce.number().int().positive().parse(value)),
      })}>
        <Field label={t('issueType')}><Combobox name="type"><option value="damage">{t('damage')}</option><option value="missing_parts">{t('missingParts')}</option><option value="access">{t('access')}</option><option value="other">{t('other')}</option></Combobox></Field>
        <Field label={t('description')}><textarea name="description" rows={3} required /></Field>
        <Field label={t('notes')}><textarea name="notes" rows={2} maxLength={4000} /></Field>
        <ChoiceGroup label={t('relatedProducts')}><div className="choice-list">{delivery.source.items.map((item) => <label className="checkbox-label" key={item.sourceLineId}><Input name="itemIds" type="checkbox" value={item.sourceLineId} />{sourceLineLabel(delivery.source, item, locale)}</label>)}</div></ChoiceGroup>
        <p className="small muted">{t('issueAuthorship')}</p>
      </ActionForm>
    </details> : null}
    </DeliveryDetailCard><DeliveryDetailCard title={t('returnRequests')} icon="calendar" tone="warning" badge={t('openCount', { count: delivery.returnRequests.filter((request) => request.status !== 'resolved').length })}>

      {delivery.returnRequests.length === 0 ? <p className="muted">{t('noReturn')}</p> : delivery.returnRequests.map((request) => <ReturnCard key={request.id} request={request} delivery={delivery} files={files} command={command} />)}
      {!delivery.completedAt && workedVisits.length > 0 ? <details className="section-gap"><summary>{t('requestReturn')}</summary>
        <ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('createReturn')} onSubmit={async (data) => command('/returns', { version: delivery.version, appointmentId: textField(data, 'appointmentId'), reason: textField(data, 'reason'), remainingWork: textField(data, 'remainingWork'), notes: optionalText(data, 'notes') })}>
          <Field label={t('originVisit')}><Combobox name="appointmentId" required>{workedVisits.map((visit) => <option key={visit.id} value={visit.id}>{t('visitNumber', { number: delivery.appointments.findIndex((candidate) => candidate.id === visit.id) + 1 })} · {formatDateTime(visit.startsAt, locale)}</option>)}</Combobox></Field>
          <Field label={t('reason')}><Input name="reason" required /></Field><Field label={t('remainingWork')}><textarea name="remainingWork" required rows={3} /></Field><Field label={t('notes')}><textarea name="notes" rows={2} maxLength={4000} /></Field>
        </ActionForm>
      </details> : !delivery.completedAt ? <Notice>{t('returnNeedsCompleted')}</Notice> : null}
    </DeliveryDetailCard>
  </>;
}

function PhotoLinks({ ids, files, deliveryId }: { ids: string[]; files: DeliveryDetail['files']; deliveryId: string }) {
  const t = useTranslations('delivery');
  if (ids.length === 0) return null;
  return <ul className="my-3 list-disc pl-5 text-xs">{ids.map((id) => {
    const file = files.find((entry) => entry.id === id);
    return <li key={id}>{file?.status === 'ready' ? <a className="underline underline-offset-4" href={`${API_URL}/deliveries/${deliveryId}/files/${id}`} target="_blank" rel="noreferrer">{file.name} ↗</a> : <span className="muted">{t('photoUnavailable', { status: deliveryStatusLabel(t, file?.status ?? 'missing') })}</span>}</li>;
  })}</ul>;
}

function IssueCard({ issue, delivery, files, command }: { issue: Delivery['issues'][number]; delivery: Delivery; files: DeliveryDetail['files']; command: Command }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  return <article id={`issue-${issue.id}`} tabIndex={-1} className="inset-card section-gap scroll-mt-4">
    <div className="section-title"><h4>{deliveryStatusLabel(t, issue.type)}</h4><span className={issue.status === 'open' ? 'badge danger' : 'badge success'}>{deliveryStatusLabel(t, issue.status)}</span></div>
    <p>{issue.description}</p><p className="small muted">{issue.authorName} · {deliveryStatusLabel(t, issue.source)} · {formatDateTime(issue.createdAt, locale)}</p>
    {issue.appointmentId ? <p className="small muted">{t('visitNumber', { number: delivery.appointments.findIndex((visit) => visit.id === issue.appointmentId) + 1 })}</p> : null}
    {issue.itemIds.length > 0 ? <ul className="my-2 grid gap-1 text-xs">{issue.itemIds.map((sourceLineId) => { const item = delivery.source.items.find((line) => line.sourceLineId === sourceLineId); return <li key={sourceLineId}>{item ? sourceLineLabel(delivery.source, item, locale) : t('productLineId', { id: sourceLineId })}</li>; })}</ul> : null}
    {issue.notes ? <p className="small">{t('notesText', { notes: issue.notes })}</p> : <p className="small muted">{t('noNotes')}</p>}
    <PhotoLinks ids={issue.photoIds} files={files} deliveryId={delivery.id} />
    {issue.status === 'resolved' && issue.resolution ? <Notice tone="success">{t('resolutionText', { resolution: issue.resolution })}</Notice> : null}
    {issue.status === 'open' && !delivery.completedAt ? <ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('resolveIssue')} secondary onSubmit={async (data) => command(`/issues/${issue.id}/resolve`, { version: delivery.version, resolution: textField(data, 'resolution') })}><Field label={t('resolution')}><textarea name="resolution" required rows={2} /></Field></ActionForm> : null}
    {!delivery.completedAt ? <details className="section-gap"><summary>{t('editIssueNotes')}</summary><ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('saveIssueNotes')} secondary onSubmit={async (data) => command(`/issues/${issue.id}/notes`, { version: delivery.version, notes: optionalText(data, 'notes') }, 'PATCH')}><Field label={t('notes')}><textarea name="notes" rows={2} maxLength={4000} defaultValue={issue.notes ?? ''} /></Field></ActionForm></details> : null}
  </article>;
}

function ReturnCard({ request, delivery, files, command }: { request: Delivery['returnRequests'][number]; delivery: Delivery; files: DeliveryDetail['files']; command: Command }) {
  const t = useTranslations('delivery');
  const photos = files.filter((file) => file.status === 'ready' && file.mime.startsWith('image/'));
  return <article className="inset-card section-gap">
    <div className="section-title"><h4>{request.reason}</h4><span className={request.status === 'resolved' ? 'badge success' : 'badge warning'}>{deliveryStatusLabel(t, request.status)}</span></div>
    <p>{request.remainingWork}</p><p className="small muted">{t('originVisitNumber', { number: delivery.appointments.findIndex((visit) => visit.id === request.originAppointmentId) + 1 })}{request.appointmentId ? ` · ${t('linkedVisit', { number: delivery.appointments.findIndex((visit) => visit.id === request.appointmentId) + 1 })}` : ` · ${t('visitNotBooked')}`}</p>
    {request.notes ? <p className="small">{t('notesText', { notes: request.notes })}</p> : <p className="small muted">{t('noNotes')}</p>}
    <PhotoLinks ids={request.photoIds} files={files} deliveryId={delivery.id} />
    {request.status === 'resolved' && request.resolution ? <Notice tone="success">{request.resolution}</Notice> : null}
    {request.status !== 'resolved' ? <><Notice>{t('returnResolutionHint')}</Notice>{!delivery.completedAt ? <ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('resolveReturn')} secondary onSubmit={async (data) => command(`/returns/${request.id}/resolve`, { version: delivery.version, resolution: textField(data, 'resolution') })}><Field label={t('resolution')}><Input name="resolution" required /></Field></ActionForm> : null}</> : null}
    {!delivery.completedAt ? <details className="section-gap"><summary>{t('editReturn')}</summary><ActionForm dataVersion={delivery.version} followLatestWhenUntouched submitLabel={t('saveReturn')} secondary onSubmit={async (data) => command(`/returns/${request.id}/notes`, { version: delivery.version, notes: optionalText(data, 'notes'), photoIds: z.array(z.uuid()).parse(data.getAll('photoIds')) }, 'PATCH')}>
      <Field label={t('notes')}><textarea name="notes" rows={2} maxLength={4000} defaultValue={request.notes ?? ''} /></Field>
      <ChoiceGroup label={t('relatedPhotos')}>{photos.length ? <div className="choice-list">{photos.map((file) => <label className="checkbox-label" key={file.id}><Input type="checkbox" name="photoIds" value={file.id} defaultChecked={request.photoIds.includes(file.id)} />{file.name}</label>)}</div> : <p className="small muted">{t('uploadPhotoFirst')}</p>}</ChoiceGroup>
    </ActionForm></details> : null}
  </article>;
}
function History({ detail, command }: { detail: DeliveryDetail; command: Command }) {
  const t = useTranslations('delivery');
  const refusalText = useTranslations('signatureRefusal');
  const workText = useTranslations('workPlan');
  const priorText = useTranslations('priorWork');
  const quantityText = useTranslations('workQuantities');
  const sourceText = useTranslations('sourceReview');
  const adjustmentText = useTranslations('workTimeAdjustments');
  const locale = useLocale();
  const recordedVisits = detail.delivery.appointments.map((appointment, index) => ({ appointment, index })).filter(({ appointment }) => appointment.status === 'in_progress' || appointment.workScope || appointment.failedAttempt || appointment.customerConfirmation || appointment.results.length > 0 || (appointment.transportAllocations?.length ?? 0) > 0);
  return <>
    <DeliveryDetailCard title={t('deliveryHistory')} icon="history" tone="neutral" badge={t('eventCount', { count: detail.history.length })}>
    {detail.history.length === 0 ? <Empty title={t('noEvents')} /> : <ol className="history-list">{detail.history.map((event) => {
      const sourceAction = sourceReviewAuditKey(event.action);
      if (event.action === 'work_quantities.updated') return <li key={event.id}>
        <span className="history-dot" /><div><h4>{quantityText('historyTitle')}</h4><p>{event.actorName} · {formatDateTime(event.at, locale)}</p>
          <WorkQuantitiesHistory details={event.details} /><details><summary>{t('eventDetails')}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details></div>
      </li>;
      const title = sourceAction ? sourceText(sourceAction) : event.action === 'prior_work.confirmed' ? priorText('historyTitle')
        : event.action === 'work_times.adjustments_updated' ? adjustmentText('historyTitle')
        : event.action === 'appointment.work_scope_updated' ? workText('auditScope')
        : event.action === 'execution.signature_refusal_reviewed' ? refusalText('audit') : deliveryAuditLabel(t, event.action);
      return <li key={event.id}><span className="history-dot" /><div><h4>{title}</h4><p>{event.actorName} · {formatDateTime(event.at, locale)}</p>{sourceAction ? <SourceReviewHistory details={event.details} /> : event.action === 'prior_work.confirmed' ? <PriorWorkHistory details={event.details} /> : event.action === 'work_times.standard_applied' ? <TimeStandardHistory details={event.details} /> : event.action === 'work_times.adjustments_updated' ? <WorkTimeAdjustmentsHistory details={event.details} /> : null}<details><summary>{t('eventDetails')}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details></div></li>;
    })}</ol>}
    </DeliveryDetailCard><DeliveryWorkReadiness delivery={detail.delivery} />
    {recordedVisits.length > 0 ? <DeliveryDetailCard title={t('recordedVisits')} icon="calendar" badge={recordedVisits.length}>

      {recordedVisits.map(({ appointment, index }) => <article id={`visit-${appointment.id}`} tabIndex={-1} className="inset-card section-gap scroll-mt-4" key={appointment.id}>
        <h4>{t('visitNumber', { number: index + 1 })}{appointment.failedAttempt ? null : ` · ${deliveryStatusLabel(t, appointment.status)}`}</h4>
        <p className="small muted">{formatDateTime(appointment.startsAt, locale)} → {formatDateTime(appointment.endsAt, locale)}</p>
        {appointment.failedAttempt ? <div className="my-3 rounded-md border border-border bg-muted/30 p-3">
          <span className="badge warning">{t('customerAbsent')}</span>
          <dl className="mt-2">
            <dt className="small muted">{t('reason')}</dt>
            <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{appointment.failedAttempt.reason}</dd>
          </dl>
          <p className="small muted mt-2">{appointment.failedAttempt.actor.name} · <time dateTime={appointment.failedAttempt.at}>{formatDateTime(appointment.failedAttempt.at, locale)}</time></p>
        </div> : null}
        <VisitWorkSnapshot scope={appointment.workScope} source={detail.delivery.source} historical />
        {appointment.customerConfirmation ? <VisitCustomerConfirmation appointment={appointment} /> : null}
        {appointment.responsibleParticipant ? <p>{t('currentVisitResponsible', { name: appointment.responsibleParticipant.name })}</p> : null}
        {appointment.status === 'in_progress' ? <VisitAssignments appointment={appointment} /> : null}
        {appointment.transportAllocations ? <TransportReadout allocations={appointment.transportAllocations} /> : null}
        {appointment.results.map((result) => {
          const superseded = appointment.results.some((candidate) => candidate.supersedesResultId === result.id);
          const review = appointment.signatureRefusalReview?.resultId === result.id ? appointment.signatureRefusalReview : undefined;
          const reviewAction = result.signatureRefusal && !superseded && !review && !detail.delivery.completedAt ? {
            version: detail.delivery.version,
            save: (body: unknown) => command(`/appointments/${appointment.id}/results/${result.id}/signature-refusal-review`, body),
          } : undefined;
          return <ResultCard key={result.id} result={result} deliveryId={detail.delivery.id} superseded={superseded} review={review} reviewAction={reviewAction} />;
        })}
      </article>)}
    </DeliveryDetailCard> : null}
    {detail.delivery.completions.length > 0 ? <DeliveryDetailCard title={t('completionRecords')} icon="shield" tone="success" badge={detail.delivery.completions.length}>{detail.delivery.completions.map((completion) => <article key={completion.id} className="inset-card"><h4>{t('completedAt', { date: formatDateTime(completion.at, locale) })}</h4><p className="small">{completion.actorName} · {t('resultCount', { count: completion.resultIds.length })}</p>{completion.reopenedAt ? <Notice>{t('reopenedAt', { date: formatDateTime(completion.reopenedAt, locale), reason: completion.reopenReason ?? '' })}</Notice> : null}<details><summary>{t('sourceSnapshot')}</summary><p>{completion.sourceSnapshot.customer.name} · {completion.sourceSnapshot.customer.address}</p></details></article>)}</DeliveryDetailCard> : null}
  </>;
}






