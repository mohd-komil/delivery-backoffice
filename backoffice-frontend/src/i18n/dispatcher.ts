import * as content from './messages/dispatcher-content';
import type { Locale } from './config';

const fixedText = new Map<string, keyof typeof content.en>([
  ['Review customer signature refusal', 'titleRefusal'],
  ['Review the report and evidence in History before closing the delivery.', 'descriptionRefusal'],
  ['Review source and accepted work', 'titleSource'], ['Locate the delivery address', 'titleAddress'], ['Review problem and repeat readiness', 'titleReadiness'], ['Resolve the reported problem', 'titleIssue'], ['Confirm readiness for another visit', 'titleHold'], ['Review completion evidence', 'titleEvidence'], ['Record warehouse receipt', 'titleReceipt'], ['Review returned cargo', 'titleCargo'],
  ['Compare the source update with the accepted plan and recorded work before continuing.', 'descriptionSource'], ['Confirm the destination and unloading entrance before planning the remaining work on a map.', 'descriptionAddress'], ['The damaged product remains blocked until the dispatcher records readiness in its original workflow.', 'descriptionHold'], ['Review the effective report and its signatures or photos in History. A queue note does not approve missing evidence.', 'descriptionEvidence'], ['Verified cargo remains to be received through the route warehouse workflow.', 'descriptionReceipt'], ['Confirm the cargo quantity and custody in the route reconciliation.', 'descriptionCargo'],
]);
export function dispatcherContentKey(value: string): keyof typeof content.en | undefined {
  const fixed = fixedText.get(value); if (fixed) return fixed;
  return isContentKey(value) ? value : undefined;
}
function isContentKey(value: string): value is keyof typeof content.en {
  return Object.hasOwn(content.en, value);
}
export function dispatcherContentText(value: string, locale: Locale): string {
  const key = dispatcherContentKey(value);
  return key ? content[locale][key] : value;
}
export function dispatcherValueKey(value: string) {
  const entries = [['unknown', 'unknownValue'], ['signed', 'signedValue'], ['missing', 'missingValue'], ['refused', 'refusedValue'], ['unavailable', 'unavailableValue'], ['warehouse', 'warehouseValue'], ['vehicle', 'vehicleValue'], ['awaiting_receipt', 'receiptValue'], ['customer', 'customerValue'], ['awaiting_replacement', 'replacementValue']] as const;
  return entries.find(([key]) => key === value)?.[1];
}
