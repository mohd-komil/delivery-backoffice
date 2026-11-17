'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { getVisit } from '@/shared/api/client';
import type { VisitDetail } from '@/shared/api/contracts';
import { useCrewResource } from '@/shared/api/use-resource';
import { formatLocale } from '@/shared/i18n/config';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { destinationLabel, formatVisitDate, formatVisitWindow } from '@/shared/lib/visit-display';
import { Button } from '@/shared/ui/button';
import { Loading, Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { RefreshButton, ResourceError } from '@/shared/ui/resource-feedback';
import { VisitStatus } from '@/shared/ui/visit-status';
import { startVisit, updateChecklist } from '../api/commands';
import { useVisitActions, type VisitActions } from '../model/actions';
import { quantityFields } from '../model/quantity';
import { AttemptFailureForm, AttemptFailureResult } from './attempt-failure';
import { VisitFinishResult } from './finish-result';
import { IssueForm } from './issue-form';
import { WorkScopeNotice } from './work-scope-notice';
import { DocumentLinks } from './document-links';

function Section({ title, icon, children }: { title: string; icon: 'users' | 'note' | 'box' | 'list'; children: ReactNode }) {
  return <section className="panel detail-section">
    <h2><span className="section-icon"><Icon name={icon} size={17} /></span>{title}</h2>
    {children}
  </section>;
}

export function VisitActionBar({ visit, actions, onOpenReport }: { visit: VisitDetail; actions: VisitActions; onOpenReport: () => void }) {
  const t = useTranslations('crew');
  const routeText = useTranslations('routes');
  const reasonId = useId();
  const requestId = useRef<string | null>(null);
  if (visit.status !== 'booked' && visit.status !== 'in_progress') return null;

  const booked = visit.status === 'booked';
  const confirmed = visit.confirmationStatus === 'customer_confirmed';
  let blocker: string | null = null;
  if (visit.scopeReviewReason) blocker = t(visit.scopeReviewReason === 'stock_pending' ? 'scopeStockTitle' : 'scopeReviewTitle');
  else if (booked && visit.routeStartBlocker) blocker = routeText(routeBlockerLabel(visit.routeStartBlocker));
  else if (booked && !confirmed) blocker = t('awaitingDescription');
  else if (booked && !visit.canStart) blocker = t('actionUnavailable');
  else if (!booked) {
    if (!visit.responsibleParticipant) blocker = t('finishNoResponsible');
    else if (!visit.canFinish) blocker = t('visitReportOwner', { name: visit.responsibleParticipant.name });
  }

  function start() {
    if (blocker || actions.busy) return;
    const id = requestId.current ?? crypto.randomUUID();
    requestId.current = id;
    void actions.run('start', () => startVisit(visit.id, { version: visit.version, requestId: id }));
  }

  return <div className="visit-action-bar" data-visit-action-bar>
    {blocker ? <p id={reasonId} className="visit-action-bar-blocker"><Icon name="alert" size={17} />{blocker}</p> : null}
    <div className="visit-action-bar-controls">
      <Button id="visit-primary-action" disabled={blocker !== null || actions.busy !== null}
        aria-describedby={blocker ? reasonId : undefined} onClick={booked ? start : onOpenReport}>
        {booked ? t(actions.busy === 'start' ? 'startingVisit' : 'startVisit') : t('recordVisitResult')}
        <Icon name={booked ? 'arrowRight' : 'note'} size={17} />
      </Button>
    </div>
  </div>;
}

function PhoneLink({ phone }: { phone: string }) {
  const t = useTranslations('crew');
  const normalized = phone.replace(/[\s().-]/g, '');
  return /^\+?\d{3,20}$/.test(normalized)
    ? <a className="button button-secondary" href={`tel:${normalized}`} aria-label={t('callVisitContact', { phone })}>
      <Icon name="phone" size={16} />{phone}
    </a>
    : <span>{phone}</span>;
}

function VisitHeader({ visit }: { visit: VisitDetail }) {
  const t = useTranslations('crew');
  const routeText = useTranslations('routes');
  const locale = useLocale();
  const address = destinationLabel(visit.destination);
  const mapsUrl = new URL('https://www.google.com/maps/search/');
  mapsUrl.searchParams.set('api', '1');
  mapsUrl.searchParams.set('query', address);

  return <header className="panel visit-hero">
    <div className="visit-hero-reference">
      <span className="visit-reference">{visit.pickingName}</span>
      <VisitStatus visit={visit} />
    </div>
    <div className="visit-hero-destination">
      <h1>{visit.customer.name}</h1>
      <p><Icon name="pin" size={18} />{address || t('addressUnavailable')}</p>
      {visit.customer.contact && visit.customer.contact !== visit.customer.name ? <p><Icon name="users" size={17} />{visit.customer.contact}</p> : null}
    </div>
    <div className="visit-hero-time">
      <span className="section-icon"><Icon name="calendar" size={17} /></span>
      <div>
        <p>{formatVisitDate(visit.startsAt, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <p className="visit-time">{formatVisitWindow(visit, locale)} <span>· {t('localTime')}</span></p>
      </div>
    </div>
    {visit.destination.address || visit.customer.phones.length ? <ul className="visit-contact-actions">
      {visit.destination.address ? <li><a className="button button-secondary" href={mapsUrl.href} target="_blank" rel="noreferrer">
        <Icon name="external" size={16} />{t('directions')}
      </a></li> : null}
      {visit.customer.phones.map((phone, index) => <li key={`${index}-${phone}`}><PhoneLink phone={phone} /></li>)}
    </ul> : null}
    {visit.route ? <Link href={`/routes/${visit.route.id}`} prefetch={false} className="button button-ghost visit-hero-route">
      <Icon name="truck" size={17} />{routeText('routeLink', { name: visit.route.name })}<Icon name="arrowRight" size={16} />
    </Link> : null}
  </header>;
}

function VisitResources({ visit }: { visit: VisitDetail }) {
  const t = useTranslations('crew');

  return <Section title={t('crew')} icon="users">
    <p>{visit.crews.map((crew) => crew.name).join(', ')}</p>
    <div className="sub-section">
      <h3>{t('vehicle')}</h3>
      {visit.vehicles.length ? <ul className="plain-list">
        {visit.vehicles.map((vehicle) => <li key={vehicle.id}>{vehicle.name} <span className="plate">{vehicle.plate}</span></li>)}
      </ul> : <p className="text-muted">{t('vehicleUnassigned')}</p>}
    </div>
  </Section>;
}

function VisitInstructions({ instructions }: { instructions: VisitDetail['instructions'] }) {
  const t = useTranslations('crew');
  const entries = [
    [t('floor'), instructions.floor],
    [t('elevator'), instructions.elevator === 'unknown' ? null : t(instructions.elevator)],
    [t('access'), instructions.access],
    [t('parking'), instructions.parking],
    [t('restrictions'), instructions.restrictions],
    [t('notes'), instructions.notes],
  ].filter((entry) => entry[1] !== null && entry[1] !== '');
  if (!entries.length) return null;

  return <Section title={t('instructions')} icon="note">
    <dl className="detail-fields">
      {entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  </Section>;
}

const serviceLabels = {
  delivery_only: 'serviceDeliveryOnly',
  delivery_installation: 'serviceDeliveryInstallation',
  installation_only: 'serviceInstallationOnly',
  collection_only: 'serviceCollectionOnly',
} as const;

function VisitItems({ visit }: { visit: VisitDetail }) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const quantity = new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 3 });
  const documents = visit.documents ?? [];
  const headerDocuments = documents.filter((document) => document.itemId === null);

  return <>
    {headerDocuments.length > 0 ? <Section title={t('deliveryDocuments')} icon="note">
      <DocumentLinks visitId={visit.id} documents={headerDocuments} />
    </Section> : null}
    <Section title={t(visit.workScope ? 'workScopeTitle' : 'items')} icon="box">
      {visit.workScope ? <div className="mb-3 space-y-1">
        <p>{t('workScopeHint')}</p>
        <p className="text-muted">{t('scopeRevision', { revision: visit.workScope.revision })}</p>
      </div> : null}
      {visit.items.length ? <ul className="visit-item-list">
        {visit.items.map((item) => {
          const lineDocuments = documents.filter((document) => document.itemId === item.sourceLineId);
          return <li key={item.sourceLineId}>
            <div className="detail-list-head"><h3>{item.name}</h3><span className="quantity">{t('quantity', { value: `${quantity.format(item.quantity)} ${item.uom}` })}</span></div>
            {item.serviceWork ? <>
              <p className="detail-list-head">
                {item.orderName ? <span className="plate">{item.orderName}</span> : null}
                <span className="plate">{t('productLine', { line: item.sourceLineId })}</span>
                <span>{item.serviceWork.service ? t(serviceLabels[item.serviceWork.service]) : t('serviceUnknown')}</span>
              </p>
              {visit.workScope && quantityFields(item).every(({ planned }) => !planned) ? <p className="text-muted">{t('notPlannedThisVisit')}</p> : null}
              <dl className="detail-fields">
                {quantityFields(item).map(({ operation, remaining, planned }) => <div key={operation}>
                  <dt>{t(operation)}</dt>
                  <dd>{planned !== undefined ? <p className="font-medium">{t('plannedForVisit', { amount: quantity.format(planned / 1000), uom: item.uom })}</p> : null}
                    <p className="text-muted">{remaining > 0 ? t('workRemaining', { amount: quantity.format(remaining / 1000), uom: item.uom }) : t('completed')}</p></dd>
                </div>)}
              </dl>
            </> : null}
            {item.configuration ? <p>{item.configuration}</p> : null}
            {item.notes ? <p>{item.notes}</p> : null}
            {lineDocuments.length > 0 ? <div className="pt-1"><h4 className="field-label">{t('productDocuments')}</h4>
              <DocumentLinks visitId={visit.id} documents={lineDocuments} />
            </div> : null}
          </li>;
        })}
      </ul> : <p className="text-muted">{t('noItems')}</p>}
    </Section>
  </>;
}

function VisitTasks({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const attempts = useRef(new Map<string, { done: boolean; requestId: string }>());
  const checklistItems = visit.tasks.flatMap(({ checklist }) => checklist.filter(({ waived }) => !waived));
  const complete = checklistItems.filter(({ done }) => done).length;

  async function update(checklistId: string, done: boolean) {
    if (visit.status !== 'in_progress' || actions.busy) return;
    const previous = attempts.current.get(checklistId);
    const requestId = previous?.done === done ? previous.requestId : crypto.randomUUID();
    attempts.current.set(checklistId, { done, requestId });
    const saved = await actions.run('checklist', () => updateChecklist(visit.id, checklistId, { version: visit.version, requestId, done }));
    if (saved) attempts.current.delete(checklistId);
  }

  return <Section title={t('tasks')} icon="list">
    {checklistItems.length > 0 ? <div className="visit-checklist-progress">
      <progress value={complete} max={checklistItems.length} aria-label={t('tasks')} />
      <span>{t('visitChecklistProgress', { complete, total: checklistItems.length })}</span>
    </div> : null}
    {visit.tasks.length ? <ul className="detail-list" aria-busy={actions.busy === 'checklist'}>
      {visit.tasks.map((task) => <li key={task.id}>
        <h3>{task.title}</h3>
        <ul className="checklist">
          {task.checklist.map((item) => <li key={item.id}>
            <label className="checklist-item">
              <input type="checkbox" checked={item.done} disabled={visit.status !== 'in_progress' || item.waived}
                aria-disabled={actions.busy !== null || undefined}
                aria-describedby={item.waived ? `waived-${item.id}` : undefined}
                onChange={(event) => void update(item.id, event.currentTarget.checked)} />
              <span>{item.label}</span>
            </label>
            {item.waived ? <span className="plate" id={`waived-${item.id}`}>{t('waived')}</span> : null}
          </li>)}
        </ul>
      </li>)}
    </ul> : <p className="text-muted">{t('noTasks')}</p>}
    {visit.status === 'booked' && visit.tasks.length ? <p className="text-muted">{t('checklistBeforeStart')}</p> : null}
  </Section>;
}

function VisitActionsPanel({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const id = useId();
  const [open, setOpen] = useState<'issue' | 'absent' | null>(null);
  const issueOpen = open === 'issue';
  const absentOpen = visit.canFinish && open === 'absent';

  return <section className="panel detail-section visit-actions" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}><span className="section-icon"><Icon name="list" size={17} /></span>{t('visitActions')}</h2>
    <div className="visit-action-controls">
      <Button variant="secondary" id={`${id}-issue`} aria-expanded={issueOpen} aria-controls={`${id}-issue-panel`}
        onClick={() => setOpen(issueOpen ? null : 'issue')}>
        <Icon name="alert" size={17} /><span>{t('reportIssue')}</span><span className="visit-action-chevron"><Icon name="chevron" size={16} /></span>
      </Button>
      {visit.canFinish ? <Button variant="secondary" id={`${id}-absent`} aria-expanded={absentOpen} aria-controls={`${id}-absent-panel`}
        onClick={() => setOpen(absentOpen ? null : 'absent')}>
        <Icon name="users" size={17} /><span>{t('attemptFailureTitle')}</span><span className="visit-action-chevron"><Icon name="chevron" size={16} /></span>
      </Button> : null}
    </div>
    <div className="visit-action-panel" id={`${id}-issue-panel`} role="region" aria-labelledby={`${id}-issue`} hidden={!issueOpen}>
      <IssueForm visit={visit} actions={actions} />
    </div>
    {visit.canFinish ? <div className="visit-action-panel" id={`${id}-absent-panel`} role="region" aria-labelledby={`${id}-absent`} hidden={!absentOpen}>
      <AttemptFailureForm visit={visit} actions={actions} />
    </div> : null}
  </section>;
}

function VisitContent({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const [reportOpen, setReportOpen] = useState(false);
  const overviewScroll = useRef<number | null>(null);
  const inProgress = visit.status === 'in_progress';
  const canReport = inProgress && visit.canFinish && !visit.scopeReviewReason;
  const reportIsOpen = reportOpen && canReport;

  function openReport() {
    if (!canReport || actions.busy) return;
    overviewScroll.current = window.scrollY;
    setReportOpen(true);
  }

  useEffect(() => {
    if (reportIsOpen) {
      const result = document.getElementById('visit-result');
      result?.focus({ preventScroll: true });
      result?.scrollIntoView({ block: 'start' });
    } else if (overviewScroll.current !== null) {
      const previousScroll = overviewScroll.current;
      overviewScroll.current = null;
      if (visit.status === 'completed') document.getElementById('visit-result')?.focus();
      else {
        window.scrollTo(0, previousScroll);
        document.getElementById('visit-primary-action')?.focus({ preventScroll: true });
      }
    }
  }, [reportIsOpen, visit.status]);

  return <>
    <div className="screen-stack visit-overview" hidden={reportIsOpen}>
      <VisitHeader visit={visit} />
      {visit.status === 'booked' || inProgress ? <WorkScopeNotice reason={visit.scopeReviewReason} /> : null}
      {visit.status === 'failed' ? <AttemptFailureResult failure={visit.failedAttempt} /> : null}
      {visit.status === 'completed' ? <VisitFinishResult visit={visit} actions={actions} /> : null}
      {inProgress ? <VisitActionsPanel visit={visit} actions={actions} /> : null}
      <VisitInstructions instructions={visit.instructions} />
      <VisitItems visit={visit} />
      <VisitTasks visit={visit} actions={actions} />
      <VisitResources visit={visit} />
      {reportIsOpen ? null : <VisitActionBar visit={visit} actions={actions} onOpenReport={openReport} />}
    </div>
    {canReport ? <div className="visit-report-frame" hidden={!reportIsOpen}>
      <VisitFinishResult visit={visit} actions={actions} reportOpen={reportIsOpen} onCloseReport={() => setReportOpen(false)} />
    </div> : null}
  </>;
}

function revision(visit: VisitDetail) {
  return visit.version;
}

export function VisitDetailScreen({ visitId }: { visitId: string }) {
  const t = useTranslations('crew');
  const load = useCallback((signal: AbortSignal) => getVisit(visitId, signal), [visitId]);
  const { resource, refreshing, refresh, publish, revalidate } = useCrewResource(load, revision);
  const actions = useVisitActions(publish, revalidate);

  return <div className="screen-stack">
    <div className="detail-navigation">
      <Link href="/visits" prefetch={false} className="button button-ghost back-link"><Icon name="arrowLeft" size={17} />{t('backToVisits')}</Link>
      <RefreshButton refreshing={refreshing} onRefresh={refresh} />
    </div>
    {resource.state === 'loading' ? <Loading>{t('loading')}</Loading> : null}
    {resource.state === 'error' ? (
      [400, 403, 404].includes(resource.status) ? <Notice>{t('visitUnavailable')}</Notice>
        : <ResourceError status={resource.status} retry={refresh} />
    ) : null}
    {resource.state === 'ready' ? <>
      {resource.refreshError !== null ? <ResourceError status={resource.refreshError} /> : null}
      <VisitContent key={resource.data.id} visit={resource.data} actions={actions} />
    </> : null}
  </div>;
}
