import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import type { VisitDetail } from '../src/shared/api/contracts';
import { readIncompleteWork } from '../src/_pages/visit-detail/model/incomplete-work';
import { readFinishQuantities } from '../src/_pages/visit-detail/model/quantity';
import { signatureInputFingerprint } from '../src/_pages/visit-detail/model/signature';
import { FinishItems } from '../src/_pages/visit-detail/ui/finish-items';
import { renderLocalized } from './render-localized';

const items: VisitDetail['items'] = [930011, 930021].map((sourceLineId, index) => ({
  sourceLineId, name: 'DEMO Oak chair (same SKU)', orderName: `Order ${index + 1}`, quantity: 2,
  remainingMilli: 2000, uom: 'unit', configuration: null, notes: null,
  serviceWork: {
    service: 'delivery_installation', remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000, remainingCollectionMilli: 0,
    availableInstallationMilli: 0, plannedDeliveryMilli: 2000, plannedInstallationMilli: 2000, plannedCollectionMilli: 0,
  },
}));

function partialReport() {
  const form = new FormData();
  form.set('quantity-930011-delivery', '1');
  form.set('quantity-930011-installation', '0');
  form.set('quantity-930021-delivery', '0');
  form.set('incomplete-930011-delivery-reason', 'missing_goods_or_parts');
  form.set('incomplete-930011-delivery-note', '  One package missing.  ');
  form.set('incomplete-930011-installation-reason', 'time_shortage');
  form.set('incomplete-930021-delivery-reason', 'damage');
  form.set('incomplete-930021-installation-reason', 'other');
  form.set('incomplete-930021-installation-note', 'Cannot assemble the damaged chair.');
  return form;
}

void test('identical products keep independent reasons per order line and operation, including omitted zero actuals', () => {
  const form = partialReport();
  const result = readFinishQuantities(items, form);
  assert.ok(result.ok);
  assert.deepEqual(result.quantities, [{ sourceLineId: 930011, deliveredMilli: 1000 }]);
  assert.deepEqual(readIncompleteWork(items, result.quantities, form), { ok: true, incompleteWork: [
    { sourceLineId: 930011, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'One package missing.' },
    { sourceLineId: 930011, operation: 'installation', reason: 'time_shortage', note: null },
    { sourceLineId: 930021, operation: 'delivery', reason: 'damage', note: null },
    { sourceLineId: 930021, operation: 'installation', reason: 'other', note: 'Cannot assemble the damaged chair.' },
  ] });
});

void test('an explanation is required for Other and long notes cannot be submitted', () => {
  const fields = partialReport();
  const actual = [{ sourceLineId: 930011, deliveredMilli: 1000 }];
  fields.set('incomplete-930021-installation-note', '   ');
  assert.deepEqual(readIncompleteWork(items, actual, fields), { ok: false, error: {
    field: 'incompleteWork', lineId: 930021, operation: 'installation', name: 'incomplete-930021-installation-note', reason: 'noteRequired',
  } });
  fields.set('incomplete-930021-installation-note', 'x'.repeat(501));
  const tooLong = readIncompleteWork(items, actual, fields);
  assert.ok(!tooLong.ok);
  assert.equal(tooLong.error.reason, 'noteTooLong');
});

void test('missing and unknown reasons focus the exact operation of the exact order line', () => {
  for (const value of ['', 'unrecognized']) {
    const fields = partialReport();
    fields.set('incomplete-930021-delivery-reason', value);
    assert.deepEqual(readIncompleteWork(items, [{ sourceLineId: 930011, deliveredMilli: 1000 }], fields), { ok: false, error: {
      field: 'incompleteWork', lineId: 930021, operation: 'delivery', name: 'incomplete-930021-delivery-reason', reason: 'reasonRequired',
    } });
  }
});

void test('completed operations discard stale reasons and work outside this visit needs no reason', () => {
  const item = items[0];
  assert.ok(item?.serviceWork);
  const onlyInstallation: VisitDetail['items'] = [{ ...item, serviceWork: {
    ...item.serviceWork, plannedDeliveryMilli: 0, plannedInstallationMilli: 1000, availableInstallationMilli: 1000,
  } }];
  assert.deepEqual(readIncompleteWork(onlyInstallation, [{ sourceLineId: 930011, deliveredMilli: 0, installedMilli: 1000 }], partialReport()),
    { ok: true, incompleteWork: [] });
  const legacy = [{ ...item, serviceWork: undefined }];
  assert.deepEqual(readIncompleteWork(legacy, [], new FormData()), { ok: true, incompleteWork: [] });
});

void test('collection also requires a reason when a planned item is not collected', () => {
  const item = items[0];
  assert.ok(item?.serviceWork);
  const collections: VisitDetail['items'] = [{ ...item, serviceWork: {
    ...item.serviceWork, service: 'collection_only', plannedDeliveryMilli: 0, plannedInstallationMilli: 0,
    plannedCollectionMilli: 2000, remainingCollectionMilli: 2000,
  } }];
  const form = new FormData();
  form.set('incomplete-930011-collection-reason', 'access');
  assert.deepEqual(readIncompleteWork(collections, [{ sourceLineId: 930011, deliveredMilli: 0, collectedMilli: 1000 }], form),
    { ok: true, incompleteWork: [{ sourceLineId: 930011, operation: 'collection', reason: 'access', note: null }] });
});

void test('changing the reason or note changes the signed report fingerprint', () => {
  const form = partialReport();
  const original = signatureInputFingerprint(form);
  form.set('incomplete-930021-delivery-reason', 'customer_refused');
  const changedReason = signatureInputFingerprint(form);
  assert.notEqual(changedReason, original);
  form.set('incomplete-930021-delivery-note', 'Customer declined delivery.');
  assert.notEqual(signatureInputFingerprint(form), changedReason);
});

void test('localized Finish controls identify the order line and operation for every incomplete reason', () => {
  const expected = { en: 'Reason for incomplete work', it: 'Motivo del lavoro incompleto', ru: 'Причина невыполненной работы', uz: 'Bajarilmagan ish sababi' };
  for (const locale of ['en', 'it', 'ru', 'uz'] as const) {
    const html = renderLocalized(createElement(FinishItems, { items, error: null, clearError: () => undefined }), locale);
    assert.ok(html.includes(expected[locale]), locale);
    assert.match(html, /Order 1/);
    assert.match(html, /Order 2/);
    for (const line of [930011, 930021]) {
      for (const operation of ['delivery', 'installation']) assert.ok(html.includes(`name="incomplete-${line}-${operation}-reason"`));
    }
    assert.equal((html.match(/aria-required="true"/gu) ?? []).length, 4);
  }
});
