'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useRef, type ReactNode } from 'react';
import { getVisit } from '@/shared/api/client';
import type { VisitDetail } from '@/shared/api/contracts';
import { useCrewResource } from '@/shared/api/use-resource';
import { formatLocale } from '@/shared/i18n/config';
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

function Section({ title, icon, children }: { title: string; icon: 'pin' | 'users' | 'note' | 'box' | 'list'; children: ReactNode }) {
  return <section className="panel detail-section">
    <h2><span className="section-icon"><Icon name={icon} size={17} /></span>{title}</h2>
    {children}
  </section>;
}

function CustomerConfirmation({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const requestId = useRef<string | null>(null);
  if (visit.status !== 'booked') return null;
  const confirmed = visit.confirmationStatus === 'customer_confirmed';

  function start() {
    if (!confirmed || !visit.canStart || actions.busy) return;
    const id = requestId.current ?? crypto.randomUUID();
    requestId.current = id;
    void actions.run('start', () => startVisit(visit.id, { version: visit.version, requestId: id }));
  }

  return <section className="panel confirmation-panel" aria-labelledby="confirmation-heading">
    <div>
      <h2 id="confirmation-heading">{t('customerConfirmation')}</h2>
      <VisitStatus visit={visit} />
      <p id="start-visit-reason">{confirmed ? t('confirmedDescription') : t('awaitingDescription')}</p>
    </div>
    <div className="confirmation-action">
      <Button disabled={!confirmed || !visit.canStart || actions.busy !== null} aria-describedby="start-visit-reason" onClick={start}>
        {actions.busy === 'start' ? t('startingVisit') : t('startVisit')}<Icon name="arrowRight" size={16} />
      </Button>
    </div>
  </section>;
}

function PhoneLink({ phone }: { phone: string }) {
  const normalized = phone.replace(/[\s().-]/g, '');
  return /^\+?\d{3,20}$/.test(normalized)
    ? <a className="contact-link" href={`tel:${normalized}`}><Icon name="phone" size={15} />{phone}</a>
    : <span>{phone}</span>;
}

function VisitLocation({ visit }: { visit: VisitDetail }) {
  const t = useTranslations('crew');
  const address = destinationLabel(visit.destination);
  const mapsUrl = new URL('https://www.google.com/maps/search/');
  mapsUrl.searchParams.set('api', '1');
  mapsUrl.searchParams.set('query', address);

  return <Section title={t('location')} icon="pin">
    <p>{address || t('addressUnavailable')}</p>
    {visit.destination.address ? <a className="button button-secondary directions" href={mapsUrl.href} target="_blank" rel="noreferrer">
      {t('directions')}<Icon name="external" size={16} />
    </a> : null}
    <div className="sub-section">
      <h3>{t('customer')}</h3>
      <p>{visit.customer.name}{visit.customer.contact && visit.customer.contact !== visit.customer.name ? ` · ${visit.customer.contact}` : ''}</p>
      {visit.customer.phones.length ? <ul className="plain-list">
        {visit.customer.phones.map((phone, index) => <li key={`${index}-${phone}`}><PhoneLink phone={phone} /></li>)}
      </ul> : <p className="text-muted">{t('noContact')}</p>}
    </div>
  </Section>;
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
      {visit.items.length ? <ul className="detail-list">
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

  async function update(checklistId: string, done: boolean) {
    if (visit.status !== 'in_progress' || actions.busy) return;
    const previous = attempts.current.get(checklistId);
    const requestId = previous?.done === done ? previous.requestId : crypto.randomUUID();
    attempts.current.set(checklistId, { done, requestId });
    const saved = await actions.run('checklist', () => updateChecklist(visit.id, checklistId, { version: visit.version, requestId, done }));
    if (saved) attempts.current.delete(checklistId);
  }

  return <Section title={t('tasks')} icon="list">
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

function VisitContent({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const locale = useLocale();

  return <>
    <div className="page-intro detail-intro">
      <div>
        <span className="eyebrow"><Icon name="calendar" size={16} />{t('visit')}</span>
        <h1>{visit.pickingName}</h1>
        <p>{formatVisitDate(visit.startsAt, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <p className="visit-time detail-time">{formatVisitWindow(visit, locale)} <span>· {t('localTime')}</span></p>
      </div>
      {visit.status === 'booked' ? null : <VisitStatus visit={visit} />}
    </div>
    {visit.status === 'booked' || visit.status === 'in_progress' ? <WorkScopeNotice reason={visit.scopeReviewReason} /> : null}
    <CustomerConfirmation visit={visit} actions={actions} />
    <div className="details-grid">
      <VisitLocation visit={visit} />
      <VisitResources visit={visit} />
    </div>
    <VisitInstructions instructions={visit.instructions} />
    <VisitItems visit={visit} />
    <VisitTasks visit={visit} actions={actions} />
    {visit.status === 'in_progress' ? <IssueForm visit={visit} actions={actions} /> : null}
    {visit.status === 'in_progress' && visit.canFinish ? <AttemptFailureForm visit={visit} actions={actions} /> : null}
    {visit.status === 'failed' ? <AttemptFailureResult failure={visit.failedAttempt} /> : <VisitFinishResult visit={visit} actions={actions} />}
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
      <VisitContent visit={resource.data} actions={actions} />
    </> : null}
  </div>;
}
