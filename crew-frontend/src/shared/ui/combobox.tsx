'use client';

import { useId, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { useLocale } from 'next-intl';
import { Command } from 'cmdk';
import { cn } from '@/shared/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

type Option = { value: string; label: string; disabled: boolean; group: string | null };
type Snapshot = { value: string; options: Option[] };
type ComboboxProps = Omit<ComponentProps<'select'>, 'multiple' | 'size'> & { multiple?: false };

const labels = {
  en: { search: 'Search options…', empty: 'No matching options.', choose: 'Select an option', required: 'Please select an option.' },
  it: { search: 'Cerca opzioni…', empty: 'Nessuna opzione trovata.', choose: 'Seleziona un’opzione', required: 'Seleziona un’opzione.' },
  ru: { search: 'Поиск вариантов…', empty: 'Ничего не найдено.', choose: 'Выберите вариант', required: 'Выберите вариант.' },
  uz: { search: 'Variantlarni qidirish…', empty: 'Mos variant topilmadi.', choose: 'Variantni tanlang', required: 'Variantni tanlang.' },
};

/** A searchable shadcn Popover/Command with a native form and React-event bridge.
 * The select is not exposed to assistive technology or keyboard navigation.
 * Its options remain authoritative for disabled states, FormData and validation.
 */
export function Combobox({ children, className, id, ref, onChange, onInvalid, disabled, required, tabIndex,
  'aria-label': ariaLabel, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid,
  ...props }: ComboboxProps) {
  const locale = useLocale();
  const text = locale === 'ru' ? labels.ru : locale === 'it' ? labels.it : locale === 'uz' ? labels.uz : labels.en;
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const native = useRef<HTMLSelectElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const command = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({ value: '', options: [] });
  const lastSnapshot = useRef('');

  function synchronize() {
    const select = native.current;
    if (!select) return;
    const next = { value: select.value, options: Array.from(select.options, (option) => ({
      value: option.value, label: option.label, disabled: option.disabled || option.parentElement?.hasAttribute('disabled') === true,
      group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.getAttribute('label') : null,
    })) };
    const key = JSON.stringify(next);
    if (lastSnapshot.current !== key) { lastSnapshot.current = key; setSnapshot(next); }
  }

  // Synchronize an external native form control, including option changes on Refresh.
  useLayoutEffect(synchronize);
  useLayoutEffect(() => {
    const form = native.current?.form;
    if (!form) return;
    const reset = () => { queueMicrotask(() => { synchronize(); setInvalid(false); setOpen(false); }); };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [props.form]);

  const selected = snapshot.options.find((option) => option.value === snapshot.value);
  // Empty-value placeholders/clear actions are not records. Disabled records count.
  const searchable = snapshot.options.filter((option) => option.value !== '').length > 5;
  const previousSearchable = useRef(searchable);
  useLayoutEffect(() => {
    if (open && previousSearchable.current !== searchable) (searchable ? searchInput.current : command.current)?.focus();
    previousSearchable.current = searchable;
  }, [open, searchable]);
  const errorId = `${generatedId}-error`;
  const description = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  function choose(value: string) {
    const select = native.current;
    if (!select || select.matches(':disabled')) return;
    const option = Array.from(select.options).find((candidate) => candidate.value === value);
    if (!option || option.disabled || option.parentElement?.hasAttribute('disabled')) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    synchronize();
    setInvalid(false); setOpen(false);
  }

  return <span className="relative block min-w-0" data-slot="combobox">
    <Popover open={open} onOpenChange={(next) => { if (!next || !native.current?.matches(':disabled')) setOpen(next); }}>
      <PopoverTrigger asChild><button ref={trigger} id={triggerId} type="button" role="combobox"
        aria-expanded={open} aria-controls={open ? `${generatedId}-popup` : undefined} aria-haspopup="dialog" aria-label={ariaLabel} aria-labelledby={labelledBy}
        aria-required={required || undefined} aria-invalid={ariaInvalid ?? (invalid || undefined)} aria-describedby={description}
        disabled={disabled} tabIndex={tabIndex}
        className={cn('flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-xs text-foreground shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20', className)}>
        <span className="min-w-0 truncate">{selected?.label ?? text.choose}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-muted-foreground" aria-hidden="true"><path d="m8 9 4-4 4 4m-8 6 4 4 4-4" /></svg>
      </button></PopoverTrigger>
      <PopoverContent id={`${generatedId}-popup`} aria-label={ariaLabel ?? text.choose} className="w-[var(--radix-popover-trigger-width)] min-w-48 p-0" onOpenAutoFocus={(event) => { event.preventDefault(); (searchable ? searchInput.current : command.current)?.focus(); }}>
        <Command ref={command} tabIndex={-1} shouldFilter={searchable} label={ariaLabel ?? text.choose} defaultValue={`option-${snapshot.options.findIndex((option) => option.value === snapshot.value)}`}>
          {searchable ? <div className="flex items-center gap-2 border-b border-border px-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-muted-foreground" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
            <Command.Input ref={searchInput} placeholder={text.search} aria-label={text.search}
              className="h-10 w-full border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus:ring-0" />
          </div> : null}
          <Command.List className="max-h-64 overflow-y-auto overscroll-contain p-1" aria-label={ariaLabel ?? text.choose}>
            {searchable ? <Command.Empty className="p-4 text-center text-xs text-muted-foreground">{text.empty}</Command.Empty> : null}
            {snapshot.options.map((option, index) => <Command.Item key={`${index}:${option.value}`}
              value={`option-${index}`} keywords={[option.label, option.group ?? '']} disabled={option.disabled}
              onSelect={() => choose(option.value)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45">
              <span aria-hidden="true" className={cn('w-4 shrink-0', option.value !== snapshot.value && 'invisible')}>✓</span>
              <span className="min-w-0 break-words">{option.label}{option.group ? <span className="mt-0.5 block text-[10px] text-muted-foreground">{option.group}</span> : null}</span>
            </Command.Item>)}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
    <select {...props} id={`${triggerId}-native`} ref={(node) => { native.current = node; if (typeof ref === 'function') return ref(node); if (ref) ref.current = node; }}
      disabled={disabled} required={required} aria-label={ariaLabel} aria-hidden="true" tabIndex={-1} data-combobox-native="" className="sr-only"
      onChange={(event) => { synchronize(); setInvalid(false); onChange?.(event); }}
      onInvalid={(event) => { event.preventDefault(); setInvalid(true); trigger.current?.focus(); onInvalid?.(event); }}>
      {children}
    </select>
    {invalid ? <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">{text.required}</span> : null}
  </span>;
}
