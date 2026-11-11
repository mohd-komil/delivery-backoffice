import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisitDetail } from '../src/shared/api/contracts';
import { actualStartOptions } from '../src/_pages/visit-detail/model/actual-start';
import { readItemChecks } from '../src/_pages/visit-detail/model/item-check';
import { selectFinishPhotos } from '../src/_pages/visit-detail/model/photo';
import { enteredQuantityMilli, readFinishQuantities } from '../src/_pages/visit-detail/model/quantity';

void test('result quantities keep milli precision for dot and comma and do not coerce invalid input', () => {
  assert.equal(enteredQuantityMilli('1,023'), 1023);
  assert.equal(enteredQuantityMilli('0.009'), 9);
  assert.equal(enteredQuantityMilli(',5'), 500);
  assert.equal(enteredQuantityMilli('  '), 0);
  assert.equal(enteredQuantityMilli(null), 0);
  for (const invalid of ['1.0001', '-1', '1e3', '1.2,3', '9999999999999999']) {
    assert.equal(enteredQuantityMilli(invalid), null);
  }
});

void test('signed result preserves line IDs and reports partial delivery, installation and collection independently', () => {
  const chair = { name: 'Chair', quantity: 2, remainingMilli: 2000, uom: 'unit', configuration: null, notes: null };
  const items: VisitDetail['items'] = [
    { ...chair, sourceLineId: 21, serviceWork: {
      service: 'delivery_installation', remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000,
      availableInstallationMilli: 0, remainingCollectionMilli: 0,
    } },
    { ...chair, sourceLineId: 22, serviceWork: {
      service: 'installation_only', remainingDeliveryMilli: 0, remainingInstallationMilli: 2000,
      availableInstallationMilli: 2000, remainingCollectionMilli: 0,
    } },
    { ...chair, sourceLineId: 23, serviceWork: {
      service: 'collection_only', remainingDeliveryMilli: 0, remainingInstallationMilli: 0,
      availableInstallationMilli: 0, remainingCollectionMilli: 2000,
    } },
    { ...chair, sourceLineId: 24 },
  ];
  const fields = new FormData();
  fields.set('quantity-21-delivery', '1');
  fields.set('quantity-21-installation', '1,5');
  fields.set('quantity-22-installation', '2');
  fields.set('quantity-23-collection', '1');
  fields.set('quantity-24-delivery', '2');
  assert.deepEqual(readFinishQuantities(items, fields), {
    ok: false, error: { field: 'quantity', name: 'quantity-21-installation', lineId: 21, reason: 'over', limit: 1000 },
  });
  fields.set('quantity-21-installation', '0,5');
  assert.deepEqual(readFinishQuantities(items, fields), { ok: true, quantities: [
    { sourceLineId: 21, deliveredMilli: 1000, installedMilli: 500 },
    { sourceLineId: 22, deliveredMilli: 0, installedMilli: 2000 },
    { sourceLineId: 23, deliveredMilli: 0, collectedMilli: 1000 },
    { sourceLineId: 24, deliveredMilli: 2000 },
  ] });
});

void test('item checks keep separate outcomes on identical products and never drop a note with no outcome', () => {
  const chair = { name: 'Chair', quantity: 1, remainingMilli: 1000, uom: 'unit', configuration: null, notes: null };
  const items: VisitDetail['items'] = [
    { ...chair, sourceLineId: 31, orderName: 'Order 1' },
    { ...chair, sourceLineId: 32, orderName: 'Order 2' },
    { ...chair, sourceLineId: 33, orderName: 'Order 3' },
  ];
  const fields = new FormData();
  fields.set('check-status-31', 'ok');
  fields.set('check-note-31', '  ');
  fields.set('check-note-32', '  Box damaged  ');
  fields.set('check-status-999', 'ok');
  assert.deepEqual(readItemChecks(items, fields), {
    ok: false, error: { field: 'itemCheck', lineId: 32, reason: 'status' },
  });

  fields.set('check-status-32', 'problem');
  assert.deepEqual(readItemChecks(items, fields), { ok: true, itemChecks: [
    { sourceLineId: 31, status: 'ok', note: null },
    { sourceLineId: 32, status: 'problem', note: 'Box damaged' },
  ] });

  fields.set('check-note-32', 'x'.repeat(501));
  assert.deepEqual(readItemChecks(items, fields), {
    ok: false, error: { field: 'itemCheck', lineId: 32, reason: 'note' },
  });
});

void test('legacy actual start uses the Rome offset and handles missing and repeated hours', () => {
  assert.deepEqual(actualStartOptions('2026-11-03T11:45'), [{ value: '2026-11-03T10:45:00.000Z', offset: '+01:00' }]);
  assert.deepEqual(actualStartOptions('2026-03-29T02:30'), []);
  assert.deepEqual(actualStartOptions('2026-10-25T02:30'), [
    { value: '2026-10-25T00:30:00.000Z', offset: '+02:00' },
    { value: '2026-10-25T01:30:00.000Z', offset: '+01:00' },
  ]);
});

void test('finish photo selection appends valid photos and preserves selected files when a limit is exceeded', () => {
  const photo = new File([new Uint8Array(5 * 1024 * 1024)], 'work.jpg', { type: 'image/jpeg' });
  const small = new File(['x'], 'work.png', { type: 'image/png' });
  const invalid = new File(['x'], 'work.svg', { type: 'image/svg+xml' });

  assert.deepEqual(selectFinishPhotos([], [photo, small]), { added: [photo, small], error: null });
  assert.deepEqual(selectFinishPhotos([photo], [invalid, small]), { added: [small], error: 'photoType' });
  assert.deepEqual(selectFinishPhotos([photo, photo, photo], [photo, small]), { added: [photo], error: 'finishPhotoTotalSize' });
  assert.deepEqual(selectFinishPhotos(Array<File>(99).fill(small), [small, small]), { added: [small], error: 'finishPhotoLimit' });
});
