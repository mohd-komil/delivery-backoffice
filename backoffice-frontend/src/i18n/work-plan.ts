import type { Locale } from './config';
import * as messages from './messages/work-plan';

const workErrorKeys = new Map([
  ['Review the source before planning work', 'source_review'],
  ['Select the service for each planned product line', 'unknown_service'],
  ['Review existing visit scopes before booking more work', 'legacy_scope_review'],
  ['Planned quantities exceed the remaining work available after other visits', 'exceedsAvailable'],
  ['Confirm that the product is already at the customer before planning installation only', 'stockRequired'],
  ['Work can change only before a visit starts, or during explicit review of an unscoped legacy visit', 'scopeLocked'],
  ['This product already has recorded or planned work', 'reservationLocked'],
  ['The selected service must preserve the work already recorded', 'servicePreserve'],
  ['Review the selected appointment work before planning this route stop', 'routeReview'],
  ['No unreserved work is available. Select a reviewed appointment or update the delivery work plan', 'routeNoWork'],
] as const);

export function workPlanErrorMessage(message: string, locale: Locale): string | undefined {
  for (const [source, key] of workErrorKeys) if (message === source) return messages[locale][key];
  return undefined;
}
