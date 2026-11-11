'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { formatLocale } from '@/shared/i18n/config';
import { incompleteReasonMessages, incompleteWorkFieldName, incompleteWorkNoteMaxLength, incompleteWorkReasons, type IncompleteWorkError } from '../model/incomplete-work';
import { enteredQuantityMilli, quantityFieldName, type quantityFields, type QuantityError } from '../model/quantity';

export function FinishOperation({ item, field, headingId, hintId, error, clearError }: {
  item: VisitDetail['items'][number]; field: ReturnType<typeof quantityFields>[number];
  headingId: string; hintId: string; error: QuantityError | IncompleteWorkError | null; clearError: () => void;
}) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const { operation, remaining, planned, limit } = field;
  const name = quantityFieldName(item.sourceLineId, operation);
  const id = `${headingId}-${operation}`;
  const format = new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 3 });
  const amount = (value: number) => format.format(value / 1000);
  const actual = enteredQuantityMilli(quantity);
  const incomplete = planned !== undefined && planned > 0 && actual !== null && actual < planned;
  const quantityError = error?.field === 'quantity' && error.name === name ? error : null;
  const workError = error?.field === 'incompleteWork' && error.operation === operation ? error : null;
  const available = item.serviceWork?.availableInstallationMilli;
  const showAvailable = operation === 'installation' && item.serviceWork?.service === 'delivery_installation'
    && available !== undefined && available < limit;
  const noteRequired = reason === 'other';

  return <div className="finish-quantity-row">
    <div>
      <label id={`${id}-label`} htmlFor={id} className="field-label">{t(operation)}</label>
      {planned !== undefined ? <p className="font-medium">{t('plannedForVisit', { amount: amount(planned), uom: item.uom })}</p> : null}
      <p id={`${id}-remaining`} className="text-muted">{item.serviceWork
        ? t('workRemaining', { amount: amount(remaining), uom: item.uom })
        : t('finishRemaining', { line: item.sourceLineId, amount: amount(remaining), uom: item.uom })}</p>
      {showAvailable ? <p id={`${id}-available`} className="text-muted">{t('installationAvailable', { amount: amount(available), uom: item.uom })}</p> : null}
    </div>
    <div className="field finish-quantity-input">
      <input id={id} name={name} type="text" inputMode="decimal" placeholder="0" value={quantity}
        aria-labelledby={`${headingId} ${id}-label`} maxLength={16} aria-invalid={quantityError ? true : undefined}
        aria-describedby={`${hintId} ${id}-remaining${showAvailable ? ` ${id}-available` : ''}${quantityError ? ` ${id}-error` : ''}`}
        onChange={(event) => { setQuantity(event.currentTarget.value); if (error) clearError(); }} />
    </div>
    {quantityError ? <p id={`${id}-error`} className="field-error" role="alert">{quantityError.reason === 'over'
      ? t('finishQuantityOver', { amount: amount(quantityError.limit), uom: item.uom }) : t('finishQuantityInvalid')}</p> : null}
    {incomplete ? <div className="col-span-full grid gap-2 rounded-md border border-border bg-[var(--muted-surface)] p-2.5">
      <p className="text-sm font-medium">{t(actual === 0 ? 'workNotPerformed' : 'workPartiallyPerformed', { amount: amount(planned - actual), uom: item.uom })}</p>
      <label className="field" htmlFor={`${id}-reason`}>
        <span id={`${id}-reason-label`}>{t('incompleteReason')}</span>
        <select id={`${id}-reason`} name={incompleteWorkFieldName(item.sourceLineId, operation, 'reason')} value={reason}
          aria-required="true" aria-labelledby={`${headingId} ${id}-label ${id}-reason-label`}
          aria-invalid={workError?.reason === 'reasonRequired' || undefined} aria-describedby={workError ? `${id}-incomplete-error` : undefined}
          onChange={(event) => { setReason(event.currentTarget.value); if (workError) clearError(); }}>
          <option value="">{t('incompleteChooseReason')}</option>
          {incompleteWorkReasons.map((value) => <option key={value} value={value}>{t(incompleteReasonMessages[value])}</option>)}
        </select>
      </label>
      <label className="field" htmlFor={`${id}-note`}>
        <span id={`${id}-note-label`}>{t(noteRequired ? 'incompleteNoteRequired' : 'incompleteNoteOptional')}</span>
        <textarea id={`${id}-note`} name={incompleteWorkFieldName(item.sourceLineId, operation, 'note')} rows={2}
          value={note} maxLength={incompleteWorkNoteMaxLength} aria-required={noteRequired || undefined}
          aria-labelledby={`${headingId} ${id}-label ${id}-note-label`}
          aria-invalid={workError && workError.reason !== 'reasonRequired' ? true : undefined}
          aria-describedby={workError ? `${id}-incomplete-error` : undefined}
          onChange={(event) => { setNote(event.currentTarget.value); if (workError) clearError(); }} />
      </label>
      {workError ? <p id={`${id}-incomplete-error`} className="field-error" role="alert">{workError.reason === 'reasonRequired'
        ? t('incompleteReasonRequired') : workError.reason === 'noteRequired' ? t('incompleteExplainOther') : t('finishItemNoteTooLong', { count: incompleteWorkNoteMaxLength })}</p> : null}
    </div> : planned !== undefined && planned > 0 && actual === planned ? <p className="col-span-full text-sm text-muted">{t('workFullyPerformed')}</p> : null}
  </div>;
}
