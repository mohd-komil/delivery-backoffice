'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Tabs } from 'radix-ui';
import { getVisits } from '@/shared/api/client';
import type { VisitSummary } from '@/shared/api/contracts';
import { useCrewResource } from '@/shared/api/use-resource';
import { destinationLabel, formatVisitDate, formatVisitWindow } from '@/shared/lib/visit-display';
import { Loading } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { RefreshButton, ResourceError } from '@/shared/ui/resource-feedback';
import { VisitStatus } from '@/shared/ui/visit-status';
import { groupVisits } from '../model/schedule';

const scheduleTabs = ['today', 'upcoming'] as const;

function VisitCard({ visit }: { visit: VisitSummary }) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const address = destinationLabel(visit.destination);

  return <Link href={`/visits/${visit.id}`} prefetch={false} className="visit-card panel">
    <div className="date-tile" aria-hidden="true">
      <span>{formatVisitDate(visit.startsAt, locale, { month: 'short' })}</span>
      <strong>{formatVisitDate(visit.startsAt, locale, { day: '2-digit' })}</strong>
    </div>
    <div className="visit-card-body">
      <div className="visit-card-title">
        <h3>{visit.pickingName}</h3>
        <VisitStatus visit={visit} />
      </div>
      <time dateTime={visit.startsAt} className="visit-time">
        <span className="sr-only">{formatVisitDate(visit.startsAt, locale, { day: 'numeric', month: 'long', year: 'numeric' })} · </span>
        {formatVisitDate(visit.startsAt, locale, { weekday: 'short' })} · {formatVisitWindow(visit, locale)}
      </time>
      <p className="card-detail"><Icon name="pin" size={16} />{address || t('addressUnavailable')}</p>
      <div className="card-resources">
        <p className="card-detail"><Icon name="users" size={16} />{visit.crews.map((crew) => crew.name).join(', ')}</p>
        <p className="card-detail"><Icon name="truck" size={16} />{visit.vehicles.length
          ? visit.vehicles.map((vehicle) => vehicle.name).join(', ') : t('vehicleUnassigned')}</p>
      </div>
    </div>
    <span className="card-arrow"><Icon name="arrowRight" size={18} /></span>
  </Link>;
}

function VisitList({ visits }: { visits: VisitSummary[] }) {
  return <ul className="visit-list">
    {visits.map((visit) => <li key={visit.id}><VisitCard visit={visit} /></li>)}
  </ul>;
}

export function VisitsScreen() {
  const t = useTranslations('crew');
  const locale = useLocale();
  const { resource, refreshing, refresh } = useCrewResource(getVisits);
  const grouped = resource.state === 'ready' ? groupVisits(resource.data.visits, resource.checkedAt) : null;

  return <div className="screen-stack">
    <div className="page-intro">
      <div>
        <span className="eyebrow"><Icon name="calendar" size={16} />{t('schedule')}</span>
        <h1>{t('myVisits')}</h1>
        <p>{t('visitListDescription')}</p>
      </div>
      <RefreshButton refreshing={refreshing} onRefresh={refresh} />
    </div>
    {resource.state === 'loading' ? <Loading>{t('loading')}</Loading> : null}
    {resource.state === 'error' ? <ResourceError status={resource.status} retry={refresh} /> : null}
    {resource.state === 'ready' && resource.refreshError !== null ? <ResourceError status={resource.refreshError} /> : null}
    {resource.state === 'ready' && grouped ? <>
      <p className="schedule-date">
        <Icon name="clock" size={16} />
        {formatVisitDate(resource.checkedAt, locale, { weekday: 'long', day: 'numeric', month: 'long' })}
        <span aria-hidden="true">·</span>{t('localTime')}
      </p>
      <Tabs.Root defaultValue="today" className="visit-tabs">
        <Tabs.List aria-label={t('schedule')} className="visit-tab-list">
          {scheduleTabs.map((section) => <Tabs.Trigger key={section} value={section} className="visit-tab-trigger">
            {t(section)} <span className="count-pill">{grouped[section].length}</span>
          </Tabs.Trigger>)}
        </Tabs.List>
        {scheduleTabs.map((section) => <Tabs.Content key={section} value={section} className="visit-tab-panel">
          {grouped[section].length > 0 ? <VisitList visits={grouped[section]} />
            : <div className="panel empty-panel">
              <Icon name="calendar" />
              <p>{t(section === 'today' ? 'todayEmpty' : 'upcomingEmpty')}</p>
            </div>}
        </Tabs.Content>)}
      </Tabs.Root>
      {grouped.past.length > 0 ? <section aria-labelledby="past-heading" className="visit-section">
        <div className="section-heading">
          <h2 id="past-heading">{t('past')}</h2>
          <span className="count-pill">{grouped.past.length}</span>
        </div>
        <VisitList visits={grouped.past} />
      </section> : null}
    </> : null}
  </div>;
}
