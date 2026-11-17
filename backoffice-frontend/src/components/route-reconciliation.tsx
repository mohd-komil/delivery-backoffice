'use client';

import { Combobox } from './ui/combobox';


import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { isWorkMessageKey } from '@/i18n/route-operations';
import { incompleteReasonLabels, isIncompleteReason } from '@/lib/incomplete-work';
import { apiRequest, errorMessage } from '@/lib/api';
import { cargoKinds, cargoLocations, cargoQuantityMilli, nextActionKinds, reconciliationLineInputSchema, reconciliationOwnersSchema, routeLineKey, type ReconciliationLineInput, type ReconciliationOwner, type RouteCommand, type RouteLineStatus, type RouteOperations } from '@/lib/route-operations';
import { ActionForm, Field, Notice, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { RouteFollowUpSelect } from './route-follow-up-select';

const operations = [
  { key: 'delivery', planned: 'plannedDeliveryMilli', done: 'deliveredMilli', remaining: 'remainingDeliveryMilli', available: 'availableDeliveryMilli' },
  { key: 'installation', planned: 'plannedInstallationMilli', done: 'installedMilli', remaining: 'remainingInstallationMilli', available: 'availableInstallationMilli' },
  { key: 'collection', planned: 'plannedCollectionMilli', done: 'collectedMilli', remaining: 'remainingCollectionMilli', available: 'availableCollectionMilli' },
] as const;
type ActionDraft = ReconciliationLineInput['nextActions'][number];
type CargoDraft = Omit<ReconciliationLineInput['cargo'][number], 'quantityMilli'> & { quantity: string };
type LineDraft = { ownerUserId: string; note: string; nextActions: ActionDraft[]; cargo: CargoDraft[] };

function initialLine(line: RouteLineStatus): LineDraft {
  const declaration = line.declaration;
  return { ownerUserId: declaration?.ownerUserId ?? '', note: declaration?.note ?? '', nextActions: operations.filter((operation) => line[operation.remaining] > 0).map((operation) => {
    const saved = declaration?.nextActions.find((entry) => entry.operation === operation.key);
    return saved ? { ...saved } : { operation: operation.key, action: 'manual_review', ownerUserId: declaration?.ownerUserId ?? '', note: '', followUpAppointmentId: null };
  }), cargo: cargoKinds.filter((kind) => kind === 'collection' ? line.plannedCollectionMilli > 0 : line.plannedDeliveryMilli > line.deliveredMilli).map((kind) => {
    const saved = declaration?.cargo.find((entry) => entry.kind === kind);
    return saved ? { kind, location: saved.location, quantity: saved.quantityMilli === null ? '' : String(saved.quantityMilli / 1000), note: saved.note } : { kind, location: 'unknown', quantity: '', note: '' };
  }) };
}
function initialLines(lines: RouteLineStatus[]): Record<string, LineDraft> { return Object.fromEntries(lines.map((line) => [routeLineKey(line), initialLine(line)])); }
function basis(lines: RouteLineStatus[]) { return JSON.stringify(lines.map((line) => ({ appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, reportMissing: line.reportMissing, quantities: operations.map((operation) => [line[operation.planned], line[operation.done], line[operation.remaining], line[operation.available]]) }))); }

export function RouteReconciliation({ data, disabled, command }: { data: RouteOperations; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  const common = useTranslations('common');
  const locale = useLocale();
  const [owners, setOwners] = useState<ReconciliationOwner[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [ownerRetry, setOwnerRetry] = useState(0);
  const [drafts, setDrafts] = useState(() => initialLines(data.lines));
  const [reviewedBasis, setReviewedBasis] = useState(() => basis(data.lines));
  const factsChanged = reviewedBasis !== basis(data.lines);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest('/routes/reconciliation-owners', reconciliationOwnersSchema, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setOwners(value); setFailure(null); }
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [ownerRetry]);
  function reset() { setDrafts(initialLines(data.lines)); setReviewedBasis(basis(data.lines)); }
  function change(line: RouteLineStatus, update: Partial<LineDraft>) {
    setDrafts((previous) => { const key = routeLineKey(line); const existing = previous[key]; return existing ? { ...previous, [key]: { ...existing, ...update } } : previous; });
  }
  function owner(line: RouteLineStatus, id: string) {
    const current = drafts[routeLineKey(line)];
    if (current) change(line, { ownerUserId: id, nextActions: current.nextActions.map((entry) => ({ ...entry, ownerUserId: !entry.ownerUserId || entry.ownerUserId === current.ownerUserId ? id : entry.ownerUserId })) });
  }
  async function save(form: FormData) {
    if (factsChanged) throw new Error(t('stale'));
    const lines = data.lines.map((line) => {
      const draft = drafts[routeLineKey(line)];
      if (!draft) throw new Error(t('invalid'));
      const parsed = reconciliationLineInputSchema.safeParse({ appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId: draft.ownerUserId, note: draft.note,
        nextActions: draft.nextActions.map((action) => ({ ...action, note: action.note.trim() || draft.note, followUpAppointmentId: action.action === 'already_planned' ? action.followUpAppointmentId : null })),
        cargo: draft.cargo.map(({ quantity, ...cargo }) => ({ ...cargo, quantityMilli: cargoQuantityMilli(quantity), note: cargo.note.trim() || draft.note })) });
      if (!parsed.success) throw new Error(`${line.orderName} · ${line.productName}: ${t('invalid')}`);
      return parsed.data;
    });
    return command('reconcile', { reason: textField(form, 'reason'), lines });
  }
  return <section className="grid min-w-0 gap-4 rounded-lg border p-4">
    <div><h4 className="font-semibold">{t('reconcile')}</h4><p className="mt-2 text-sm text-muted-foreground">{t('reconcileHelp')}</p></div>
    {failure ? <Notice tone="error">{errorMessage(failure, locale)} <Button type="button" variant="outline" onClick={() => setOwnerRetry((value) => value + 1)}>{t('retry')}</Button></Notice> : null}
    {factsChanged ? <Notice>{t('stale')} <Button type="button" variant="outline" onClick={reset}>{common('latestData')}</Button></Notice> : null}
    <ActionForm dataVersion={data.version} onResetDraft={reset} disabled={disabled || factsChanged || !!failure || !owners.length} submitLabel={t('saveReconciliation')} successMessage={t('saved')} onSubmit={save}>
      <DataTable caption={t('reconcile')} className="min-w-[780px]" header={<tr><th>{t('work')}</th><th>{t('reconcile')}</th></tr>} rows={data.lines.map((line) => {
        const draft = drafts[routeLineKey(line)];
        if (!draft) return <tr key={routeLineKey(line)}><td colSpan={2}>{t('stale')}</td></tr>;
        return <tr key={routeLineKey(line)} data-reconciliation-line={routeLineKey(line)}><th scope="row" className="max-w-52 whitespace-normal align-top text-sm font-medium normal-case">{line.orderName}<strong className="mt-1 block">{line.productName}</strong><span className="cell-sub">{line.sourceLineId} · {line.uom}</span><span className="cell-sub">{data.stops.find((stop) => stop.appointmentId === line.appointmentId)?.pickingName}</span></th><td className="min-w-[530px] whitespace-normal align-top">
          <LineFacts line={line} />
          <div className="my-3 grid gap-3 sm:grid-cols-2"><OwnerField value={draft.ownerUserId} owners={owners} onChange={(value) => owner(line, value)} /><Field label={t('lineNote')}><Input required maxLength={2000} value={draft.note} onChange={(event) => change(line, { note: event.target.value })} /></Field></div>
          <div className="grid gap-3">{draft.nextActions.map((action) => <section key={action.operation} className="grid gap-3 rounded-lg border bg-muted/20 p-3"><h5 className="font-semibold">{t(action.operation)} · {t('nextAction')}</h5><div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('nextAction')}><Combobox value={action.action} onChange={(event) => { const next = nextActionKinds.find((kind) => kind === event.target.value); if (next) change(line, { nextActions: draft.nextActions.map((entry) => entry.operation === action.operation ? { ...entry, action: next } : entry) }); }}>{nextActionKinds.filter((kind) => kind !== 'installation_visit' || action.operation === 'installation').map((kind) => <option key={kind} value={kind} disabled={!!line.planningBlockedReason && ['ready_for_repeat', 'installation_visit', 'already_planned'].includes(kind)}>{t(kind)}</option>)}</Combobox></Field>
            <OwnerField value={action.ownerUserId} owners={owners} onChange={(value) => change(line, { nextActions: draft.nextActions.map((entry) => entry.operation === action.operation ? { ...entry, ownerUserId: value } : entry) })} />
            {action.action === 'already_planned' ? <RouteFollowUpSelect line={line} operation={action.operation} value={action.followUpAppointmentId} onChange={(value) => change(line, { nextActions: draft.nextActions.map((entry) => entry.operation === action.operation ? { ...entry, followUpAppointmentId: value } : entry) })} /> : null}
            <Field label={t('note')}><Input maxLength={2000} value={action.note} placeholder={draft.note} onChange={(event) => change(line, { nextActions: draft.nextActions.map((entry) => entry.operation === action.operation ? { ...entry, note: event.target.value } : entry) })} /></Field>
          </div></section>)}</div>
          <div className="mt-3 grid gap-3">{draft.cargo.map((cargo) => <section key={cargo.kind} className="grid gap-3 rounded-lg border p-3"><h5 className="font-semibold">{t('cargo')} · {t(cargo.kind)}</h5><div className="grid gap-3 sm:grid-cols-2"><Field label={t('location')}><Combobox value={cargo.location} onChange={(event) => { const location = cargoLocations.find((value) => value === event.target.value); if (location) change(line, { cargo: draft.cargo.map((entry) => entry.kind === cargo.kind ? { ...entry, location } : entry) }); }}>{cargoLocations.map((value) => <option key={value} value={value}>{t(value)}</option>)}</Combobox></Field>
            <Field label={t('quantity')}><Input type="number" min={0} max={(cargo.kind === 'collection' ? line.collectedMilli : Math.max(0, line.plannedDeliveryMilli - line.deliveredMilli)) / 1000} required={cargo.location !== 'unknown'} step="0.001" value={cargo.quantity} onChange={(event) => change(line, { cargo: draft.cargo.map((entry) => entry.kind === cargo.kind ? { ...entry, quantity: event.target.value } : entry) })} /></Field>
            <Field label={t('note')}><Input maxLength={2000} value={cargo.note} placeholder={draft.note} onChange={(event) => change(line, { cargo: draft.cargo.map((entry) => entry.kind === cargo.kind ? { ...entry, note: event.target.value } : entry) })} /></Field></div></section>)}</div>
        </td></tr>;
      })} />
      <Field label={t('reconciliationReason')}><Input name="reason" required maxLength={2000} /></Field>
    </ActionForm>
    <WarehouseReceipts data={data} disabled={disabled} command={command} />
  </section>;
}

function OwnerField({ value, owners, onChange }: { value: string; owners: ReconciliationOwner[]; onChange: (value: string) => void }) {
  const t = useTranslations('routeOperations');
  return <Field label={t('owner')}><Combobox value={value} required onChange={(event) => onChange(event.target.value)}><option value="">{t('selectOwner')}</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</Combobox></Field>;
}

function LineFacts({ line }: { line: RouteLineStatus }) {
  const t = useTranslations('routeOperations');
  const work = useTranslations('workPlan');
  const delivery = useTranslations('delivery');
  return <div className="grid gap-2"><p className="text-xs text-muted-foreground">{t('packagingUnknown')}</p>{line.reportMissing ? <p className="text-xs text-warning-foreground">{t('reportMissing')}</p> : null}
    {line.remainingBasis === 'visit_snapshot_source_missing' ? <p className="text-xs text-warning-foreground">{t('SOURCE_LINE_MISSING')}</p> : null}
    {operations.filter((operation) => line[operation.planned] || line[operation.remaining] || line[operation.done]).map((operation) => <dl key={operation.key} className="grid grid-cols-5 gap-2 rounded-md bg-muted/30 p-2 text-xs"><div><dt className="font-semibold">{t(operation.key)}</dt></div>{(['planned', 'done', 'remaining', 'available'] as const).map((key) => <div key={key}><dt className="text-muted-foreground">{t(key)}</dt><dd className="font-mono">{line[operation[key]] / 1000} {line.uom}</dd></div>)}</dl>)}
    {line.planningBlockedReason && line.planningBlockedReason !== 'source_line_missing' ? <p className="text-xs text-warning-foreground">{isWorkMessageKey(line.planningBlockedReason) ? work(line.planningBlockedReason) : line.planningBlockedReason}</p> : null}
    {line.incompleteWork.map((entry, index) => <p key={`${entry.operation}:${index}`} className="text-xs">{t(entry.operation)} · {isIncompleteReason(entry.reason) ? delivery(incompleteReasonLabels[entry.reason]) : entry.reason}{entry.note ? ` · ${entry.note}` : ''}</p>)}
  </div>;
}

function WarehouseReceipts({ data, disabled, command }: { data: RouteOperations; disabled: boolean; command: RouteCommand }) {
  const t = useTranslations('routeOperations');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const candidates = data.lines.flatMap((line) => cargoKinds.filter((kind) => kind === 'collection' ? line.plannedCollectionMilli > 0 || line.collectedMilli > 0 : line.plannedDeliveryMilli > 0).map((kind) => ({ line, kind, key: `${routeLineKey(line)}:${kind}` })));
  if (!candidates.length && !data.runtime.warehouseReceipts.length) return null;
  return <section className="grid min-w-0 gap-3 border-t pt-4"><h4 className="font-semibold">{t('receipts')}</h4><p className="text-sm text-muted-foreground">{t('receiptsHelp')}</p>
    <ActionForm dataVersion={data.version} disabled={disabled} submitLabel={t('receive')} successMessage={t('saved')} onSubmit={async (form) => {
      const reason = textField(form, 'reason');
      const items = candidates.flatMap(({ line, kind, key }) => {
        const value = cargoQuantityMilli(amounts[key] ?? '');
        if (value === undefined) throw new Error(t('invalid'));
        return value === null || value === 0 ? [] : [{ appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, kind, quantityMilli: value, note: notes[key]?.trim() || reason }];
      });
      if (!items.length) throw new Error(t('emptyReceipt'));
      const version = await command('warehouse-receipts', { reason, items }); setAmounts({}); setNotes({}); return version;
    }}>
      <DataTable caption={t('receipts')} className="min-w-[680px]" header={<tr><th>{t('work')}</th><th>{t('received')}</th><th>{t('receiveQuantity')}</th><th>{t('note')}</th></tr>} rows={candidates.map(({ line, kind, key }) => <tr key={key}><th scope="row" className="max-w-xs whitespace-normal text-xs font-medium normal-case">{line.orderName} · {line.productName}<span className="cell-sub">{line.sourceLineId} · {t(kind)}</span></th><td>{(kind === 'collection' ? line.warehouseReceivedCollectionMilli : line.warehouseReceivedUndeliveredMilli) / 1000} {line.uom}</td><td><Input type="number" min={0} step="0.001" aria-label={`${t('receiveQuantity')} · ${line.orderName} · ${line.sourceLineId} · ${t(kind)}`} value={amounts[key] ?? ''} onChange={(event) => setAmounts((value) => ({ ...value, [key]: event.target.value }))} /></td><td><Input maxLength={2000} aria-label={`${t('note')} · ${line.orderName} · ${line.sourceLineId} · ${t(kind)}`} value={notes[key] ?? ''} onChange={(event) => setNotes((value) => ({ ...value, [key]: event.target.value }))} /></td></tr>)} />
      <Field label={t('receiptReason')}><Input name="reason" required maxLength={2000} /></Field>
    </ActionForm>
  </section>;
}
