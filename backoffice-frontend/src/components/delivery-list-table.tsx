'use client';

import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { DeliveryList } from '@/lib/contracts';
import { sourceOrders, sourceServiceLabel, sourceStateLabel } from '@/lib/source';
import { formatDateTime } from '@/lib/time';
import { deliveryServicePlanLabel, deliveryStatusLabel, ProgressBadge } from './delivery-detail-presentation';
import { DataTable, type DataTablePagination } from './ui/data-table';

type ListItem = DeliveryList['items'][number];
type Planning = NonNullable<ListItem['planning']>;
type ActiveVisit = Planning['activeVisits'][number];

export function DeliveryListTable({ items, selected, onOpen, pagination }: {
  items: DeliveryList['items']; selected: string | null; onOpen: (id: string) => void; pagination?: DataTablePagination;
}) {
  const t = useTranslations('workspace');
  const labels = useTranslations('deliveryList');
  const deliveryText = useTranslations('delivery');
  const common = useTranslations('common');
  const locale = useLocale();
  const estimateHintId = useId();

  return <div className="min-w-0 space-y-2">
    <DataTable className="delivery-table min-w-[1000px]" containerClassName="relative" caption={labels('caption')} pagination={pagination}
        header={<tr>
          <th scope="col">{t('deliverySalesOrders')}</th><th scope="col">{t('customerDestination')}</th>
          <th scope="col">{labels('status')}</th><th scope="col">{labels('scheduled')}</th>
          <th scope="col" aria-describedby={estimateHintId}>{labels('remaining')}</th><th scope="col">{t('source')}</th><th scope="col"><span className="sr-only">{t('open')}</span></th>
        </tr>}
        rows={items.map((delivery) => {
          const { source, planning } = delivery;
          const service = deliveryServicePlanLabel(deliveryText, delivery) ?? (source.serviceType ? sourceServiceLabel(source.serviceType, locale) : undefined);
          const crews = planning ? [...new Map(planning.activeVisits.flatMap((visit) => visit.crews.map((crew) => [crew.id, crew] as const))).values()] : [];
          return <tr key={delivery.id} className={selected === delivery.id ? 'row-selected' : ''}>
            <td className="min-w-40"><button className="reference" onClick={() => onOpen(delivery.id)}>{source.pickingName}</button><span className="cell-sub max-w-56 break-words">{sourceOrders(source).map((order) => order.name).join(', ')} · {t('productLines', { count: source.items.length })}</span></td>
            <td className="min-w-48 max-w-64 break-words">
              <strong>{source.customer.name}</strong>
              {source.customer.address ? <span className="cell-sub">{source.customer.address}</span> : null}
              <span className="cell-sub">{[source.customer.city, delivery.geography?.province, delivery.geography?.postalCode, source.customer.country].filter(Boolean).join(', ') || t('destinationMissing')}</span>
              <div className="mt-3 space-y-1.5">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('service')}</span>
                {service ? <span className="inline-flex rounded-md bg-info px-2.5 py-1 text-xs font-semibold text-info-foreground">{service}</span> : <span className="muted">{common('notProvided')}</span>}
              </div>
            </td>
            <td className="min-w-44 max-w-56">
              {planning ? <ProgressBadge progress={planning.status} /> : <span className="muted">{labels('unavailable')}</span>}
              <div className="mt-3 space-y-1.5">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{labels('teams')}</span>
                {crews.length ? <ul className="space-y-1 font-medium">{crews.map((crew) => <li key={crew.id} className="break-words">{crew.name}</li>)}</ul> : <span className="muted">{labels(planning ? 'unassigned' : 'unavailable')}</span>}
              </div>
            </td>
            <td className="min-w-56"><ScheduledVisits planning={planning} /></td>
            <td className="min-w-44 max-w-52"><RemainingWork planning={planning} /></td>
            <td className="min-w-28"><span className={delivery.sourceReview || delivery.sourceChanged ? 'badge warning' : 'badge success'}>{t(delivery.sourceReview ? 'reviewSource' : delivery.sourceChanged ? 'sourceChanged' : 'imported')}</span><span className="cell-sub">Odoo · {sourceStateLabel(source.sourceState, locale)}</span></td>
            <td><button className="icon-button" aria-label={t('openDelivery', { name: source.pickingName })} onClick={() => onOpen(delivery.id)}>↗</button></td>
          </tr>;
        })} />
    <p id={estimateHintId} className="max-w-4xl text-xs text-muted-foreground">{labels('estimateHint')}</p>
  </div>;
}

function ScheduledVisits({ planning }: { planning: ListItem['planning'] }) {
  const t = useTranslations('deliveryList');
  const visits = planning?.activeVisits ?? [];
  const first = visits[0];
  if (!first) return <span className="muted">{t(planning ? 'unscheduled' : 'unavailable')}</span>;
  return <div>
    <VisitTimes visit={first} />
    <span className="cell-sub">{t('activeVisits', { count: visits.length })}</span>
    {visits.length > 1 ? <details className="mt-2 text-xs">
      <summary className="cursor-pointer rounded-sm py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('allVisits', { count: visits.length })}</summary>
      <ul className="mt-2 space-y-3 border-l border-border pl-3">{visits.map((visit) => <li key={visit.id}>
        <VisitTimes visit={visit} />
        <p className="cell-sub">{visit.crews.map((crew) => crew.name).join(', ') || t('unassigned')}</p>
      </li>)}</ul>
    </details> : null}
  </div>;
}

function VisitTimes({ visit }: { visit: ActiveVisit }) {
  const locale = useLocale();
  const t = useTranslations('delivery');
  return <div className="text-xs tabular-nums">
    <span className="mb-1 block font-medium">{deliveryStatusLabel(t, visit.status)}</span>
    <time dateTime={visit.startsAt} className="block">{formatDateTime(visit.startsAt, locale)}</time>
    <span className="cell-sub">→ <time dateTime={visit.endsAt}>{formatDateTime(visit.endsAt, locale)}</time></span>
  </div>;
}

function RemainingWork({ planning }: { planning: ListItem['planning'] }) {
  const t = useTranslations('deliveryList');
  const estimate = planning?.remainingWorkEstimate;
  return <div>
    <span className="font-medium tabular-nums">{estimate?.minutes === null || estimate?.minutes === undefined
      ? t('unknownEstimate') : t(estimate.basis === 'proportional_remaining_operations' ? 'provisionalMinutes' : 'minutes', { count: estimate.minutes })}</span>
    {estimate?.basis === 'proportional_remaining_operations' ? <span className="cell-sub">{t('provisional')}</span> : null}
    {estimate?.basis === 'no_remaining_work' ? <span className="cell-sub">{t('noRemaining')}</span> : null}
    {estimate?.sourceMinutes !== null && estimate?.sourceMinutes !== undefined ? <span className="cell-sub">{t('sourceMinutes', { count: estimate.sourceMinutes })}</span> : null}
  </div>;
}
