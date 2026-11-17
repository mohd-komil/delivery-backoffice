'use client';

import { Combobox } from './ui/combobox';


import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { planningLocationDetailSchema, planningLocationFieldsSchema, planningLocationsSchema, type PlanningLocation } from '@/lib/planning-locations';
import { coordinateFromText, mapCoordinatesSchema } from '@/lib/map-coordinates';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Empty, Field, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { PlanningEditor, PlanningHistory, PlanningReadState, PlanningReason, usePlanningCommand, usePlanningRead } from './planning-reference-common';

export function PlanningLocations({ active }: { active: boolean }) {
  const t = useTranslations('planning'); const locale = useLocale();
  const read = usePlanningRead('/planning/locations', planningLocationsSchema, active);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<{ base: PlanningLocation | null } | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  function refresh() { read.refresh(); setDetailRevision((value) => value + 1); }
  const query = search.trim().toLocaleLowerCase();
  const rows = read.data?.locations.filter((item) => `${item.name} ${Object.values(item.address).join(' ')}`.toLocaleLowerCase().includes(query)
    && (status === 'all' || item.enabled === (status === 'enabled'))) ?? [];
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-3xl text-sm text-muted-foreground">{t('locationsHelp')}</p><div className="flex gap-2"><Button variant="outline" disabled={read.loading} onClick={refresh}>{t('refresh')}</Button><Button onClick={() => setEditing({ base: null })}>{t('add')}</Button></div></div>
    <div className="mt-4 grid gap-x-4 sm:grid-cols-2"><Field label={t('search')}><Input value={search} onChange={(event) => setSearch(event.target.value)} /></Field><Field label={t('status')}><Combobox value={status} onChange={(event) => setStatus(event.target.value)}>{(['all', 'enabled', 'disabled'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field></div>
    <PlanningReadState data={read.data !== null} failure={read.failure} loading={read.loading} retry={refresh} />
    {read.data ? <DataTable caption={t('locations')} resetKey={`${search}:${status}`} header={<tr><th>{t('name')}</th><th>{t('street')}</th><th>{t('verification')}</th><th>{t('status')}</th><th>{t('updated')}</th><th><span className="sr-only">{t('edit')}</span></th></tr>}
      rows={rows.map((item) => <tr key={item.id}><th scope="row" className="text-sm font-medium normal-case"><span>{item.name}</span><span className="cell-sub">{t(item.kind)}</span>{item.demo ? <span className="badge warning mt-1">DEMO</span> : null}</th><td className="max-w-72 whitespace-normal">{[item.address.street, item.address.city, item.address.province, item.address.postalCode, item.address.country].filter(Boolean).join(', ') || '—'}<span className="cell-sub font-mono">{item.unloadingEntrance ? `${item.unloadingEntrance.point.latitude}, ${item.unloadingEntrance.point.longitude}` : item.point ? `${item.point.latitude}, ${item.point.longitude}` : t('pointMissing')}</span></td><td><span className={`badge ${item.verification === 'operator_confirmed' ? 'success' : 'warning'}`}>{t(item.verification)}</span></td><td>{t(item.enabled ? 'enabled' : 'disabled')}</td><td className="text-xs">{formatDateTime(item.updatedAt, locale)}</td><td><Button size="sm" variant="outline" disabled={!read.ready} onClick={() => setEditing({ base: item })}>{t('edit')}</Button></td></tr>)} emptyRow={<tr><td colSpan={6}><Empty title={t('noResults')} /></td></tr>} /> : null}
    {editing && active ? <LocationEditor key={editing.base?.id ?? 'new'} initial={editing.base} revision={detailRevision} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
  </>;
}

function LocationEditor({ initial, revision, onClose, onSaved }: { initial: PlanningLocation | null; revision: number; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('planning'); const [base, setBase] = useState(initial);
  const read = usePlanningRead(initial ? `/planning/locations/${initial.id}` : null, planningLocationDetailSchema, true, revision);
  const latest = read.data?.location ?? base; const command = usePlanningCommand();
  return <PlanningEditor title={base?.name ?? t('locations')} onClose={onClose} refresh={initial ? read.refresh : undefined} loading={read.loading}>
    <PlanningReadState data={base !== null} failure={read.failure} loading={read.loading} retry={read.refresh} />
    <ActionForm dataVersion={latest?.version} onResetDraft={() => setBase(latest)} submitDisabled={initial !== null && !read.ready} submitLabel={t('save')} successMessage={t('saved')}
      onSubmit={async (data) => {
        const point = pointField(data, 'address'); const entrance = pointField(data, 'entrance');
        const entranceNote = textField(data, 'entranceNote');
        if (entrance === null && entranceNote) throw new Error(t('entranceHelp'));
        const fields = planningLocationFieldsSchema.parse({ name: textField(data, 'name'), kind: textField(data, 'kind'),
          address: { street: textField(data, 'street'), city: textField(data, 'city'), province: textField(data, 'province'), postalCode: textField(data, 'postalCode'), country: textField(data, 'country') },
          point, unloadingEntrance: entrance ? { point: entrance, note: entranceNote } : null,
          coordinateSource: textField(data, 'coordinateSource'), verification: textField(data, 'verification'), enabled: data.get('enabled') === 'on', demo: data.get('demo') === 'on' });
        const saved = await command(base ? `/planning/locations/${base.id}` : '/planning/locations', planningLocationDetailSchema,
          { ...fields, reason: textField(data, 'reason'), ...(base ? { version: base.version } : {}) }, base ? 'PATCH' : 'POST');
        onSaved(); return saved.location.version;
      }}>
      <div className="grid gap-x-4 sm:grid-cols-2"><Field label={t('name')}><Input name="name" required maxLength={200} defaultValue={base?.name ?? ''} /></Field><Field label={t('type')}><Combobox name="kind" defaultValue={base?.kind ?? 'warehouse'}><option value="warehouse">{t('warehouse')}</option><option value="other">{t('other')}</option></Combobox></Field></div>
      <Field label={t('street')}><Input name="street" maxLength={500} defaultValue={base?.address.street ?? ''} /></Field>
      <div className="grid gap-x-4 sm:grid-cols-2">{(['city', 'province', 'postalCode', 'country'] as const).map((field) => <Field key={field} label={t(field)}><Input name={field} maxLength={field === 'postalCode' ? 30 : field === 'country' ? 100 : 200} defaultValue={base?.address[field] ?? ''} /></Field>)}</div>
      <CoordinateFields prefix="address" label={t('addressPoint')} point={base?.point ?? null} />
      <div className="rounded-md border border-border bg-muted/20 p-3"><CoordinateFields prefix="entrance" label={t('entrance')} point={base?.unloadingEntrance?.point ?? null} /><Field label={t('entranceNote')} hint={t('entranceHelp')}><textarea name="entranceNote" rows={2} maxLength={2000} defaultValue={base?.unloadingEntrance?.note ?? ''} /></Field></div>
      <div className="grid gap-x-4 sm:grid-cols-2"><Field label={t('coordinateSource')}><Combobox name="coordinateSource" defaultValue={base?.coordinateSource ?? 'manual'}>{(['manual', 'public_demo'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field><Field label={t('verification')}><Combobox name="verification" defaultValue={base?.verification ?? 'unverified'}>{(['unverified', 'operator_confirmed'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field></div>
      <label className="checkbox-label"><Input name="enabled" type="checkbox" defaultChecked={base?.enabled ?? true} />{t('enabled')}</label><p className="text-xs text-muted-foreground">{t('availableHelp')}</p>
      <label className="checkbox-label"><Input name="demo" type="checkbox" defaultChecked={base?.demo ?? false} />{t('demo')}</label><p className="text-xs text-muted-foreground">{t('demoHelp')}</p><PlanningReason />
    </ActionForm>
    {read.data ? <PlanningHistory entries={read.data.history.map((event) => ({ ...event, snapshot: <LocationSnapshot item={event.snapshot} /> }))} /> : null}
  </PlanningEditor>;
}

function pointField(data: FormData, prefix: string) {
  const latitude = textField(data, `${prefix}Latitude`); const longitude = textField(data, `${prefix}Longitude`);
  return !latitude && !longitude ? null : mapCoordinatesSchema.parse({ latitude: coordinateFromText(latitude), longitude: coordinateFromText(longitude) });
}
function CoordinateFields({ prefix, label, point }: { prefix: string; label: string; point: PlanningLocation['point'] }) {
  const t = useTranslations('planning');
  return <fieldset><legend className="mb-2 text-sm font-medium">{label}</legend><div className="grid gap-x-4 sm:grid-cols-2"><Field label={t('latitude')}><Input name={`${prefix}Latitude`} inputMode="decimal" defaultValue={point?.latitude ?? ''} maxLength={30} /></Field><Field label={t('longitude')}><Input name={`${prefix}Longitude`} inputMode="decimal" defaultValue={point?.longitude ?? ''} maxLength={30} /></Field></div></fieldset>;
}
export function LocationSnapshot({ item }: { item: PlanningLocation }) {
  const t = useTranslations('planning'); const locale = useLocale();
  return <div className="grid gap-1 whitespace-pre-wrap [overflow-wrap:anywhere]"><p className="font-medium">{item.name} · {t(item.kind)} {item.demo ? '· DEMO' : ''}</p><p>{Object.values(item.address).filter(Boolean).join(', ')}</p><p>{t(item.verification)} · {t(item.enabled ? 'enabled' : 'disabled')} · {t(item.coordinateSource)}</p><p className="font-mono">{t('addressPoint')}: {item.point ? `${item.point.latitude}, ${item.point.longitude}` : t('pointMissing')}</p>{item.unloadingEntrance ? <p>{t('entrance')}: {item.unloadingEntrance.point.latitude}, {item.unloadingEntrance.point.longitude} · {item.unloadingEntrance.note}</p> : null}{item.confirmedBy && item.confirmedAt ? <p>{t('confirmedBy', { name: item.confirmedBy.name, date: formatDateTime(item.confirmedAt, locale) })}</p> : null}</div>;
}
