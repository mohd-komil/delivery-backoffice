import type { ActiveReturnStatus, IssueType, View } from './contracts';
import { geographyFilterQuery, type GeographyFilters } from './geography-filters';

export type DeliveryFilterView = Exclude<View, 'inbox'>;

export type DeliveryViewFilters = {
  geography: GeographyFilters;
  search?: string;
  crew?: { id: string; name: string };
  dateFrom?: string;
  dateTo?: string;
  issueType?: IssueType;
  returnStatus?: ActiveReturnStatus;
};

export const emptyDeliveryViewFilters: DeliveryViewFilters = { geography: {} };

export function deliveryViewScopeQuery(filters: DeliveryViewFilters) {
  const query = new URLSearchParams();
  if (filters.search) query.set('search', filters.search);
  if (filters.crew) query.set('crewId', filters.crew.id);
  for (const key of ['dateFrom', 'dateTo', 'issueType', 'returnStatus'] as const) {
    const value = filters[key];
    if (value) query.set(key, value);
  }
  return query.toString();
}

export function deliveryViewFilterQuery(filters: DeliveryViewFilters) {
  return [deliveryViewScopeQuery(filters), geographyFilterQuery(filters.geography)].filter(Boolean).join('&');
}
