'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { bookingLocalValue, bookingTimeOptions, parseBookingInstant } from '@/lib/time';
import { Field, textField } from './ui';
import { Input } from './ui/input';
import type { DeliveryText } from './delivery-detail-presentation';

export function dateTimeField(data: FormData, name: string, t: DeliveryText): string {
  const value = textField(data, name);
  if (!value) throw new Error(t('validRomeTime'));
  return parseBookingInstant(value);
}

export function DateTimeFields({ startsAt, endsAt, startsAtName = 'startsAt', endsAtName = 'endsAt', startsAtLabel, endsAtLabel }: { startsAt?: string; endsAt?: string; startsAtName?: string; endsAtName?: string; startsAtLabel?: string; endsAtLabel?: string }) {
  const t = useTranslations('delivery');
  return <div className="form-grid"><DateTimeInput name={startsAtName} label={startsAtLabel ?? t('startsAt')} initialInstant={startsAt} /><DateTimeInput name={endsAtName} label={endsAtLabel ?? t('endsAt')} initialInstant={endsAt} /></div>;
}

export function DateTimeInput({ name, label, initialInstant, onInstantChange }: {
  name: string; label: string; initialInstant?: string; onInstantChange?: (instant: string) => void;
}) {
  const t = useTranslations('delivery');
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState(() => initialInstant ? bookingLocalValue(initialInstant) : '');
  const [chosen, setChosen] = useState(() => initialInstant ? parseBookingInstant(initialInstant) : '');
  const options = bookingTimeOptions(local);
  const selected = options.length === 1 ? options[0]?.value ?? '' : options.find((option) => option.value === chosen)?.value ?? '';
  const invalidMessage = local && options.length === 0 ? t('invalidRomeTime') : '';
  const error = invalidMessage || (options.length > 1 && !selected ? t('repeatedRomeHour') : null);
  const occurrenceLabel = t('occurrenceLabel', { label });
  useEffect(() => { input.current?.setCustomValidity(invalidMessage); }, [invalidMessage]);
  const initialDate = initialInstant ? new Date(initialInstant) : null;
  const step = initialDate?.getUTCMilliseconds() ? '0.001' : initialDate?.getUTCSeconds() ? '1' : '60';
  return <div><Field label={label} hint={t('romeTime')}><Input ref={input} id={inputId} data-booking-field={name} type="datetime-local" required step={step} value={local} aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : undefined} onChange={(event) => {
    const value = event.target.value;
    const choices = bookingTimeOptions(value);
    event.currentTarget.setCustomValidity(value && choices.length === 0 ? t('invalidRomeTime') : '');
    setLocal(value); setChosen('');
    onInstantChange?.(choices.length === 1 ? choices[0]?.value ?? '' : '');
  }} /></Field><input type="hidden" name={name} value={selected} />{options.length > 1 ? <Field label={occurrenceLabel}><select aria-label={occurrenceLabel} required value={selected} onChange={(event) => {
    setChosen(event.target.value);
    onInstantChange?.(event.target.value);
  }}><option value="">{t('chooseOccurrence')}</option>{options.map((option, index) => <option key={option.value} value={option.value}>{t(index === 0 ? 'firstOccurrence' : 'secondOccurrence', { offset: option.offset })}</option>)}</select></Field> : null}{error ? <p id={`${inputId}-error`} className="small text-destructive" role="status">{error}</p> : null}</div>;
}
