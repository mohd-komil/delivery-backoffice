'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';
import { transportAvailabilitySchema, type Appointment, type TransportAllocation, type TransportAvailability, type Vehicle } from '@/lib/contracts';
import { formatDateTime, parseBookingInstant } from '@/lib/time';
import { DateTimeFields, dateTimeField } from './date-time-fields';
import { ActionForm, ChoiceGroup, Field, Notice, Pending, textField } from './ui';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, useDialogState } from './ui/dialog';
import { DetailIcon, deliveryStatusLabel, type DeliveryText } from './delivery-detail-presentation';
import { DeliveryDetailCard } from './delivery-detail-card';

type Command = (path: string, body: unknown, method?: string) => Promise<number>;
type TransportAction = { kind: 'add' } | { kind: 'replace' | 'cancel'; allocation: TransportAllocation };
type ReservationWindow = { from: string; to: string };

function driverLabel(driver: TransportAllocation['driver'], t: DeliveryText): string {
  return driver.kind === 'none' ? t('driverUnspecified') : driver.kind === 'participant' ? driver.person.name : t('externalName', { name: `${driver.name} · ${driver.phone}` });
}

export function TransportReadout({ allocations, title, emptyMessage }: { allocations: TransportAllocation[]; title?: string; emptyMessage?: string }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  return <section className="transport-readout min-w-0"><h4 className="mb-3 text-sm font-medium">{title ?? t('transportHistory')}</h4>{allocations.length === 0 ? <p className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">{emptyMessage ?? t('noTransport')}</p> : <ul className="space-y-3">{allocations.map((allocation) => <li className="rounded-lg border border-border bg-muted/20 p-4 text-xs [overflow-wrap:anywhere]" key={allocation.id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="flex min-w-0 items-center gap-2 text-sm"><DetailIcon name="truck" className="text-info-foreground" /><span>{allocation.vehicle.name} · <span className="font-mono">{allocation.vehicle.plate}</span></span></strong><span className={allocation.status === 'active' ? 'badge success' : 'badge neutral'}>{deliveryStatusLabel(t, allocation.status)}</span></div>
    <p className="mt-2">{t('reservedRange', { from: formatDateTime(allocation.reserveFrom, locale), to: formatDateTime(allocation.reserveTo, locale) })}</p>{allocation.driver.kind !== 'none' ? <p className="mt-1">{driverLabel(allocation.driver, t)}</p> : null}
    {allocation.vehicle.ownership === 'external' ? <p className="mt-1 muted">{allocation.vehicle.providerName} · {allocation.vehicle.providerContact ?? t('providerContactMissing')}</p> : null}
    <p className="mt-1 muted">{t('recordedBy', { name: allocation.createdBy.name, date: formatDateTime(allocation.createdAt, locale) })}</p>{allocation.replacesAllocationId ? <p className="mt-1 muted">{t('replacementPreserved')}</p> : null}
    {allocation.retirementReason ? <p className="mt-1">{t(allocation.status === 'replaced' ? 'replacement' : 'cancellation')}: {allocation.retirementReason}{allocation.retiredBy ? ` · ${allocation.retiredBy.name}` : ''}{allocation.retiredAt ? ` · ${formatDateTime(allocation.retiredAt, locale)}` : ''}</p> : null}
  </li>)}</ul>}</section>;
}

export function VisitTransport({ deliveryId, version, appointment, vehicles, closed, refreshKey, command }: { deliveryId: string; version: number; appointment: Appointment; vehicles: readonly Vehicle[]; closed: boolean; refreshKey: number; command: Command }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const [action, setAction, actionOpen] = useDialogState<TransportAction>();
  const allocations = appointment.transportAllocations ?? [];
  const activeAllocations = allocations.filter((allocation) => allocation.status === 'active');
  const mutable = appointment.status === 'booked' && appointment.results.length === 0 && !closed;
  return <DeliveryDetailCard title={t('vehicle')} icon="truck" badge={activeAllocations.length} className="visit-transport-card"><div className="min-w-0" data-visit-transport={appointment.id}>
    <TransportReadout allocations={activeAllocations} title={deliveryStatusLabel(t, 'active')} emptyMessage={t('noActiveTransport')} />
    {allocations.length > activeAllocations.length ? <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground"><DetailIcon name="history" />{t('transportHistoryHint')}</p> : null}
    {activeAllocations.map((allocation) => {
      const current = vehicles.find((vehicle) => vehicle.id === allocation.vehicle.id);
      const warning = !current ? t('vehicleMissing') : !current.enabled ? t('vehicleDisabled') : current.operationalStatus !== 'available' ? t('vehicleOperationalWarning', { status: deliveryStatusLabel(t, current.operationalStatus) }) : null;
      return warning ? <Notice key={allocation.id}>{t('reservationPreserved', { vehicle: allocation.vehicle.name, plate: allocation.vehicle.plate, warning })} {mutable ? t('mutableTransportReview') : t('transportReview')}</Notice> : null;
    })}
    {mutable ? <><div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">{appointment.assignments.length > 0 ? <Button type="button" size="sm" onClick={() => setAction({ kind: 'add' })}>{t('allocateVehicleButton')}</Button> : null}{activeAllocations.map((allocation) => <div className="flex flex-wrap gap-2" key={allocation.id}><Button type="button" size="sm" variant="outline" aria-label={t('replaceResource', { name: allocation.vehicle.name })} onClick={() => setAction({ kind: 'replace', allocation })}>{t('replaceResource', { name: allocation.vehicle.plate })}</Button><Button type="button" size="sm" variant="outline" aria-label={t('cancelTransportResource', { name: allocation.vehicle.name })} onClick={() => setAction({ kind: 'cancel', allocation })}>{t('cancelResource', { name: allocation.vehicle.plate })}</Button></div>)}</div>{appointment.assignments.length === 0 ? <p className="mt-3 small muted">{t('assignBeforeTransport')}</p> : null}<p className="mt-3 small muted">{t('transportWindowHint')}</p></> : <p className="mt-3 small muted">{t('immutableTransportHint')}</p>}
    {action && mutable ? <Dialog open={actionOpen} onOpenChange={(open) => { if (!open) setAction(null); }}><DialogContent className="dialog" aria-describedby={undefined}><div className="section-title"><DialogTitle asChild><h2>{action.kind === 'add' ? t('allocateVisitTransport') : action.kind === 'replace' ? t('replaceVisitVehicle') : t('cancelVisitTransport')}</h2></DialogTitle><button className="icon-button" aria-label={t('closeTransportEditor')} onClick={() => setAction(null)}>×</button></div><p className="small muted mb-4">{t('visitTimeRange', { from: formatDateTime(appointment.startsAt, locale), to: formatDateTime(appointment.endsAt, locale) })}</p><TransportEditor key={action.kind === 'add' ? 'add' : `${action.kind}-${action.allocation.id}`} deliveryId={deliveryId} version={version} appointment={appointment} action={action} refreshKey={refreshKey} command={command} onSaved={() => setAction(null)} /></DialogContent></Dialog> : null}
  </div></DeliveryDetailCard>;
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
  const selectedVehicle = availability?.data.vehicles.find((vehicle) => vehicle.id === vehicleId);
  const selectedProblem = vehicleId && (!selectedVehicle || vehicleProblem(selectedVehicle)) ? selectedVehicle ? vehicleProblem(selectedVehicle) : t('selectedVehicleMissing') : null;
  function resetDraft() { request.current = null; setWindow(initialWindow); setVehicleId(''); setRevision((value) => value + 1); }
  return <ActionForm dataVersion={version} onResetDraft={resetDraft} submitLabel={action.kind === 'add' ? t('allocateVehicle') : action.kind === 'replace' ? t('replaceVehicle') : t('cancelTransport')} submitDisabled={action.kind !== 'cancel' && (loading || !!error || !availability || !!selectedProblem)} onSubmit={async (data) => {
    const reason = action.kind === 'add' ? undefined : textField(data, 'reason');
    if (action.kind !== 'add' && !reason) throw new Error(t('transportReasonRequired'));
    let plan = {};
    if (action.kind !== 'cancel') {
      const actualWindow = checkedWindow(data, appointment, t);
      if (!availability || loading || error || actualWindow.from !== availability.window.from || actualWindow.to !== availability.window.to) throw new Error(t('checkUpdatedWindow'));
      if (!selectedVehicle || vehicleProblem(selectedVehicle)) throw new Error(t('chooseVehicle'));
      plan = { vehicleId: selectedVehicle.id, reserveFrom: actualWindow.from, reserveTo: actualWindow.to, driver: { kind: 'none' } };
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
      </> : null}
      {selectedProblem ? <Notice tone="error">{selectedProblem} {t('transportSelectionPreserved')}</Notice> : null}
    </>}
    {action.kind !== 'add' ? <Field label={action.kind === 'replace' ? t('replacementReason') : t('transportCancellationReason')}><textarea name="reason" rows={2} required maxLength={2000} /></Field> : null}
  </ActionForm>;
}
