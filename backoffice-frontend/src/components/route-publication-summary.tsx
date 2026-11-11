'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Delivery, WorkScope } from '@/lib/contracts';
import type { PublicationReview } from '@/lib/route-publication';
import { formatDateTime } from '@/lib/time';
import { workOperations } from '@/lib/visit-work';

export function ScopeSummary({ scope, source }: { scope: WorkScope; source?: Delivery['source'] }) {
  const t = useTranslations('routePublication');
  return <ul className="mt-2 grid gap-2 text-xs">{scope.lines.map((line) => <li key={line.sourceLineId} className="rounded-md border bg-background/70 p-2">
    <strong>{line.sourceItem.name}</strong><span className="ml-2 text-muted-foreground">{[source?.salesOrders?.find((order) => order.id === line.sourceItem.saleOrderId)?.name ?? source?.saleOrderName ?? (line.sourceItem.saleOrderId ? t('order', { id: line.sourceItem.saleOrderId }) : null), t('line', { id: line.sourceLineId })].filter(Boolean).join(' · ')}</span>
    <span className="mt-1 block">{workOperations.filter((operation) => line[operation.key] > 0).map((operation) => `${t(operation.label)}: ${line[operation.key] / 1000} ${line.sourceItem.uom}`).join(' · ')}</span>
  </li>)}</ul>;
}

export function FrozenPublication({ review, confirmationLabel }: { review: PublicationReview; confirmationLabel?: string }) {
  const t = useTranslations('routePublication');
  const locale = useLocale();
  return <section className="grid gap-3">
    <p className="text-xs text-info-foreground">{t('estimate')}</p>
    <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('departure')}</dt><dd>{formatDateTime(review.timeline.departAt, locale)}</dd></div><div><dt className="text-muted-foreground">{t('return')}</dt><dd>{review.timeline.returnAt ? formatDateTime(review.timeline.returnAt, locale) : '—'}</dd></div></dl>
    <ol className="grid gap-3">{review.stops.map((stop, index) => <li key={stop.appointmentId} className="rounded-md border p-3">
      <strong>{index + 1}. {stop.pickingName}</strong><p className="text-xs text-muted-foreground">{formatDateTime(stop.startsAt, locale)} — {formatDateTime(stop.endsAt, locale)}</p>
      <p className="mt-2 text-sm">{t('responsible')}: {stop.responsibleParticipant.name}</p>
      <p className="text-xs text-muted-foreground">{stop.assignments.map((assignment) => `${assignment.crewName} · ${assignment.people.map((person) => person.name).join(', ')}`).join(' · ')}</p>
      <p className="mt-2 text-xs text-muted-foreground">{confirmationLabel ?? t('confirmationAtPublication')}: <span className={`badge ${stop.customerConfirmationStatus === 'customer_confirmed' ? 'success' : 'warning'}`}>{t(stop.customerConfirmationStatus)}</span></p>
      <ScopeSummary scope={stop.workScope} />
    </li>)}</ol>
  </section>;
}
