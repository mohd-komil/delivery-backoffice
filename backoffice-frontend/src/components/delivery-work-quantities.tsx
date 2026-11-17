'use client';

import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { Delivery, LineService } from '@/lib/contracts';
import { operationApplies } from '@/lib/service-types';
import { workQuantitiesHistorySchema, workQuantitiesUpdateSchema, type WorkQuantitiesUpdate } from '@/lib/work-quantities';
import { quantityMilli, workOperations, type WorkOperation } from '@/lib/visit-work';
import { ActionForm, Field, textField } from './ui';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';

export function WorkQuantitySummary({ line, unit }: { line: LineService; unit: string }) {
  const t = useTranslations('workPlan');
  const format = useFormatter();
  const active = workOperations.filter((operation) => operationApplies(line.service, operation.label) || line[operation.total] > 0 || line[operation.done] > 0 || line[operation.reserved] > 0);
  if (active.length === 0) return null;

  return <div className="overview-work-progress">{active.map((operation) => <div key={operation.key}>
    <h5 className="font-semibold">{t(operation.label)} <span className="font-normal text-muted-foreground">· {unit}</span></h5>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">{([
      { label: 'required', field: operation.total }, { label: 'done', field: operation.done },
      { label: 'reservedShort', field: operation.reserved }, { label: 'remaining', field: operation.remaining },
    ] as const).map(({ label, field }) => <div key={field}>
      <dt className="text-muted-foreground">{t(label)}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{format.number(line[field] / 1000)}</dd>
    </div>)}</dl>
  </div>)}</div>;
}

export function EditWorkQuantities({ line, item, label, version, save }: {
  line: LineService; item: Delivery['source']['items'][number]; label: string; version: number;
  save: (update: WorkQuantitiesUpdate) => Promise<number>;
}) {
  const t = useTranslations('workQuantities');
  const [open, setOpen] = useState(false);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" size="sm" variant="outline" disabled={!line.canEditRequiredQuantities}
      aria-label={`${t('edit')} · ${label}`}>{t('edit')}</Button></DialogTrigger>
    <WorkQuantitiesDialog line={line} item={item} label={label} version={version} save={save} onSaved={() => setOpen(false)} />
  </Dialog>;
}

function WorkQuantitiesDialog({ line, item, label, version, save, onSaved }: {
  line: LineService; item: Delivery['source']['items'][number]; label: string; version: number;
  save: (update: WorkQuantitiesUpdate) => Promise<number>; onSaved: () => void;
}) {
  const t = useTranslations('workQuantities');
  const descriptionId = useId();

  return <DialogContent className="dialog" aria-describedby={descriptionId}>
    <DialogTitle className="text-lg font-semibold">{t('edit')}</DialogTitle>
    <p className="mt-1 break-words text-sm font-medium">{label}</p>
    <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
    <WorkQuantitiesForm line={line} item={item} version={version} save={save} onSaved={onSaved} />
    <div className="mt-2 flex justify-end"><DialogClose asChild><Button type="button" variant="ghost">{t('cancel')}</Button></DialogClose></div>
  </DialogContent>;
}

function WorkQuantitiesForm({ line, item, version, save, onSaved }: {
  line: LineService; item: Delivery['source']['items'][number]; version: number;
  save: (update: WorkQuantitiesUpdate) => Promise<number>; onSaved: () => void;
}) {
  const t = useTranslations('workQuantities');
  const workText = useTranslations('workPlan');
  const format = useFormatter();
  const [restoreDefault, setRestoreDefault] = useState(false);
  const maxMilli = Math.round(item.quantity * 1000);
  const active = workOperations.filter((operation) => operationApplies(line.service, operation.label));

  function readQuantity(data: FormData, operation: WorkOperation): number {
    if (!operationApplies(line.service, operation.label)) return 0;
    const value = quantityMilli(textField(data, operation.key));
    if (value === null) throw new Error(workText('invalidQuantity'));
    if (value < line[operation.done] + line[operation.reserved] || value > maxMilli) throw new Error(t('outsideLimits'));
    return value;
  }

  return <ActionForm dataVersion={version} disabled={!line.canEditRequiredQuantities} submitLabel={t('save')} successMessage={t('saved')}
    onResetDraft={() => setRestoreDefault(false)} onSubmit={async (data) => {
      const quantities = restoreDefault ? null : {
        deliveryMilli: readQuantity(data, workOperations[0]),
        installationMilli: readQuantity(data, workOperations[1]),
        collectionMilli: readQuantity(data, workOperations[2]),
      };
      if (quantities) {
        if (quantities.deliveryMilli + quantities.installationMilli + quantities.collectionMilli === 0) throw new Error(t('oneOperationRequired'));
        if (line.service === 'delivery_installation' && quantities.installationMilli > quantities.deliveryMilli) throw new Error(t('installationLimit'));
      }
      const reason = textField(data, 'reason');
      if (!reason) throw new Error(t('reasonRequired'));
      const savedVersion = await save(workQuantitiesUpdateSchema.parse({ version, sourceLineId: line.sourceLineId, quantities, reason }));
      onSaved();
      return savedVersion;
    }}>
    {line.requiredQuantitiesCustomized ? <label className="mt-3 flex items-center gap-2 text-sm">
      <Input type="checkbox" checked={restoreDefault} onChange={(event) => setRestoreDefault(event.currentTarget.checked)} />{t('restore', { quantity: format.number(item.quantity), unit: item.uom })}
    </label> : null}
    <div className="grid gap-x-3 sm:grid-cols-2">{active.map((operation) => {
      const min = (line[operation.done] + line[operation.reserved]) / 1000;
      return <Field key={operation.key} label={`${workText(operation.label)} · ${item.uom}`} hint={t('limits', { min: format.number(min), max: format.number(item.quantity) })}>
        <Input type="number" inputMode="decimal" name={operation.key} step="0.001" min={min} max={item.quantity} required disabled={restoreDefault}
          defaultValue={line[operation.total] / 1000} />
      </Field>;
    })}</div>
    <Field label={t('reason')}><Input name="reason" required maxLength={2000} /></Field>
  </ActionForm>;
}

export function WorkQuantitiesHistory({ details }: { details: unknown }) {
  const t = useTranslations('workQuantities');
  const workText = useTranslations('workPlan');
  const format = useFormatter();
  const result = workQuantitiesHistorySchema.safeParse(details);
  if (!result.success) return null;
  const { sourceLineId, previous, current, reason, sourceItem } = result.data;

  return <div className="mt-2 grid gap-2 text-xs">
    <p className="font-medium">{sourceItem ? `${sourceItem.name} · ` : ''}{t('sourceLine', { id: sourceLineId })}</p>
    <dl className="flex flex-wrap gap-x-5 gap-y-2">{workOperations.filter(({ key }) => previous[key] !== current[key]).map(({ key, label }) =>
      <div key={key}><dt>{workText(label)}</dt><dd className="mt-0.5 tabular-nums text-muted-foreground">{format.number(previous[key] / 1000)} → {format.number(current[key] / 1000)} {sourceItem?.uom}</dd></div>)}</dl>
    <p className="whitespace-pre-wrap break-words text-muted-foreground">{reason}</p>
  </div>;
}
