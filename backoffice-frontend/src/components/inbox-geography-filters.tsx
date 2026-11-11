'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { DeliveryList } from '@/lib/contracts';
import { Field } from './ui';

export type InboxGeography = { city?: string | null; province?: string | null; postalCode?: string | null };

export function inboxGeographyQuery(filters: InboxGeography) {
  const query = new URLSearchParams();
  for (const key of ['city', 'province', 'postalCode'] as const) {
    const value = filters[key];
    if (value === null) query.set(`${key}Missing`, 'true');
    else if (value !== undefined) query.set(key, value);
  }
  return query.toString();
}

type GeographyOptions = NonNullable<DeliveryList['matchingGeographyFacets']>['cities'];

function soleKnownValue(matches: GeographyOptions | undefined, choices: GeographyOptions | undefined) {
  const option = matches?.length === 1 ? matches[0] : undefined;
  if (!option || option.value === null || option.count <= 0) return undefined;
  const value = option.value;
  return choices?.find((choice) => choice.value?.toLowerCase() === value.toLowerCase())?.value ?? value;
}

export function selectSoleGeographyOptions(filters: InboxGeography, facets: DeliveryList['matchingGeographyFacets'], choices?: DeliveryList['geographyFacets']): InboxGeography {
  const city = soleKnownValue(facets?.cities, choices?.cities);
  const province = soleKnownValue(facets?.provinces, choices?.provinces);
  const postalCode = soleKnownValue(facets?.postalCodes, choices?.postalCodes);
  return {
    ...filters,
    ...(filters.city === undefined && city !== undefined ? { city } : {}),
    ...(filters.province === undefined && province !== undefined ? { province } : {}),
    ...(filters.postalCode === undefined && postalCode !== undefined ? { postalCode } : {}),
  };
}

export function InboxGeographyFilters({ filters, facets, facetsQuery, failed, onChange }: {
  filters: InboxGeography;
  facets: DeliveryList['geographyFacets'];
  facetsQuery: string | null;
  failed: boolean;
  onChange: (filters: InboxGeography, changed?: keyof InboxGeography) => void;
}) {
  const t = useTranslations('inboxGeography');
  const hintId = useId();
  const applied = new URLSearchParams(facetsQuery ?? '');
  const requested = new URLSearchParams(inboxGeographyQuery(filters));
  const matchesContext = (key: keyof InboxGeography) => applied.get(key) === requested.get(key)
    && applied.get(`${key}Missing`) === requested.get(`${key}Missing`);
  const citiesReady = facets !== undefined && facetsQuery !== null;
  const provincesReady = citiesReady && matchesContext('city');
  const postalCodesReady = provincesReady && matchesContext('province');
  const fields = [
    { key: 'city', label: 'city', all: 'allCities', options: facets?.cities, ready: citiesReady },
    { key: 'province', label: 'province', all: 'allProvinces', options: facets?.provinces, ready: provincesReady },
    { key: 'postalCode', label: 'postalCode', all: 'allPostalCodes', options: facets?.postalCodes, ready: postalCodesReady },
  ] as const;

  return <section className="mt-6 rounded-lg border border-border bg-card p-4" aria-label={t('title')} aria-describedby={hintId}>
    <div className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto] [&_.field]:m-0">
      {fields.map(({ key, label, all, options, ready }) => {
        const selected = filters[key];
        const available = ready ? options ?? [] : options?.filter((option) => option.value === selected) ?? [];
        const choices = selected !== undefined && !available.some((option) => option.value === selected)
          ? [...available, { value: selected, count: 0 }] : available;
        return <Field key={key} label={t(label)}>
          <select value={selected === undefined ? '' : JSON.stringify(selected)} disabled={!ready} onChange={(event) => {
            const choice = choices.find((option) => JSON.stringify(option.value) === event.target.value);
            if (key === 'city') onChange({ city: choice?.value }, 'city');
            else if (key === 'province') onChange({ city: filters.city, province: choice?.value }, 'province');
            else onChange({ ...filters, postalCode: choice?.value }, 'postalCode');
          }}>
            <option value="">{t(all)}</option>
            {choices.map((option) => <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>{option.value === null ? t('missing', { count: option.count }) : `${option.value} (${option.count})`}</option>)}
          </select>
        </Field>;
      })}
      <button type="button" className="button secondary whitespace-nowrap" disabled={!Object.values(filters).some((value) => value !== undefined)} onClick={() => onChange({})}>{t('clear')}</button>
    </div>
    <p id={hintId} className="mt-3 text-xs text-muted-foreground">{t('hint')}</p>
    {!postalCodesReady ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t(failed || (facetsQuery !== null && !facets) ? 'unavailable' : 'updating')}</p> : null}
  </section>;
}
