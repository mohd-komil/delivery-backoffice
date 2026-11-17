'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { CalendarFilters as CalendarFilterValues, calendarFilterOptions } from '@/lib/calendar-filters';
import { Field } from './ui';
import { Combobox } from './ui/combobox';

export function CalendarFilters({ filters, options, shown, total, available, loading, error, onRetry, onGeographyChange, onChange }: {
  filters: CalendarFilterValues;
  options: ReturnType<typeof calendarFilterOptions>;
  shown: number;
  total: number;
  available: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onGeographyChange: (key: 'city' | 'province' | 'postalCode', value: string | null | undefined) => void;
  onChange: (filters: CalendarFilterValues) => void;
}) {
  const t = useTranslations('calendar');
  const geography = useTranslations('inboxGeography');
  const hintId = useId();
  const active = filters.city !== undefined || filters.province !== undefined || filters.postalCode !== undefined
    || filters.crewId !== undefined || filters.customerName.length > 0;
  const fields = [
    { key: 'city', choices: options.cities, all: 'allCities' },
    { key: 'province', choices: options.provinces, all: 'allProvinces' },
    { key: 'postalCode', choices: options.postalCodes, all: 'allPostalCodes' },
  ] as const;

  return <section className="my-4 rounded-xl border border-border bg-card shadow-xs" aria-label={t('filtersTitle')} aria-describedby={hintId}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5h16l-6 7v6l-4 2v-8z" /></svg>
        </span>
        <h2 className="text-sm font-semibold">{t('filtersTitle')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">{t('filteredCount', { shown, total })}</span>
      </div>
      <button type="button" className="button secondary" disabled={!active} onClick={() => onChange({ customerName: '' })}>{geography('clear')}</button>
    </div>
    <div className="p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 [&_.field]:m-0">
        {fields.map(({ key, choices, all }) => <Field key={key} label={geography(key)}>
          <Combobox aria-label={geography(key)} disabled={!available} value={filters[key] === undefined ? '' : JSON.stringify(filters[key])} onChange={(event) => {
            onGeographyChange(key, choices.find((choice) => JSON.stringify(choice.value) === event.currentTarget.value)?.value);
          }}>
            <option value="">{geography(all)}</option>
            {choices.map((choice) => <option key={JSON.stringify(choice.value)} value={JSON.stringify(choice.value)}>{choice.value === null ? geography('missing', { count: choice.count }) : `${choice.value} (${choice.count})`}</option>)}
          </Combobox>
        </Field>)}
        <Field label={t('teamFilter')}>
          <Combobox aria-label={t('teamFilter')} disabled={!available} value={filters.crewId === undefined ? '' : JSON.stringify(filters.crewId)} onChange={(event) => {
            const choice = options.crews.find((item) => JSON.stringify(item.value) === event.currentTarget.value);
            onChange({ ...filters, crewId: choice?.value, crewName: choice?.label ?? undefined });
          }}>
            <option value="">{t('allTeams')}</option>
            {options.crews.map((choice) => <option key={JSON.stringify(choice.value)} value={JSON.stringify(choice.value)}>{choice.label ?? t('noCrewAssigned')}</option>)}
          </Combobox>
        </Field>
        <Field label={t('customerNameFilter')}>
          <input type="search" value={filters.customerName} placeholder={t('customerSearch')} maxLength={250} onChange={(event) => onChange({ ...filters, customerName: event.currentTarget.value })} />
        </Field>
      </div>
      <p id={hintId} className="mt-3 text-xs leading-relaxed text-muted-foreground">{t('filtersHint')}</p>
      {loading ? <p className="mt-2 text-xs text-muted-foreground" role="status">{t('loadingFilterLists')}</p> : error ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" role="status">
        <span className="text-destructive">{t('filterListsUnavailable')} {error}</span>
        <button type="button" className="text-button" onClick={onRetry}>{t('retryFilterLists')}</button>
      </div> : null}
    </div>
  </section>;
}
