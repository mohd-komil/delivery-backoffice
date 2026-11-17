'use client';

import { Combobox } from './ui/combobox';


import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { timeStandardDetailSchema, timeStandardFieldsSchema, timeStandardSchema, timeStandardsListSchema, type TimeStandard } from '@/lib/planning-time-standards';
import { operationApplies, serviceTypeSchema, type ServiceType } from '@/lib/service-types';
import { workTimeOperations, workTimeRateInputSchema } from '@/lib/work-times';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Empty, Field, optionalText, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { deliveryServiceLabel } from './delivery-detail-presentation';
import { PlanningEditor, PlanningHistory, PlanningReadState, PlanningReason, usePlanningCommand, usePlanningRead } from './planning-reference-common';

export function PlanningTimeStandards({ active }: { active: boolean }) {
  const t = useTranslations('planning'); const deliveryText = useTranslations('delivery'); const locale = useLocale();
  const read = usePlanningRead('/planning/time-standards', timeStandardsListSchema, active);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all'); const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{ base: TimeStandard | null } | null>(null);
  function refresh() { read.refresh(); setRevision((value) => value + 1); }
  const query = search.trim().toLocaleLowerCase();
  const rows = read.data?.filter((item) => `${item.name} ${item.unit} ${item.category ?? ''} ${item.sourceReference}`.toLocaleLowerCase().includes(query)
    && (status === 'all' || (status === 'disabled' ? !item.enabled : item.enabled && item.status === status))) ?? [];
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-3xl text-sm text-muted-foreground">{t('standardsHelp')}</p><div className="flex gap-2"><Button variant="outline" disabled={read.loading} onClick={refresh}>{t('refresh')}</Button><Button onClick={() => setEditing({ base: null })}>{t('add')}</Button></div></div>
    <div className="mt-4 grid gap-x-4 sm:grid-cols-2"><Field label={t('search')}><Input value={search} onChange={(event) => setSearch(event.target.value)} /></Field><Field label={t('status')}><Combobox value={status} onChange={(event) => setStatus(event.target.value)}>{(['all', 'draft', 'confirmed', 'disabled'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field></div>
    <PlanningReadState data={read.data !== null} failure={read.failure} loading={read.loading} retry={refresh} />
    {read.data ? <DataTable caption={t('standards')} resetKey={`${search}:${status}`} header={<tr><th>{t('name')}</th><th>{t('service')}</th><th>{t('rates')}</th><th>{t('status')}</th><th>{t('updated')}</th><th><span className="sr-only">{t('edit')}</span></th></tr>}
      rows={rows.map((item) => <tr key={item.id}><th scope="row" className="text-sm font-medium normal-case">{item.name}<span className="cell-sub">{item.category}</span></th><td>{deliveryServiceLabel(deliveryText, item.service)}<span className="cell-sub">{item.unit}</span></td><td><StandardRates item={item} /><span className="cell-sub">{t(item.basis)}</span></td><td><span className={`badge ${item.enabled && item.status === 'confirmed' ? 'success' : 'warning'}`}>{t(item.enabled ? item.status : 'disabled')}</span></td><td className="text-xs">{formatDateTime(item.updatedAt, locale)}</td><td><Button size="sm" variant="outline" disabled={!read.ready} onClick={() => setEditing({ base: item })}>{t('edit')}</Button></td></tr>)} emptyRow={<tr><td colSpan={6}><Empty title={t('noResults')} /></td></tr>} /> : null}
    {editing && active ? <TimeStandardEditor key={editing.base?.id ?? 'new'} initial={editing.base} revision={revision} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
  </>;
}

function TimeStandardEditor({ initial, revision, onClose, onSaved }: { initial: TimeStandard | null; revision: number; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('planning'); const [base, setBase] = useState(initial); const command = usePlanningCommand();
  const read = usePlanningRead(initial ? `/planning/time-standards/${initial.id}` : null, timeStandardDetailSchema, true, revision);
  const latest = read.data?.item ?? base;
  return <PlanningEditor title={base?.name ?? t('standards')} onClose={onClose} refresh={initial ? read.refresh : undefined} loading={read.loading}>
    <PlanningReadState data={base !== null} failure={read.failure} loading={read.loading} retry={read.refresh} />
    <ActionForm dataVersion={latest?.version} onResetDraft={() => setBase(latest)} submitDisabled={initial !== null && !read.ready} submitLabel={t('save')} successMessage={t('saved')} onSubmit={async (data) => {
      const service = serviceTypeSchema.parse(textField(data, 'service'));
      const fields = timeStandardFieldsSchema.parse({ name: textField(data, 'name'), service, unit: textField(data, 'unit'), category: optionalText(data, 'category'),
        rates: { deliveryMinutesPerUnit: operationApplies(service, 'delivery') ? workTimeRateInputSchema.parse(textField(data, 'deliveryMinutesPerUnit')) : null,
          installationMinutesPerUnit: operationApplies(service, 'installation') ? workTimeRateInputSchema.parse(textField(data, 'installationMinutesPerUnit')) : null,
          collectionMinutesPerUnit: operationApplies(service, 'collection') ? workTimeRateInputSchema.parse(textField(data, 'collectionMinutesPerUnit')) : null },
        basis: textField(data, 'basis'), assumptions: textField(data, 'assumptions'), exclusions: textField(data, 'exclusions'), examples: textField(data, 'examples'), sourceReference: textField(data, 'sourceReference'),
        status: textField(data, 'status'), enabled: data.get('enabled') === 'on' });
      const saved = await command(base ? `/planning/time-standards/${base.id}` : '/planning/time-standards', timeStandardSchema,
        { ...fields, reason: textField(data, 'reason'), ...(base ? { version: base.version } : {}) }, base ? 'PATCH' : 'POST'); onSaved(); return saved.version;
    }}><StandardFields item={base} /><PlanningReason /></ActionForm>
    {read.data ? <PlanningHistory entries={read.data.history.map((event) => ({ ...event, snapshot: <StandardSnapshot item={event.after} /> }))} /> : null}
  </PlanningEditor>;
}

function StandardFields({ item }: { item: TimeStandard | null }) {
  const t = useTranslations('planning'); const deliveryText = useTranslations('delivery');
  const [service, setService] = useState<ServiceType>(item?.service ?? 'delivery_only');
  return <>
    <Field label={t('name')}><Input name="name" required maxLength={200} defaultValue={item?.name ?? ''} /></Field>
    <div className="grid gap-x-4 sm:grid-cols-2"><Field label={t('service')}><Combobox name="service" value={service} onChange={(event) => setService(serviceTypeSchema.parse(event.target.value))}>{serviceTypeSchema.options.map((value) => <option key={value} value={value}>{deliveryServiceLabel(deliveryText, value)}</option>)}</Combobox></Field><Field label={t('unit')} hint={t('unitHelp')}><Input name="unit" required maxLength={80} defaultValue={item?.unit ?? ''} /></Field></div>
    <Field label={t('category')}><Input name="category" maxLength={200} defaultValue={item?.category ?? ''} /></Field>
    <Field label={t('basis')} hint={t('basisHelp')}><Combobox name="basis" defaultValue={item?.basis ?? 'unspecified'}>{(['unspecified', 'elapsed_team_minutes', 'person_minutes'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field>
    <div className="grid gap-x-3 sm:grid-cols-3">{workTimeOperations.map((operation) => <Field key={operation.key} label={t('rate', { operation: t(operation.key) })}><Input name={operation.field} type="number" inputMode="numeric" min={1} max={1440} step={1} disabled={!operationApplies(service, operation.key)} defaultValue={item?.rates[operation.field] ?? ''} /></Field>)}</div>
    {(['sourceReference', 'assumptions', 'exclusions', 'examples'] as const).map((field) => <Field key={field} label={t(field === 'sourceReference' ? 'source' : field)}><textarea name={field} rows={2} maxLength={2000} defaultValue={item?.[field] ?? ''} /></Field>)}
    <Field label={t('status')} hint={t('confirmHelp')}><Combobox name="status" defaultValue={item?.status ?? 'draft'}><option value="draft">{t('draft')}</option><option value="confirmed">{t('confirmed')}</option></Combobox></Field>
    <label className="checkbox-label"><Input name="enabled" type="checkbox" defaultChecked={item?.enabled ?? true} />{t('enabled')}</label><p className="text-xs text-muted-foreground">{t('availableHelp')}</p>
  </>;
}
export function StandardRates({ item }: { item: Pick<TimeStandard, 'rates'> }) {
  const t = useTranslations('planning');
  return <span className="grid gap-1 text-xs tabular-nums">{workTimeOperations.filter((operation) => item.rates[operation.field] !== null).map((operation) => <span key={operation.key}>{t(operation.key)}: {item.rates[operation.field]}</span>)}</span>;
}
export function StandardSnapshot({ item }: { item: Pick<TimeStandard, 'name' | 'version' | 'service' | 'unit' | 'category' | 'rates' | 'basis' | 'assumptions' | 'exclusions' | 'examples' | 'sourceReference'> }) {
  const t = useTranslations('planning'); const deliveryText = useTranslations('delivery');
  return <div className="grid gap-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"><p className="font-medium">{item.name} · v{item.version}</p><p>{deliveryServiceLabel(deliveryText, item.service)} · {item.unit} · {t(item.basis)}</p>{item.category ? <p>{item.category}</p> : null}<StandardRates item={item} />{(['sourceReference', 'assumptions', 'exclusions', 'examples'] as const).map((field) => item[field] ? <p key={field}><strong>{t(field === 'sourceReference' ? 'source' : field)}:</strong> {item[field]}</p> : null)}</div>;
}
