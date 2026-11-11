'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { apiRequest } from '@/lib/api';
import { reconciliationOwnersSchema, type ReconciliationOwner, type RouteRevision } from '@/lib/route-operations';
import { formatDateTime } from '@/lib/time';
import { DataTable } from './ui/data-table';

/** Immutable declarations and receipts belong to the selected version, never to today's editable form. */
export function RouteRevisionFacts({ snapshot }: { snapshot: RouteRevision }) {
  const t = useTranslations('routeOperations');
  const routes = useTranslations('routes');
  const pub = useTranslations('routePublication');
  const locale = useLocale();
  const [owners, setOwners] = useState<ReconciliationOwner[]>([]);
  useEffect(() => {
    if (!snapshot.runtime.reconciliation) return;
    const controller = new AbortController();
    void apiRequest('/routes/reconciliation-owners', reconciliationOwnersSchema, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setOwners(value); }, () => { /* Immutable owner IDs remain visible when the optional name lookup is unavailable. */ });
    return () => controller.abort();
  }, [snapshot.runtime.reconciliation]);
  const owner = (id: string) => owners.find((entry) => entry.id === id)?.name ?? id;
  const lineName = (appointmentId: string, sourceLineId: number) => {
    const stop = snapshot.data.review.stops.find((entry) => entry.appointmentId === appointmentId);
    const line = stop?.workScope.lines.find((entry) => entry.sourceLineId === sourceLineId);
    return [stop?.pickingName, line?.sourceItem.saleOrderId ? pub('order', { id: line.sourceItem.saleOrderId }) : null, line?.sourceItem.name, pub('line', { id: sourceLineId })].filter(Boolean).join(' · ');
  };
  const transports = [...new Map(snapshot.data.appointments.flatMap(({ appointment }) => appointment.transportAllocations ?? []).filter((allocation) => allocation.status === 'active').map((allocation) => [allocation.vehicle.id, allocation])).values()];
  const events = [
    { key: 'actualDeparture', value: snapshot.runtime.departed }, { key: 'returningAction', value: snapshot.runtime.returning },
    { key: 'abort', value: snapshot.runtime.aborted }, { key: 'cancel', value: snapshot.runtime.cancelled },
    { key: 'actualReturn', value: snapshot.runtime.returned }, { key: 'close', value: snapshot.runtime.closed },
  ] as const;
  return <section className="grid min-w-0 gap-4 rounded-lg border p-3">
    {transports.map((allocation) => <p key={allocation.vehicle.id} className="text-sm">{routes('vehicle')}: {allocation.vehicle.name} · {allocation.vehicle.plate}<span className="cell-sub">{allocation.driver.kind === 'participant' ? allocation.driver.person.name : allocation.driver.kind === 'external' ? `${allocation.driver.name} · ${allocation.driver.phone}` : '—'}</span></p>)}
    <dl className="grid gap-2 text-sm">{events.map(({ key, value }) => value ? <div key={key}><dt className="font-medium">{t(key)}</dt><dd>{formatDateTime('actualReturnedAt' in value ? value.actualReturnedAt : value.at, locale)} · {value.actor.name}{value.note ? ` · ${value.note}` : ''}</dd></div> : null)}</dl>
    {snapshot.runtime.skipped.map((entry) => <p key={entry.appointmentId} className="text-sm">{t('skipped')} · {snapshot.data.review.stops.find((stop) => stop.appointmentId === entry.appointmentId)?.pickingName} · {entry.note} · {entry.actor.name}</p>)}
    {snapshot.runtime.reconciliation ? <section className="grid gap-2"><h5 className="font-semibold">{t('reconcile')}</h5><p className="text-xs text-muted-foreground">{formatDateTime(snapshot.runtime.reconciliation.at, locale)} · {snapshot.runtime.reconciliation.actor.name} · {snapshot.runtime.reconciliation.reason}</p>
      <DataTable caption={t('reconcile')} header={<tr><th>{t('work')}</th><th>{t('nextAction')}</th><th>{t('cargo')}</th></tr>} rows={snapshot.runtime.reconciliation.lines.map((line) => <tr key={`${line.appointmentId}:${line.sourceLineId}`}><td className="max-w-sm whitespace-normal">{lineName(line.appointmentId, line.sourceLineId)}<span className="cell-sub">{t('owner')}: {owner(line.ownerUserId)} · {line.note}</span></td><td className="whitespace-normal">{line.nextActions.map((action) => <p key={action.operation}>{t(action.operation)}: {t(action.action)} · {owner(action.ownerUserId)} · {action.note}</p>)}</td><td className="whitespace-normal">{line.cargo.map((cargo) => <p key={cargo.kind}>{t(cargo.kind)}: {cargo.quantityMilli === null ? t('unknown') : cargo.quantityMilli / 1000} · {t(cargo.location)} · {cargo.note}</p>)}</td></tr>)} />
    </section> : null}
    {snapshot.runtime.warehouseReceipts.map((receipt) => <section key={receipt.id} className="grid gap-2"><h5 className="font-semibold">{t('receipts')}</h5><p className="text-xs text-muted-foreground">{formatDateTime(receipt.at, locale)} · {receipt.actor.name} · {receipt.reason}</p><ul className="grid gap-2 text-sm">{receipt.items.map((item) => <li key={`${item.appointmentId}:${item.sourceLineId}:${item.kind}`}>{lineName(item.appointmentId, item.sourceLineId)} · {t(item.kind)}: {item.quantityMilli / 1000} · {item.note}</li>)}</ul></section>)}
    {snapshot.runtime.closureException ? <p className="text-sm text-warning-foreground">{t('exceptionReason')}: {snapshot.runtime.closureException}</p> : null}
  </section>;
}
