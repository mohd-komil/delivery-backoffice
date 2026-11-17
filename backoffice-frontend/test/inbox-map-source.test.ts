import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { en, it, ru, uz } from '../src/i18n/messages/inbox-map';
import { ApiFixture, click, deliveryId, domHarness, settle, waitFor } from './refresh-fixtures';

function withoutCoordinates(api: ApiFixture) {
  api.defer('/deliveries/map', 'GET', '?view=inbox').reply({
    total: 1, mappedCount: 0, missingCount: 1, markers: [], area: null,
    missingCoordinates: [{
      deliveryId, pickingName: 'TEST/OUT/01', orderNames: ['TEST/SO/01'],
      customerName: 'Test customer', address: 'Test address',
      geography: { city: 'Messina', province: 'ME', postalCode: '98100', source: 'odoo' },
    }],
  });
}

void test('Odoo map explains missing coordinates in all languages and keeps the delivery accessible', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.defer('/health').reply({ status: 'ok', sourceKind: 'odoo_readonly' });
  withoutCoordinates(api);
  const page = await domHarness(api);
  const opened: string[] = [];
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const component = createElement(InboxDeliveryMap, {
      query: '', refreshKey: 0, visible: true,
      onOpen: (id: string) => { opened.push(id); },
    });
    await page.render(component);
    const doc = page.dom.window.document;
    await waitFor(() => doc.body.textContent?.includes(en.noCoordinatesOdooHelp) === true, 'Odoo missing-coordinate explanation');
    for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
      await page.render(component, locale);
      const text = doc.body.textContent ?? '';
      assert.ok(text.includes(messages.odooHint));
      assert.ok(text.includes(messages.noCoordinatesOdooHelp));
      assert.equal(text.includes(messages.demoHint), false, 'Connected addresses must not be described as locally supplied demo coordinates');
      const action = Array.from(doc.querySelectorAll('button')).find((item) => item.textContent?.includes('TEST/OUT/01'));
      assert.ok(action instanceof page.dom.window.HTMLButtonElement);
      await click(action);
    }
    assert.deepEqual(opened, Array.from({ length: 4 }, () => deliveryId));
    assert.equal(api.calls.filter((call) => call.pathname === '/health').length, 1);
    assert.equal(api.calls.some((call) => call.method !== 'GET' || /google|geocod/.test(call.pathname)), false);
  } finally { await page.close(); }
});

void test('loading or unavailable source metadata leaves the map explanation neutral', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const health = api.defer('/health');
  withoutCoordinates(api);
  const page = await domHarness(api);
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen: () => undefined }));
    const doc = page.dom.window.document;
    await waitFor(() => health.called && doc.body.textContent?.includes('TEST/OUT/01') === true, 'map is usable before source metadata settles');
    assert.ok(doc.body.textContent?.includes(en.coordinatesHint));
    assert.equal(doc.body.textContent?.includes(en.demoHint), false);
    assert.equal(doc.body.textContent?.includes(en.odooHint), false);
    await act(async () => { health.reply({ message: 'Unavailable' }, 503); });
    await settle();
    assert.ok(doc.body.textContent?.includes(en.coordinatesHint));
    assert.equal(doc.body.textContent?.includes(en.demoHint), false);
    assert.equal(doc.body.textContent?.includes(en.odooHint), false);
  } finally { await page.close(); }
});

void test('verified synthetic source retains the local-demo map notice', { concurrency: false }, async () => {
  const api = new ApiFixture();
  withoutCoordinates(api);
  const page = await domHarness(api);
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen: () => undefined }));
    await waitFor(() => page.dom.window.document.body.textContent?.includes(en.demoHint) === true, 'verified local-demo notice');
    assert.equal(page.dom.window.document.body.textContent?.includes(en.noCoordinatesOdooHelp), false);
  } finally { await page.close(); }
});
