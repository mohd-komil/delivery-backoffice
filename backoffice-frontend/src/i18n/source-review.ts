import type { Locale } from './config';
import * as messages from './messages/source-review';

const labels = [
  'source_missing', 'source_invalid', 'source_ineligible', 'snapshot_incomplete', 'revision_unverified', 'revision_conflict',
  'line_scope_changed', 'source_changed_after_work', 'destination', 'status', 'service', 'orders', 'line_removed', 'line_identity',
  'quantity', 'line_details', 'line_added', 'other', 'SOURCE_UNAVAILABLE', 'SOURCE_INELIGIBLE', 'SOURCE_INCOMPLETE', 'DELIVERY_CLOSED',
  'VISIT_IN_PROGRESS', 'ROUTE_CHANGE_REQUIRED', 'PRIOR_WORK_CONFLICT', 'RECORDED_WORK_IDENTITY_CONFLICT', 'SOURCE_BELOW_RECORDED_WORK', 'SOURCE_REVISION_REGRESSION',
] as const satisfies readonly (keyof typeof messages.en)[];

export function sourceReviewMessageKey(value: string) {
  return labels.find((key) => key === value);
}

export function sourceReviewErrorMessage(message: string, locale: Locale): string | undefined {
  if (message === 'The source update changed. Reload its differences before deciding.') return messages[locale].stale;
  if (message === 'The proposed source is unavailable') return messages[locale].SOURCE_UNAVAILABLE;
  return undefined;
}
