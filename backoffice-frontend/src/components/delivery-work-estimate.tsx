'use client';

import { useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { motion, MotionConfig } from 'motion/react';
import { z } from 'zod';
import type { Delivery, RemainingWorkEstimate } from '@/lib/contracts';
import { allowanceMinutesInputSchema, workTimeAdjustmentsCommandSchema, workTimeAdjustmentsSchema, workTimeFactorInputSchema, type WorkTimeAdjustmentsCommand } from '@/lib/work-times';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Field, textField } from './ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DeliveryDetailCard } from './delivery-detail-card';
import { WorkEstimateSummary } from './work-estimate-summary';

const fixedFields = ['visitMinutes', 'deliveryMinutes', 'installationMinutes', 'collectionMinutes'] as const;

export function DeliveryWorkEstimate({ delivery, estimate, save }: {
  delivery: Delivery;
  estimate: RemainingWorkEstimate;
  save: (input: WorkTimeAdjustmentsCommand) => Promise<number>;
}) {
  const t = useTranslations('workTimeAdjustments');
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const request = useRef<{ key: string; id: string } | null>(null);
  const saved = delivery.workTimeAdjustments;
  const canEdit = delivery.completedAt === null && !delivery.sourceReview && !delivery.appointments.some((appointment) => appointment.status === 'in_progress');
  const usesSource = estimate.basis === 'proportional_remaining_operations' || estimate.basis === 'mixed_operation_rates'
    || estimate.calculation?.missingFields?.includes('sourceEstimateExcludesAdjustments') === true;
  return <DeliveryDetailCard title={t('title')} icon="clock">
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{t('help')}</p>
      <WorkEstimateSummary estimate={estimate} />
      {saved ? <div className="grid gap-1 text-xs text-muted-foreground">
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{t('source', { source: saved.sourceReference })}</p>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{saved.assumptions}</p>
        <p>{t('savedBy', { name: saved.updatedBy.name, date: formatDateTime(saved.updatedAt, locale) })}</p>
      </div> : null}
      {canEdit || editing ? <div><Button type="button" variant="outline" size="sm" aria-expanded={editing} aria-controls={editing ? editorId : undefined} onClick={() => setEditing((value) => !value)}>{t(editing ? 'hide' : 'edit')}</Button></div> : null}
      {!canEdit ? <p className="text-xs text-muted-foreground">{t('locked')}</p> : null}
      {editing ? <MotionConfig reducedMotion="user"><motion.div id={editorId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="border-t border-border pt-3">
        {!saved ? <p className="mb-3 text-xs text-info-foreground">{t('defaults')}</p> : null}
        <ActionForm dataVersion={delivery.version} disabled={!canEdit} submitLabel={t('save')} successMessage={t('saved')} onSubmit={(data) => {
          const values = {
            version: delivery.version,
            factorPercent: workTimeFactorInputSchema.parse(textField(data, 'factorPercent')),
            visitMinutes: allowanceMinutesInputSchema.parse(textField(data, 'visitMinutes')),
            deliveryMinutes: allowanceMinutesInputSchema.parse(textField(data, 'deliveryMinutes')),
            installationMinutes: allowanceMinutesInputSchema.parse(textField(data, 'installationMinutes')),
            collectionMinutes: allowanceMinutesInputSchema.parse(textField(data, 'collectionMinutes')),
            sourceEstimateExcludesAdjustments: data.get('sourceEstimateExcludesAdjustments') === 'on',
            sourceReference: textField(data, 'sourceReference'), assumptions: textField(data, 'assumptions'), reason: textField(data, 'reason'),
          };
          const key = JSON.stringify(values);
          if (!request.current || request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
          return save(workTimeAdjustmentsCommandSchema.parse({ ...values, requestId: request.current.id }));
        }}>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label={t('factor')}><Input name="factorPercent" type="number" inputMode="numeric" min={1} max={1000} step={1} defaultValue={saved ? saved.factorPercent ?? '' : 100} /></Field>
            {fixedFields.map((field) => <Field key={field} label={t(field)}><Input name={field} type="number" inputMode="numeric" min={0} max={1440} step={1} defaultValue={saved ? saved[field] ?? '' : 0} /></Field>)}
          </div>
          <p className="text-xs text-muted-foreground">{t('empty')}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('fixedHelp')}</p>
          {usesSource || saved?.sourceEstimateExcludesAdjustments ? <Field label={t('sourceAck')} hint={t('sourceAckHelp')}><Input name="sourceEstimateExcludesAdjustments" type="checkbox" defaultChecked={saved?.sourceEstimateExcludesAdjustments ?? false} /></Field> : null}
          <Field label={t('sourceReference')}><textarea name="sourceReference" rows={2} required maxLength={2000} defaultValue={saved?.sourceReference ?? ''} /></Field>
          <Field label={t('assumptions')}><textarea name="assumptions" rows={2} required maxLength={2000} defaultValue={saved?.assumptions ?? ''} /></Field>
          <Field label={t('reason')}><textarea name="reason" rows={2} required maxLength={2000} /></Field>
        </ActionForm>
      </motion.div></MotionConfig> : null}
    </div>
  </DeliveryDetailCard>;
}

const adjustmentHistorySchema = z.object({ reason: z.string(), saved: workTimeAdjustmentsSchema });

export function WorkTimeAdjustmentsHistory({ details }: { details: unknown }) {
  const t = useTranslations('workTimeAdjustments');
  const parsed = adjustmentHistorySchema.safeParse(details);
  if (!parsed.success) return null;
  const saved = parsed.data.saved;
  return <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
    <p className="font-medium">{t('revision', { version: saved.version })}</p>
    <dl className="grid grid-cols-2 gap-3">{(['factorPercent', ...fixedFields] as const).map((field) => <div key={field}>
      <dt className="text-muted-foreground">{t(field)}</dt>
      <dd className="mt-1 tabular-nums">{saved[field] === null ? t('unknown') : field === 'factorPercent' ? `${saved[field]}%` : t('minutes', { count: saved[field] })}</dd>
    </div>)}</dl>
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{t('source', { source: saved.sourceReference })}</p>
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{saved.assumptions}</p>
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{parsed.data.reason}</p>
  </div>;
}
