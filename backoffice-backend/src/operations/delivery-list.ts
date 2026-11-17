import { z } from 'zod';
import { DeliveryGeographySchema, deliveryGeography, type DeliveryGeography } from '../domain/delivery-geography';
import { DeliverySchema, IdSchema, InstantSchema, RemainingWorkEstimateSchema, ViewSchema, type Delivery } from '../domain/model';
import { deriveProgress, deriveViews, remainingWorkEstimate } from '../domain/rules';
import { areaBounds, areaQueryShape, DeliveryAreaSchema, pointInArea, validateAreaQuery } from './delivery-area';
import type { EffectiveDeliveryPoint } from './delivery-points';
import { deliveryActivity, deliveryActivityFacets, deliveryActivityQueryShape, DeliveryFilterFacetsSchema,
  validateDeliveryActivityQuery, type DeliveryActivityQuery, type FilterCrew } from './delivery-view-filters';

const DeliveryFilterQuerySchema = z.object({
  view: ViewSchema.optional(),
  search: z.string().max(100).optional(),
  city: z.string().trim().min(1).max(4000).optional(),
  province: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  cityMissing: z.literal('true').optional(),
  provinceMissing: z.literal('true').optional(),
  postalCodeMissing: z.literal('true').optional(),
  ...areaQueryShape,
}).strict();
type DeliveryFilterQuery = z.infer<typeof DeliveryFilterQuerySchema>;

function validateGeographyFilterPairs(query: DeliveryFilterQuery, context: z.RefinementCtx) {
  validateAreaQuery(query, context);
  for (const [field, missing] of [['city', 'cityMissing'], ['province', 'provinceMissing'], ['postalCode', 'postalCodeMissing']] as const) {
    if (query[field] !== undefined && query[missing] !== undefined) {
      context.addIssue({ code: 'custom', path: [missing], message: `Choose either ${field} or missing ${field}` });
    }
  }
}

export const DeliveryListQuerySchema = DeliveryFilterQuerySchema.extend({
  ...deliveryActivityQueryShape,
  page: z.coerce.number().int().min(1).max(500).default(1),
}).superRefine((query, context) => {
  validateGeographyFilterPairs(query, context);
  validateDeliveryActivityQuery(query, context);
});
export const DeliveryMapQuerySchema = DeliveryFilterQuerySchema.extend({
  view: z.literal('inbox').default('inbox'),
}).superRefine(validateGeographyFilterPairs);
export type DeliveryListQuery = z.infer<typeof DeliveryListQuerySchema>;

const GeographyFacetSchema = z.object({ value: z.string().nullable(), count: z.number().int().nonnegative() }).strict();
export const GeographyFacetsSchema = z.object({
  cities: z.array(GeographyFacetSchema),
  provinces: z.array(GeographyFacetSchema),
  postalCodes: z.array(GeographyFacetSchema),
}).strict();

export const DeliveryPlanningSchema = z.object({
  status: z.union([ViewSchema.exclude(['issues', 'return_required']), z.literal('awaiting_closure')]),
  activeVisits: z.array(z.object({
    id: IdSchema, status: z.enum(['booked', 'in_progress']), startsAt: InstantSchema, endsAt: InstantSchema,
    crews: z.array(z.object({ id: IdSchema, name: z.string() }).strict()),
  }).strict()),
  remainingWorkEstimate: RemainingWorkEstimateSchema,
}).strict();
export const DeliveryListItemSchema = DeliverySchema.extend({ geography: DeliveryGeographySchema, planning: DeliveryPlanningSchema });
export const DeliveryListSchema = z.object({
  items: z.array(DeliveryListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(10),
  counts: z.record(ViewSchema, z.number().int().nonnegative()),
  geographyFacets: GeographyFacetsSchema,
  matchingGeographyFacets: GeographyFacetsSchema,
  filterFacets: DeliveryFilterFacetsSchema,
  area: DeliveryAreaSchema,
});

function matches(value: string | null, filter: string | undefined, missing: 'true' | undefined) {
  if (missing) return value === null;
  return filter === undefined || (value !== null && value.toLowerCase() === filter.toLowerCase());
}

function matchesGeography(value: DeliveryGeography, query: DeliveryFilterQuery): boolean {
  return matches(value.city, query.city, query.cityMissing)
    && matches(value.province, query.province, query.provinceMissing)
    && matches(value.postalCode, query.postalCode, query.postalCodeMissing);
}

function matchesDeliverySearch(delivery: Delivery, search: string) {
  if (!search) return true;
  const { pickingName, customer, salesOrders, saleOrderName, saleOrderId } = delivery.source;
  const orders = salesOrders ?? [{ name: saleOrderName, id: saleOrderId }];
  return [pickingName, customer.name, saleOrderName, saleOrderId, ...orders.flatMap(({ name, id }) => [name, id])]
    .some((field) => String(field ?? '').toLowerCase().includes(search));
}

export function selectDeliveryList(all: readonly Delivery[], query: DeliveryFilterQuery & DeliveryActivityQuery,
  points?: ReadonlyMap<string, EffectiveDeliveryPoint>, crews: readonly FilterCrew[] = []) {
  const view = query.view;
  const allViewItems = all.filter((delivery) => !view || deriveViews(delivery).includes(view))
    .map((delivery) => ({ delivery, geography: deliveryGeography(delivery) }));
  if (view && view !== 'inbox') {
    const search = query.search?.trim().toLowerCase() ?? '';
    const matches = allViewItems.filter(({ delivery }) => matchesDeliverySearch(delivery, search)).map((item) => ({
      item,
      activity: deliveryActivity(item.delivery, view, query),
      matchesGeography: matchesGeography(item.geography, query),
    }));
    const matchingActivity = matches.filter(({ activity }) =>
      activity.crewMatches && activity.dateMatches && activity.issueMatches && activity.returnMatches);
    return {
      filtered: matchingActivity.filter((match) => match.matchesGeography).map(({ item }) => item),
      facetGeographies: matchingActivity.map(({ item }) => item.geography),
      filterFacets: deliveryActivityFacets(matches.filter((match) => match.matchesGeography).map(({ activity }) => activity), crews),
      area: null,
    };
  }

  const search = query.search?.toLowerCase();
  const matchesQuery = ({ delivery, geography }: typeof allViewItems[number]) => matchesGeography(geography, query)
    && (!search || [delivery.source.pickingName, delivery.source.customer.name, delivery.source.customer.city ?? '']
      .join(' ').toLowerCase().includes(search));
  const bounds = areaBounds(query);
  if (bounds && points === undefined) throw new Error('Area selection requires resolved delivery coordinates');
  const viewItems = bounds ? allViewItems.filter(({ delivery }) => pointInArea(points?.get(delivery.id), bounds)) : allViewItems;
  const filtered = viewItems.filter(matchesQuery);
  const area = bounds ? { bounds, excludedMissingCoordinates: allViewItems.filter((item) => matchesQuery(item) && !points?.has(item.delivery.id)).length } : null;
  return {
    filtered, area, facetGeographies: viewItems.map(({ geography }) => geography),
    filterFacets: { crews: [], issueTypes: [], returnStatuses: [] },
  };
}

export function deliveryPlanning(delivery: Delivery): z.infer<typeof DeliveryPlanningSchema> {
  const activeVisits = delivery.appointments.flatMap((appointment) => {
    if (appointment.status !== 'booked' && appointment.status !== 'in_progress') return [];
    const crews = new Map(appointment.assignments.map(({ crewId, crewName }) => [crewId.toLowerCase(), { id: crewId, name: crewName }]));
    return [{ id: appointment.id, status: appointment.status, startsAt: appointment.startsAt, endsAt: appointment.endsAt, crews: [...crews.values()] }];
  }).sort((left, right) => Number(right.status === 'in_progress') - Number(left.status === 'in_progress')
    || Date.parse(left.startsAt) - Date.parse(right.startsAt) || left.id.localeCompare(right.id));
  return { status: deriveProgress(delivery), activeVisits, remainingWorkEstimate: remainingWorkEstimate(delivery) };
}

type GeographyFacet = z.infer<typeof GeographyFacetSchema>;

function geographyKey(value: string | null) { return value?.toLowerCase() ?? null; }

function facets(values: (string | null)[]) {
  const counts = new Map<string | null, GeographyFacet>();
  for (const value of values) {
    const key = geographyKey(value);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].sort((left, right) => {
    if (left.value === null) return right.value === null ? 0 : 1;
    if (right.value === null) return -1;
    return left.value.localeCompare(right.value, 'en', { sensitivity: 'base' });
  });
}

export function geographyFacets(values: readonly DeliveryGeography[], query: DeliveryFilterQuery) {
  const cityMatches = values.filter(({ city }) => matches(city, query.city, query.cityMissing));
  const provinceMatches = cityMatches.filter(({ province }) => matches(province, query.province, query.provinceMissing));
  return {
    cities: facets(values.map(({ city }) => city)),
    provinces: facets(cityMatches.map(({ province }) => province)),
    postalCodes: facets(provinceMatches.map(({ postalCode }) => postalCode)),
  };
}

function withScopedCounts(choices: GeographyFacet[], scoped: GeographyFacet[]): GeographyFacet[] {
  const counts = new Map(scoped.map(({ value, count }) => [geographyKey(value), count]));
  return choices.map(({ value }) => ({ value, count: counts.get(geographyKey(value)) ?? 0 }));
}

export function operationalGeographyFacets(catalogue: readonly DeliveryGeography[], scoped: readonly DeliveryGeography[], query: DeliveryFilterQuery) {
  const choices = geographyFacets(catalogue, query);
  const counts = geographyFacets(scoped, query);
  return {
    cities: withScopedCounts(choices.cities, counts.cities),
    provinces: withScopedCounts(choices.provinces, counts.provinces),
    postalCodes: withScopedCounts(choices.postalCodes, counts.postalCodes),
  };
}

export function matchingGeographyFacets(values: readonly DeliveryGeography[], query: DeliveryFilterQuery) {
  const matching = values.filter((geography) => matchesGeography(geography, query));
  return {
    cities: facets(matching.map(({ city }) => city)),
    provinces: facets(matching.map(({ province }) => province)),
    postalCodes: facets(matching.map(({ postalCode }) => postalCode)),
  };
}
