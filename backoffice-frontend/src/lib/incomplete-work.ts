import type { Appointment } from './contracts';

type IncompleteReason = NonNullable<Appointment['results'][number]['incompleteWork']>[number]['reason'];
export const incompleteReasonLabels = {
  missing_goods_or_parts: 'incompleteMissingGoodsOrParts', damage: 'incompleteDamage', access: 'incompleteAccess',
  customer_refused: 'incompleteCustomerRefused', time_shortage: 'incompleteTimeShortage', other: 'incompleteOther',
} as const satisfies Record<IncompleteReason, string>;

export function isIncompleteReason(value: string): value is IncompleteReason {
  return Object.hasOwn(incompleteReasonLabels, value);
}
