'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { CrewRoute, RouteStop } from '@/shared/api/route-contracts';
import { formatLocale } from '@/shared/i18n/config';
import { formatVisitDate, romeDay } from '@/shared/lib/visit-display';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { Icon } from '@/shared/ui/icon';

export function StopStatus({ stop }: { stop: RouteStop }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  if (stop.skipped || stop.status === 'cancelled') return <span className="status-badge status-neutral"><Icon name="alert" size={14} />{t(stop.skipped ? 'skipped' : 'cancelledStop')}</span>;
  if (stop.status === 'completed') return <span className="status-badge status-neutral"><Icon name="check" size={14} />{common('completed')}</span>;
  if (stop.status === 'failed') return <span className="status-badge status-warning"><Icon name="alert" size={14} />{common('attemptFailureTitle')}</span>;
  if (stop.status === 'in_progress') return <span className="status-badge status-info"><Icon name="clock" size={14} />{common('inProgress')}</span>;
  const confirmed = stop.confirmationStatus === 'customer_confirmed';
  return <span className={`status-badge ${confirmed ? 'status-success' : 'status-warning'}`}><Icon name={confirmed ? 'check' : 'clock'} size={14} />{common(confirmed ? 'confirmed' : 'awaiting')}</span>;
}

function StopEta({ eta, departAt }: { eta: RouteStop['eta']; departAt: string }) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const day = eta && romeDay(eta) !== romeDay(departAt) ? { day: 'numeric', month: 'short' } as const : {};

  return <span className="inline-flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted">
    <span>{t('eta')}</span>
    {eta ? <time className="font-semibold text-foreground tabular-nums" dateTime={eta}>
      {formatVisitDate(eta, locale, { ...day, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
    </time> : <span>{t('unknown')}</span>}
  </span>;
}

function StopDetails({ stop, route }: { stop: RouteStop; route: CrewRoute }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const locale = useLocale();
  const number = new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 3 });
  const selectedLines = route.lines.filter((line) => line.appointmentId === stop.appointmentId);
  const plan = route.draft.stops.find((entry) => entry.deliveryId === stop.deliveryId);
  const skipped = route.runtime.skipped.find((entry) => entry.appointmentId === stop.appointmentId);
  const window = stop.customerWindow;
  const time = (value: string) => formatVisitDate(value, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  return <>
    <dl className="detail-fields">
      <div><dt>{t('clientWindow')}</dt><dd>{window?.kind === 'arrival' || window?.kind === 'work_end'
        ? <>{t(window.kind === 'arrival' ? 'windowArrival' : 'windowFinish')} · {time(window.startsAt)} – {time(window.endsAt)}</>
        : t(window?.kind === 'unrestricted' ? 'windowUnrestricted' : 'windowUnknown')}</dd></div>
      <div><dt>{t('workEnd')}</dt><dd>{stop.workEndAt ? time(stop.workEndAt) : t('unknown')}{plan?.workMinutes ? ` · ${t('workDuration', { minutes: plan.workMinutes })}` : ''}</dd></div>
      <div><dt>{t('responsible')}</dt><dd>{stop.responsibleParticipant?.name ?? t('unknown')}</dd></div>
    </dl>
    {stop.entrance ? <p className="card-detail"><Icon name="pin" size={16} />{t(stop.geocoding ? 'addressPoint' : 'entrance')} · {stop.entrance.latitude.toFixed(5)}, {stop.entrance.longitude.toFixed(5)}</p>
      : <p className="text-muted">{t('entranceUnknown')}</p>}
    {stop.entrance && stop.geocoding ? <div className="space-y-1 text-xs text-muted">
      <p>{t('addressPointHint')}</p>
      <p><a href="https://www.geoapify.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Powered by Geoapify</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">OpenStreetMap</a></p>
      <p className="[overflow-wrap:anywhere]">{stop.geocoding.attribution}</p>
    </div> : null}
    {selectedLines.length ? <ul className="detail-list">
      {selectedLines.map((line) => <li key={`${line.appointmentId}:${line.sourceLineId}`}>
        <h4 className="font-semibold">{line.productName}</h4>
        <p>{line.orderName} · {common('productLine', { line: line.sourceLineId })}</p>
        <div className="flex flex-wrap gap-2">
          {([['delivery', line.plannedDeliveryMilli], ['installation', line.plannedInstallationMilli], ['collection', line.plannedCollectionMilli]] as const).filter(([, amount]) => amount > 0)
            .map(([operation, amount]) => <span key={operation} className="plate">{common(operation)} · {number.format(amount / 1000)} {line.uom}</span>)}
        </div>
      </li>)}
    </ul> : null}
    {skipped?.note ? <p className="rounded-lg bg-[var(--warning-bg)] p-3 text-[var(--warning-fg)]">{t('skipReason')}: {skipped.note}</p> : null}
  </>;
}

function StopLinks({ stop, address, next }: { stop: RouteStop; address: string; next: boolean }) {
  const t = useTranslations('routes');
  const maps = new URL('https://www.google.com/maps/search/');
  maps.searchParams.set('api', '1');
  maps.searchParams.set('query', stop.entrance ? `${stop.entrance.latitude},${stop.entrance.longitude}` : address);

  return <div className="flex flex-wrap gap-2">
    {stop.status !== 'cancelled' ? <Link prefetch={false} href={`/visits/${stop.appointmentId}`} className={`button min-h-11 justify-start text-start ${next ? 'button-primary' : 'button-secondary'}`}>
      {t('openVisit')}<Icon name="arrowRight" size={16} /></Link> : null}
    {address || stop.entrance ? <a href={maps.href} target="_blank" rel="noreferrer" className="button button-secondary min-h-11 justify-start text-start">
      {t('openDirections')}<Icon name="external" size={16} /></a> : null}
  </div>;
}

export function RouteStopCard({ stop, route, next }: { stop: RouteStop; route: CrewRoute; next: boolean }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const address = [stop.address, stop.city].filter(Boolean).join(', ');
  const position = t('stopNumber', { number: stop.sequence });
  const blocker = stop.status === 'booked' && stop.startBlockerCode ? t(routeBlockerLabel(stop.startBlockerCode)) : null;

  if (next) return <article className="panel detail-section gap-3! border-[var(--info-border)]! bg-[var(--info-bg)]! p-4! sm:p-5!" aria-label={t('nextStop')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="eyebrow text-[var(--info-fg)]"><Icon name="pin" size={17} />{t('nextStop')} · {position}</span>
      <StopStatus stop={stop} />
    </div>
    <div>
      <h2 className="text-xl! leading-tight">{address || common('addressUnavailable')}</h2>
      <p className="mt-1 text-muted">{stop.customerName} · {stop.pickingName}</p>
    </div>
    <div className="w-fit rounded-lg border border-[var(--info-border)] bg-card px-3 py-2">
      <StopEta eta={stop.eta} departAt={route.draft.departAt} />
    </div>
    {blocker ? <p className="text-muted">{blocker}</p> : null}
    <StopLinks stop={stop} address={address} next={next} />
    <details className="group border-t border-[var(--info-border)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-1 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {t('stopDetails')}<span className="text-muted group-open:rotate-180 motion-safe:transition-transform"><Icon name="chevron" size={16} /></span>
      </summary>
      <div className="grid gap-3 pb-1"><StopDetails stop={stop} route={route} /></div>
    </details>
  </article>;

  return <details className="group min-w-0" aria-label={`${position} · ${stop.pickingName}`}>
    <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 p-3 hover:bg-muted-surface sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] [&::-webkit-details-marker]:hidden">
      <span className="grid size-8 shrink-0 place-items-center self-start rounded-lg border border-border bg-muted-surface font-mono text-xs font-semibold text-muted">
        <span aria-hidden="true">{stop.sequence}</span><span className="sr-only">{position}</span>
      </span>
      <span className="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
        <strong className="text-sm font-semibold leading-snug">{address || common('addressUnavailable')}</strong>
        <span className="text-xs text-muted">{stop.customerName} · {stop.pickingName}</span>
      </span>
      <span className="col-start-2 col-end-4 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:col-start-3 sm:col-end-4 sm:row-start-1 sm:justify-end">
        <StopEta eta={stop.eta} departAt={route.draft.departAt} /><StopStatus stop={stop} />
      </span>
      <span className="col-start-3 row-start-1 text-muted group-open:rotate-180 motion-safe:transition-transform sm:col-start-4">
        <Icon name="chevron" size={16} />
      </span>
    </summary>
    <div className="detail-section border-t border-border bg-card">
      {blocker ? <p className="text-muted">{blocker}</p> : null}
      <StopDetails stop={stop} route={route} />
      <StopLinks stop={stop} address={address} next={next} />
    </div>
  </details>;
}
