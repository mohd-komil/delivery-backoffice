'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'motion/react';
import { getRoute } from '@/shared/api/routes';
import type { CrewRoute } from '@/shared/api/route-contracts';
import { useCrewResource } from '@/shared/api/use-resource';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Loading, Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { RefreshButton, ResourceError } from '@/shared/ui/resource-feedback';
import { RouteStatus } from '@/shared/ui/route-status';
import { useRouteActions, type RouteActions } from '../model/actions';
import { RouteActionPanel } from './route-actions';
import { RouteStopCard } from './route-stop';

function RouteContent({ route, actions }: { route: CrewRoute; actions: RouteActions }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const planKey = JSON.stringify({ draft: route.draft, resources: route.resources, responsible: route.routeResponsible });
  const [initialPlan] = useState(planKey);
  const time = (value: string) => formatVisitDate(value, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const driver = route.resources.driver;
  const next = route.status === 'published' || route.status === 'in_progress'
    ? route.stops.find((stop) => stop.appointmentId === route.nextAppointmentId) : undefined;
  const groups = {
    remainingStops: route.stops.filter((stop) => !stop.skipped && (stop.status === 'booked' || stop.status === 'in_progress')),
    completedStops: route.stops.filter((stop) => !stop.skipped && (stop.status === 'completed' || stop.status === 'failed')),
    cancelledStops: route.stops.filter((stop) => stop.skipped || stop.status === 'cancelled'),
  };
  const groupsOrder = ['remainingStops', 'completedStops', 'cancelledStops'] as const;
  return <>
    <div className="page-intro detail-intro">
      <div><span className="eyebrow"><Icon name="truck" size={16} />{t('routeVersion', { version: route.version })}</span><h1>{route.name}</h1>
        <p>{formatVisitDate(route.draft.departAt, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {common('localTime')}</p></div>
      <RouteStatus status={route.status} />
    </div>
    {initialPlan !== planKey ? <motion.section initial={{ opacity: reduceMotion ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.15 }}
      className="grid gap-2 rounded-xl border border-[var(--info-border)] bg-[var(--info-bg)] p-4 text-[var(--info-fg)]" role="status">
      <h2 className="flex items-center gap-2 font-semibold"><Icon name="refresh" />{t('routeChangedTitle')}</h2><p>{t('routeChangedDescription')}</p>
    </motion.section> : null}
    {next ? <section className="panel detail-section border-[var(--info-border)]" aria-label={t('nextStop')}>
      <span className="eyebrow"><Icon name="pin" />{t('nextStop')}</span>
      <div><h2>{next.pickingName}</h2><p>{next.customerName}</p><p className="text-muted">{[next.address, next.city].filter(Boolean).join(', ')}</p></div>
      <Link prefetch={false} href={`/visits/${next.appointmentId}`} className="button button-primary justify-self-start">{t('openVisit')}<Icon name="arrowRight" size={16} /></Link>
    </section> : null}
    <section className="panel detail-section" aria-labelledby="trip-heading">
      <h2 id="trip-heading"><span className="section-icon"><Icon name="truck" /></span>{t('overview')}</h2>
      <dl className="detail-fields sm:grid-cols-2">
        <div><dt>{t('vehicle')}</dt><dd>{route.resources.vehicle.name} <span className="plate">{route.resources.vehicle.plate}</span></dd></div>
        <div><dt>{t('crew')}</dt><dd>{route.resources.crew.name}</dd></div>
        <div><dt>{t('driver')}</dt><dd>{driver.kind === 'participant' ? driver.person.name : driver.kind === 'external' ? driver.name : t('unknown')}</dd></div>
        <div><dt>{t('responsible')}</dt><dd>{route.routeResponsible.name}</dd></div>
        <div><dt>{t('departure')}</dt><dd>{time(route.draft.departAt)} · {route.resources.start.name}</dd></div>
        <div><dt>{t('estimatedReturn')}</dt><dd>{route.review.timeline.returnAt ? time(route.review.timeline.returnAt) : t('unknown')} · {route.resources.end.name}</dd></div>
        {route.runtime.departed ? <div><dt>{t('actualDeparture')}</dt><dd>{time(route.runtime.departed.at)}</dd></div> : null}
        {route.runtime.returned ? <div><dt>{t('actualReturn')}</dt><dd>{time(route.runtime.returned.actualReturnedAt)}</dd></div> : null}
      </dl>
      <p className="rounded-lg bg-[var(--info-bg)] p-3 text-[var(--info-fg)]">{t('estimatedHint')}</p>
      {route.draft.planning?.transferBufferMinutes !== null && route.draft.planning?.transferBufferMinutes !== undefined
        ? <p className="card-detail"><Icon name="clock" size={16} />{t('returnBuffer', { minutes: route.draft.planning.transferBufferMinutes })}</p> : null}
    </section>
    <RouteActionPanel route={route} actions={actions} />
    {!next && route.status === 'in_progress' ? <p className="text-muted">{t('noMoreStops')}</p> : null}
    {groupsOrder.map((name) => groups[name].length ? <section key={name} aria-labelledby={`route-${name}`} className="grid min-w-0 gap-3">
      <div className="section-heading"><h2 id={`route-${name}`}>{t(name)}</h2><span className="count-pill">{groups[name].length}</span></div>
      <ol className="grid min-w-0 gap-3">{groups[name].map((stop) => <li key={stop.appointmentId}>
        <RouteStopCard stop={stop} route={route} next={stop.appointmentId === next?.appointmentId} />
      </li>)}</ol>
    </section> : null)}
    {route.runtime.aborted || route.runtime.cancelled || route.runtime.returned?.note || route.runtime.closed ? <section className="panel detail-section" aria-labelledby="route-events-heading">
      <h2 id="route-events-heading"><Icon name="note" />{t('showHistory')}</h2>
      {([['returning', route.runtime.aborted], ['cancelled', route.runtime.cancelled], ['returned', route.runtime.returned], ['closed', route.runtime.closed]] as const)
        .map(([label, event]) => event ? <div key={label} className="grid gap-1 border-t border-border pt-3"><h3>{t(label)}</h3>
          <p className="text-muted">{t('recordedAt', { time: time(event.at) })} · {event.actor.name}</p>{event.note ? <p>{event.note}</p> : null}</div> : null)}
    </section> : null}
    <p className="text-muted text-sm">{t('updatedByDispatcher')}</p>
  </>;
}

function revision(route: CrewRoute) { return route.version; }

export function RouteDetailScreen({ routeId }: { routeId: string }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const load = useCallback((signal: AbortSignal) => getRoute(routeId, signal), [routeId]);
  const { resource, refreshing, refresh, publish, revalidate } = useCrewResource(load, revision);
  const actions = useRouteActions(routeId, publish, revalidate);
  return <div className="screen-stack">
    <div className="detail-navigation"><Link href="/routes" prefetch={false} className="button button-ghost back-link"><Icon name="arrowLeft" size={17} />{t('backToRoutes')}</Link>
      <RefreshButton refreshing={refreshing} onRefresh={refresh} /></div>
    {resource.state === 'loading' ? <Loading>{common('loading')}</Loading> : null}
    {resource.state === 'error' ? [400, 403, 404].includes(resource.status) ? <Notice>{t('routeUnavailable')}</Notice> : <ResourceError status={resource.status} retry={refresh} /> : null}
    {resource.state === 'ready' ? <>
      {resource.refreshError !== null ? <ResourceError status={resource.refreshError} /> : null}
      <RouteContent route={resource.data} actions={actions} />
    </> : null}
  </div>;
}
