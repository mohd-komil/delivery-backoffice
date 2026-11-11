'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { motion } from 'motion/react';
import type { Appointment, AppointmentPlanning, Delivery, DeliveryDetail, LineService, WorkScope } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { formatDateTime } from '@/lib/time';
import { initialWorkDrafts, validateWorkDrafts, workCapacity, workLineBlocked, workOperations, type WorkDraft } from '@/lib/visit-work';
import { ActionForm, Field, Notice, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataTable } from './ui/data-table';
import { deliveryServiceLabel } from './delivery-detail-presentation';

type Source = Delivery['source'];

export function WorkAvailabilityTable({ source, lines }: { source: Source; lines: readonly LineService[] }) {
  const t = useTranslations('workPlan');
  const locale = useLocale();
  const format = useFormatter();
  const items = new Map(source.items.map((item) => [item.sourceLineId, item]));
  return <section className="mt-4 rounded-lg border border-border p-3">
    <h4 className="mb-3 font-medium">{t('title')}</h4>
    <DataTable caption={t('caption')} className="min-w-[720px]" header={<tr>{(['item', 'operation', 'total', 'done', 'remaining', 'reserved', 'available'] as const).map((key) => <th scope="col" key={key}>{t(key)}</th>)}</tr>}
      rows={lines.flatMap((line) => {
        const item = items.get(line.sourceLineId);
        if (!item) return [];
        return workOperations.filter((operation) => line[operation.total] > 0 || line[operation.done] > 0 || line[operation.reserved] > 0).map((operation) => <tr key={`${line.sourceLineId}:${operation.key}`}>
          <th scope="row" className="max-w-xs whitespace-normal text-xs font-medium normal-case">{sourceLineLabel(source, item, locale)}<span className="cell-sub">{item.uom}</span></th>
          <td>{t(operation.label)}</td>
          {[operation.total, operation.done, operation.remaining, operation.reserved].map((key) => <td key={key} className="tabular-nums">{format.number(line[key] / 1000)}</td>)}
          <td className="tabular-nums">{line.planningBlockedReason ? <>
            <span className="badge warning">{t('availabilityReview')}</span>
            <span className="cell-sub max-w-64 whitespace-normal">{t(line.planningBlockedReason)}</span>
          </> : format.number(line[operation.available] / 1000)}</td>
        </tr>);
      })} />
  </section>;
}

export function WorkScopeFields({ source, lines, drafts, onChange, scope, editing = false }: {
  source: Source; lines: readonly LineService[]; drafts: readonly WorkDraft[]; onChange: (drafts: WorkDraft[]) => void; scope?: WorkScope; editing?: boolean;
}) {
  const t = useTranslations('workPlan');
  const locale = useLocale();
  const format = useFormatter();
  const items = new Map(source.items.map((item) => [item.sourceLineId, item]));
  const linesById = new Map(lines.map((line) => [line.sourceLineId, line]));
  const selected = drafts.filter((draft) => workOperations.some((operation) => Number(draft[operation.key]) > 0)).length;
  function update(sourceLineId: number, change: Partial<Omit<WorkDraft, 'sourceLineId'>>) {
    onChange(drafts.map((draft) => draft.sourceLineId === sourceLineId ? { ...draft, ...change } : draft));
  }
  function selectAvailable() {
    const includingThisVisit = lines.map((line) => ({ ...line,
      availableDeliveryMilli: workCapacity(line, workOperations[0], scope),
      availableInstallationMilli: workCapacity(line, workOperations[1], scope),
      availableCollectionMilli: workCapacity(line, workOperations[2], scope),
    }));
    onChange(initialWorkDrafts(includingThisVisit, undefined, editing));
  }
  return <div className="work-scope-fields">
    <p className="small muted">{t('scopeIntro')}</p>
    {lines.every((line) => workOperations.every((operation) => workCapacity(line, operation, scope) === 0)) ? <p className="mt-2 text-sm">{t('noWork')}</p> : null}
    <div className="my-3 flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={selectAvailable}>{t('chooseAvailable')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(drafts.map((draft) => ({ ...draft, deliveryMilli: '0', installationMilli: '0', collectionMilli: '0', customerStockConfirmed: false })))}>{t('clearSelection')}</Button>
      <span className="small muted" aria-live="polite">{t('selectedCount', { count: selected })}</span>
    </div>
    <DataTable caption={t('scopeTitle')} className="min-w-[740px]" header={<tr><th scope="col">{t('item')}</th>{workOperations.map((operation) => <th scope="col" key={operation.key}>{t(operation.label)}</th>)}</tr>} rows={drafts.flatMap((draft) => {
      const item = items.get(draft.sourceLineId);
      const line = linesById.get(draft.sourceLineId);
      if (!item || !line) return [];
      const label = sourceLineLabel(source, item, locale);
      const blocked = workLineBlocked(line, editing);
      return [<tr key={draft.sourceLineId} data-work-line={draft.sourceLineId}>
        <th scope="row" className="max-w-xs whitespace-normal text-xs font-medium normal-case">{label}
          {line.planningBlockedReason ? <span className="cell-sub text-warning-foreground">{t(line.planningBlockedReason)}</span> : null}
        </th>
        {workOperations.map((operation) => {
          const capacity = workCapacity(line, operation, scope);
          return <td key={operation.key} className="min-w-36 align-top">
            <Input type="number" inputMode="decimal" min={0} step="0.001" max={capacity / 1000} value={draft[operation.key]} disabled={blocked || capacity === 0}
              aria-label={t('quantityLabel', { operation: t(operation.label), line: label })}
              onChange={(event) => update(draft.sourceLineId, { [operation.key]: event.target.value })} />
            <p className="small muted mt-1">{t('capacity', { amount: format.number(capacity / 1000), unit: item.uom })}</p>
            {operation.key === 'installationMilli' && line.service === 'installation_only' && Number(draft.installationMilli) > 0 ? <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.customerStockConfirmed} disabled={blocked} onChange={(event) => update(draft.sourceLineId, { customerStockConfirmed: event.target.checked })} /><span>{t('stockConfirm')}<small className="cell-sub">{t('stockHint')}</small></span></label> : null}
          </td>;
        })}
      </tr>];
    })} />
  </div>;
}

export function VisitWorkSnapshot({ scope, source, historical = false }: { scope: WorkScope | undefined; source: Source; historical?: boolean }) {
  const t = useTranslations('workPlan');
  const deliveryText = useTranslations('delivery');
  const locale = useLocale();
  const format = useFormatter();
  if (!scope) return historical ? <p className="small muted">{t('noSnapshot')}</p> : null;
  return <section className="inset-card section-gap visit-work-snapshot">
    <div className="section-title"><h4>{t('snapshotTitle')}</h4><span className="badge neutral">{t('snapshotRevision', { revision: scope.revision })}</span></div>
    <p className="small muted">{t('snapshotCaptured', { name: scope.confirmedBy.name, date: formatDateTime(scope.confirmedAt, locale) })}</p>
    <DataTable caption={t('snapshotTitle')} className="min-w-[660px]" header={<tr><th scope="col">{t('item')}</th><th scope="col">{t('recordedService')}</th>{workOperations.map((operation) => <th scope="col" key={operation.key}>{t(operation.label)}</th>)}</tr>} rows={scope.lines.map((line) => <tr key={line.sourceLineId}>
      <th scope="row" className="max-w-xs whitespace-normal text-xs font-medium normal-case">{sourceLineLabel(source, line.sourceItem, locale)}<span className="cell-sub">{line.sourceItem.uom}</span></th>
      <td>{deliveryServiceLabel(deliveryText, line.service)}{line.customerStockConfirmed ? <span className="cell-sub">{t('stockRecorded')}</span> : null}</td>
      {workOperations.map((operation) => <td key={operation.key} className="tabular-nums">{format.number(line[operation.key] / 1000)}</td>)}
    </tr>)} />
    {historical ? <p className="small muted">{t('snapshotHint')}</p> : null}
  </section>;
}

export function VisitWorkEditor({ detail, appointment, planning, command }: {
  detail: DeliveryDetail; appointment: Appointment; planning: AppointmentPlanning | undefined;
  command: (path: string, body: unknown, method?: string) => Promise<number>;
}) {
  const t = useTranslations('workPlan');
  const [open, setOpen] = useState(false);
  const editorId = useId();
  const reviewReason = planning?.reviewReason ?? (!appointment.workScope ? 'missing_scope' : null);
  return <section className="section-gap">
    <VisitWorkSnapshot scope={appointment.workScope} source={detail.delivery.source} />
    {reviewReason ? <Notice>{t(reviewReason === 'damage_hold' ? 'damage_hold' : reviewReason === 'missing_scope' ? 'reviewMissing' : reviewReason === 'source_review' ? 'reviewSource' : reviewReason === 'stock_pending' ? 'stockPending' : 'reviewChanged')}</Notice> : null}
    {planning?.canEdit && detail.lineServices ? <>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={editorId} onClick={() => setOpen((value) => !value)}>{t(open ? 'hideScope' : reviewReason ? 'reviewScope' : 'editScope')}</Button>
      {open ? <motion.div id={editorId} className="mt-3 rounded-lg border border-border bg-muted/20 p-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <WorkScopeEditForm detail={detail} appointment={appointment} lines={detail.lineServices} command={command} onSaved={() => setOpen(false)} />
      </motion.div> : null}
    </> : null}
  </section>;
}

function WorkScopeEditForm({ detail, appointment, lines, command, onSaved }: {
  detail: DeliveryDetail; appointment: Appointment; lines: LineService[];
  command: (path: string, body: unknown, method?: string) => Promise<number>; onSaved: () => void;
}) {
  const t = useTranslations('workPlan');
  const [drafts, setDrafts] = useState(() => initialWorkDrafts(lines, appointment.workScope, true));
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [baseScope, setBaseScope] = useState(appointment.workScope);
  const reset = () => { setDrafts(initialWorkDrafts(lines, appointment.workScope, true)); setBaseScope(appointment.workScope); setRequestId(crypto.randomUUID()); };
  return <ActionForm dataVersion={detail.delivery.version} onResetDraft={reset} submitLabel={t('saveScope')} onSubmit={async (data) => {
    const result = validateWorkDrafts(drafts, lines, baseScope, true);
    if (result.error) throw new Error(t(result.error));
    const savedVersion = await command(`/appointments/${appointment.id}/work-scope`, { version: detail.delivery.version, requestId, workLines: result.lines, reason: textField(data, 'reason') }, 'PATCH');
    onSaved();
    return savedVersion;
  }}>
    <WorkScopeFields source={detail.delivery.source} lines={lines} drafts={drafts} onChange={setDrafts} scope={baseScope} editing />
    <Field label={t('changeReason')}><Input name="reason" required maxLength={2000} /></Field>
    <p className="small muted">{t('confirmationReset')}</p>
  </ActionForm>;
}
