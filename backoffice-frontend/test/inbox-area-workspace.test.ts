import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema } from '../src/lib/contracts';
import { inboxMapAreaSchema, type InboxMapArea } from '../src/lib/inbox-map-area';
import { ApiFixture, button, click, deliveryId, domHarness, listFixture, settle, waitFor } from './refresh-fixtures';

function listData(area: InboxMapArea | null = null) {
  return deliveryListSchema.parse({ ...listFixture('DEMO/AREA/01'), total: area ? 1 : 21,
    geographyFacets: {
      cities: [{ value: 'Catania', count: area ? 1 : 21 }], provinces: [{ value: 'CT', count: area ? 1 : 21 }],
      postalCodes: [{ value: '95121', count: area ? 1 : 21 }],
    },
    area: area ? { bounds: area, excludedMissingCoordinates: 1 } : null,
  });
}

function mapData(area: InboxMapArea | null = null) {
  return {
    total: 1, mappedCount: 1, missingCount: 0,
    markers: [{ deliveryId, pickingName: 'DEMO/AREA/01', orderNames: ['SO/AREA'], customerName: 'Synthetic customer', address: 'Synthetic Street 1',
      geography: { city: 'Catania', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' },
      point: { latitude: 37.5, longitude: 15.08 }, pointSource: 'reference' }],
    missingCoordinates: [], area: area ? { bounds: area, excludedMissingCoordinates: 1 } : null,
  };
}

function cityField(document: Document) {
  const select = Array.from(document.querySelectorAll('label')).find((label) => label.firstElementChild?.textContent === 'City')?.querySelector('select');
  assert.ok(select instanceof HTMLSelectElement);
  return select;
}

function visibleButton(document: Document, label: string) {
  const found = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent === label && !entry.closest('[hidden]'));
  assert.ok(found, `Missing visible button: ${label}`);
  return found;
}

void test('Inbox area and city share List/Map requests, reset pagination, survive Refresh and repeated selection, and clear independently', async (context) => {
  const api = new ApiFixture();
  api.list = listData();
  const page = await domHarness(api);
  try {
    context.mock.getter(page.dom.window.HTMLElement.prototype, 'clientWidth', function (this: HTMLElement) { return this.classList.contains('inbox-leaflet-map') ? 640 : 0; });
    context.mock.getter(page.dom.window.HTMLElement.prototype, 'clientHeight', function (this: HTMLElement) { return this.classList.contains('inbox-leaflet-map') ? 420 : 0; });
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial Inbox');
    api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania').reply(listData());
    const city = cityField(document);
    await act(async () => { city.value = JSON.stringify('Catania'); city.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'city filter loaded');
    api.defer('/deliveries', 'GET', '?view=inbox&page=2&city=Catania').reply({ ...listData(), page: 2 });
    await click(button(document, 'Next'));
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'page 2 loaded');
    api.defer('/deliveries/map', 'GET', '?view=inbox&city=Catania').reply(mapData());
    await click(button(document, 'Map'));
    await waitFor(() => Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent === 'Use visible area' && !entry.disabled), 'interactive map');
    const canvas = document.querySelector('.inbox-leaflet-map');
    const callsBeforePan = api.calls.length;
    await click(button(document, '+'));
    await settle();
    assert.equal(api.calls.length, callsBeforePan, 'moving the map does not silently change shared filters');

    const filteredList = api.defer('/deliveries');
    const filteredMap = api.defer('/deliveries/map');
    await click(button(document, 'Use visible area'));
    await waitFor(() => filteredList.called && filteredMap.called, 'area applied to both endpoints');
    const listCall = api.calls.filter((call) => call.pathname === '/deliveries').at(-1);
    const mapCall = api.calls.filter((call) => call.pathname === '/deliveries/map').at(-1);
    assert.ok(listCall && mapCall);
    const listQuery = new URLSearchParams(listCall.search);
    const mapQuery = new URLSearchParams(mapCall.search);
    assert.equal(listQuery.get('page'), '1');
    assert.equal(listQuery.get('city'), 'Catania');
    assert.equal(mapQuery.has('page'), false);
    const area = inboxMapAreaSchema.parse({ north: Number(mapQuery.get('north')), south: Number(mapQuery.get('south')),
      east: Number(mapQuery.get('east')), west: Number(mapQuery.get('west')) });
    listQuery.delete('page');
    assert.equal(listQuery.toString(), mapQuery.toString());
    await act(async () => { filteredList.reply(listData(area)); filteredMap.reply(mapData(area)); });
    await waitFor(() => !button(document, '↻ Refresh').disabled && !button(document, 'Use visible area').disabled, 'area results settled');
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);

    const beforeRepeat = api.calls.length;
    await click(button(document, 'Use visible area'));
    await settle();
    assert.equal(button(document, '↻ Refresh').disabled, false, 'applying identical bounds must not leave list loading forever');
    assert.equal(api.calls.length, beforeRepeat, 'identical bounds are a no-op');

    const refreshList = api.defer('/deliveries', 'GET', listCall.search);
    refreshList.reply(listData(area));
    const refreshMap = api.defer('/deliveries/map', 'GET', mapCall.search);
    refreshMap.reply(mapData(area));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => refreshList.called && refreshMap.called && !button(document, '↻ Refresh').disabled, 'shared Refresh');
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.match(document.body.textContent ?? '', /1 matching deliveries without usable coordinates are excluded/);

    await click(button(document, 'List'));
    const mapsBeforeClear = api.calls.filter((call) => call.pathname === '/deliveries/map').length;
    const clear = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    clear.reply(listData());
    await click(visibleButton(document, 'Clear area'));
    await waitFor(() => clear.called && !button(document, '↻ Refresh').disabled, 'cleared area retains city');
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries/map').length, mapsBeforeClear, 'hidden Map does not fetch');
    const clearedMap = api.defer('/deliveries/map', 'GET', '?view=inbox&city=Catania');
    clearedMap.reply(mapData());
    await click(button(document, 'Map'));
    await waitFor(() => clearedMap.called && !button(document, 'Use visible area').disabled, 'Map uses the same cleared area query');
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});
