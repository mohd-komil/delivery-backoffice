'use client';

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { motion } from 'motion/react';
import type { LineService, RemainingWorkEstimate } from '@/lib/contracts';
import { formatDateTime } from '@/lib/time';
import { workTimeOperations, workTimeRateInputSchema, workTimesInputSchema, type LineWorkTime, type WorkTimesUpdate, workTimeStandardSnapshotSchema } from '@/lib/work-times';
import type { z } from 'zod';
import type { ApplyTimeStandard } from '@/lib/planning-time-standards';
import { DeliveryTimeStandard } from './delivery-time-standard';
import { ActionForm, Field } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DetailIcon } from './delivery-detail-presentation';
import { WorkEstimateSummary } from './work-estimate-summary';

export function DeliveryWorkTime({ line, estimate, unit, label, version, save, standard, applyStandard }: {
  line: LineService; estimate: LineWorkTime; unit: string; label: string; version: number;
  save: (update: WorkTimesUpdate) => Promise<number>;
  standard?: z.infer<typeof workTimeStandardSnapshotSchema>; applyStandard?: (update: ApplyTimeStandard) => Promise<number>;
}) {
  const t = useTranslations('workTimes');
  const locale = useLocale();
  const planningText = useTranslations('planning');
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const hasLocal = estimate.localSavedAt !== null;
  const canEdit = estimate.canEdit && (line.service !== null || hasLocal);
  const basis = estimate.basis === 'source_total_proportion' ? 'source' : estimate.basis;
  return <section className="mt-3 rounded-md border border-border bg-muted/25 p-3" aria-label={`${t('title')} · ${label}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h5 className="flex items-center gap-1.5 text-xs font-medium"><DetailIcon name="clock" className="text-info-foreground" />{t('title')}</h5>
        <p className="mt-1 text-xs text-muted-foreground">{t('remaining')}: <strong className="font-medium tabular-nums text-foreground">{estimate.remainingMinutes === null
          ? t('unknown') : estimate.remainingMinutes === 0 ? t('noRemaining') : t('minutes', { count: estimate.remainingMinutes })}</strong></p>
      </div>
      {canEdit || editing ? <Button type="button" size="sm" variant="outline" aria-expanded={editing} aria-controls={editing ? editorId : undefined}
        aria-label={`${t(editing ? 'hide' : 'edit')} · ${label}`} onClick={() => setEditing((value) => !value)}>{t(editing ? 'hide' : 'edit')}</Button> : null}
    </div>
    {estimate.basis !== 'unknown' ? <p className="mt-2 text-xs text-muted-foreground">{t(basis)}</p> : null}
    {hasLocal ? <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-xs">
      {workTimeOperations.map((operation) => {
        const value = estimate[operation.field];
        return value === null ? null : <div key={operation.key}>
        <dt className="font-medium">{t(operation.key)}</dt>
        <dd className="mt-0.5 tabular-nums text-muted-foreground">{t('rateValue', { count: value, unit })}</dd>
      </div>; })}
    </dl> : null}
    {estimate.basis === 'source_total_proportion' || estimate.basis === 'mixed' ? <p className="mt-2 text-xs text-muted-foreground">{t(estimate.basis === 'mixed' ? 'mixedHelp' : 'sourceHelp')}</p> : null}
    {estimate.stale ? <p role="status" className="mt-2 text-xs text-warning-foreground">{t('stale')}</p> : null}
    {estimate.missingOperations.length > 0 ? <p className="mt-2 text-xs text-warning-foreground">{t('missing', { operations: estimate.missingOperations.map((operation) => t(operation)).join(', ') })}</p> : null}
    {!estimate.canEdit ? <p className="mt-2 text-xs text-muted-foreground">{t('locked')}</p> : line.service === null ? <p className="mt-2 text-xs text-warning-foreground">{t('serviceRequired')}</p> : null}
    {estimate.localSavedAt && estimate.localSavedBy ? <p className="mt-2 text-xs text-muted-foreground">{t('savedBy', { name: estimate.localSavedBy.name, date: formatDateTime(estimate.localSavedAt, locale) })}</p> : null}
    {standard ? <p className="mt-2 text-xs text-info-foreground">{planningText('appliedStandard', { name: standard.name, version: standard.version })}<span className="mt-1 block text-muted-foreground">{planningText('sourceReference', { source: standard.sourceReference })}</span></p> : null}
    {editing ? <motion.div id={editorId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{t('teamMinutes', { unit })}</p>
      <ActionForm dataVersion={version} disabled={!estimate.canEdit} submitLabel={t('save')} successMessage={t('saved')} secondary onSubmit={(data) => save(workTimesInputSchema.parse({
        version, sourceLineId: line.sourceLineId,
        deliveryMinutesPerUnit: workTimeRateInputSchema.parse(data.get('deliveryMinutesPerUnit') ?? ''),
        installationMinutesPerUnit: workTimeRateInputSchema.parse(data.get('installationMinutesPerUnit') ?? ''),
        collectionMinutesPerUnit: workTimeRateInputSchema.parse(data.get('collectionMinutesPerUnit') ?? ''),
      }))}>
        <div className="grid gap-x-3 sm:grid-cols-3">{workTimeOperations.map((operation) => <Field key={operation.key} label={t('rate', { operation: t(operation.key), unit })}>
          <Input type="number" inputMode="numeric" min={1} max={1440} step={1} name={operation.field}
            aria-label={`${t('rate', { operation: t(operation.key), unit })} · ${label}`}
            disabled={line[operation.total] === 0} defaultValue={estimate[operation.field] ?? ''} placeholder={t('notProvided')} />
        </Field>)}</div>
        <p className="text-xs text-muted-foreground">{t('emptyHint')}</p>
      </ActionForm>
      {estimate.canEdit && applyStandard ? <DeliveryTimeStandard line={line} unit={unit} version={version} apply={applyStandard} /> : null}
    </motion.div> : null}
  </section>;
}

export function WorkEstimateProvenance({ basis, estimate }: { basis: RemainingWorkEstimate['basis']; estimate?: RemainingWorkEstimate }) {
  const t = useTranslations('workTimes');
  const label = basis === 'local_operation_rates' ? 'local' : basis === 'mixed_operation_rates' ? 'mixed'
    : basis === 'proportional_remaining_operations' ? 'source' : null;
  return <>{label ? <span className="mt-1 block text-xs text-muted-foreground">{t(label)}</span> : null}{estimate ? <WorkEstimateSummary estimate={estimate} compact /> : null}</>;
}
