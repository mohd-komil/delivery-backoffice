'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { CrewRoute, RouteStop } from '@/shared/api/route-contracts';
import { formatLocale } from '@/shared/i18n/config';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { Icon } from '@/shared/ui/icon';

export function StopStatus({ stop }: { stop: RouteStop }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  if (stop.skipped || stop.status === 'cancelled') return <span className="status-badge status-neutral"><Icon name="alert" size={14} />{t('skipped')}</span>;
  if (stop.status === 'completed') return <span className="status-badge status-neutral"><Icon name="check" size={14} />{common('completed')}</span>;
  if (stop.status === 'failed') return <span className="status-badge status-warning"><Icon name="alert" size={14} />{common('attemptFailureTitle')}</span>;
  if (stop.status === 'in_progress') return <span className="status-badge status-info"><Icon name="clock" size={14} />{common('inProgress')}</span>;
  const confirmed = stop.confirmationStatus === 'customer_confirmed';
  return <span className={`status-badge ${confirmed ? 'status-success' : 'status-warning'}`}><Icon name={confirmed ? 'check' : 'clock'} size={14} />{common(confirmed ? 'confirmed' : 'awaiting')}</span>;
}

export function RouteStopCard({ stop, route, next }: { stop: RouteStop; route: CrewRoute; next: boolean }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const locale = useLocale();
  const number = new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 3 });
  const address = [stop.address, stop.city].filter(Boolean).join(', ');
  const selectedLines = route.lines.filter((line) => line.appointmentId === stop.appointmentId);
  const plan = route.draft.stops.find((entry) => entry.deliveryId === stop.deliveryId);
  const skipped = route.runtime.skipped.find((entry) => entry.appointmentId === stop.appointmentId);
  const window = stop.customerWindow;
  const maps = new URL('https://www.google.com/maps/search/');
  maps.searchParams.set('api', '1');
  maps.searchParams.set('query', stop.entrance ? `${stop.entrance.latitude},${stop.entrance.longitude}` : address);
  const time = (value: string) => formatVisitDate(value, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <article className={`panel detail-section ${next ? 'border-[var(--info-border)] ring-1 ring-[var(--info-border)]' : ''}`} aria-label={`${t('stopNumber', { number: stop.sequence })} · ${stop.pickingName}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="eyebrow"><Icon name="pin" size={16} />{t('stopNumber', { number: stop.sequence })}{next ? ` · ${t('nextStop')}` : ''}</span><StopStatus stop={stop} />
    </div>
    <div><h3 className="!text-base">{stop.pickingName}</h3><p>{stop.customerName}</p><p className="text-muted">{address || common('addressUnavailable')}</p></div>
    <dl className="detail-fields">
      <div><dt>{t('clientWindow')}</dt><dd>{window?.kind === 'arrival' || window?.kind === 'work_end'
        ? <>{t(window.kind === 'arrival' ? 'windowArrival' : 'windowFinish')} · {time(window.startsAt)} – {time(window.endsAt)}</>
        : t(window?.kind === 'unrestricted' ? 'windowUnrestricted' : 'windowUnknown')}</dd></div>
      <div><dt>{t('eta')}</dt><dd>{stop.eta ? time(stop.eta) : t('unknown')}</dd></div>
      <div><dt>{t('workEnd')}</dt><dd>{stop.workEndAt ? time(stop.workEndAt) : t('unknown')}{plan?.workMinutes ? ` · ${t('workDuration', { minutes: plan.workMinutes })}` : ''}</dd></div>
      <div><dt>{t('responsible')}</dt><dd>{stop.responsibleParticipant?.name ?? t('unknown')}</dd></div>
    </dl>
    {stop.entrance ? <p className="card-detail"><Icon name="pin" size={16} />{t('entrance')} · {stop.entrance.latitude.toFixed(5)}, {stop.entrance.longitude.toFixed(5)}</p>
      : <p className="text-muted">{t('entranceUnknown')}</p>}
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
    {stop.status === 'booked' && stop.startBlockerCode ? <p className="text-muted">{t(routeBlockerLabel(stop.startBlockerCode))}</p> : null}
    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
      {stop.status !== 'cancelled' ? <Link prefetch={false} href={`/visits/${stop.appointmentId}`} className={`button ${next ? 'button-primary' : 'button-secondary'}`}>
        {t('openVisit')}<Icon name="arrowRight" size={16} /></Link> : null}
      {address || stop.entrance ? <a href={maps.href} target="_blank" rel="noreferrer" className="button button-secondary">{t('openDirections')}<Icon name="external" size={16} /></a> : null}
    </div>
  </article>;
}
