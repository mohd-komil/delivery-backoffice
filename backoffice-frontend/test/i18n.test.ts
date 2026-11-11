import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { ApiFixture, click, domHarness, waitFor } from './refresh-fixtures';

void test('language changes translate the current workspace while keeping the selected view and loaded rows', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    const workspace = createElement(Backoffice);
    await page.render(workspace);
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table tbody tr') !== null, 'delivery list');
    assert.match(document.querySelector('h1')?.textContent ?? '', /Inbox to plan/);

    const planned = [...document.querySelectorAll('.delivery-view-nav button')].find((entry) => entry.textContent?.includes('Planned'));
    assert.ok(planned instanceof page.dom.window.HTMLButtonElement);
    await click(planned);
    await waitFor(() => document.querySelector('.view-nav.active')?.textContent?.includes('Planned') === true, 'planned view');
    const table = document.querySelector('.delivery-table');
    const row = table?.querySelector('tbody tr');
    assert.ok(row);
    const reads = api.calls.length;

    for (const [locale, title, language, customer] of [
      ['it', 'Pianificate', 'Lingua', 'Cliente e destinazione'],
      ['ru', 'Запланированы', 'Язык', 'Клиент и адрес'],
      ['uz', 'Rejalashtirilgan', 'Til', 'Mijoz va manzil'],
      ['en', 'Planned', 'Language', 'Customer & destination'],
    ] as const) {
      await page.render(workspace, locale);
      assert.ok(document.querySelector('h1')?.textContent?.startsWith(title));
      const selector = document.querySelector('select[aria-label="' + language + '"]');
      assert.ok(selector instanceof page.dom.window.HTMLSelectElement);
      assert.equal(selector.value, locale);
      assert.equal(table?.querySelectorAll('th')[1]?.textContent, customer);
      assert.equal(document.querySelector('.delivery-table tbody tr'), row);
      assert.match(row.textContent ?? '', /DEMO\/OUT\/REFRESH/);
      assert.equal(api.calls.length, reads);
    }
  } finally {
    await page.close();
  }
});
