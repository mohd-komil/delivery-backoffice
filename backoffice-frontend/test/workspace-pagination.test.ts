import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema, importSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, listFixture, waitFor } from './refresh-fixtures';

function deliveries(page: number, total = 21) {
  const base = listFixture();
  const item = base.items[0];
  assert.ok(item);
  const start = (page - 1) * 10;
  return deliveryListSchema.parse({ ...base, page, total, items: Array.from({ length: Math.max(0, Math.min(10, total - start)) }, (_, index) => {
    const number = start + index + 1;
    return { ...item, id: `72000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
      source: { ...item.source, pickingName: `DEMO/PAGE/${number}` } };
  }) });
}

void test('delivery pagination uses server pages, preserves page and rows on Refresh, and recovers after the last page disappears', async () => {
  const api = new ApiFixture();
  api.list = deliveries(1);
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelectorAll('.delivery-table tbody tr').length === 10, 'first ten deliveries');
    assert.equal(button(document, 'Previous').disabled, true);
    const second = api.defer('/deliveries', 'GET', '?view=inbox&page=2');
    second.reply(deliveries(2));
    await click(button(document, 'Next'));
    await waitFor(() => document.querySelector('.delivery-table tbody tr')?.textContent?.includes('DEMO/PAGE/11') === true, 'server page two');
    assert.equal(document.querySelectorAll('.delivery-table tbody tr').length, 10, 'server pages are not sliced twice');
    const table = document.querySelector('.delivery-table');
    const row = table?.querySelector('tbody tr');
    const region = document.querySelector('.table-wrap');
    assert.ok(region instanceof HTMLElement);
    region.scrollLeft = 160;
    const refresh = api.defer('/deliveries', 'GET', '?view=inbox&page=2');
    await click(button(document, '↻ Refresh'));
    assert.equal(row?.isConnected, true);
    await act(async () => { refresh.reply(deliveries(2)); });
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'page two refresh');
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.equal(table?.querySelector('tbody tr'), row);
    assert.equal(region.scrollLeft, 160);
    const third = api.defer('/deliveries', 'GET', '?view=inbox&page=3');
    third.reply(deliveries(3));
    await click(button(document, 'Next'));
    await waitFor(() => document.querySelector('.delivery-table tbody tr')?.textContent?.includes('DEMO/PAGE/21') === true, 'last page');
    assert.equal(document.querySelectorAll('.delivery-table tbody tr').length, 1);
    assert.equal(button(document, 'Next').disabled, true);
    const reduced = api.defer('/deliveries', 'GET', '?view=inbox&page=3');
    const recovery = api.defer('/deliveries', 'GET', '?view=inbox&page=2');
    recovery.reply(deliveries(2, 11));
    await click(button(document, '↻ Refresh'));
    await act(async () => { reduced.reply(deliveries(3, 11)); });
    await waitFor(() => recovery.called && !button(document, '↻ Refresh').disabled, 'recover to last available server page');
    assert.equal(document.querySelectorAll('.delivery-table tbody tr').length, 1);
    assert.match(document.querySelector('.delivery-table tbody tr')?.textContent ?? '', /DEMO\/PAGE\/11/);
    assert.equal(button(document, 'Next').disabled, true);
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('import history paginates ten runs and retains second-page expanded diagnostics across Refresh and failure', async () => {
  const api = new ApiFixture();
  api.imports = Array.from({ length: 21 }, (_, index) => importSchema.parse({
    id: `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    status: 'succeeded', startedAt: '2026-11-10T08:00:00Z', finishedAt: '2026-11-10T08:00:01Z',
    processed: index + 1, error: null, details: [`Synthetic run ${index + 1}`],
  }));
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'workspace loaded');
    const sourceSync = Array.from(document.querySelectorAll('nav[aria-label="Backoffice sections"] button')).find((entry) => entry.textContent?.includes('Source sync'));
    assert.ok(sourceSync instanceof HTMLButtonElement);
    await click(sourceSync);
    await waitFor(() => document.querySelectorAll('.imports-table-region tbody tr').length === 10, 'first ten import runs');
    await click(button(document, 'Next'));
    const details = document.querySelector('.imports-table-region details');
    const region = document.querySelector('.imports-table-region');
    assert.ok(details instanceof page.dom.window.HTMLDetailsElement);
    assert.ok(region instanceof HTMLElement);
    assert.match(details.textContent ?? '', /Synthetic run 11/);
    details.open = true;
    region.scrollLeft = 120;
    const refresh = api.defer('/imports');
    await click(button(document, '↻ Refresh history'));
    assert.equal(details.isConnected, true);
    await act(async () => { refresh.reply(api.imports); });
    await waitFor(() => !button(document, '↻ Refresh history').disabled, 'history refreshed');
    assert.equal(document.querySelector('.imports-table-region details'), details);
    assert.equal(details.open, true);
    assert.equal(region.scrollLeft, 120);
    const failure = api.defer('/imports');
    await click(button(document, '↻ Refresh history'));
    await act(async () => { failure.reply({ message: 'Synthetic history unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic history unavailable') === true, 'history failure');
    assert.equal(document.querySelector('.imports-table-region details'), details);
    assert.equal(details.open, true);
    const reduced = api.defer('/imports');
    await click(button(document, '↻ Refresh history'));
    await act(async () => { reduced.reply(api.imports.slice(0, 7)); });
    await waitFor(() => document.querySelectorAll('.imports-table-region tbody tr').length === 7, 'history shrank to one page');
    assert.equal(button(document, 'Previous').disabled, true);
    assert.equal(button(document, 'Next').disabled, true);
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});
