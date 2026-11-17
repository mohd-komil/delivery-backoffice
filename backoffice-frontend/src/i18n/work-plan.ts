import type { Locale } from './config';
import * as messages from './messages/work-plan';
import * as workTimes from './messages/work-times';
import * as priorWork from './messages/prior-work';
import * as workQuantities from './messages/work-quantities';

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
const timeErrorKeys = new Map([
  ['Work times cannot change while this product is being worked on', 'activeWork'],
  ['Enter work times only for operations required by this product service', 'operationUnavailable'],
  ['Review the source before changing work times', 'sourceReview'],
  ['Select the service before entering work times', 'serviceRequired'],
] as const);
const priorWorkErrorKeys = new Map([
  ['Prior work must be confirmed before planning or recording this product line', 'locked'],
  ['Select the service before confirming prior work', 'unknown_service'],
  ['Prior work cannot exceed the current picking line and its selected operations', 'exceeds'],
  ['Prior installed quantity cannot exceed prior delivered quantity', 'installedExceeds'],
  ['Reconcile confirmed prior work with the current source before planning', 'stale'],
  ['Confirmed prior work requires review; new planning is blocked', 'stale'],
] as const);
const workQuantityErrorKeys = new Map([
  ['Enter positive work for the selected service within the source line quantity', 'outsideLimits'],
  ['Required installation cannot exceed required delivery', 'installationLimit'],
  ['Required quantities must cover completed and booked work. Adjust affected visits first.', 'outsideLimits'],
] as const);

export function workPlanErrorMessage(message: string, locale: Locale): string | undefined {
  for (const [source, key] of workErrorKeys) if (message === source) return messages[locale][key];
  for (const [source, key] of timeErrorKeys) if (message === source) return workTimes[locale][key];
  for (const [source, key] of priorWorkErrorKeys) if (message === source) return priorWork[locale][key];
  for (const [source, key] of workQuantityErrorKeys) if (message === source) return workQuantities[locale][key];
  return undefined;
}
