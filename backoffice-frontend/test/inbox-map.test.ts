import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema } from '../src/lib/contracts';
import { appendInboxMapArea, type InboxMapArea } from '../src/lib/inbox-map-area';
import { ApiFixture, button, click, deliveryId, domHarness, listFixture, settle, waitFor } from './refresh-fixtures';

function id(index: number) {
  return `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function metadata(index: number) {
  return {
    deliveryId: id(index), pickingName: `DEMO/MAP/${String(index).padStart(2, '0')}`, orderNames: [`SO/${index}`],
    customerName: `Synthetic customer ${index}`, address: `Synthetic Street ${index}`,
    geography: { city: 'Catania', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' as const },
  };
}

function mapData(markerIds: number[], missingIds: number[] = [], area: { bounds: InboxMapArea; excludedMissingCoordinates: number } | null = null) {
  return {
    total: markerIds.length + missingIds.length, mappedCount: markerIds.length, missingCount: missingIds.length,
    markers: markerIds.map((index) => ({ ...metadata(index), point: { latitude: 37.5 + index / 1000, longitude: 15.08 + index / 1000 }, pointSource: 'reference' as const })),
    missingCoordinates: missingIds.map(metadata),
    area,
  };
}

function listData() {
  const list = listFixture();
  const base = list.items[0];
  assert.ok(base);
  return deliveryListSchema.parse({
    ...list, total: 14, counts: { ...list.counts, inbox: 14 },
    items: Array.from({ length: 10 }, (_, index) => ({ ...base, id: id(index + 1), source: { ...base.source, pickingName: metadata(index + 1).pickingName } })),
    geographyFacets: {
      cities: [{ value: 'Catania', count: 14 }, { value: 'Messina', count: 2 }],
      provinces: [{ value: 'CT', count: 14 }], postalCodes: [{ value: '95121', count: 14 }],
    },
    matchingGeographyFacets: {
      cities: [{ value: 'Catania', count: 14 }], provinces: [{ value: 'CT', count: 14 }], postalCodes: [{ value: '95121', count: 14 }],
    },
  });
}

function mapReply(api: ApiFixture, query: string, value: ReturnType<typeof mapData>) {
  const response = api.defer('/deliveries/map', 'GET', `?view=inbox${query ? `&${query}` : ''}`);
  response.reply(value);
  return response;
}

function openButton(scope: ParentNode, picking: string): HTMLButtonElement {
  const found = scope.querySelector(`button[aria-label="Open ${picking}"]`);
  assert.ok(found instanceof HTMLButtonElement, `Missing accessible delivery action: ${picking}`);
  return found;
}

function geographyField(document: Document, label: string): HTMLSelectElement {
  const control = Array.from(document.querySelectorAll('label')).find((entry) => entry.firstElementChild?.textContent === label)?.querySelector('select');
  assert.ok(control instanceof HTMLSelectElement);
  return control;
}

async function selectGeography(document: Document, label: string, name: string) {
  const select = geographyField(document, label);
  assert.equal(select.disabled, false);
  await act(async () => { select.value = JSON.stringify(name); select.dispatchEvent(new Event('change', { bubbles: true })); });
}

void test('Inbox defaults to List and Map loads every matching delivery independently of list pagination with the shared filters', async () => {
  const api = new ApiFixture();
  api.list = listData();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox list');
    assert.equal(button(document, 'List').getAttribute('aria-pressed'), 'true');
    assert.equal(button(document, 'Map').getAttribute('aria-pressed'), 'false');
    assert.equal(api.calls.some((call) => call.pathname === '/deliveries/map'), false, 'List mode must not request map data');
    api.defer('/deliveries', 'GET', '?view=inbox&page=2').reply({ ...listData(), page: 2 });
    await click(button(document, 'Next'));
    await waitFor(() => api.calls.some((call) => call.search === '?view=inbox&page=2'), 'second list page');
    const all = mapReply(api, '', mapData(Array.from({ length: 12 }, (_, index) => index + 1), [13, 14]));
    await click(button(document, 'Map'));
    await waitFor(() => all.called && document.querySelector('button[aria-label="Open DEMO/MAP/12"]') !== null, 'all 12 map deliveries');
    const mapRegion = document.querySelector('section[aria-label="Delivery map"]');
    assert.ok(mapRegion);
    assert.equal(button(document, 'Map').getAttribute('aria-pressed'), 'true');
    assert.match(document.body.textContent ?? '', /Deliveries on map \(12\)/);
    assert.match(document.body.textContent ?? '', /Without coordinates/);
    assert.ok(openButton(document, 'DEMO/MAP/14'), 'A missing-coordinate delivery remains accessible');
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries/map').some((call) => new URLSearchParams(call.search).has('page')), false);
    api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania').reply(listData());
    const filtered = mapReply(api, 'city=Catania', mapData([1, 2]));
    api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121').reply(listData());
    const automatic = mapReply(api, 'city=Catania&province=CT&postalCode=95121', mapData([1, 2]));
    await selectGeography(document, 'City', 'Catania');
    await waitFor(() => filtered.called && automatic.called && document.querySelector('button[aria-label="Open DEMO/MAP/12"]') === null, 'shared map query includes automatically selected province and CAP');
    assert.ok(openButton(document, 'DEMO/MAP/02'));
    assert.equal(geographyField(document, 'Province').value, JSON.stringify('CT'));
    assert.equal(geographyField(document, 'Postal code (CAP)').value, JSON.stringify('95121'));
    const messinaList = listData();
    assert.ok(messinaList.geographyFacets);
    messinaList.geographyFacets = {
      cities: messinaList.geographyFacets.cities,
      provinces: [{ value: 'ME', count: 2 }], postalCodes: [{ value: '98100', count: 2 }],
    };
    messinaList.matchingGeographyFacets = {
      cities: [{ value: 'Messina', count: 2 }], provinces: [{ value: 'ME', count: 2 }], postalCodes: [{ value: '98100', count: 2 }],
    };
    const cityList = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Messina');
    cityList.reply(messinaList);
    const cityMap = mapReply(api, 'city=Messina', mapData([2]));
    const messinaAutomaticList = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Messina&province=ME&postalCode=98100');
    messinaAutomaticList.reply(messinaList);
    const messinaAutomaticMap = mapReply(api, 'city=Messina&province=ME&postalCode=98100', mapData([2]));
    await selectGeography(document, 'City', 'Messina');
    await waitFor(() => cityList.called && cityMap.called && messinaAutomaticList.called && messinaAutomaticMap.called && mapRegion.querySelector('button[aria-label="Open DEMO/MAP/02"]') !== null, 'List and Map both replace obsolete province and CAP after changing city');
    assert.equal(geographyField(document, 'Province').value, JSON.stringify('ME'));
    assert.equal(geographyField(document, 'Postal code (CAP)').value, JSON.stringify('98100'));
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries/map').at(-1)?.search, '?view=inbox&city=Messina&province=ME&postalCode=98100');
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').at(-1)?.search, '?view=inbox&page=1&city=Messina&province=ME&postalCode=98100');
    const clearedList = api.defer('/deliveries', 'GET', '?view=inbox&page=1');
    clearedList.reply(listData());
    const clearedMap = mapReply(api, '', mapData([1, 2]));
    await click(button(document, 'Clear filters'));
    await waitFor(() => clearedList.called && clearedMap.called && !geographyField(document, 'Postal code (CAP)').disabled, 'all filters cleared for inverse selection');
    assert.equal(geographyField(document, 'City').value, '');
    const capList = api.defer('/deliveries', 'GET', '?view=inbox&page=1&postalCode=95121');
    capList.reply(listData());
    const capMap = mapReply(api, 'postalCode=95121', mapData([1, 2]));
    const inverseList = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121');
    inverseList.reply(listData());
    const inverseMap = mapReply(api, 'city=Catania&province=CT&postalCode=95121', mapData([1, 2]));
    await selectGeography(document, 'Postal code (CAP)', '95121');
    await waitFor(() => capList.called && capMap.called && inverseList.called && inverseMap.called && !geographyField(document, 'Postal code (CAP)').disabled, 'CAP selection applies auto-filled city and province to both list and map');
    assert.equal(geographyField(document, 'City').value, JSON.stringify('Catania'));
    assert.equal(geographyField(document, 'Province').value, JSON.stringify('CT'));
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries/map').at(-1)?.search, '?view=inbox&city=Catania&province=CT&postalCode=95121');
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').at(-1)?.search, '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    assert.equal(api.calls.some((call) => /google|geocod|routes/.test(call.pathname)), false);
    assert.equal(document.querySelector('script[src*="maps.googleapis.com"]'), null);
  } finally { await page.close(); }
});

void test('map delivery actions open the existing details panel and its nearby work without a mutation', async () => {
  const api = new ApiFixture();
  api.list = listData();
  mapReply(api, '', mapData([1, 2], [3]));
  api.defer('/routes').reply({ drafts: [], points: [] });
  api.defer('/routes/jobs', 'GET', `?anchorId=${deliveryId}&radiusKm=10`).reply({ jobs: [], anchorJob: null, anchorHasCoordinates: false });
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox list');
    await click(button(document, 'Map'));
    await waitFor(() => document.querySelector('button[aria-label="Open DEMO/MAP/01"]') !== null, 'map delivery action');
    await click(openButton(document, 'DEMO/MAP/01'));
    await waitFor(() => document.querySelector('.delivery-panel') !== null && document.querySelector('textarea[name="notes"]') !== null, 'existing delivery panel');
    assert.match(document.querySelector('.delivery-panel')?.textContent ?? '', /Nearby work/);
    await waitFor(() => api.calls.some((call) => call.pathname === '/routes/jobs' && call.search.includes(`anchorId=${deliveryId}`)), 'nearby selection follows the map delivery');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    assert.equal(button(page.container, 'Map').getAttribute('aria-pressed'), 'true');
  } finally { await page.close(); }
});

void test('a changed map query blocks old data and ignores an aborted response that arrives after the latest result', async () => {
  const api = new ApiFixture();
  mapReply(api, '', mapData([1]));
  const page = await domHarness(api);
  const opened: string[] = [];
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const onOpen = (delivery: string) => { opened.push(delivery); };
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('button[aria-label="Open DEMO/MAP/01"]') !== null, 'first map result');
    const older = api.defer('/deliveries/map', 'GET', '?view=inbox&city=Catania');
    await page.render(createElement(InboxDeliveryMap, { query: 'city=Catania', refreshKey: 0, visible: true, onOpen }));
    await waitFor(() => older.called, 'older map search');
    const oldAction = document.querySelector('button[aria-label="Open DEMO/MAP/01"]');
    assert.ok(oldAction instanceof HTMLButtonElement);
    assert.ok(oldAction.disabled || oldAction.closest('[inert]'), 'Old filter results must be inactive while the map query changes');
    const latest = mapReply(api, 'city=Messina', mapData([2]));
    await page.render(createElement(InboxDeliveryMap, { query: 'city=Messina', refreshKey: 0, visible: true, onOpen }));
    await waitFor(() => latest.called && document.querySelector('button[aria-label="Open DEMO/MAP/02"]') !== null, 'latest map result');
    await act(async () => { older.reply(mapData([3])); });
    await settle();
    assert.equal(document.querySelector('button[aria-label="Open DEMO/MAP/03"]'), null);
    assert.equal(api.calls.find((call) => call.search === '?view=inbox&city=Catania')?.signal?.aborted, true);
    await click(openButton(document, 'DEMO/MAP/02'));
    assert.deepEqual(opened, [id(2)]);
  } finally { await page.close(); }
});

void test('map refresh and List/Map visibility preserve the canvas and expanded delivery list while updating data', async () => {
  const api = new ApiFixture();
  mapReply(api, '', mapData([1, 2]));
  const page = await domHarness(api);
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const onOpen = () => undefined;
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('button[aria-label="Open DEMO/MAP/02"]') !== null, 'map result');
    const list = openButton(document, 'DEMO/MAP/02').closest('details');
    assert.ok(list);
    const listBody = list.querySelector('ul');
    assert.ok(listBody);
    list.open = true;
    listBody.scrollTop = 98;
    await waitFor(() => document.querySelector('.inbox-leaflet-map') !== null, 'map canvas');
    const canvas = document.querySelector('.inbox-leaflet-map');
    const response = api.defer('/deliveries/map', 'GET', '?view=inbox');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 1, visible: true, onOpen }));
    await waitFor(() => response.called, 'map refresh');
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(openButton(document, 'DEMO/MAP/02').closest('details'), list);
    assert.equal(list.open, true);
    assert.equal(listBody.scrollTop, 98);
    await act(async () => { response.reply(mapData([1, 2, 3])); });
    await waitFor(() => document.querySelector('button[aria-label="Open DEMO/MAP/03"]') !== null, 'new map data');
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(list.open, true);
    assert.equal(listBody.scrollTop, 98);
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 1, visible: false, onOpen }));
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(list.isConnected, true);
    mapReply(api, '', mapData([1, 2, 3]));
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 1, visible: true, onOpen }));
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(list.open, true);
    assert.equal(listBody.scrollTop, 98);
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('deliveries without coordinates remain accessible and a map API failure can be retried into an empty result', async () => {
  const api = new ApiFixture();
  mapReply(api, '', mapData([], [1, 2]));
  const page = await domHarness(api);
  const opened: string[] = [];
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const onOpen = (delivery: string) => { opened.push(delivery); };
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen }));
    const document = page.dom.window.document;
    await waitFor(() => document.body.textContent?.includes('These deliveries have no coordinates') === true, 'all deliveries missing coordinates');
    assert.match(document.body.textContent ?? '', /Without coordinates/);
    assert.match(document.body.textContent ?? '', /0 of 2 deliveries on the map/);
    await click(openButton(document, 'DEMO/MAP/02'));
    assert.deepEqual(opened, [id(2)]);
    const existing = openButton(document, 'DEMO/MAP/01');
    const failed = api.defer('/deliveries/map', 'GET', '?view=inbox');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 1, visible: true, onOpen }));
    await waitFor(() => failed.called, 'map refresh request');
    await act(async () => { failed.reply({ message: 'Synthetic map API unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic map API unavailable') === true, 'map failure shown');
    assert.equal(openButton(document, 'DEMO/MAP/01'), existing);
    assert.match(document.body.textContent ?? '', /Showing the last loaded data/);
    const retry = mapReply(api, '', mapData([]));
    await click(button(document, 'Retry map'));
    await waitFor(() => retry.called && document.body.textContent?.includes('No deliveries match these filters') === true, 'successful retry with no matches');
    assert.equal(document.querySelector('button[aria-label="Open DEMO/MAP/01"]'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /Synthetic map API unavailable/);
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('a hidden map does not fetch and an in-flight response from a previous visibility session is ignored', async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const onOpen = () => undefined;
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: false, onOpen }));
    assert.equal(api.calls.length, 0);
    const older = api.defer('/deliveries/map', 'GET', '?view=inbox');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen }));
    await waitFor(() => older.called, 'visible map request');
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: false, onOpen }));
    assert.equal(api.calls[0]?.signal?.aborted, true);
    await act(async () => { older.reply(mapData([1])); });
    await settle();
    assert.equal(page.dom.window.document.querySelector('button[aria-label="Open DEMO/MAP/01"]'), null);
    const latest = mapReply(api, '', mapData([2]));
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen }));
    await waitFor(() => latest.called && page.dom.window.document.querySelector('button[aria-label="Open DEMO/MAP/02"]') !== null, 'fresh result after showing map');
    assert.equal(page.dom.window.document.querySelector('button[aria-label="Open DEMO/MAP/01"]'), null);
  } finally { await page.close(); }
});

void test('visible-area selection is explicit, keeps an empty map available and can be cleared after a failed Refresh', async (context) => {
  const api = new ApiFixture();
  mapReply(api, '', mapData([1, 2], [3]));
  const page = await domHarness(api);
  const selected: (InboxMapArea | null)[] = [];
  try {
    context.mock.getter(page.dom.window.HTMLElement.prototype, 'clientWidth', function (this: HTMLElement) { return this.classList.contains('inbox-leaflet-map') ? 640 : 0; });
    context.mock.getter(page.dom.window.HTMLElement.prototype, 'clientHeight', function (this: HTMLElement) { return this.classList.contains('inbox-leaflet-map') ? 420 : 0; });
    const { InboxDeliveryMap } = await import('../src/components/inbox-delivery-map');
    const onOpen = () => undefined;
    const onAreaChange = (area: InboxMapArea | null) => { selected.push(area); };
    await page.render(createElement(InboxDeliveryMap, { query: '', refreshKey: 0, visible: true, onOpen, onAreaChange }));
    const document = page.dom.window.document;
    await waitFor(() => Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent === 'Use visible area' && !entry.disabled), 'area action waits for the map');
    const canvas = document.querySelector('.inbox-leaflet-map');
    assert.ok(canvas);
    const callsBeforeMove = api.calls.length;
    await click(button(document, '+'));
    await settle();
    assert.equal(api.calls.length, callsBeforeMove, 'zooming does not implicitly refilter');
    assert.equal(selected.length, 0);
    await click(button(document, 'Use visible area'));
    const area = selected[0];
    assert.ok(area);
    assert.ok(area.north > area.south && area.east > area.west);
    assert.equal(api.calls.length, callsBeforeMove, 'the parent owns shared List/Map filters');
    const query = new URLSearchParams();
    appendInboxMapArea(query, area);
    const empty = mapReply(api, query.toString(), mapData([], [], { bounds: area, excludedMissingCoordinates: 1 }));
    const props = { query: query.toString(), refreshKey: 0, visible: true, onOpen, onAreaChange, area };
    await page.render(createElement(InboxDeliveryMap, props));
    await waitFor(() => empty.called && document.body.textContent?.includes('No deliveries match these filters') === true, 'empty selected area');
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    assert.equal(canvas.closest('[hidden]'), null, 'an empty selected area still permits moving the map and selecting another area');
    assert.match(document.body.textContent ?? '', /1 matching deliveries without usable coordinates are excluded/);
    assert.equal(button(document, 'Use visible area').disabled, false);
    await page.render(createElement(InboxDeliveryMap, { ...props, visible: false }));
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
    mapReply(api, query.toString(), mapData([], [], { bounds: area, excludedMissingCoordinates: 1 }));
    await page.render(createElement(InboxDeliveryMap, props));
    await waitFor(() => !button(document, 'Use visible area').disabled, 'same selected area after List/Map switch');
    assert.equal(selected.length, 1);
    const failure = api.defer('/deliveries/map', 'GET', `?view=inbox&${query.toString()}`);
    await page.render(createElement(InboxDeliveryMap, { ...props, refreshKey: 1 }));
    await waitFor(() => failure.called, 'area Refresh');
    assert.equal(button(document, 'Use visible area').disabled, true, 'a pending snapshot cannot select bounds');
    await act(async () => { failure.reply({ message: 'Synthetic area query failure' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic area query failure') === true, 'failed area Refresh');
    assert.equal(button(document, 'Use visible area').disabled, true, 'failed data must not be presented as a current map');
    assert.equal(button(document, 'Clear area').disabled, false);
    await click(button(document, 'Clear area'));
    assert.deepEqual(selected, [area, null]);
    assert.equal(document.querySelector('.inbox-leaflet-map'), canvas);
  } finally { await page.close(); }
});
