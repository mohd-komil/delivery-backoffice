'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Tabs } from 'radix-ui';
import { getRoutes } from '@/shared/api/routes';
import type { CrewRoute } from '@/shared/api/route-contracts';
import { useCrewResource } from '@/shared/api/use-resource';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Loading } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { RefreshButton, ResourceError } from '@/shared/ui/resource-feedback';
import { RouteStatus } from '@/shared/ui/route-status';
import { groupRoutes } from '../model/schedule';

const sections = ['active', 'upcoming', 'history'] as const;
const emptyLabels = { active: 'emptyActive', upcoming: 'emptyUpcoming', history: 'emptyHistory' } as const;

function RouteCard({ route }: { route: CrewRoute }) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const next = route.stops.find((stop) => stop.appointmentId === route.nextAppointmentId);
  return <Link href={`/routes/${route.id}`} prefetch={false} className="visit-card panel">
    <span className="date-tile" aria-hidden="true"><Icon name="truck" size={23} /></span>
    <div className="visit-card-body">
      <div className="visit-card-title"><h3>{route.name}</h3><RouteStatus status={route.status} /></div>
      <time dateTime={route.draft.departAt} className="visit-time">{formatVisitDate(route.draft.departAt, locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
      <p className="card-detail"><Icon name="list" size={16} />{t('stopsCount', { count: route.stops.length })} · {t('routeVersion', { version: route.version })}</p>
      {next ? <p className="card-detail"><Icon name="pin" size={16} />{t('nextStop')}: {[next.address, next.city].filter(Boolean).join(', ') || next.pickingName}</p> : null}
      <p className="card-detail"><Icon name="truck" size={16} />{route.resources.vehicle.name} · {route.resources.vehicle.plate}</p>
      <p className="card-detail"><Icon name="users" size={16} />{route.routeResponsible.name}</p>
    </div>
    <span className="card-arrow"><Icon name="arrowRight" /></span>
  </Link>;
}

export function RoutesScreen() {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const { resource, refreshing, refresh } = useCrewResource(getRoutes);
  const grouped = resource.state === 'ready' ? groupRoutes(resource.data.routes, resource.checkedAt) : null;
  return <div className="screen-stack">
    <div className="page-intro"><div><span className="eyebrow"><Icon name="truck" size={16} />{common('schedule')}</span><h1>{t('myRoutes')}</h1><p>{t('description')}</p></div>
      <RefreshButton refreshing={refreshing} onRefresh={refresh} />
    </div>
    {resource.state === 'loading' ? <Loading>{common('loading')}</Loading> : null}
    {resource.state === 'error' ? <ResourceError status={resource.status} retry={refresh} /> : null}
    {resource.state === 'ready' && resource.refreshError !== null ? <ResourceError status={resource.refreshError} /> : null}
    {grouped ? <Tabs.Root defaultValue="active" className="visit-tabs">
      <Tabs.List aria-label={t('myRoutes')} className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-[var(--muted-surface)] p-1">
        {sections.map((section) => <Tabs.Trigger key={section} value={section} className="visit-tab-trigger route-tab-trigger">{t(section)}<span className="count-pill">{grouped[section].length}</span></Tabs.Trigger>)}
      </Tabs.List>
      {sections.map((section) => <Tabs.Content key={section} value={section} className="visit-tab-panel">
        {grouped[section].length ? <ul className="visit-list">{grouped[section].map((route) => <li key={route.id}><RouteCard route={route} /></li>)}</ul>
          : <div className="panel empty-panel"><Icon name="truck" /><p>{t(emptyLabels[section])}</p></div>}
      </Tabs.Content>)}
    </Tabs.Root> : null}
  </div>;
}
