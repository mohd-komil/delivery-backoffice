import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { deliverySchema, geographySchema } from '../src/lib/contracts';
import { sourceHealthSchema } from '../src/lib/workspace-source';
import { ApiFixture, click, detailFixture, domHarness, user, waitFor } from './refresh-fixtures';

void test('source contracts retain CAP, province, SKU and UoM identity without adding them to legacy snapshots', () => {
  const legacy = detailFixture().delivery;
  const restored = deliverySchema.parse(legacy);
  assert.equal(Object.hasOwn(restored.source.customer, 'postalCode'), false);
  assert.equal(Object.hasOwn(restored.source.items[0] ?? {}, 'sku'), false);
  const delivery = deliverySchema.parse({ ...legacy, source: { ...legacy.source,
    customer: { ...legacy.source.customer, province: 'ME', postalCode: '00100' },
    items: legacy.source.items.map((item) => ({ ...item, sku: 'CHAIR-01', uomId: 1 })),
  } });
  assert.equal(delivery.source.customer.postalCode, '00100');
  assert.equal(delivery.source.customer.province, 'ME');
  assert.equal(delivery.source.items[0]?.sku, 'CHAIR-01');
  assert.equal(delivery.source.items[0]?.uomId, 1);
  assert.equal(geographySchema.safeParse({ city: 'Messina', province: 'ME', postalCode: '00100', source: 'odoo' }).success, true);
  assert.equal(sourceHealthSchema.safeParse({ status: 'ok', sourceModel: 'unknown legacy label' }).success, false);
  assert.equal(sourceHealthSchema.safeParse({ status: 'ok', sourceKind: 'production' }).success, false);
});

void test('workspace waits for source verification, then uses Odoo test-copy labels in sidebar and Imports', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const source = api.defer('/health');
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.sidebar-bottom') !== null, 'workspace');
    assert.match(doc.querySelector('.demo-stamp')?.textContent ?? '', /Checking data source/);
    assert.doesNotMatch(doc.body.textContent ?? '', /SYNTHETIC DATA ONLY|Source is a teaching model/);
    source.reply({ status: 'ok', sourceKind: 'odoo_readonly', sourceModel: 'Customer-schema test copy' });
    await waitFor(() => doc.querySelector('.demo-stamp')?.textContent?.includes('ODOO TEST SOURCE') === true, 'verified source');
    assert.match(doc.querySelector('.sidebar-bottom')?.textContent ?? '', /Customer-schema test copy/);
    const imports = Array.from(doc.querySelectorAll('.nav-item')).find((entry) => entry.textContent?.includes('Source sync'));
    assert.ok(imports instanceof page.dom.window.HTMLButtonElement);
    await click(imports);
    await waitFor(() => doc.body.textContent?.includes("Odoo development copy contains test data in the customer's schema") === true, 'read-only import explanation');
    assert.doesNotMatch(doc.body.textContent ?? '', /Fake Odoo is a teaching model/);
    assert.equal(api.calls.filter((call) => call.pathname === '/health').length, 1);
  } finally { await page.close(); }
});

void test('unavailable or unrecognized source metadata is shown as unknown, never synthetic', { concurrency: false }, async () => {
  for (const [response, status] of [[{ message: 'Unavailable' }, 503], [{ status: 'ok' }, 200]] as const) {
    const api = new ApiFixture();
    const source = api.defer('/health');
    const page = await domHarness(api);
    try {
      const { Backoffice } = await import('../src/components/backoffice');
      await page.render(createElement(Backoffice));
      source.reply(response, status);
      const doc = page.dom.window.document;
      await waitFor(() => doc.querySelector('.demo-stamp')?.textContent === 'SOURCE NOT VERIFIED', 'unknown source');
      assert.doesNotMatch(doc.body.textContent ?? '', /SYNTHETIC DATA ONLY|ODOO TEST SOURCE/);
    } finally { await page.close(); }
  }
});

void test('login source label follows verified runtime metadata in all four languages', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const login = api.defer('/auth/me');
  const source = api.defer('/health');
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    const component = createElement(Backoffice);
    await page.render(component);
    login.reply({ message: 'Login required' }, 401);
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.login-foot') !== null, 'login screen');
    assert.match(doc.querySelector('.login-foot')?.textContent ?? '', /Checking data source/);
    source.reply({ status: 'ok', sourceKind: 'odoo_readonly' });
    await waitFor(() => doc.querySelector('.login-foot')?.textContent?.includes('customer-schema Odoo copy') === true, 'runtime source on login');
    for (const [locale, phrase] of [
      ['en', 'customer-schema Odoo copy'], ['it', 'copia Odoo dello schema cliente'],
      ['ru', 'копия схемы Odoo клиента'], ['uz', 'mijoz Odoo sxemasining nusxasi'],
    ] as const) {
      await page.render(component, locale);
      assert.ok(doc.querySelector('.login-foot')?.textContent?.includes(phrase));
    }
    assert.equal(api.calls.filter((call) => call.pathname === '/health').length, 1);
  } finally { await page.close(); }
});

void test('delivery overview shows source CAP/province and renders SKU as plain text beside its source line', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.detail.delivery.source.customer = { ...api.detail.delivery.source.customer, province: 'ME', postalCode: '00100' };
  const sku = '<script>notExecutable()</script>';
  api.detail.delivery.source.items = api.detail.delivery.source.items.map((item) => ({ ...item, sku, uomId: 1 }));
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: api.detail.delivery.id, user, onClose: () => undefined, onChanged: () => undefined }));
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.product-row') !== null, 'product overview');
    assert.match(doc.querySelector('.customer-card')?.textContent ?? '', /Messina, ME, 00100, IT/);
    assert.ok(doc.querySelector('.product-row')?.textContent?.includes('SKU: ' + sku));
    assert.equal(doc.querySelector('.product-row script'), null);
    assert.match(doc.querySelector('.product-row')?.textContent ?? '', /Source line 10/);
  } finally { await page.close(); }
});
