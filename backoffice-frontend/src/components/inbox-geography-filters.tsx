'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { DeliveryList } from '@/lib/contracts';
import { geographyFilterQuery, type GeographyFilters } from '@/lib/geography-filters';
import { Field } from './ui';
import { Combobox } from './ui/combobox';

export type InboxGeography = GeographyFilters;
export { geographyFilterQuery as inboxGeographyQuery, selectSoleGeographyOptions } from '@/lib/geography-filters';

type GeographyFieldsProps = {
  filters: InboxGeography;
  facets: DeliveryList['geographyFacets'];
  facetsQuery: string | null;
  onChange: (filters: InboxGeography, changed?: keyof InboxGeography) => void;
};

function geographyReadiness({ filters, facets, facetsQuery }: Omit<GeographyFieldsProps, 'onChange'>) {
  const applied = new URLSearchParams(facetsQuery ?? '');
  const requested = new URLSearchParams(geographyFilterQuery(filters));
  const matchesContext = (key: keyof InboxGeography) => applied.get(key) === requested.get(key)
    && applied.get(`${key}Missing`) === requested.get(`${key}Missing`);
  const citiesReady = facets !== undefined && facetsQuery !== null;
  const provincesReady = citiesReady && matchesContext('city');
  const postalCodesReady = provincesReady && matchesContext('province');
  return { citiesReady, provincesReady, postalCodesReady };
}

export function DeliveryGeographyFields({ filters, facets, facetsQuery, onChange }: GeographyFieldsProps) {
  const t = useTranslations('inboxGeography');
  const { citiesReady, provincesReady, postalCodesReady } = geographyReadiness({ filters, facets, facetsQuery });
  const fields = [
    { key: 'city', label: 'city', all: 'allCities', options: facets?.cities, ready: citiesReady },
    { key: 'province', label: 'province', all: 'allProvinces', options: facets?.provinces, ready: provincesReady },
    { key: 'postalCode', label: 'postalCode', all: 'allPostalCodes', options: facets?.postalCodes, ready: postalCodesReady },
  ] as const;

  return <>{fields.map(({ key, label, all, options, ready }) => {
    const selected = filters[key];
    const available = ready ? options ?? [] : options?.filter((option) => option.value === selected) ?? [];
    const choices = selected !== undefined && !available.some((option) => option.value === selected)
      ? [...available, { value: selected, count: 0 }] : available;
    return <Field key={key} label={t(label)}>
      <Combobox aria-label={t(label)} value={selected === undefined ? '' : JSON.stringify(selected)} disabled={!ready} onChange={(event) => {
        const choice = choices.find((option) => JSON.stringify(option.value) === event.target.value);
        if (key === 'city') onChange({ city: choice?.value }, 'city');
        else if (key === 'province') onChange({ city: filters.city, province: choice?.value }, 'province');
        else onChange({ ...filters, postalCode: choice?.value }, 'postalCode');
      }}>
        <option value="">{t(all)}</option>
        {choices.map((option) => <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>{option.value === null ? t('missing', { count: option.count }) : `${option.value} (${option.count})`}</option>)}
      </Combobox>
    </Field>;
  })}</>;
}

export function InboxGeographyFilters({ failed, ...fields }: GeographyFieldsProps & { failed: boolean }) {
  const t = useTranslations('inboxGeography');
  const hintId = useId();
  const { postalCodesReady } = geographyReadiness(fields);
  return <section className="mt-6 rounded-lg border border-border bg-card p-4" aria-label={t('title')} aria-describedby={hintId}>
    <div className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto] [&_.field]:m-0">
      <DeliveryGeographyFields {...fields} />
      <button type="button" className="button secondary whitespace-nowrap" disabled={!Object.values(fields.filters).some((value) => value !== undefined)} onClick={() => fields.onChange({})}>{t('clear')}</button>
    </div>
    <p id={hintId} className="mt-3 text-xs text-muted-foreground">{t('hint')}</p>
    {!postalCodesReady ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t(failed || (fields.facetsQuery !== null && !fields.facets) ? 'unavailable' : 'updating')}</p> : null}
  </section>;
}
