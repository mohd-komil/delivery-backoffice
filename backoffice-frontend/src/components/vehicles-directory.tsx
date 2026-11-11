'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { vehicleSchema, type User, type Vehicle } from '@/lib/contracts';
import { ActionForm, Empty, Field, Notice, Pending, optionalText, textField } from './ui';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { PageHeadingTitle } from './page-help';
import { DataTable } from './ui/data-table';

export function VehiclesDirectory({ user }: { user: User }) {
  const t = useTranslations('directory');
  const locale = useLocale();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<number | null>(null);
  const [failureState, setFailureState] = useState<{ cause: unknown } | null>(null);
  const error = failureState ? errorMessage(failureState.cause, locale) : null;
  const [search, setSearch] = useState('');
  const [ownership, setOwnership] = useState('all');
  const [status, setStatus] = useState('all');
  const [editor, setEditor] = useState<{ key: string; base: Vehicle | undefined } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const loading = revision !== settled;
  const admin = user.role === 'admin';
  function refresh() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController(); pending.current = controller;
    void apiRequest('/vehicles', z.array(vehicleSchema), { signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) { setVehicles(value); setFailureState(null); setSettled(revision); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setFailureState({ cause: failure }); setSettled(revision); } },
    );
    return () => controller.abort();
  }, [revision]);
  function saved(vehicle: Vehicle) { pending.current?.abort(); setVehicles((current) => [...(current ?? []).filter((entry) => entry.id !== vehicle.id), vehicle]); setEditor(null); refresh(); }
  const query = search.trim().toLocaleLowerCase();
  const filtered = vehicles?.filter((vehicle) => `${vehicle.name} ${vehicle.plate} ${vehicle.providerName ?? ''} ${vehicle.providerContact ?? ''}`.toLocaleLowerCase().includes(query) && (ownership === 'all' || vehicle.ownership === ownership) && (status === 'all' || (status === 'disabled' ? !vehicle.enabled : vehicle.operationalStatus === status && vehicle.enabled))) ?? [];
  const changed = editor?.base && vehicles?.find((vehicle) => vehicle.id === editor.base?.id)?.version !== editor.base.version;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('vehiclesEyebrow')}</p><PageHeadingTitle title={t('vehicles')} topic="vehicles" /><p className="subtitle">{t('vehiclesSubtitle')}</p></div><div className="flex flex-wrap gap-2"><button className="button secondary" disabled={loading} onClick={refresh}>{t('refreshVehicles')}</button>{admin ? <button className="button" onClick={() => setEditor({ key: 'new', base: undefined })}>{t('newVehicleButton')}</button> : null}</div></div>
    <Notice>{admin ? t('maintainVehicles') + " " : t('vehicleOperatorNotice') + " "}{t('vehicleCrewBinding')}</Notice>
    <div className="directory-filters flex-wrap"><Field label={t('searchVehicles')}><Input value={search} onChange={(event) => setSearch(event.target.value)} /></Field><Field label={t('ownership')}><select value={ownership} onChange={(event) => setOwnership(event.target.value)}><option value="all">{t('allVehicles')}</option><option value="company">{t('company')}</option><option value="external">{t('external')}</option></select></Field><Field label={t('status')}><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{t('allStatuses')}</option><option value="available">{t('available')}</option><option value="maintenance">{t('maintenance')}</option><option value="out_of_service">{t('outOfService')}</option><option value="disabled">{t('disabled')}</option></select></Field></div>
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" role="status" aria-live="polite">{error ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{error}{vehicles ? " " + t('previousVehicles') : ''}</span><button className="text-button" disabled={loading} onClick={refresh}>{t('retryVehicles')}</button></> : <span className="muted">{vehicles && loading ? t('refreshingVehicles') : ''}</span>}</div>
    {!vehicles ? loading ? <Pending>{t('loadingVehicles')}</Pending> : <Empty title={t('vehiclesUnavailable')}>{t('retryCatalog')}</Empty> : <><DataTable containerClassName="table-wrap relative vehicles-table-region" className="vehicles-table min-w-[780px]" caption={t('vehiclesCaption')} resetKey={JSON.stringify([search, ownership, status])} header={<tr><th scope="col">{t('vehiclePlate')}</th><th scope="col">{t('ownership')}</th><th scope="col">{t('providerContactHeading')}</th><th scope="col">{t('status')}</th><th scope="col">{t('notes')}</th>{admin ? <th scope="col"><span className="sr-only">{t('manageVehicle')}</span></th> : null}</tr>} rows={filtered.map((vehicle) => <tr key={vehicle.id}><th scope="row" className="bg-transparent text-xs font-medium tracking-normal text-foreground normal-case">{vehicle.name}<span className="cell-sub font-mono">{vehicle.plate}</span></th><td className="capitalize">{t(vehicle.ownership)}</td><td>{vehicle.providerName ?? t('companyVehicle')}<span className="cell-sub">{vehicle.providerContact ?? t('noContact')}</span></td><td><span className={vehicle.enabled && vehicle.operationalStatus === 'available' ? 'badge success' : 'badge warning'}>{vehicle.enabled ? t('vehicleBadgeStatus', { status: vehicle.operationalStatus }) : t('disabled')}</span></td><td className="max-w-xs whitespace-pre-wrap">{vehicle.notes ?? '—'}</td>{admin ? <td><button className="button secondary small" aria-label={t('editNamedVehicle', { name: vehicle.name })} onClick={() => setEditor({ key: vehicle.id, base: vehicle })}>{t('editVehicle')}</button></td> : null}</tr>)} />{filtered.length === 0 ? <Empty title={vehicles.length === 0 ? t('noVehicles') : t('noMatchingVehicles')}>{t('addVehiclesHint')}</Empty> : null}</>}
    {editor && admin ? <Dialog open onOpenChange={(open) => { if (!open) setEditor(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{editor.base ? t('editVehicle') : t('newVehicle')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeVehicle')} onClick={() => setEditor(null)}>×</button></div>{changed ? <Notice>{t('newerVehicle')}</Notice> : null}<VehicleForm key={editor.key} vehicle={editor.base} onSaved={saved} /></DialogContent></Dialog> : null}
  </>;
}

function VehicleForm({ vehicle, onSaved }: { vehicle: Vehicle | undefined; onSaved: (value: Vehicle) => void }) {
  const t = useTranslations('directory');
  const [ownership, setOwnership] = useState<Vehicle['ownership']>(vehicle?.ownership ?? 'company');
  return <ActionForm submitLabel={vehicle ? t('saveVehicle') : t('createVehicle')} onSubmit={async (data) => {
    const name = textField(data, 'name');
    const plate = z.string().trim().toUpperCase().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9 -]*$/u).safeParse(textField(data, 'plate'));
    if (!plate.success) throw new Error(t('plateValidation'));
    const body = { name, plate: plate.data, ownership, providerName: ownership === 'external' ? optionalText(data, 'providerName') : null, providerContact: ownership === 'external' ? optionalText(data, 'providerContact') : null, operationalStatus: z.enum(['available', 'maintenance', 'out_of_service']).parse(textField(data, 'operationalStatus')), enabled: data.get('enabled') === 'on', notes: optionalText(data, 'notes'), ...(vehicle ? { version: vehicle.version } : {}) };
    if (ownership === 'external' && !body.providerName) throw new Error(t('requireProvider'));
    onSaved(await mutate(vehicle ? `/vehicles/${vehicle.id}` : '/vehicles', vehicleSchema, body, vehicle ? 'PATCH' : 'POST'));
  }}><Field label={t('vehicleName')}><Input name="name" required maxLength={200} defaultValue={vehicle?.name ?? ''} /></Field><div className="form-grid"><Field label={t('registrationPlate')}><Input name="plate" required maxLength={32} defaultValue={vehicle?.plate ?? ''} /></Field><Field label={t('ownership')}><select value={ownership} onChange={(event) => setOwnership(z.enum(['company', 'external']).parse(event.target.value))}><option value="company">{t('company')}</option><option value="external">{t('external')}</option></select></Field></div>{ownership === 'external' ? <><Field label={t('providerName')}><Input name="providerName" required maxLength={200} defaultValue={vehicle?.providerName ?? ''} /></Field><Field label={t('providerContact')}><Input name="providerContact" maxLength={500} defaultValue={vehicle?.providerContact ?? ''} /></Field></> : null}<Field label={t('operationalStatus')}><select name="operationalStatus" defaultValue={vehicle?.operationalStatus ?? 'available'}><option value="available">{t('available')}</option><option value="maintenance">{t('maintenance')}</option><option value="out_of_service">{t('outOfService')}</option></select></Field><Field label={t('notes')}><textarea name="notes" rows={3} maxLength={4000} defaultValue={vehicle?.notes ?? ''} /></Field><label className="checkbox-label"><Input name="enabled" type="checkbox" defaultChecked={vehicle?.enabled ?? true} />{t('enabledAllocations')}</label><p className="small muted">{t('vehicleStatusHint')}</p></ActionForm>;
}
