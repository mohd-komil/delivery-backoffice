import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import type { VisitDetail } from '../src/shared/api/contracts';
import { renderLocalized } from './render-localized';
import { quantityFields, readFinishQuantities } from '../src/_pages/visit-detail/model/quantity';
import { FinishItems } from '../src/_pages/visit-detail/ui/finish-items';
import { WorkScopeNotice } from '../src/_pages/visit-detail/ui/work-scope-notice';

function sameProductLines(): VisitDetail['items'] {
  const product = { name: 'Synthetic oak chair', quantity: 2, remainingMilli: 1000, uom: 'unit', configuration: null, notes: null };
  return [
    { ...product, sourceLineId: 11, orderName: 'Order A', serviceWork: {
      service: 'delivery_installation', remainingDeliveryMilli: 1000, remainingInstallationMilli: 2000, remainingCollectionMilli: 0,
      availableInstallationMilli: 1000, plannedDeliveryMilli: 0, plannedInstallationMilli: 1000, plannedCollectionMilli: 0,
    } },
    { ...product, sourceLineId: 12, orderName: 'Order B', serviceWork: {
      service: 'delivery_only', remainingDeliveryMilli: 1000, remainingInstallationMilli: 0, remainingCollectionMilli: 0,
      availableInstallationMilli: 0, plannedDeliveryMilli: 0, plannedInstallationMilli: 0, plannedCollectionMilli: 0,
    } },
  ];
}

void test('scope caps operations independently on identical products and does not turn global remaining into work for this visit', () => {
  const items = sameProductLines();
  const first = items[0];
  assert.ok(first);
  assert.deepEqual(quantityFields(first), [
    { operation: 'delivery', remaining: 1000, planned: 0, limit: 0 },
    { operation: 'installation', remaining: 2000, planned: 1000, limit: 1000 },
  ]);
  const form = new FormData();
  form.set('quantity-11-installation', '1');
  assert.deepEqual(readFinishQuantities(items, form), { ok: true, quantities: [{ sourceLineId: 11, deliveredMilli: 0, installedMilli: 1000 }] });
  form.set('quantity-11-installation', '2');
  assert.deepEqual(readFinishQuantities(items, form), { ok: false,
    error: { field: 'quantity', name: 'quantity-11-installation', lineId: 11, reason: 'over', limit: 1000 } });
  form.set('quantity-11-installation', '1');
  form.set('quantity-12-delivery', '1');
  assert.deepEqual(readFinishQuantities(items, form), { ok: false,
    error: { field: 'quantity', name: 'quantity-12-delivery', lineId: 12, reason: 'over', limit: 0 } });
});

void test('installation is bounded by stock and actual delivery in this report as well as the confirmed scope', () => {
  const item = sameProductLines()[0];
  assert.ok(item?.serviceWork);
  const scoped: VisitDetail['items'] = [{ ...item, serviceWork: {
    ...item.serviceWork, plannedDeliveryMilli: 1000, plannedInstallationMilli: 2000, availableInstallationMilli: 500,
  } }];
  const fields = new FormData();
  fields.set('quantity-11-delivery', '0,5');
  fields.set('quantity-11-installation', '1.5');
  assert.deepEqual(readFinishQuantities(scoped, fields), { ok: false,
    error: { field: 'quantity', name: 'quantity-11-installation', lineId: 11, reason: 'over', limit: 1000 } });
  fields.set('quantity-11-installation', '1');
  assert.deepEqual(readFinishQuantities(scoped, fields), { ok: true, quantities: [{ sourceLineId: 11, deliveredMilli: 500, installedMilli: 1000 }] });
});

void test('Finish shows only planned inputs with the correct order, while unknown services do not become delivery inputs', () => {
  const items = sameProductLines();
  const html = renderLocalized(createElement(FinishItems, { items, error: null, clearError: () => undefined }));
  assert.match(html, /Order A/);
  assert.match(html, /This visit: 1 unit/);
  assert.match(html, /quantity-11-installation/);
  assert.doesNotMatch(html, /quantity-11-delivery|quantity-12-delivery|Order B/);
  const unknown = items[0];
  assert.ok(unknown?.serviceWork);
  assert.deepEqual(quantityFields({ ...unknown, serviceWork: { ...unknown.serviceWork, service: null } }), []);
});

void test('scope review notices are localized and explain legacy work without inventing a plan', () => {
  const expected = { en: 'no confirmed list of work', it: 'non ha un elenco di lavori confermato', ru: 'нет подтверждённого состава работ', uz: 'tasdiqlangan ishlar ro‘yxati yo‘q' };
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(WorkScopeNotice, { reason: 'missing_scope' }), locale);
    assert.ok(html.includes(expected[locale]), locale);
  }
});

void test('damage readiness is a recognized server review reason with an actionable localized booked-visit notice',async()=>{
  const {visitDetailSchema}=await import('../src/shared/api/contracts');
  const reason=visitDetailSchema.shape.scopeReviewReason.parse('damage_hold');
  const expected={en:'damaged product',it:'prodotto danneggiato',ru:'повреждённого товара',uz:'Shikastlangan mahsulot'};
  for(const locale of ['en','it','ru','uz'] as const){
    const html=renderLocalized(createElement(WorkScopeNotice,{reason}),locale);
    assert.ok(html.includes(expected[locale]),locale);
    assert.doesNotMatch(html,/MISSING_MESSAGE|undefined/);
  }
});
