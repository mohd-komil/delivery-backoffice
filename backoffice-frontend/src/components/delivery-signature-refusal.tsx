'use client';

import { useId, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { signatureRefusalReviewCommandSchema, type Appointment } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { formatDateTime } from '@/lib/time';
import { quantityMilli, workOperations } from '@/lib/visit-work';
import { ActionForm, ChoiceGroup, Field, textField } from './ui';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';

type VisitResult = Appointment['results'][number];
type SignedRefusal = NonNullable<VisitResult['signatureRefusal']>;
type Review = Appointment['signatureRefusalReview'];

export function SignatureRefusalReview({ result, refusal, review, reviewAction }: {
  result: VisitResult; refusal: SignedRefusal; review: Review;
  reviewAction?: { version: number; save: (body: unknown) => Promise<number> };
}) {
  const t = useTranslations('signatureRefusal');
  const locale = useLocale();
  return <section aria-label={t('customerRefused')} className="my-4 rounded-lg border border-border bg-muted/20 p-4">
    <span className={review ? 'badge success' : 'badge warning'}>{t(review?.decision ?? 'pending')}</span>
    <dl className="mt-3 space-y-3">
      <div><dt className="small muted">{t('refusalReason')}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{refusal.reason}</dd></div>
      {refusal.noPhotoReason ? <div><dt className="small muted">{t('noPhotoReason')}</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{refusal.noPhotoReason}</dd></div> : null}
      {review ? <div><dt className="small muted">{t('reviewReason')}</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{review.reason}</dd>
        <dd className="small muted">{t('reviewedBy', { name: review.reviewedBy.name, date: formatDateTime(review.reviewedAt, locale) })}</dd>
      </div> : null}
    </dl>
    {review?.decision === 'corrected' ? <CorrectedQuantities result={result} quantities={review.quantities} /> : null}
    {!review && reviewAction ? <ReviewDialog result={result} {...reviewAction} /> : null}
  </section>;
}

function ReviewDialog({ result, version, save }: { result: VisitResult; version: number; save: (body: unknown) => Promise<number> }) {
  const t = useTranslations('signatureRefusal');
  const [open, setOpen] = useState(false);
  const done = useRef(false);
  const descriptionId = useId();
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" size="sm" variant="outline" className="mt-3">{t('review')}</Button></DialogTrigger>
    <DialogContent className="dialog max-h-[85vh] overflow-y-auto" aria-describedby={descriptionId} onCloseAutoFocus={(event) => {
      if (!done.current) return;
      event.preventDefault();
      document.getElementById(`result-${result.id}`)?.focus({ preventScroll: true });
    }}>
      <DialogTitle className="text-lg font-semibold">{t('review')}</DialogTitle>
      <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">{t('dialogDescription')}</p>
      <ReviewForm result={result} version={version} save={save} onSaved={() => { done.current = true; setOpen(false); }} />
      <div className="mt-2 flex justify-end"><DialogClose asChild><Button type="button" variant="ghost">{t('cancel')}</Button></DialogClose></div>
    </DialogContent>
  </Dialog>;
}

function ReviewForm({ result, version, save, onSaved }: {
  result: VisitResult; version: number; save: (body: unknown) => Promise<number>; onSaved: () => void;
}) {
  const t = useTranslations('signatureRefusal');
  const [decision, setDecision] = useState<'approved' | 'corrected'>('approved');
  const request = useRef<{ payload: string; id: string } | null>(null);
  return <ActionForm dataVersion={version} onResetDraft={() => setDecision('approved')} submitLabel={t('save')} successMessage={t('saved')}
    onSubmit={async (data) => {
      const reason = textField(data, 'reason');
      if (!reason) throw new Error(t('reasonRequired'));
      let quantities: VisitResult['quantities'] | undefined;
      if (decision === 'corrected') {
        quantities = result.quantities.map((reported) => {
          const adjusted = { ...reported };
          for (const operation of workOperations) {
            const maximum = reported[operation.done] ?? 0;
            if (maximum === 0) continue;
            const value = textField(data, correctionField(reported.sourceLineId, operation.done));
            const parsed = quantityMilli(value);
            if (!value || parsed === null || parsed > maximum) throw new Error(t('invalidQuantity'));
            adjusted[operation.done] = parsed;
          }
          return adjusted;
        });
        const changed = quantities.some((adjusted, index) => workOperations.some((operation) =>
          adjusted[operation.done] !== result.quantities[index]?.[operation.done]));
        if (!changed) throw new Error(t('changeRequired'));
      }
      const command = { version, decision, reason, ...(quantities === undefined ? {} : { quantities }) };
      const payload = JSON.stringify(command);
      if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
      const savedVersion = await save(signatureRefusalReviewCommandSchema.parse({ ...command, requestId: request.current.id }));
      onSaved();
      return savedVersion;
    }}>
    <ChoiceGroup label={t('decision')}>
      <label className="checkbox-label"><Input type="radio" className="size-4 shrink-0 accent-primary" name="decision" value="approved"
        checked={decision === 'approved'} onChange={() => setDecision('approved')} />{t('accept')}</label>
      <label className="checkbox-label"><Input type="radio" className="size-4 shrink-0 accent-primary" name="decision" value="corrected"
        checked={decision === 'corrected'} onChange={() => setDecision('corrected')} />{t('correct')}</label>
    </ChoiceGroup>
    {decision === 'corrected' ? <CorrectionFields result={result} /> : null}
    <Field label={t('reviewReason')}><textarea name="reason" rows={3} maxLength={2000} required /></Field>
  </ActionForm>;
}

function correctionField(lineId: number, operation: (typeof workOperations)[number]['done']) {
  return `correction-${lineId}-${operation}`;
}

function CorrectionFields({ result }: { result: VisitResult }) {
  const t = useTranslations('signatureRefusal');
  const workText = useTranslations('workPlan');
  const deliveryText = useTranslations('delivery');
  const locale = useLocale();
  const items = new Map(result.sourceSnapshot.items.map((item) => [item.sourceLineId, item]));
  return <div className="mb-4">
    <p className="small muted">{t('correctionHint')}</p>
    {result.quantities.map((quantity) => {
      const fields = workOperations.filter((operation) => (quantity[operation.done] ?? 0) > 0);
      if (!fields.length) return null;
      const item = items.get(quantity.sourceLineId);
      const product = item ? sourceLineLabel(result.sourceSnapshot, item, locale) : deliveryText('sourceLine', { id: quantity.sourceLineId });
      return <fieldset key={quantity.sourceLineId} className="mt-3 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium [overflow-wrap:anywhere]">{product}</legend>
        <div className="grid gap-x-3 sm:grid-cols-2">{fields.map((operation) => {
          const maximum = (quantity[operation.done] ?? 0) / 1000;
          return <Field key={operation.done} label={`${workText(operation.label)}${item?.uom ? ` · ${item.uom}` : ''}`}>
            <Input type="number" name={correctionField(quantity.sourceLineId, operation.done)} min={0} max={maximum} step="0.001"
              inputMode="decimal" required defaultValue={maximum} aria-label={t('quantityLabel', { operation: workText(operation.label), product, unit: item?.uom ?? '' })} />
          </Field>;
        })}</div>
      </fieldset>;
    })}
  </div>;
}

function CorrectedQuantities({ result, quantities }: { result: VisitResult; quantities: VisitResult['quantities'] }) {
  const t = useTranslations('signatureRefusal');
  const workText = useTranslations('workPlan');
  const deliveryText = useTranslations('delivery');
  const locale = useLocale();
  const format = useFormatter();
  const corrected = new Map(quantities.map((quantity) => [quantity.sourceLineId, quantity]));
  const items = new Map(result.sourceSnapshot.items.map((item) => [item.sourceLineId, item]));
  return <div className="mt-3">
    <h5 className="text-sm font-medium">{t('adjustedQuantities')}</h5>
    <ul className="mt-1 grid gap-1 text-sm">{result.quantities.flatMap((reported) => {
      const item = items.get(reported.sourceLineId);
      return workOperations.flatMap((operation) => {
        const before = reported[operation.done] ?? 0;
        const after = corrected.get(reported.sourceLineId)?.[operation.done] ?? 0;
        if (before === after) return [];
        return <li key={correctionField(reported.sourceLineId, operation.done)} className="[overflow-wrap:anywhere]">
          {item ? sourceLineLabel(result.sourceSnapshot, item, locale) : deliveryText('sourceLine', { id: reported.sourceLineId })}
          {' · '}{workText(operation.label)}{' · '}
          {t('quantityChange', { before: format.number(before / 1000), after: format.number(after / 1000), unit: item?.uom ?? '' })}
        </li>;
      });
    })}</ul>
  </div>;
}
