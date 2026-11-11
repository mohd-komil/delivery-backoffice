'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { apiRequest, errorMessage } from '@/lib/api';
import { transportAvailabilitySchema, type Appointment, type TransportAllocation, type TransportAvailability, type Vehicle } from '@/lib/contracts';
import { formatDateTime, parseBookingInstant } from '@/lib/time';
import { DateTimeFields, dateTimeField } from './date-time-fields';
import { ActionForm, ChoiceGroup, Field, Notice, Pending, textField } from './ui';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { deliveryStatusLabel, type DeliveryText } from './delivery-detail-presentation';

type Command = (path: string, body: unknown, method?: string) => Promise<number>;
type TransportAction = { kind: 'add' } | { kind: 'replace' | 'cancel'; allocation: TransportAllocation };
type ReservationWindow = { from: string; to: string };

function driverLabel(driver: TransportAllocation['driver'], t: DeliveryText): string {
  return driver.kind === 'none' ? t('driverUnspecified') : driver.kind === 'participant' ? driver.person.name : t('externalName', { name: `${driver.name} · ${driver.phone}` });
}

export function TransportReadout({ allocations, title, emptyMessage }: { allocations: TransportAllocation[]; title?: string; emptyMessage?: string }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  return <section className="my-4 min-w-0"><h4>{title ?? t('transportHistory')}</h4>{allocations.length === 0 ? <p className="small muted">{emptyMessage ?? t('noTransport')}</p> : <ul className="mt-2 space-y-3">{allocations.map((allocation) => <li className="rounded-md border border-border p-3 text-xs [overflow-wrap:anywhere]" key={allocation.id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong>{allocation.vehicle.name} · <span className="font-mono">{allocation.vehicle.plate}</span></strong><span className={allocation.status === 'active' ? 'badge success' : 'badge neutral'}>{deliveryStatusLabel(t, allocation.status)}</span></div>
    <p className="mt-2">{t('reservedRange', { from: formatDateTime(allocation.reserveFrom, locale), to: formatDateTime(allocation.reserveTo, locale) })}</p><p className="mt-1">{driverLabel(allocation.driver, t)}</p>
    {allocation.vehicle.ownership === 'external' ? <p className="mt-1 muted">{allocation.vehicle.providerName} · {allocation.vehicle.providerContact ?? t('providerContactMissing')}</p> : null}
    <p className="mt-1 muted">{t('recordedBy', { name: allocation.createdBy.name, date: formatDateTime(allocation.createdAt, locale) })}</p>{allocation.replacesAllocationId ? <p className="mt-1 muted">{t('replacementPreserved')}</p> : null}
    {allocation.retirementReason ? <p className="mt-1">{t(allocation.status === 'replaced' ? 'replacement' : 'cancellation')}: {allocation.retirementReason}{allocation.retiredBy ? ` · ${allocation.retiredBy.name}` : ''}{allocation.retiredAt ? ` · ${formatDateTime(allocation.retiredAt, locale)}` : ''}</p> : null}
  </li>)}</ul>}</section>;
}

export function VisitTransport({ deliveryId, version, appointment, vehicles, closed, refreshKey, command }: { deliveryId: string; version: number; appointment: Appointment; vehicles: readonly Vehicle[]; closed: boolean; refreshKey: number; command: Command }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const [action, setAction] = useState<TransportAction | null>(null);
  const allocations = appointment.transportAllocations ?? [];
  const activeAllocations = allocations.filter((allocation) => allocation.status === 'active');
  const mutable = appointment.status === 'booked' && appointment.results.length === 0 && !closed;
  return <div className="section-gap min-w-0" data-visit-transport={appointment.id}>
    <TransportReadout allocations={activeAllocations} emptyMessage={t('noActiveTransport')} />
    {allocations.length > activeAllocations.length ? <p className="small muted">{t('transportHistoryHint')}</p> : null}
    {activeAllocations.map((allocation) => {
      const current = vehicles.find((vehicle) => vehicle.id === allocation.vehicle.id);
      const warning = !current ? t('vehicleMissing') : !current.enabled ? t('vehicleDisabled') : current.operationalStatus !== 'available' ? t('vehicleOperationalWarning', { status: deliveryStatusLabel(t, current.operationalStatus) }) : null;
      return warning ? <Notice key={allocation.id}>{t('reservationPreserved', { vehicle: allocation.vehicle.name, plate: allocation.vehicle.plate, warning })} {mutable ? t('mutableTransportReview') : t('transportReview')}</Notice> : null;
    })}
    {mutable ? <><div className="flex flex-wrap gap-2">{appointment.assignments.length > 0 ? <button className="button secondary small" onClick={() => setAction({ kind: 'add' })}>{t('allocateVehicleButton')}</button> : null}{activeAllocations.map((allocation) => <div className="flex flex-wrap gap-2" key={allocation.id}><button className="button secondary small" aria-label={t('replaceResource', { name: allocation.vehicle.name })} onClick={() => setAction({ kind: 'replace', allocation })}>{t('replaceResource', { name: allocation.vehicle.plate })}</button><button className="button secondary small" aria-label={t('cancelTransportResource', { name: allocation.vehicle.name })} onClick={() => setAction({ kind: 'cancel', allocation })}>{t('cancelResource', { name: allocation.vehicle.plate })}</button></div>)}</div>{appointment.assignments.length === 0 ? <p className="mt-2 small muted">{t('assignBeforeTransport')}</p> : null}<p className="mt-2 small muted">{t('transportWindowHint')}</p></> : <p className="small muted">{t('immutableTransportHint')}</p>}
    {action && mutable ? <Dialog open onOpenChange={(open) => { if (!open) setAction(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{action.kind === 'add' ? t('allocateVisitTransport') : action.kind === 'replace' ? t('replaceVisitVehicle') : t('cancelVisitTransport')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeTransportEditor')} onClick={() => setAction(null)}>×</button></div><p className="small muted mb-4">{t('visitTimeRange', { from: formatDateTime(appointment.startsAt, locale), to: formatDateTime(appointment.endsAt, locale) })}</p><TransportEditor key={action.kind === 'add' ? 'add' : `${action.kind}-${action.allocation.id}`} deliveryId={deliveryId} version={version} appointment={appointment} action={action} refreshKey={refreshKey} command={command} onSaved={() => setAction(null)} /></DialogContent></Dialog> : null}
  </div>;
}

function checkedWindow(data: FormData, appointment: Appointment, t: DeliveryText): ReservationWindow {
  const from = dateTimeField(data, 'reserveFrom', t); const to = dateTimeField(data, 'reserveTo', t);
  if (Date.parse(to) <= Date.parse(from)) throw new Error(t('reservationOrder'));
  if (Date.parse(from) > Date.parse(appointment.startsAt) || Date.parse(to) < Date.parse(appointment.endsAt)) throw new Error(t('reservationCoverage'));
  if (Date.parse(to) - Date.parse(from) > 45 * 86_400_000) throw new Error(t('reservationLimit'));
  return { from, to };
}

function conflictText(conflicts: TransportAvailability['people'][number]['conflicts'], locale: string): string {
  return conflicts.map((conflict) => `${conflict.pickingName} · ${formatDateTime(conflict.startsAt, locale)} → ${formatDateTime(conflict.endsAt, locale)}`).join('; ');
}

function TransportEditor({ deliveryId, version, appointment, action, refreshKey, command, onSaved }: { deliveryId: string; version: number; appointment: Appointment; action: TransportAction; refreshKey: number; command: Command; onSaved: () => void }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const original = action.kind === 'add' ? undefined : action.allocation;
  const initialWindow = { from: parseBookingInstant(original?.reserveFrom ?? appointment.startsAt), to: parseBookingInstant(original?.reserveTo ?? appointment.endsAt) };
  const [window, setWindow] = useState(initialWindow);
  const [revision, setRevision] = useState(0);
  const [availability, setAvailability] = useState<{ window: ReservationWindow; data: TransportAvailability } | null>(null);
  const queryKey = `${deliveryId}/${appointment.id}/${window.from}/${window.to}/${revision}/${refreshKey}`;
  const [settled, setSettled] = useState<string | null>(null);
  const loading = action.kind !== 'cancel' && settled !== queryKey;
  const [error, setError] = useState<string | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const [driverKind, setDriverKind] = useState<'none' | 'participant' | 'external'>(original?.driver.kind ?? 'none');
  const [participantId, setParticipantId] = useState(original?.driver.kind === 'participant' ? original.driver.person.id : '');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const groupId = useId();
  useEffect(() => {
    if (action.kind === 'cancel') return;
    const controller = new AbortController();
    void apiRequest(`/deliveries/${deliveryId}/appointments/${appointment.id}/transport/availability?${new URLSearchParams({ from: window.from, to: window.to })}`, transportAvailabilitySchema, { signal: controller.signal }).then(
      (data) => { if (!controller.signal.aborted) { setAvailability({ window, data }); setError(null); setSettled(queryKey); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(failure, locale)); setSettled(queryKey); } },
    );
    return () => controller.abort();
  }, [deliveryId, appointment.id, action.kind, window, revision, refreshKey, queryKey, locale]);
  const otherActive = (appointment.transportAllocations ?? []).filter((allocation) => allocation.status === 'active' && allocation.id !== original?.id);
  function vehicleProblem(vehicle: TransportAvailability['vehicles'][number]): string | null {
    if (otherActive.some((allocation) => allocation.vehicle.id === vehicle.id)) return t('alreadyAllocated');
    if (!vehicle.enabled) return t('allocationDisabled');
    if (vehicle.operationalStatus !== 'available') return t('operationalStatus', { status: deliveryStatusLabel(t, vehicle.operationalStatus) });
    return vehicle.busy ? t('reservedConflict', { conflicts: conflictText(vehicle.conflicts, locale) }) : null;
  }
  function personProblem(person: TransportAvailability['people'][number]): string | null {
    if (otherActive.some((allocation) => allocation.driver.kind === 'participant' && allocation.driver.person.id === person.id)) return t('alreadyDriving');
    if (!person.enabled) return t('allocationDisabled');
    return person.busy ? t('occupiedConflict', { conflicts: conflictText(person.conflicts, locale) }) : null;
  }
  const selectedVehicle = availability?.data.vehicles.find((vehicle) => vehicle.id === vehicleId);
  const selectedPerson = availability?.data.people.find((person) => person.id === participantId);
  const selectedProblem = vehicleId && (!selectedVehicle || vehicleProblem(selectedVehicle)) ? selectedVehicle ? vehicleProblem(selectedVehicle) : t('selectedVehicleMissing') : driverKind === 'participant' && participantId && (!selectedPerson || personProblem(selectedPerson)) ? selectedPerson ? personProblem(selectedPerson) : t('selectedDriverMissing') : null;
  function resetDraft() { request.current = null; setWindow(initialWindow); setVehicleId(''); setDriverKind(original?.driver.kind ?? 'none'); setParticipantId(original?.driver.kind === 'participant' ? original.driver.person.id : ''); setRevision((value) => value + 1); }
  return <ActionForm dataVersion={version} onResetDraft={resetDraft} submitLabel={action.kind === 'add' ? t('allocateVehicle') : action.kind === 'replace' ? t('replaceVehicle') : t('cancelTransport')} submitDisabled={action.kind !== 'cancel' && (loading || !!error || !availability || !!selectedProblem)} onSubmit={async (data) => {
    const reason = action.kind === 'add' ? undefined : textField(data, 'reason');
    if (action.kind !== 'add' && !reason) throw new Error(t('transportReasonRequired'));
    let plan = {};
    if (action.kind !== 'cancel') {
      const actualWindow = checkedWindow(data, appointment, t);
      if (!availability || loading || error || actualWindow.from !== availability.window.from || actualWindow.to !== availability.window.to) throw new Error(t('checkUpdatedWindow'));
      if (!selectedVehicle || vehicleProblem(selectedVehicle)) throw new Error(t('chooseVehicle'));
      const driver = driverKind === 'participant' ? { kind: 'participant', participantId: z.uuid().parse(participantId) } : driverKind === 'external' ? { kind: 'external', name: z.string().min(1).max(200).parse(textField(data, 'driverName')), phone: z.string().min(1).max(200).parse(textField(data, 'driverPhone')) } : { kind: 'none' };
      if (driverKind === 'participant' && (!selectedPerson || personProblem(selectedPerson))) throw new Error(t('chooseDriver'));
      plan = { vehicleId: selectedVehicle.id, reserveFrom: actualWindow.from, reserveTo: actualWindow.to, driver };
    }
    const body = { version, ...plan, ...(reason ? { reason } : {}) };
    const payload = JSON.stringify(body);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    const route = `/appointments/${appointment.id}/transport${action.kind === 'add' ? '' : `/${action.allocation.id}/${action.kind}`}`;
    const savedVersion = await command(route, { ...body, requestId: request.current.id });
    onSaved(); return savedVersion;
  }}>
    {action.kind === 'cancel' ? <Notice>{t('cancelReservation', { vehicle: action.allocation.vehicle.name, plate: action.allocation.vehicle.plate })}</Notice> : <>
      <DateTimeFields startsAt={initialWindow.from} endsAt={initialWindow.to} startsAtName="reserveFrom" endsAtName="reserveTo" startsAtLabel={t('reservedFrom')} endsAtLabel={t('reservedUntil')} />
      <div className="my-3 flex flex-wrap items-center gap-3"><button type="button" className="button secondary small" disabled={loading} onClick={(event) => { const form = event.currentTarget.form; if (!form) return; try { setWindow(checkedWindow(new FormData(form), appointment, t)); setRevision((value) => value + 1); } catch (failure) { setError(errorMessage(failure, locale)); } }}>{t('checkAvailability')}</button><span className="small muted">{loading ? t('checkingWindow') : availability && !error ? t('checkedWindow') : t('checkWindow')}</span></div>
      {error ? <Notice tone="error">{error} <button type="button" className="text-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{t('retryAvailability')}</button></Notice> : null}
      {!availability && loading ? <Pending>{t('loadingResources')}</Pending> : null}
      {availability ? <><p className="mb-3 small muted">{t('checkedRange', { from: formatDateTime(availability.window.from, locale), to: formatDateTime(availability.window.to, locale) })}</p><ChoiceGroup label={t('vehicle')}><div className="choice-list max-h-56 overflow-y-auto">{availability.data.vehicles.length === 0 ? <p className="small muted">{t('noVehicles')}</p> : availability.data.vehicles.map((vehicle) => { const problem = vehicleProblem(vehicle); const selected = vehicleId === vehicle.id; return <label className={`checkbox-label items-start ${problem ? 'text-muted-foreground' : ''}`} key={vehicle.id}><Input type="radio" name="vehicleId" value={vehicle.id} checked={selected} disabled={!!problem && !selected} required aria-describedby={problem ? `${groupId}-${vehicle.id}` : undefined} onChange={() => setVehicleId(vehicle.id)} /><span className="min-w-0 [overflow-wrap:anywhere]">{vehicle.name} · {vehicle.plate}<small className="cell-sub">{vehicle.ownership === 'external' ? vehicle.providerName : t('companyVehicle')}{vehicle.providerContact ? ` · ${vehicle.providerContact}` : ''}</small>{problem ? <small id={`${groupId}-${vehicle.id}`} className="cell-sub">{problem}</small> : null}</span></label>; })}</div></ChoiceGroup>
      <Field label={t('driver')}><select value={driverKind} onChange={(event) => setDriverKind(z.enum(['none', 'participant', 'external']).parse(event.target.value))}><option value="none">{t('notSpecified')}</option><option value="participant">{t('directoryDriver')}</option><option value="external">{t('externalDriver')}</option></select></Field>
      {driverKind === 'participant' ? <ChoiceGroup label={t('participantDriver')}><p className="small muted mb-2">{t('driverHint')}</p><div className="choice-list max-h-52 overflow-y-auto">{availability.data.people.map((person) => { const problem = personProblem(person); const selected = participantId === person.id; return <label className={`checkbox-label items-start ${problem ? 'text-muted-foreground' : ''}`} key={person.id}><Input type="radio" name="participantDriverId" value={person.id} checked={selected} disabled={!!problem && !selected} required aria-describedby={problem ? `${groupId}-${person.id}` : undefined} onChange={() => setParticipantId(person.id)} /><span>{person.external ? t('externalName', { name: person.name }) : person.name}{problem ? <small id={`${groupId}-${person.id}`} className="cell-sub">{problem}</small> : null}</span></label>; })}</div></ChoiceGroup> : driverKind === 'external' ? <div className="form-grid"><Field label={t('externalDriverName')}><Input name="driverName" required maxLength={200} defaultValue={original?.driver.kind === 'external' ? original.driver.name : ''} /></Field><Field label={t('externalDriverPhone')}><Input name="driverPhone" type="tel" required maxLength={200} defaultValue={original?.driver.kind === 'external' ? original.driver.phone : ''} /></Field></div> : null}</> : null}
      {selectedProblem ? <Notice tone="error">{selectedProblem} {t('transportSelectionPreserved')}</Notice> : null}
    </>}
    {action.kind !== 'add' ? <Field label={action.kind === 'replace' ? t('replacementReason') : t('transportCancellationReason')}><textarea name="reason" rows={2} required maxLength={2000} /></Field> : null}
  </ActionForm>;
}
