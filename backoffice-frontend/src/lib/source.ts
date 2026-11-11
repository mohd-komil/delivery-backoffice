import type { Delivery } from './contracts';
import { commonTranslations } from '@/i18n/common';
import { defaultLocale } from '@/i18n/config';

type Source = Delivery['source'];

const sourceStateKeys = new Map([
  ['assigned', 'sourceAssigned'],
  ['done', 'sourceDone'],
  ['cancel', 'sourceCancelled'],
  ['draft', 'sourceDraft'],
  ['waiting', 'sourceWaiting'],
  ['confirmed', 'sourceConfirmed'],
] as const);

export function sourceStateLabel(state: string, locale: string): string {
  for (const [code, key] of sourceStateKeys) {
    if (state === code) return commonTranslations(locale)(key);
  }
  return state;
}

export function sourceServiceLabel(service: string, locale: string): string {
  if (service === 'delivery') return commonTranslations(locale)('deliveryService');
  if (service === 'delivery_and_assembly') return commonTranslations(locale)('assemblyService');
  return service;
}

export function sourceOrders(source: Source): { id: number; name: string }[] {
  return source.salesOrders ?? [{ id: source.saleOrderId, name: source.saleOrderName }];
}

export function sourceLineOrder(source: Source, item: Source['items'][number], locale: string = defaultLocale): string {
  const t = commonTranslations(locale);
  if (item.saleOrderId === undefined) return t('unrecordedOrder');
  return sourceOrders(source).find((order) => order.id === item.saleOrderId)?.name ?? t('salesOrder', { id: item.saleOrderId });
}

export function sourceLineLabel(source: Source, item: Source['items'][number], locale: string = defaultLocale): string {
  return commonTranslations(locale)('sourceLine', { name: item.name, order: sourceLineOrder(source, item, locale), id: item.sourceLineId });
}
