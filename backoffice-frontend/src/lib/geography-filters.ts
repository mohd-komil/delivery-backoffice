export type GeographyFilters = { city?: string | null; province?: string | null; postalCode?: string | null };
export type GeographyOption = { value: string | null; count: number };
export type GeographyFacets = { cities: GeographyOption[]; provinces: GeographyOption[]; postalCodes: GeographyOption[] };

export function geographyFilterQuery(filters: GeographyFilters) {
  const query = new URLSearchParams();
  for (const key of ['city', 'province', 'postalCode'] as const) {
    const value = filters[key];
    if (value === null) query.set(`${key}Missing`, 'true');
    else if (value !== undefined) query.set(key, value);
  }
  return query.toString();
}

function soleKnownValue(matches: GeographyOption[] | undefined, choices: GeographyOption[] | undefined) {
  const option = matches?.length === 1 ? matches[0] : undefined;
  if (!option || option.value === null || option.count <= 0) return undefined;
  const value = option.value;
  return choices?.find((choice) => choice.value?.toLowerCase() === value.toLowerCase())?.value ?? value;
}

/** Called only after explicit selection: unknown values and zero matches never auto-select. */
export function selectSoleGeographyOptions(filters: GeographyFilters, facets: GeographyFacets | undefined, choices?: GeographyFacets): GeographyFilters {
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
