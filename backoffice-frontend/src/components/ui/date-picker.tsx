'use client';

import { useId, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { useLocale } from 'next-intl';
import { enGB, it, ru, uz } from 'date-fns/locale';
import { formatLocale, resolveLocale } from '@/i18n/config';
import { Calendar } from './calendar';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const copy = {
  en: { choose: 'Choose a date', month: 'Choose a month', time: 'Time', today: 'Today', clear: 'Clear', done: 'Done', previous: 'Previous month', next: 'Next month', previousYear: 'Previous year', nextYear: 'Next year' },
  it: { choose: 'Scegli una data', month: 'Scegli un mese', time: 'Ora', today: 'Oggi', clear: 'Cancella', done: 'Fine', previous: 'Mese precedente', next: 'Mese successivo', previousYear: 'Anno precedente', nextYear: 'Anno successivo' },
  ru: { choose: 'Выберите дату', month: 'Выберите месяц', time: 'Время', today: 'Сегодня', clear: 'Очистить', done: 'Готово', previous: 'Предыдущий месяц', next: 'Следующий месяц', previousYear: 'Предыдущий год', nextYear: 'Следующий год' },
  uz: { choose: 'Sanani tanlang', month: 'Oyni tanlang', time: 'Vaqt', today: 'Bugun', clear: 'Tozalash', done: 'Tayyor', previous: 'Oldingi oy', next: 'Keyingi oy', previousYear: 'Oldingi yil', nextYear: 'Keyingi yil' },
};
const locales = { en: enGB, it, ru, uz };
const smallButton = 'inline-flex min-h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40';

function parseDay(value: string): Date | undefined {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month) return undefined;
  const result = new Date(year, month - 1, day || 1, 12);
  return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === (day || 1) ? result : undefined;
}
function dayValue(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function todayInRome(): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parseDay(day) ?? new Date();
}

type DatePickerProps = Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'ref' | 'children'> & {
  type: 'date' | 'month' | 'datetime-local';
  value: string;
  label: string;
  onValueChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  'data-booking-field'?: string;
};

/** Calendar/Popover UI; the native bridge retains browser validity and FormData. */
export function DatePicker({ type, value, label, onValueChange, inputRef, className = '', id, disabled, onInvalid, onFocus, ...inputProps }: DatePickerProps) {
  const locale = resolveLocale(useLocale());
  const text = copy[locale];
  const generated = useId();
  const localInput = useRef<HTMLInputElement>(null);
  const nativeInput = inputRef ?? localInput;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [validation, setValidation] = useState('');
  const selected = parseDay(value);
  const [year, setYear] = useState(() => selected?.getFullYear() ?? todayInRome().getFullYear());
  const [month, setMonth] = useState(() => selected ?? todayInRome());
  const controlId = id ?? generated;
  const time = value.split('T')[1] ?? '';
  const formatted = selected ? new Intl.DateTimeFormat(formatLocale(locale), { day: type === 'month' ? undefined : 'numeric', month: 'short', year: 'numeric' }).format(selected) : '';
  function change(next: string) { setValidation(''); onValueChange(next); }
  function chooseDay(date: Date) {
    const next = dayValue(date);
    change(type === 'month' ? next.slice(0, 7) : type === 'datetime-local' ? `${next}T${time || '09:00'}` : next);
    if (type !== 'datetime-local') setOpen(false);
  }
  return <div className={`relative min-w-0 ${className}`} data-date-picker={type}>
    <input {...inputProps} ref={nativeInput} type={type} id={controlId} value={value} disabled={disabled}
      aria-hidden="true" tabIndex={-1} className="sr-only" style={{ minHeight: 0, width: 1, height: 1, padding: 0, border: 0 }}
      onChange={(event) => change(event.currentTarget.value)} onFocus={(event) => { onFocus?.(event); trigger.current?.focus(); }}
      onInvalid={(event) => { onInvalid?.(event); event.preventDefault(); setValidation(event.currentTarget.validationMessage); trigger.current?.focus(); }} />
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setMonth(selected ?? todayInRome()); setYear(selected?.getFullYear() ?? todayInRome().getFullYear()); } }}>
      <PopoverTrigger asChild><button type="button" ref={trigger} disabled={disabled} aria-label={label} role="combobox" aria-haspopup="dialog" aria-autocomplete="none" aria-expanded={open} aria-controls={`${controlId}-calendar`}
        aria-required={inputProps.required} aria-invalid={inputProps['aria-invalid'] || Boolean(validation)}
        aria-describedby={[inputProps['aria-describedby'], validation ? `${controlId}-validation` : ''].filter(Boolean).join(' ') || undefined}
        className="flex min-h-10 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2 text-left text-sm font-normal text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50">
        <span className={formatted ? 'min-w-0 truncate' : 'min-w-0 truncate text-muted-foreground'}>{formatted ? `${formatted}${type === 'datetime-local' && time ? ` · ${time}` : ''}` : text[type === 'month' ? 'month' : 'choose']}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-muted-foreground" aria-hidden="true"><path d="M8 2v4m8-4v4M3 10h18M4 4h16v17H4z" /></svg>
      </button></PopoverTrigger>
      <PopoverContent id={`${controlId}-calendar`} className="w-auto max-w-[calc(100vw-2rem)] p-0" align="start" aria-label={label}>
        {type === 'month' ? <div className="w-72 p-3">
          <div className="mb-3 flex items-center justify-between"><button type="button" className={smallButton} aria-label={text.previousYear} onClick={() => setYear((current) => current - 1)}>‹</button><span className="text-sm font-semibold">{year}</span><button type="button" className={smallButton} aria-label={text.nextYear} onClick={() => setYear((current) => current + 1)}>›</button></div>
          <div className="grid grid-cols-3 gap-2">{Array.from({ length: 12 }, (_, index) => {
            const date = new Date(year, index, 1, 12);
            const chosen = selected?.getFullYear() === year && selected.getMonth() === index;
            return <button type="button" key={index} aria-pressed={chosen} className={`${smallButton} ${chosen ? 'border-primary bg-primary text-primary-foreground' : ''}`} onClick={() => chooseDay(date)}>{new Intl.DateTimeFormat(formatLocale(locale), { month: 'short' }).format(date)}</button>;
          })}</div>
        </div> : <Calendar mode="single" required selected={selected} month={month} onMonthChange={setMonth} onSelect={chooseDay} locale={locales[locale]} today={todayInRome()}
          labels={{ labelPrevious: () => text.previous, labelNext: () => text.next, labelDayButton: (date) => new Intl.DateTimeFormat(formatLocale(locale), { dateStyle: 'full' }).format(date) }} />}
        {type === 'datetime-local' ? <div className="border-t border-border p-3"><label className="grid gap-2 text-xs font-medium">{text.time}<input type="time" aria-label={`${label} · ${text.time}`} disabled={!selected} step={inputProps.step ?? 60} value={time} onChange={(event) => change(event.currentTarget.value && selected ? `${dayValue(selected)}T${event.currentTarget.value}` : '')} className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" /></label></div> : null}
        <div className="flex items-center justify-between gap-2 border-t border-border p-3"><button type="button" className={smallButton} onClick={() => chooseDay(todayInRome())}>{text.today}</button><button type="button" className={smallButton} onClick={() => change('')}>{text.clear}</button><button type="button" className={smallButton} onClick={() => setOpen(false)}>{text.done}</button></div>
      </PopoverContent>
    </Popover>
    {validation ? <p id={`${controlId}-validation`} className="mt-1 text-xs text-destructive" role="alert">{validation}</p> : null}
  </div>;
}
