'use client';

import { Combobox } from './ui/combobox';


import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { dispatcherContentText } from '@/i18n/dispatcher';
import { apiRequest, errorMessage } from '@/lib/api';
import type { DeliveryFocus, DeliveryTab } from '@/lib/contracts';
import { dispatcherFiltersSchema, dispatcherKindSchema, dispatcherListSchema, dispatcherOwnerSchema, dispatcherQuery, type DispatcherCase, type DispatcherFilters, type DispatcherList, type DispatcherOwner } from '@/lib/dispatcher';
import { formatDateTime } from '@/lib/time';
import { Empty, Field, Notice, Pending } from './ui';
import { Button } from './ui/button';
import { DataTable } from './ui/data-table';
import { PageHeadingTitle } from './page-help';
import { DispatcherCaseDialog } from './dispatcher-case-dialog';

export function DispatcherQueue({ refreshKey = 0, active = true, onOpenDelivery, onOpenRouteDraft }: {
  refreshKey?: number; active?: boolean; onOpenDelivery: (id: string, tab?: DeliveryTab, focus?: DeliveryFocus) => void; onOpenRouteDraft: (id: string) => void;
}) {
  const t = useTranslations('dispatcher');
  const locale = useLocale();
  const [filters, setFilters] = useState<DispatcherFilters>({ status: 'open', kind: 'all', owner: 'all', page: 1 });
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data: DispatcherList; owners: DispatcherOwner[] } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [activation, setActivation] = useState({ active, revision: 0 });
  if (activation.active !== active) setActivation({ active, revision: activation.revision + 1 });
  const query = dispatcherQuery(filters);
  const key = `${query}:${revision}:${refreshKey}:${activation.revision}`;
  const ready = loaded?.key === key && failure === null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.all([apiRequest(`/dispatcher/queue?${query}`, dispatcherListSchema, { signal: controller.signal }),
      apiRequest('/dispatcher/owners', z.array(dispatcherOwnerSchema), { signal: controller.signal })]).then(([data, owners]) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
      if (data.page > lastPage) { setFilters((current) => ({ ...current, page: lastPage })); return; }
      setLoaded({ key, data, owners }); setFailure(null);
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [query, key, active]);
  function refresh() { setFailure(null); setRevision((value) => value + 1); }
  function openOriginal(item: DispatcherCase) {
    const target = item.target;
    if (target.section === 'routes' && target.routeId) onOpenRouteDraft(target.routeId);
    else if (target.section === 'deliveries' && target.deliveryId) onOpenDelivery(target.deliveryId, target.tab ?? 'overview', item.origin);
  }
  const data = loaded?.data;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('eyebrow')}</p><PageHeadingTitle title={t('title')} topic="decisions" /><p className="subtitle">{t('subtitle')}</p></div>
      <Button type="button" variant="outline" disabled={!ready && failure === null} onClick={refresh}>{t('refresh')}</Button></div>
    {data ? <div className="mb-4 text-xs text-muted-foreground"><p className="font-medium text-foreground">{t('counts', { open: data.counts.open, resolved: data.counts.resolved })}</p><p className="mt-1">{t('countsHelp')}</p></div> : null}
    <div className="mb-4 grid gap-x-4 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-3">
      <Field label={t('status')}><Combobox value={filters.status} onChange={(event) => { setFailure(null); setFilters((current) => ({ ...current, page: 1, status: dispatcherFiltersSchema.shape.status.parse(event.target.value) })); }}>{(['open', 'resolved', 'all'] as const).map((status) => <option key={status} value={status}>{t(status)}</option>)}</Combobox></Field>
      <Field label={t('kind')}><Combobox value={filters.kind} onChange={(event) => { setFailure(null); setFilters((current) => ({ ...current, page: 1, kind: dispatcherFiltersSchema.shape.kind.parse(event.target.value) })); }}><option value="all">{t('all')}</option>{dispatcherKindSchema.options.map((kind) => <option key={kind} value={kind}>{t(kind)}{data ? ` (${data.counts.kinds[kind]})` : ''}</option>)}</Combobox></Field>
      <Field label={t('ownerFilter')}><Combobox value={filters.owner} onChange={(event) => { setFailure(null); setFilters((current) => ({ ...current, page: 1, owner: dispatcherFiltersSchema.shape.owner.parse(event.target.value) })); }}>{(['all', 'unassigned', 'mine'] as const).map((owner) => <option key={owner} value={owner}>{t(owner)}</option>)}{loaded?.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</Combobox></Field>
    </div>
    <div className="mb-3 min-h-6 text-xs" role="status">{failure ? <Notice tone="error">{t('failed')} {errorMessage(failure, locale)} <Button type="button" variant="outline" size="sm" onClick={refresh}>{t('retry')}</Button></Notice> : !ready && data ? t('refreshing') : null}</div>
    {!data && !failure ? <Pending>{t('loading')}</Pending> : null}
    {data ? <DataTable caption={t('title')} containerClassName="dispatcher-table-region" resetKey={query}
      header={<tr><th scope="col">{t('case')}</th><th scope="col">{t('delivery')}</th><th scope="col">{t('nextAction')}</th><th scope="col">{t('ownerFilter')}</th><th scope="col">{t('status')}</th><th scope="col">{t('updated')}</th></tr>}
      pagination={{ page: data.page, pageSize: data.pageSize, total: data.total, disabled: !ready, onPageChange: (page) => setFilters((current) => ({ ...current, page })) }}
      rows={data.items.map((item) => <tr key={item.key}>
        <th scope="row" className="max-w-64 whitespace-normal text-sm font-medium normal-case"><button className="text-button text-left" disabled={!ready} onClick={() => setSelected(item.key)}>{t(item.kind)}</button><span className="cell-sub">{dispatcherContentText(item.title, locale)}</span></th>
        <td className="max-w-72 whitespace-normal"><strong>{item.pickingName ?? item.customerName ?? t('notProvided')}</strong><span className="cell-sub">{item.customerName}</span><span className="cell-sub">{[item.orderName, item.productName].filter(Boolean).join(' · ')}</span>{item.origin.sourceLineId ? <span className="cell-sub font-mono">{t('line', { id: item.origin.sourceLineId })}</span> : null}</td>
        <td className="max-w-72 whitespace-normal [overflow-wrap:anywhere]">{item.nextAction ?? dispatcherContentText(item.description, locale)}{item.coordinationStale ? <span className="cell-sub text-warning-foreground">{t('coordinationStale')}</span> : null}</td>
        <td>{item.owner?.name ?? t('unassigned')}<span className="cell-sub">{item.ownerSource === 'source' ? t('inheritedOwner') : item.ownerSource === 'coordination' ? t('explicitOwner') : ''}</span></td>
        <td><span className={`badge ${item.status === 'open' ? 'warning' : 'success'}`}>{t(item.status)}</span></td>
        <td className="whitespace-nowrap text-xs">{item.updatedAt ? formatDateTime(item.updatedAt, locale) : '—'}</td>
      </tr>)} emptyRow={<tr><td colSpan={6}><Empty title={t('empty')}>{t('emptyHelp')}</Empty></td></tr>} /> : null}
    {selected ? <DispatcherCaseDialog key={selected} active={active} caseKey={selected} refreshKey={`${revision}:${refreshKey}:${activation.revision}`} owners={loaded?.owners ?? []}
      onClose={() => setSelected(null)} onSaved={refresh} onOpenOriginal={openOriginal} /> : null}
  </>;
}
