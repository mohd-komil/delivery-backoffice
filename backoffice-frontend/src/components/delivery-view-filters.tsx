'use client';

import { useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatLocale, resolveLocale } from '@/i18n/config';
import type { DeliveryList } from '@/lib/contracts';
import { emptyDeliveryViewFilters, type DeliveryFilterView, type DeliveryViewFilters } from '@/lib/delivery-view-filters';
import type { GeographyFilters } from '@/lib/geography-filters';
import { deliveryStatusLabel } from './delivery-detail-presentation';
import { DeliveryGeographyFields } from './inbox-geography-filters';
import { Field } from './ui';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { DatePicker } from './ui/date-picker';
import { Input } from './ui/input';

type FacetChoice<Value extends string> = { value: Value; label: string; count: number };
type FilterKey = keyof DeliveryViewFilters;
type ActiveFilter = { key: FilterKey; label: string; value: string };

const iconPaths = {
  filter: 'M3 6h18M6 12h12m-9 6h6',
  search: 'm20 20-4.3-4.3M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  chevron: 'm6 9 6 6 6-6',
  remove: 'm6 6 12 12M18 6 6 18',
};

function FilterIcon({ name, className = '' }: { name: keyof typeof iconPaths; className?: string }) {
  return <svg aria-hidden="true" className={`size-4 shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={iconPaths[name]} />
  </svg>;
}

function FacetField<Value extends string>({ label, all, selected, choices, onChange }: {
  label: string;
  all: string;
  selected: { value: Value; label: string } | undefined;
  choices: FacetChoice<Value>[] | undefined;
  onChange: (choice: FacetChoice<Value> | undefined) => void;
}) {
  const options = [...(choices ?? [])];
  if (selected && !options.some(({ value }) => value === selected.value)) options.push({ ...selected, count: 0 });

  return <Field label={label}>
    <Combobox aria-label={label} className="min-h-10" value={selected?.value ?? ''} disabled={!choices}
      onChange={(event) => onChange(options.find(({ value }) => value === event.target.value))}>
      <option value="">{all}</option>
      {options.map(({ value, label, count }) => <option key={value} value={value}>{label} ({count})</option>)}
    </Combobox>
  </Field>;
}

export function DeliveryFilters({ view, filters, facets, geographyFacets, geographyFacetsQuery, onChange }: {
  view: DeliveryFilterView;
  filters: DeliveryViewFilters;
  facets: DeliveryList['filterFacets'];
  geographyFacets: DeliveryList['geographyFacets'];
  geographyFacetsQuery: string | null;
  onChange: (filters: DeliveryViewFilters, changedGeography?: keyof GeographyFilters) => void;
}) {
  const t = useTranslations('deliveryFilters');
  const deliveries = useTranslations('delivery');
  const geographyText = useTranslations('inboxGeography');
  const locale = resolveLocale(useLocale());
  const headingId = useId();
  const advancedId = useId();
  const advancedHintId = useId();
  const rangeErrorId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(filters.search ?? '');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dateInvalid, setDateInvalid] = useState(false);
  const from = t(view === 'completed' ? 'completionFrom' : 'visitFrom');
  const to = t(view === 'completed' ? 'completionTo' : 'visitTo');
  const dateFormat = new Intl.DateTimeFormat(formatLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' });
  const issueLabel = filters.issueType ? deliveryStatusLabel(deliveries, filters.issueType) : undefined;
  const returnLabel = filters.returnStatus ? deliveryStatusLabel(deliveries, filters.returnStatus) : undefined;
  const location = [
    [filters.geography.city, geographyText('city')],
    [filters.geography.province, geographyText('province')],
    [filters.geography.postalCode, geographyText('postalCode')],
  ].flatMap(([value, label]) => value === undefined ? [] : [value ?? `${label}: ${deliveries('notProvided')}`]).join(', ');

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'search', label: t('search'), value: filters.search });
  if (filters.crew) active.push({ key: 'crew', label: t('team'), value: filters.crew.name });
  if (issueLabel) active.push({ key: 'issueType', label: t('issueType'), value: issueLabel });
  if (returnLabel) active.push({ key: 'returnStatus', label: t('returnStatus'), value: returnLabel });
  if (filters.dateFrom) active.push({ key: 'dateFrom', label: from, value: dateFormat.format(new Date(filters.dateFrom)) });
  if (filters.dateTo) active.push({ key: 'dateTo', label: to, value: dateFormat.format(new Date(filters.dateTo)) });
  if (location) active.push({ key: 'geography', label: t('location'), value: location });
  const advancedCount = Number(Boolean(filters.dateFrom)) + Number(Boolean(filters.dateTo)) + Number(Boolean(location));

  function remove(key: FilterKey) {
    if (key === 'search' && search.trim() === filters.search) setSearch('');
    if (key === 'dateFrom' || key === 'dateTo') setDateInvalid(false);
    onChange(key === 'geography' ? { ...filters, geography: {} } : { ...filters, [key]: undefined });
  }

  function changeDate(field: 'dateFrom' | 'dateTo', value: string) {
    const next = { ...filters, [field]: value || undefined };
    const invalid = Boolean(next.dateFrom && next.dateTo && next.dateFrom > next.dateTo);
    setDateInvalid(invalid);
    if (!invalid) onChange(next);
  }

  return <section aria-labelledby={headingId} className="@container mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-xs [&_.field]:m-0 [&_.field]:min-w-0 [&_.field>[data-slot=combobox]]:mb-0 [&_.field_[role=combobox]]:min-h-11 @3xl:[&_.field_[role=combobox]]:min-h-10">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/25 px-4 py-2.5 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-info text-info-foreground"><FilterIcon name="filter" /></span>
        <h2 id={headingId} className="text-sm leading-snug font-semibold">{t('title')}</h2>
      </div>
      <Button type="button" variant="ghost" size="sm" className="min-h-9" disabled={!active.length && search === ''} onClick={() => {
        setSearch('');
        setDateInvalid(false);
        onChange(emptyDeliveryViewFilters);
        searchInput.current?.focus();
      }}>{t('clear')}</Button>
    </div>
    <div className="flex flex-wrap items-end gap-3 px-4 py-3.5 sm:px-5 [&>label]:flex-[1_1_11rem] @3xl:[&>label]:max-w-56">
      <form className="flex min-w-0 flex-[5_1_18rem] items-end gap-2 [&_.field]:flex-1" method="post" onSubmit={(event) => {
        event.preventDefault();
        const term = search.trim();
        setSearch(term);
        onChange({ ...filters, search: term || undefined });
      }}>
        <Field label={t('search')}>
          <div className="relative">
            <FilterIcon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchInput} type="search" className="h-11 ps-9 @3xl:h-10" placeholder={t('searchPlaceholder')} maxLength={100} value={search}
              onChange={(event) => setSearch(event.target.value)} />
          </div>
        </Field>
        <Button type="submit" className="h-11 @3xl:h-10">{t('searchSubmit')}</Button>
      </form>
      {view === 'planned' ? null : <FacetField label={t('team')} all={t('allTeams')}
        selected={filters.crew ? { value: filters.crew.id, label: filters.crew.name } : undefined}
        choices={facets?.crews.map(({ id, name, count }) => ({ value: id, label: name, count }))}
        onChange={(choice) => onChange({ ...filters, crew: choice ? { id: choice.value, name: choice.label } : undefined })} />}
      {view === 'issues' ? <FacetField label={t('issueType')} all={t('allIssueTypes')}
        selected={filters.issueType && issueLabel ? { value: filters.issueType, label: issueLabel } : undefined}
        choices={facets?.issueTypes.map(({ value, count }) => ({ value, label: deliveryStatusLabel(deliveries, value), count }))}
        onChange={(choice) => onChange({ ...filters, issueType: choice?.value })} /> : null}
      {view === 'return_required' ? <FacetField label={t('returnStatus')} all={t('allReturnStatuses')}
        selected={filters.returnStatus && returnLabel ? { value: filters.returnStatus, label: returnLabel } : undefined}
        choices={facets?.returnStatuses.map(({ value, count }) => ({ value, label: deliveryStatusLabel(deliveries, value), count }))}
        onChange={(choice) => onChange({ ...filters, returnStatus: choice?.value })} /> : null}
      <Button type="button" variant="outline" className="h-11 shrink-0 aria-expanded:bg-muted @3xl:h-10"
        aria-expanded={advancedOpen} aria-controls={advancedId} aria-describedby={advancedHintId} onClick={() => setAdvancedOpen(!advancedOpen)}>
        {t('more')}
        {advancedCount ? <span aria-hidden="true" className="inline-grid size-5 place-items-center rounded-full bg-info text-[11px] font-semibold text-info-foreground">{advancedCount}</span> : null}
        <FilterIcon name="chevron" className={`text-muted-foreground motion-safe:transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
      </Button>
      <span id={advancedHintId} className="sr-only">{t('moreHint')}</span>
    </div>
    {active.length > 0 ? <ul aria-label={t('applied')} className="flex list-none flex-wrap gap-1.5 border-t border-border px-4 py-2.5 sm:px-5">
      {active.map(({ key, label, value }) => <li key={key} className="max-w-full min-w-0">
        <button type="button" aria-label={t('remove', { label, value })} title={t('remove', { label, value })}
          className="flex min-h-8 max-w-full items-center gap-2 rounded-full border border-info-foreground/15 bg-info py-1 pr-2.5 pl-3 text-left text-xs text-info-foreground motion-safe:transition-colors hover:border-info-foreground/35 hover:bg-info-foreground/10 focus-visible:outline-offset-1"
          onClick={(event) => {
            const item = event.currentTarget.parentElement;
            const neighbor = item?.nextElementSibling ?? item?.previousElementSibling;
            (neighbor?.querySelector('button') ?? searchInput.current)?.focus();
            remove(key);
          }}>
          <span className="min-w-0 wrap-anywhere"><span className="font-semibold">{label}:</span> {value}</span>
          <FilterIcon name="remove" className="size-3.5" />
        </button>
      </li>)}
    </ul> : null}
    <div id={advancedId} hidden={!advancedOpen} className="border-t border-border bg-muted/25 px-4 py-4 sm:px-5">
      <div className="grid gap-4 @4xl:grid-cols-[2fr_3fr] @4xl:gap-5">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-muted-foreground">{t(view === 'completed' ? 'completionDates' : 'visitDates')}</legend>
          <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2">
            <Field label={from}>
              <DatePicker type="date" label={from} value={filters.dateFrom ?? ''} onValueChange={(value) => changeDate('dateFrom', value)}
                aria-invalid={dateInvalid || undefined} aria-describedby={dateInvalid ? rangeErrorId : undefined} />
            </Field>
            <Field label={to}>
              <DatePicker type="date" label={to} value={filters.dateTo ?? ''} onValueChange={(value) => changeDate('dateTo', value)}
                aria-invalid={dateInvalid || undefined} aria-describedby={dateInvalid ? rangeErrorId : undefined} />
            </Field>
          </div>
          {dateInvalid ? <p id={rangeErrorId} role="alert" className="mt-2 text-xs text-destructive">{t('dateOrder')}</p> : null}
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-muted-foreground">{t('location')}</legend>
          <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @md:grid-cols-3 [&>.field:last-child]:col-span-full @md:[&>.field:last-child]:col-span-1">
            <DeliveryGeographyFields filters={filters.geography} facets={geographyFacets} facetsQuery={geographyFacetsQuery}
              onChange={(geography, field) => onChange({ ...filters, geography }, field)} />
          </div>
        </fieldset>
      </div>
    </div>
  </section>;
}
