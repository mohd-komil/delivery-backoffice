import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { appointmentSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, user, waitFor } from './refresh-fixtures';

function scopedVisit(api: ApiFixture) {
  const delivery = api.detail.delivery;
  const product = delivery.source.items[0];
  assert.ok(product);
  const source = { ...delivery.source,
    salesOrders: [{ id: 1, name: 'DEMO/SO/FIRST' }, { id: 2, name: 'DEMO/SO/SECOND' }],
    items: [
      { ...product, quantity: 2, saleOrderId: 1 },
      { ...product, sourceLineId: 20, quantity: 1, saleOrderId: 2 },
      { ...product, sourceLineId: 30, saleOrderId: 2 },
    ],
  };
  const id = '88000000-0000-4000-8000-000000000001';
  const at = '2026-11-10T10:00:00Z';
  return appointmentSchema.parse({ id, startsAt: '2026-11-10T09:00:00Z', endsAt: at, status: 'completed',
    cancellationReason: null, returnRequestId: null, assignments: [], results: [{
      id: '88000000-0000-4000-8000-000000000002', appointmentId: id, receivedAt: at,
      actualStart: '2026-11-10T09:00:00Z', actualEnd: at, summary: 'DEMO per-operation result',
      source: 'crew_frontoffice', supersedesResultId: null, correctionReason: null,
      actor: { kind: 'crew', id: user.id, name: 'DEMO responsible participant' }, responsiblePersonId: user.id,
      quantities: [{ sourceLineId: 10, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 20, deliveredMilli: 1000 }],
      incompleteWork: [
        { sourceLineId: 10, operation: 'delivery', reason: 'damage', note: 'One unit damaged.' },
        { sourceLineId: 10, operation: 'installation', reason: 'missing_goods_or_parts', note: 'Fixings missing.' },
        { sourceLineId: 20, operation: 'installation', reason: 'access', note: 'Room locked.' },
      ],
      evidence: [], customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer signature', at },
      crewSignature: { status: 'signed', signerName: 'DEMO responsible participant', text: 'DEMO crew signature', at },
      sourceSnapshot: source, instructionsSnapshot: delivery.instructions, assignmentsSnapshot: [],
      workScopeSnapshot: { revision: 1, sourceFingerprint: 'a'.repeat(64), confirmedAt: '2026-11-10T08:00:00Z', confirmedBy: user,
        lines: source.items.filter((item) => item.sourceLineId !== 30).map((sourceItem) => ({
          sourceLineId: sourceItem.sourceLineId, deliveryMilli: sourceItem.quantity * 1000, installationMilli: sourceItem.quantity * 1000,
          collectionMilli: 0, service: 'delivery_installation', sourceItem,
        })),
      },
    }],
  });
}

void test('result contract accepts structured incomplete work without inventing legacy data and validates untrusted reasons', () => {
  const visit = scopedVisit(new ApiFixture());
  const result = visit.results[0];
  assert.ok(result);
  assert.equal(result.incompleteWork?.length, 3);
  const read = (incompleteWork: unknown) => appointmentSchema.safeParse({ ...visit, results: [{ ...result, incompleteWork }] });
  for (const reason of ['missing_goods_or_parts', 'damage', 'access', 'customer_refused', 'time_shortage', 'other']) {
    assert.equal(read([{ sourceLineId: 10, operation: 'delivery', reason, note: 'Details' }]).success, true);
  }
  const trimmed = read([{ sourceLineId: 10, operation: 'collection', reason: 'other', note: '  Customer requested another slot.  ' }]);
  assert.ok(trimmed.success);
  assert.equal(trimmed.data.results[0]?.incompleteWork?.[0]?.note, 'Customer requested another slot.');
  for (const entry of [
    { sourceLineId: 10, operation: 'delivery', reason: 'unknown', note: null },
    { sourceLineId: 10, operation: 'delivery', reason: 'other', note: '   ' },
    { sourceLineId: 10, operation: 'delivery', reason: 'other', note: null },
    { sourceLineId: 10, operation: 'delivery', reason: 'damage', note: 'x'.repeat(501) },
    { sourceLineId: 0, operation: 'delivery', reason: 'damage', note: null },
    { sourceLineId: 10, operation: 'unknown', reason: 'damage', note: null },
  ]) assert.equal(read([entry]).success, false);
  assert.ok(read([]).success);
  delete result.incompleteWork;
  const legacy = appointmentSchema.parse(visit).results[0];
  assert.ok(legacy);
  assert.equal(Object.hasOwn(legacy, 'incompleteWork'), false);
});

void test('History keeps partial and unperformed work distinct by order, operation and immutable report version', async () => {
  const api = new ApiFixture();
  const visit = scopedVisit(api);
  const original = visit.results[0];
  assert.ok(original?.incompleteWork);
  const note = 'Time ran out.\n<b>Keep this as text.</b>';
  const corrected = { ...original, id: '88000000-0000-4000-8000-000000000003', supersedesResultId: original.id,
    correctionReason: 'Clarified why the first delivery was partial.',
    incompleteWork: original.incompleteWork.map((entry) => entry.sourceLineId === 10 && entry.operation === 'delivery'
      ? { ...entry, reason: 'time_shortage', note } : entry),
  };
  api.detail.delivery.appointments = [appointmentSchema.parse({ ...visit, results: [original, corrected] })];
  api.detail.delivery.source = { ...api.detail.delivery.source,
    saleOrderName: 'DEMO later order name', items: api.detail.delivery.source.items.map((item) => ({ ...item, name: 'DEMO renamed later' })),
  };
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: api.detail.delivery.id, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.detail-tab-overview') !== null, 'delivery details');
    await click(button(document, 'History'));
    const [oldCard, currentCard] = document.querySelectorAll('.result-card');
    assert.ok(oldCard && currentCard);
    assert.match(oldCard.querySelector('[data-slot=card-header]')?.textContent ?? '', /Superseded/);
    assert.match(currentCard.querySelector('[data-slot=card-header]')?.textContent ?? '', /Current/);
    assert.match(oldCard.textContent ?? '', /DEMO customer signature.*DEMO crew signature/s);
    const oldWork = oldCard.querySelector('section[aria-label="Work recorded on this visit"]');
    const currentWork = currentCard.querySelector('section[aria-label="Work recorded on this visit"]');
    assert.ok(oldWork && currentWork);
    const [firstDelivery, firstInstallation, secondDelivery, secondInstallation] = currentWork.querySelectorAll('tbody tr');
    assert.ok(firstDelivery && firstInstallation && secondDelivery && secondInstallation);
    assert.equal(currentWork.querySelectorAll('tbody tr').length, 4);
    assert.match(firstDelivery.querySelector('th')?.textContent ?? '', /DEMO table · DEMO\/SO\/FIRST · line 10/);
    assert.deepEqual([...firstDelivery.querySelectorAll('td')].slice(0, 4).map((cell) => cell.textContent), ['Delivery', '2', '1', '1']);
    assert.match(firstDelivery.textContent ?? '', /Partially completed.*Not enough time/s);
    assert.equal(firstDelivery.querySelector('p.whitespace-pre-wrap')?.textContent, note);
    assert.equal(firstDelivery.querySelector('b'), null, 'Crew notes are text, not HTML');
    assert.match(firstInstallation.textContent ?? '', /Installation202Not performedMissing goods or partsFixings missing/);
    assert.match(secondDelivery.querySelector('th')?.textContent ?? '', /DEMO\/SO\/SECOND · line 20/);
    assert.deepEqual([...secondDelivery.querySelectorAll('td')].slice(0, 4).map((cell) => cell.textContent), ['Delivery', '1', '1', '0']);
    assert.match(secondDelivery.textContent ?? '', /Completed/);
    assert.doesNotMatch(secondDelivery.textContent ?? '', /reason|Not performed|Not enough time/i);
    assert.match(secondInstallation.textContent ?? '', /DEMO\/SO\/SECOND · line 20.*Installation101Not performedAccess prevented the workRoom locked/s);
    assert.doesNotMatch(currentWork.textContent, /Collection|line 30|renamed later|later order name/);
    assert.match(oldWork.textContent, /Damaged goodsOne unit damaged/);
    assert.doesNotMatch(oldWork.textContent, /Not enough time/);

    api.detail.delivery.version += 1;
    await click(button(document, '↻ Refresh'));
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'refreshed history');
    assert.strictEqual(document.querySelectorAll('section[aria-label="Work recorded on this visit"]')[1], currentWork);
    assert.match(currentWork.textContent, /DEMO\/SO\/FIRST · line 10.*Not enough time/s);
  } finally { await page.close(); }
});

void test('older scoped and unscoped reports never invent reasons or missing planned quantities', async () => {
  const api = new ApiFixture();
  const result = scopedVisit(api).results[0];
  assert.ok(result);
  delete result.incompleteWork;
  const page = await domHarness(api);
  try {
    const { DeliveryResultWork } = await import('../src/components/delivery-result-work');
    await page.render(createElement(DeliveryResultWork, { result }));
    const document = page.dom.window.document;
    assert.equal([...document.querySelectorAll('tbody p')].filter((node) => node.textContent === 'Per-operation reasons were not recorded in this older report.').length, 3);
    assert.doesNotMatch(document.body.textContent ?? '', /Missing goods or parts|Damaged goods|Access prevented/);
    delete result.workScopeSnapshot;
    await page.render(createElement(DeliveryResultWork, { result }));
    assert.equal(document.querySelector('table'), null);
    assert.match(document.body.textContent ?? '', /older report has no confirmed work plan/);
    assert.match(document.body.textContent ?? '', /DEMO\/SO\/FIRST · line 10 · Delivery 1 unit/);
    assert.match(document.body.textContent ?? '', /DEMO\/SO\/SECOND · line 20 · Delivery 1 unit/);
    assert.doesNotMatch(document.body.textContent ?? '', /Not performed|Partially completed|Installation/);
  } finally { await page.close(); }
});

void test('work outcomes and reasons are translated in each supported language', async () => {
  const api = new ApiFixture();
  const result = scopedVisit(api).results[0];
  assert.ok(result);
  const page = await domHarness(api);
  try {
    const { DeliveryResultWork } = await import('../src/components/delivery-result-work');
    for (const [locale, partial, reason] of [
      ['en', 'Partially completed', 'Missing goods or parts'],
      ['it', 'Parzialmente completato', 'Merce o componenti mancanti'],
      ['ru', 'Выполнено частично', 'Не хватает товара или деталей'],
      ['uz', 'Qisman bajarilgan', 'Tovar yoki qismlar yetishmayapti'],
    ] as const) {
      await page.render(createElement(DeliveryResultWork, { result }), locale);
      const text = page.dom.window.document.body.textContent ?? '';
      assert.ok(text.includes(partial), locale);
      assert.ok(text.includes(reason), locale);
      assert.ok(text.includes('DEMO/SO/FIRST'), locale);
      assert.ok(text.includes('DEMO/SO/SECOND'), locale);
    }
  } finally { await page.close(); }
});
