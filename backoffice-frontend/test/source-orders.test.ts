import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { deliverySchema } from '../src/lib/contracts';
import { sourceLineLabel, sourceLineOrder, sourceOrders } from '../src/lib/source';
import { ApiFixture, button, click, detailFixture, domHarness, user, waitFor } from './refresh-fixtures';

void test('multi-order picking contracts preserve line ownership and leave legacy snapshots absent', () => {
  const legacy = detailFixture().delivery; const legacyItem = legacy.source.items[0]; assert.ok(legacyItem);
  assert.deepEqual(sourceOrders(legacy.source), [{ id: 1, name: 'DEMO/SO/REFRESH' }]);
  assert.equal(sourceLineOrder(legacy.source, legacyItem), 'Order not recorded for this line');
  assert.equal(Object.hasOwn(deliverySchema.parse(legacy).source, 'salesOrders'), false);
  const item = { ...legacyItem, sourceLineId: 20, name: 'DEMO same product', saleOrderId: 2 };
  const multiple = deliverySchema.parse({ ...legacy, source: { ...legacy.source, salesOrders: [{ id: 1, name: 'DEMO/SO/FIRST' }, { id: 2, name: 'DEMO/SO/SECOND' }], items: [{ ...legacyItem, saleOrderId: 1 }, item] } });
  assert.deepEqual(sourceOrders(multiple.source).map((order) => order.name), ['DEMO/SO/FIRST', 'DEMO/SO/SECOND']);
  assert.equal(sourceLineLabel(multiple.source, item), 'DEMO same product · DEMO/SO/SECOND · line 20');
  assert.equal(deliverySchema.safeParse({ ...multiple, source: { ...multiple.source, items: [{ ...item, saleOrderId: 99 }] } }).success, false);
  assert.equal(deliverySchema.safeParse({ ...multiple, source: { ...multiple.source, salesOrders: [{ id: 2, name: 'Missing primary' }] } }).success, false);
});

void test('delivery overview, issue choices and document choices show all orders and the actual product-line owner', { concurrency: false }, async () => {
  const api = new ApiFixture(); const item = api.detail.delivery.source.items[0]; assert.ok(item);
  api.detail.delivery.source = { ...api.detail.delivery.source, salesOrders: [{ id: 1, name: 'DEMO/SO/FIRST' }, { id: 2, name: 'DEMO/SO/SECOND' }], items: [{ ...item, saleOrderId: 1 }, { ...item, sourceLineId: 20, saleOrderId: 2 }] };
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel'); await page.render(createElement(DeliveryPanel, { id: api.detail.delivery.id, user, onClose: () => undefined, onChanged: () => undefined })); const doc = page.dom.window.document;
    await waitFor(() => doc.querySelectorAll('.product-row').length === 2, 'multi-order overview'); assert.match(doc.querySelector('.panel-header')?.textContent ?? '', /DEMO\/SO\/FIRST, DEMO\/SO\/SECOND/); assert.match(doc.querySelectorAll('.product-row')[1]?.textContent ?? '', /DEMO\/SO\/SECOND/);
    await click(button(doc, 'Issues & returns')); const labels = Array.from(doc.querySelectorAll('input[name="itemIds"]')).map((input) => input.parentElement?.textContent); assert.match(labels[1] ?? '', /DEMO\/SO\/SECOND · line 20/);
    await click(button(doc, 'Documents & evidence')); const choices = Array.from(doc.querySelectorAll('select[name="itemId"] option')).map((option) => option.textContent); assert.match(choices[2] ?? '', /DEMO\/SO\/SECOND · line 20/);
  } finally { await page.close(); }
});

void test('line service changes target the order line even when both lines have the same product', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const item = api.detail.delivery.source.items[0];
  assert.ok(item);
  api.detail.delivery.source = {
    ...api.detail.delivery.source,
    salesOrders: [{ id: 1, name: 'DEMO/SO/FIRST' }, { id: 2, name: 'DEMO/SO/SECOND' }],
    items: [{ ...item, saleOrderId: 1, quantity: 2 }, { ...item, sourceLineId: 20, saleOrderId: 2, quantity: 2 }],
  };
  api.detail.delivery.servicePlan = { defaultService: 'delivery_installation', overrides: [{ sourceLineId: 20, service: 'collection_only' }] };
  const firstLine = {
    sourceLineId: 10, service: 'delivery_installation', inherited: true, locked: true,
    deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0,
    remainingDeliveryMilli: 1000, remainingInstallationMilli: 2000, remainingCollectionMilli: 0,
    totalDeliveryMilli: 2000, totalInstallationMilli: 2000, totalCollectionMilli: 0,
    reservedDeliveryMilli: 0, reservedInstallationMilli: 0, reservedCollectionMilli: 0,
    availableDeliveryMilli: 1000, availableInstallationMilli: 2000, availableCollectionMilli: 0, planningBlockedReason: null,
  } as const;
  const secondLine = {
    sourceLineId: 20, service: 'collection_only', inherited: false, locked: false,
    deliveredMilli: 0, installedMilli: 0, collectedMilli: 0,
    remainingDeliveryMilli: 0, remainingInstallationMilli: 0, remainingCollectionMilli: 2000,
    totalDeliveryMilli: 0, totalInstallationMilli: 0, totalCollectionMilli: 2000,
    reservedDeliveryMilli: 0, reservedInstallationMilli: 0, reservedCollectionMilli: 0,
    availableDeliveryMilli: 0, availableInstallationMilli: 0, availableCollectionMilli: 2000, planningBlockedReason: null,
  } as const;
  api.detail.lineServices = [firstLine, secondLine];
  const path = `/deliveries/${api.detail.delivery.id}/services`;
  const change = api.defer(path, 'PATCH');
  const page = await domHarness(api);

  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: api.detail.delivery.id, user, onClose: () => undefined, onChanged: () => undefined }));
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelectorAll('.product-row').length === 2, 'service rows');
    const [first, second] = doc.querySelectorAll('.product-row');
    assert.ok(first && second);
    assert.match(first.textContent ?? '', /DEMO\/SO\/FIRST.*Service protected by recorded or planned work.*Delivery1 done · 1 left.*Installation0 done · 2 left/s);
    assert.equal(first.querySelector('button'), null, 'Recorded work locks the first line');
    assert.match(second.textContent ?? '', /DEMO\/SO\/SECOND.*Collection0 done · 2 left/s);
    await click(button(second, 'Edit line service'));
    const select = second.querySelector('select');
    assert.ok(select);
    select.value = '';
    await click(button(second, 'Save service'));
    await waitFor(() => change.called, 'line service PATCH');
    assert.deepEqual(api.calls.find((call) => call.pathname === path)?.body, { version: 1, sourceLineId: 20, service: null });
    change.reply({
      ...api.detail,
      delivery: { ...api.detail.delivery, version: 2, servicePlan: { defaultService: 'delivery_installation', overrides: [] } },
      lineServices: [firstLine, { ...secondLine, service: 'delivery_installation', inherited: true, remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000, remainingCollectionMilli: 0 }],
    });
    await waitFor(() => second.textContent?.includes('Uses default') === true, 'inherited service on the second line');
    assert.match(first.textContent ?? '', /Delivery1 done · 1 left/);
    assert.match(second.textContent ?? '', /Delivery0 done · 2 left/);
  } finally {
    await page.close();
  }
});
