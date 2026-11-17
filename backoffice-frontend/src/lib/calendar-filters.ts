import type { CalendarEntry, CalendarFilterCatalog } from './contracts';
import { selectSoleGeographyOptions, type GeographyFacets, type GeographyFilters, type GeographyOption } from './geography-filters';

export type CalendarFilters = GeographyFilters & { crewId?: string | null; crewName?: string | null; customerName: string };
export type CalendarCrewOption = { value: string | null; label: string | null };
export type CalendarFilterOptions = GeographyFacets & { crews: CalendarCrewOption[] };

function geographyValue(value: string | null | undefined) { return value?.trim() || null; }
function geographyKey(value: string | null | undefined) { return geographyValue(value)?.toLowerCase() ?? null; }
function searchText(value: string) { return value.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }

function matchesGeography(destination: GeographyFilters | undefined, filters: GeographyFilters) {
  return (['city', 'province', 'postalCode'] as const).every((key) => filters[key] === undefined || geographyKey(destination?.[key]) === geographyKey(filters[key]));
}

function matchesPeople(entry: CalendarEntry, filters: CalendarFilters) {
  const matchesCrew = filters.crewId === undefined || (filters.crewId === null
    ? entry.appointment.assignments.length === 0
    : entry.appointment.assignments.some((assignment) => assignment.crewId.toLowerCase() === filters.crewId?.toLowerCase()));
  return matchesCrew && searchText(entry.customerName).includes(searchText(filters.customerName));
}

/** Calendar callers supply the complete selected period, excluding cancelled visits. */
export function filterCalendarEntries<T extends CalendarEntry>(entries: readonly T[], filters: CalendarFilters): T[] {
  return entries.filter((entry) => matchesPeople(entry, filters) && matchesGeography(entry.geography, filters));
}

function geographyOptions(destinations: CalendarFilterCatalog['destinations'], field: keyof GeographyFilters, selected?: string | null): GeographyOption[] {
  const groups = new Map<string | null, GeographyOption>();
  for (const destination of destinations) {
    const value = geographyValue(destination[field]);
    const key = geographyKey(value);
    const existing = groups.get(key);
    if (existing) existing.count += destination.count;
    else groups.set(key, { value, count: destination.count });
  }
  if (selected !== undefined) {
    const key = geographyKey(selected);
    const existing = groups.get(key);
    // Keep the exact selected option value during Refresh, including casing changes.
    if (existing) existing.value = selected;
    else groups.set(key, { value: selected, count: 0 });
  }
  return Array.from(groups.values())
    .sort((left, right) => left.value === null ? 1 : right.value === null ? -1 : left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: 'base' }));
}

function geographyFacets(destinations: CalendarFilterCatalog['destinations']): GeographyFacets {
  return { cities: geographyOptions(destinations, 'city'), provinces: geographyOptions(destinations, 'province'), postalCodes: geographyOptions(destinations, 'postalCode') };
}

function crewOptions(crews: CalendarFilterCatalog['crews'], selected?: string | null, selectedName?: string | null): CalendarCrewOption[] {
  const groups = new Map<string | null, CalendarCrewOption>([[null, { value: null, label: null }]]);
  // Disabled teams can still have historical assignments; filtering must include them.
  for (const crew of crews) {
    groups.set(crew.id.toLowerCase(), { value: crew.id, label: crew.name });
  }
  if (selected !== undefined) {
    const key = selected?.toLowerCase() ?? null;
    const existing = groups.get(key);
    if (existing) existing.value = selected;
    else groups.set(key, { value: selected, label: selectedName ?? null });
  }
  return Array.from(groups.values())
    .sort((left, right) => left.value === null ? 1 : right.value === null ? -1 : (left.label ?? '').localeCompare(right.label ?? ''));
}

/** Global catalogue choices are independent of calendar dates, customers and team filters. */
export function calendarFilterOptions(catalog: CalendarFilterCatalog, filters: CalendarFilters): CalendarFilterOptions {
  const cities = catalog.destinations.filter((destination) => matchesGeography(destination, { city: filters.city }));
  const provinces = cities.filter((destination) => matchesGeography(destination, { province: filters.province }));
  return {
    cities: geographyOptions(catalog.destinations, 'city', filters.city),
    provinces: geographyOptions(cities, 'province', filters.province),
    postalCodes: geographyOptions(provinces, 'postalCode', filters.postalCode),
    crews: crewOptions(catalog.crews, filters.crewId, filters.crewName),
  };
}

/** An explicit parent change clears child choices before completing sole known values. */
export function changeCalendarGeography(catalog: CalendarFilterCatalog, filters: CalendarFilters, field: keyof GeographyFilters, value: string | null | undefined): CalendarFilters {
  const destination: GeographyFilters = field === 'city' ? { city: value }
    : field === 'province' ? { city: filters.city, province: value }
      : { city: filters.city, province: filters.province, postalCode: value };
  const next: CalendarFilters = { ...filters, city: undefined, province: undefined, postalCode: undefined, ...destination };
  if (value === undefined) return next;
  const matching = catalog.destinations.filter((candidate) => matchesGeography(candidate, destination));
  return { ...next, ...selectSoleGeographyOptions(destination, geographyFacets(matching), calendarFilterOptions(catalog, next)) };
}
