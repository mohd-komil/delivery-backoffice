import { z } from 'zod';
import { DeliveryGeographySchema, deliveryGeography, type DeliveryGeography } from '../domain/delivery-geography';
import { DeliverySchema, IdSchema, InstantSchema, RemainingWorkEstimateSchema, ViewSchema, type Delivery } from '../domain/model';
import { deriveProgress, deriveViews, remainingWorkEstimate } from '../domain/rules';
import { areaBounds, areaQueryShape, DeliveryAreaSchema, pointInArea, validateAreaQuery } from './delivery-area';
import type { EffectiveDeliveryPoint } from './delivery-points';

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
  page: z.coerce.number().int().min(1).max(500).default(1),
}).superRefine(validateGeographyFilterPairs);
export const DeliveryMapQuerySchema = DeliveryFilterQuerySchema.extend({
  view: z.literal('inbox').default('inbox'),
}).superRefine(validateGeographyFilterPairs);
export type DeliveryListQuery = z.infer<typeof DeliveryListQuerySchema>;

const GeographyFacetSchema = z.object({ value: z.string().nullable(), count: z.number().int().positive() }).strict();
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

export function selectDeliveryList(all: readonly Delivery[], query: DeliveryFilterQuery, points?: ReadonlyMap<string, EffectiveDeliveryPoint>) {
  const allViewItems = all.filter((delivery) => !query.view || deriveViews(delivery).includes(query.view))
    .map((delivery) => ({ delivery, geography: deliveryGeography(delivery) }));
  const matchesQuery = ({ delivery, geography }: typeof allViewItems[number]) => matchesGeography(geography, query)
    && (!query.search || [delivery.source.pickingName, delivery.source.customer.name, delivery.source.customer.city ?? '']
      .join(' ').toLowerCase().includes(query.search.toLowerCase()));
  const bounds = areaBounds(query);
  if (bounds && points === undefined) throw new Error('Area selection requires resolved delivery coordinates');
  const viewItems = bounds ? allViewItems.filter(({ delivery }) => pointInArea(points?.get(delivery.id), bounds)) : allViewItems;
  const filtered = viewItems.filter(matchesQuery);
  const area = bounds ? { bounds, excludedMissingCoordinates: allViewItems.filter((item) => matchesQuery(item) && !points?.has(item.delivery.id)).length } : null;
  return { viewItems, filtered, area };
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

function facets(values: (string | null)[]) {
  const counts = new Map<string | null, { value: string | null; count: number }>();
  for (const value of values) {
    const key = value?.toLowerCase() ?? null;
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

export function matchingGeographyFacets(values: readonly DeliveryGeography[], query: DeliveryFilterQuery) {
  const matching = values.filter((geography) => matchesGeography(geography, query));
  return {
    cities: facets(matching.map(({ city }) => city)),
    provinces: facets(matching.map(({ province }) => province)),
    postalCodes: facets(matching.map(({ postalCode }) => postalCode)),
  };
}
