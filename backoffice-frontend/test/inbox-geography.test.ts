import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, listFixture, settle, waitFor } from './refresh-fixtures';

const facets = {
  cities: [{ value: 'Catania', count: 15 }, { value: 'Messina', count: 10 }, { value: null, count: 1 }],
  provinces: [{ value: 'CT', count: 14 }, { value: 'ME', count: 9 }, { value: null, count: 3 }],
  postalCodes: [{ value: '00100', count: 1 }, { value: '95121', count: 11 }, { value: '95122', count: 3 }, { value: '98100', count: 9 }, { value: null, count: 2 }],
};

const facetsByContext = {
  all: facets,
  catania: { cities: facets.cities, provinces: [{ value: 'CT', count: 14 }, { value: null, count: 1 }], postalCodes: [{ value: '95121', count: 11 }, { value: '95122', count: 3 }, { value: null, count: 1 }] },
  cataniaCt: { cities: facets.cities, provinces: [{ value: 'CT', count: 14 }, { value: null, count: 1 }], postalCodes: [{ value: '95121', count: 11 }, { value: '95122', count: 3 }] },
  messina: { cities: facets.cities, provinces: [{ value: 'ME', count: 9 }, { value: null, count: 1 }], postalCodes: [{ value: '98100', count: 9 }, { value: null, count: 1 }] },
  missingProvince: { cities: facets.cities, provinces: facets.provinces, postalCodes: [{ value: '00100', count: 1 }, { value: null, count: 2 }] },
};

function deliveries(name = 'DEMO/GEOGRAPHY', page = 1, total = 26, context: keyof typeof facetsByContext = 'all') {
  const list = listFixture(name);
  return deliveryListSchema.parse({
    ...list, page, total, counts: { ...list.counts, inbox: 26 }, geographyFacets: facetsByContext[context],
    items: total === 0 ? [] : list.items.map((delivery) => ({
      ...delivery,
      source: { ...delivery.source, customer: { ...delivery.source.customer, city: 'Catania' } },
      geography: { city: 'Catania', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' },
    })),
  });
}

function soleOptionDeliveries(name: string, city = 'Catania', province = 'CT', postalCode = '00100') {
  const data = deliveries(name, 1, 2);
  data.geographyFacets = {
    cities: [{ value: 'Catania', count: 2 }, { value: 'Messina', count: 2 }],
    provinces: [{ value: province, count: 2 }], postalCodes: [{ value: postalCode, count: 2 }],
  };
  data.matchingGeographyFacets = {
    cities: [{ value: city, count: 2 }], provinces: [{ value: province, count: 2 }], postalCodes: [{ value: postalCode, count: 2 }],
  };
  data.items = data.items.map((delivery) => ({ ...delivery,
    source: { ...delivery.source, customer: { ...delivery.source.customer, city } },
    geography: { city, province, postalCode, source: 'synthetic_fixture' },
  }));
  return data;
}

function field(document: Document, label: string): HTMLSelectElement {
  const control = Array.from(document.querySelectorAll('label'))
    .find((entry) => entry.firstElementChild?.textContent === label)?.querySelector('select');
  assert.ok(control instanceof HTMLSelectElement, `Missing labelled geography filter: ${label}`);
  return control;
}

async function select(control: HTMLSelectElement, value: string) {
  assert.equal(control.disabled, false);
  const option = Array.from(control.options).find((entry) => entry.value === value || entry.value === JSON.stringify(value));
  assert.ok(option, `Missing filter option: ${value}`);
  await act(async () => { control.value = option.value; control.dispatchEvent(new Event('change', { bubbles: true })); });
}

function reply(api: ApiFixture, search: string, value = deliveries()) {
  const response = api.defer('/deliveries', 'GET', search);
  response.reply(value);
  return response;
}

function viewButton(document: Document, label: string): HTMLButtonElement {
  const control = Array.from(document.querySelectorAll('nav[aria-label="Delivery views"] button'))
    .find((candidate) => candidate.textContent?.includes(label));
  assert.ok(control instanceof HTMLButtonElement);
  return control;
}

void test('Inbox geography keeps all cities, uses hierarchical child facets, and resets pagination when filtering or clearing', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox deliveries');
    const city = field(document, 'City');
    const province = field(document, 'Province');
    const postalCode = field(document, 'Postal code (CAP)');
    assert.ok(Array.from(city.options).some((option) => option.value === JSON.stringify('Messina')), 'A city absent from this page is still available from server facets');
    assert.ok(Array.from(postalCode.options).some((option) => option.value === JSON.stringify('00100')), 'Postal codes retain leading zeroes');

    reply(api, '?view=inbox&page=2', deliveries('DEMO/PAGE2', 2));
    await click(button(document, 'Next'));
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/PAGE2') === true, 'second page');
    const cityRequest = reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/CITY', 1, 15, 'catania'));
    await select(city, 'Catania');
    await waitFor(() => cityRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CITY') === true, 'city filter starts at page one');
    assert.deepEqual(Array.from(province.options, (option) => option.value), ['', JSON.stringify('CT'), 'null']);
    assert.deepEqual(Array.from(postalCode.options, (option) => option.value), ['', JSON.stringify('95121'), JSON.stringify('95122'), 'null']);
    const provinceRequest = reply(api, '?view=inbox&page=1&city=Catania&province=CT', deliveries('DEMO/PROVINCE', 1, 14, 'cataniaCt'));
    await select(province, 'CT');
    await waitFor(() => provinceRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/PROVINCE') === true, 'combined province filter');
    const capRequest = reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121', deliveries('DEMO/CAP', 1, 11, 'cataniaCt'));
    await select(postalCode, '95121');
    await waitFor(() => capRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CAP') === true, 'all three filters');
    assert.match(document.querySelector('.delivery-table')?.textContent ?? '', /CT/);
    assert.match(document.querySelector('.delivery-table')?.textContent ?? '', /95121/);
    assert.equal(field(document, 'City'), city);
    assert.equal(field(document, 'Province'), province);
    assert.equal(field(document, 'Postal code (CAP)'), postalCode);
    reply(api, '?view=inbox&page=2&city=Catania&province=CT&postalCode=95121', deliveries('DEMO/FILTERED-PAGE2', 2, 11, 'cataniaCt'));
    await click(button(document, 'Next'));
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/FILTERED-PAGE2') === true, 'pagination retains combined criteria');
    const clearRequest = reply(api, '?view=inbox&page=1', deliveries('DEMO/CLEARED'));
    await click(button(document, 'Clear filters'));
    await waitFor(() => clearRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CLEARED') === true, 'clear filters returns page one');
    assert.equal(city.value, '');
    assert.equal(province.value, '');
    assert.equal(postalCode.value, '');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    assert.equal(api.calls.some((call) => call.pathname.includes('routes') || call.pathname.includes('google')), false);
  } finally { await page.close(); }
});

void test('changing a geographic filter ignores an older response even if it arrives after the latest empty result', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox data');
    const city = field(document, 'City');
    const older = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await select(city, 'Catania');
    await waitFor(() => older.called, 'older request');
    const latest = reply(api, '?view=inbox&page=1&city=Messina', deliveries('DEMO/LATEST', 1, 0, 'messina'));
    await select(city, 'Messina');
    await waitFor(() => latest.called && document.querySelector('.delivery-table') === null, 'latest empty result');
    await act(async () => { older.reply(deliveries('DEMO/STALE', 1, 15, 'catania')); });
    await settle();
    assert.equal(city.value, JSON.stringify('Messina'));
    assert.equal(document.querySelector('.delivery-table'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /DEMO\/STALE/);
    assert.equal(api.calls.find((call) => call.search === '?view=inbox&page=1&city=Catania')?.signal?.aborted, true);
    assert.ok(Array.from(city.options).some((option) => option.value === JSON.stringify('Catania')), 'An empty result must not erase full-view filter choices');
  } finally { await page.close(); }
});

void test('missing geography uses explicit missing flags and a leading-zero postal code stays text', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox data');
    const province = field(document, 'Province');
    const missing = Array.from(province.options).find((option) => option.textContent === 'Not provided (3)');
    assert.ok(missing);
    const missingRequest = reply(api, '?view=inbox&page=1&provinceMissing=true', deliveries('DEMO/MISSING', 1, 3, 'missingProvince'));
    await select(province, missing.value);
    await waitFor(() => missingRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/MISSING') === true, 'missing province filter');
    const combined = reply(api, '?view=inbox&page=1&provinceMissing=true&postalCode=00100', deliveries('DEMO/ZERO-CAP', 1, 1, 'missingProvince'));
    await select(field(document, 'Postal code (CAP)'), '00100');
    await waitFor(() => combined.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/ZERO-CAP') === true, 'string postal code filter');
    const call = api.calls.find((entry) => entry.search.includes('postalCode=00100'));
    assert.ok(call);
    const params = new URLSearchParams(call.search);
    assert.equal(params.get('postalCode'), '00100');
    assert.equal(params.get('provinceMissing'), 'true');
    assert.equal(params.has('province'), false);
    const cityRequest = reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/CLEAR-MISSING', 1, 15, 'catania'));
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => cityRequest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CLEAR-MISSING') === true, 'city selection clears a missing province and CAP');
    assert.equal(province.value, '');
    assert.equal(field(document, 'Postal code (CAP)').value, '');
  } finally { await page.close(); }
});

void test('filtered refresh preserves selectors, table, open delivery details, notes and scroll on success and failure', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox data');
    const city = field(document, 'City');
    reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/FILTERED', 1, 15, 'catania'));
    await select(city, 'Catania');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/FILTERED') === true, 'filtered result');
    const table = document.querySelector('.delivery-table');
    const row = table?.querySelector('tbody tr');
    assert.ok(table);
    assert.ok(row);
    api.defer('/routes').reply({ drafts: [], points: [] });
    api.defer('/routes/jobs').reply({ jobs: [], anchorJob: null, anchorHasCoordinates: false });
    await click(button(table, 'DEMO/FILTERED'));
    await waitFor(() => document.querySelector('textarea[name="notes"]') !== null, 'opened delivery instructions');
    const panel = document.querySelector('.delivery-panel');
    const panelBody = document.querySelector('.panel-body');
    const notes = document.querySelector('textarea[name="notes"]');
    assert.ok(panel);
    assert.ok(panelBody instanceof HTMLElement);
    assert.ok(notes instanceof HTMLTextAreaElement);
    await act(async () => { notes.value = 'Unsaved operator note'; notes.dispatchEvent(new Event('input', { bubbles: true })); });
    panelBody.scrollTop = 235;
    const pending = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await click(button(page.container, '↻ Refresh'));
    assert.equal(pending.called, true);
    assert.equal(field(document, 'City'), city);
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.equal(table.querySelector('tbody tr'), row);
    assert.equal(document.querySelector('.delivery-panel'), panel);
    assert.equal(document.querySelector('textarea[name="notes"]'), notes);
    assert.equal(notes.value, 'Unsaved operator note');
    assert.equal(panelBody.scrollTop, 235);
    await act(async () => { pending.reply(deliveries('DEMO/REFRESHED', 1, 15, 'catania')); });
    await waitFor(() => table.textContent?.includes('DEMO/REFRESHED') === true, 'filtered refresh result');
    assert.equal(table.querySelector('tbody tr'), row);
    assert.equal(document.querySelector('.delivery-panel'), panel);
    assert.equal(notes.value, 'Unsaved operator note');
    assert.equal(panelBody.scrollTop, 235);
    const failure = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await click(button(page.container, '↻ Refresh'));
    await act(async () => { failure.reply({ message: 'Synthetic geography refresh failed' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic geography refresh failed') === true, 'refresh failure');
    assert.equal(field(document, 'City'), city);
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.equal(document.querySelector('.delivery-panel'), panel);
    assert.equal(notes.value, 'Unsaved operator note');
    assert.equal(panelBody.scrollTop, 235);
  } finally { await page.close(); }
});

void test('Inbox geography choices do not filter other views and are restored when returning to Inbox', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox data');
    reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/INBOX', 1, 15, 'catania'));
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/INBOX') === true, 'filtered Inbox');
    const planned = reply(api, '?view=planned&page=1', deliveries('DEMO/PLANNED', 1, 1));
    await click(viewButton(document, 'Planned'));
    await waitFor(() => planned.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/PLANNED') === true, 'unfiltered Planned view');
    assert.equal(field(document, 'City').value, '');
    const inbox = reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/RETURNED', 1, 15, 'catania'));
    await click(viewButton(document, 'Inbox to plan'));
    await waitFor(() => inbox.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/RETURNED') === true, 'restored Inbox');
    assert.equal(field(document, 'City').value, JSON.stringify('Catania'));
    assert.equal(api.calls.some((call) => call.search.startsWith('?view=planned') && call.search.includes('city=')), false);
  } finally { await page.close(); }
});

void test('a selected city that disappears from refreshed facets remains visible and can be cleared', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox data');
    const city = field(document, 'City');
    reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/SELECTED', 1, 15, 'catania'));
    await select(city, 'Catania');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/SELECTED') === true, 'selected city');
    const changed = deliveries('DEMO/EMPTY', 1, 0);
    changed.geographyFacets = { cities: [{ value: 'Messina', count: 10 }], provinces: [], postalCodes: [] };
    const refresh = reply(api, '?view=inbox&page=1&city=Catania', changed);
    await click(button(document, '↻ Refresh'));
    await waitFor(() => refresh.called && document.querySelector('.delivery-table') === null, 'updated empty geography');
    assert.equal(field(document, 'City'), city);
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(city.selectedOptions[0]?.textContent, 'Catania (0)', 'The active filter cannot silently revert to All cities');
    const cleared = reply(api, '?view=inbox&page=1', deliveries('DEMO/CLEAR-STALE'));
    await click(button(document, 'Clear filters'));
    await waitFor(() => cleared.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CLEAR-STALE') === true, 'cleared vanished facet');
    assert.equal(city.value, '');
  } finally { await page.close(); }
});

void test('changing city clears selected province and CAP immediately and hides obsolete child choices until the response', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial Inbox');
    const city = field(document, 'City');
    const province = field(document, 'Province');
    const cap = field(document, 'Postal code (CAP)');
    reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/CATANIA', 1, 15, 'catania'));
    await select(city, 'Catania');
    await waitFor(() => !province.disabled, 'Catania province choices');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT', deliveries('DEMO/CT', 1, 14, 'cataniaCt'));
    await select(province, 'CT');
    await waitFor(() => !cap.disabled, 'CT postal choices');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121', deliveries('DEMO/CT-CAP', 1, 11, 'cataniaCt'));
    await select(cap, '95121');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CT-CAP') === true, 'selected child filters');

    const pending = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Messina');
    await select(city, 'Messina');
    assert.equal(city.disabled, false, 'City remains available while dependent filters load');
    assert.equal(province.value, '');
    assert.equal(cap.value, '');
    assert.equal(province.disabled, true);
    assert.equal(cap.disabled, true);
    assert.deepEqual(Array.from(province.options, (option) => option.value), ['']);
    assert.deepEqual(Array.from(cap.options, (option) => option.value), ['']);
    await waitFor(() => pending.called, 'Messina request without old descendants');
    await act(async () => { pending.reply(deliveries('DEMO/MESSINA', 1, 10, 'messina')); });
    await waitFor(() => !province.disabled && !cap.disabled, 'Messina child choices');
    assert.deepEqual(Array.from(province.options, (option) => option.value), ['', JSON.stringify('ME'), 'null']);
    assert.deepEqual(Array.from(cap.options, (option) => option.value), ['', JSON.stringify('98100'), 'null']);
    assert.equal(field(document, 'Province'), province);
    assert.equal(field(document, 'Postal code (CAP)'), cap);

    const clear = api.defer('/deliveries', 'GET', '?view=inbox&page=1');
    await click(button(document, 'Clear filters'));
    assert.equal(city.value, '');
    assert.equal(province.disabled, true);
    assert.equal(cap.disabled, true);
    await act(async () => { clear.reply(deliveries('DEMO/CLEARED')); });
    await waitFor(() => !province.disabled && !cap.disabled, 'all child choices after clearing');
    assert.ok(Array.from(province.options).some((option) => option.value === JSON.stringify('CT')));
    assert.ok(Array.from(province.options).some((option) => option.value === JSON.stringify('ME')));
  } finally { await page.close(); }
});

void test('changing province clears CAP while a refresh in the same parent context preserves available options and selection', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial Inbox');
    const city = field(document, 'City');
    const province = field(document, 'Province');
    const cap = field(document, 'Postal code (CAP)');
    reply(api, '?view=inbox&page=1&city=Catania', deliveries('DEMO/CATANIA', 1, 15, 'catania'));
    await select(city, 'Catania');
    await waitFor(() => !province.disabled, 'Catania options');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT', deliveries('DEMO/CT', 1, 14, 'cataniaCt'));
    await select(province, 'CT');
    await waitFor(() => !cap.disabled, 'CT options');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121', deliveries('DEMO/CAP', 1, 11, 'cataniaCt'));
    await select(cap, '95121');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/CAP') === true, 'CAP result');

    const provinceChange = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await select(province, '');
    assert.equal(city.value, JSON.stringify('Catania'));
    assert.equal(province.disabled, false, 'Changing province does not invalidate the unchanged city context');
    assert.equal(cap.value, '');
    assert.equal(cap.disabled, true);
    assert.deepEqual(Array.from(cap.options, (option) => option.value), ['']);
    await act(async () => { provinceChange.reply(deliveries('DEMO/CITY-ONLY', 1, 15, 'catania')); });
    await waitFor(() => !cap.disabled, 'city-only postal choices');
    reply(api, '?view=inbox&page=1&city=Catania&postalCode=95122', deliveries('DEMO/OTHER-CAP', 1, 3, 'catania'));
    await select(cap, '95122');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/OTHER-CAP') === true, 'new CAP result');

    const options = Array.from(cap.options);
    const refresh = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania&postalCode=95122');
    await click(button(document, '↻ Refresh'));
    assert.equal(city.disabled, false);
    assert.equal(province.disabled, false);
    assert.equal(cap.disabled, false);
    assert.equal(cap.value, JSON.stringify('95122'));
    assert.deepEqual(Array.from(cap.options), options);
    await act(async () => { refresh.reply({ message: 'Synthetic same-context refresh failure' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic same-context refresh failure') === true, 'same-context failure');
    assert.equal(cap.disabled, false);
    assert.equal(cap.value, JSON.stringify('95122'));
    assert.deepEqual(Array.from(cap.options), options);
  } finally { await page.close(); }
});

void test('stale successes and a failed new city request cannot re-enable child options from the wrong context', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial Inbox');
    const city = field(document, 'City');
    const province = field(document, 'Province');
    const cap = field(document, 'Postal code (CAP)');
    const older = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await select(city, 'Catania');
    await waitFor(() => older.called, 'older city request');
    const newer = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Messina');
    await select(city, 'Messina');
    await waitFor(() => newer.called, 'newer city request');
    await act(async () => { older.reply(deliveries('DEMO/STALE-CATANIA', 1, 15, 'catania')); });
    await settle();
    assert.equal(province.disabled, true);
    assert.equal(cap.disabled, true);
    assert.deepEqual(Array.from(province.options, (option) => option.value), ['']);
    assert.deepEqual(Array.from(cap.options, (option) => option.value), ['']);
    await act(async () => { newer.reply({ message: 'Synthetic new-context failure' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic new-context failure') === true, 'new city failure');
    assert.equal(city.disabled, false);
    assert.equal(city.value, JSON.stringify('Messina'));
    assert.equal(province.disabled, true);
    assert.equal(cap.disabled, true);
    const retry = reply(api, '?view=inbox&page=1&city=Messina', deliveries('DEMO/RETRY-MESSINA', 1, 10, 'messina'));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => retry.called && !province.disabled && !cap.disabled, 'correct context retry');
    assert.deepEqual(Array.from(province.options, (option) => option.value), ['', JSON.stringify('ME'), 'null']);
    assert.deepEqual(Array.from(cap.options, (option) => option.value), ['', JSON.stringify('98100'), 'null']);
    assert.doesNotMatch(document.querySelector('.delivery-table')?.textContent ?? '', /STALE-CATANIA/);
  } finally { await page.close(); }
});

void test('an explicit city choice selects its sole known province and CAP, while initial load, manual All, Refresh and Clear do not', async () => {
  const api = new ApiFixture();
  const initial = soleOptionDeliveries('DEMO/INITIAL-SOLE');
  assert.ok(initial.geographyFacets);
  initial.geographyFacets.cities = [{ value: 'Catania', count: 2 }];
  api.list = initial;
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'sole-option initial data');
    const city = field(document, 'City');
    const province = field(document, 'Province');
    const cap = field(document, 'Postal code (CAP)');
    assert.deepEqual([city.value, province.value, cap.value], ['', '', '']);
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').length, 1);
    reply(api, '?view=inbox&page=1&city=Catania', soleOptionDeliveries('DEMO/AUTO-SOURCE'));
    const automatic = reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=00100', soleOptionDeliveries('DEMO/AUTO-SELECTED'));
    await select(city, 'Catania');
    await waitFor(() => automatic.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/AUTO-SELECTED') === true, 'one automatic follow-up');
    assert.deepEqual([province.value, cap.value], [JSON.stringify('CT'), JSON.stringify('00100')]);
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').length, 3);

    const allCaps = reply(api, '?view=inbox&page=1&city=Catania&province=CT', soleOptionDeliveries('DEMO/MANUAL-ALL-CAP'));
    await select(cap, '');
    await waitFor(() => allCaps.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/MANUAL-ALL-CAP') === true, 'manual All CAP');
    assert.equal(cap.value, '');
    const allProvinces = reply(api, '?view=inbox&page=1&city=Catania', soleOptionDeliveries('DEMO/MANUAL-ALL-PROVINCE'));
    await select(province, '');
    await waitFor(() => allProvinces.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/MANUAL-ALL-PROVINCE') === true, 'manual All province');
    assert.deepEqual([province.value, cap.value], ['', '']);
    const refresh = reply(api, '?view=inbox&page=1&city=Catania', soleOptionDeliveries('DEMO/REFRESH-SOLE'));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => refresh.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/REFRESH-SOLE') === true, 'same-context refresh');
    assert.deepEqual([province.value, cap.value], ['', '']);
    const cleared = reply(api, '?view=inbox&page=1', initial);
    await click(button(document, 'Clear filters'));
    await waitFor(() => cleared.called && city.value === '' && !province.disabled, 'clear sole options');
    assert.deepEqual([city.value, province.value, cap.value], ['', '', '']);
  } finally { await page.close(); }
});

void test('city selection auto-selects a sole province but leaves multiple CAP choices, and explicit province selection can auto-select its sole CAP', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    const multipleCaps = soleOptionDeliveries('DEMO/MULTIPLE-CAPS');
    assert.ok(multipleCaps.geographyFacets);
    multipleCaps.geographyFacets.postalCodes = [{ value: '00100', count: 1 }, { value: '00101', count: 1 }];
    assert.ok(multipleCaps.matchingGeographyFacets);
    multipleCaps.matchingGeographyFacets.postalCodes = multipleCaps.geographyFacets.postalCodes;
    reply(api, '?view=inbox&page=1&city=Catania', multipleCaps);
    const autoProvince = reply(api, '?view=inbox&page=1&city=Catania&province=CT', multipleCaps);
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => autoProvince.called && !field(document, 'Postal code (CAP)').disabled, 'sole province follow-up');
    assert.equal(field(document, 'Province').value, JSON.stringify('CT'));
    assert.equal(field(document, 'Postal code (CAP)').value, '');
    reply(api, '?view=inbox&page=1&city=Catania', multipleCaps);
    await select(field(document, 'Province'), '');
    await waitFor(() => !field(document, 'Postal code (CAP)').disabled, 'manual All province settled');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT', soleOptionDeliveries('DEMO/ONE-CAP-NOW'));
    const autoCap = reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=00100', soleOptionDeliveries('DEMO/PROVINCE-AUTO-CAP'));
    await select(field(document, 'Province'), 'CT');
    await waitFor(() => autoCap.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/PROVINCE-AUTO-CAP') === true, 'explicit province automatic CAP');
    assert.equal(field(document, 'Postal code (CAP)').value, JSON.stringify('00100'));
  } finally { await page.close(); }
});

void test('automatic selection follows only the current explicit parent intent and can recover after that request fails', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    const old = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania');
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => old.called, 'old city request');
    reply(api, '?view=inbox&page=1&city=Messina', soleOptionDeliveries('DEMO/MESSINA-SOLE', 'Messina', 'ME', '98100'));
    const latest = reply(api, '?view=inbox&page=1&city=Messina&province=ME&postalCode=98100', soleOptionDeliveries('DEMO/LATEST-AUTO', 'Messina', 'ME', '98100'));
    await select(field(document, 'City'), 'Messina');
    await waitFor(() => latest.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/LATEST-AUTO') === true, 'latest auto selection');
    await act(async () => { old.reply(soleOptionDeliveries('DEMO/STALE-AUTO')); });
    await settle();
    assert.deepEqual([field(document, 'Province').value, field(document, 'Postal code (CAP)').value], [JSON.stringify('ME'), JSON.stringify('98100')]);
    assert.equal(api.calls.some((call) => call.search === '?view=inbox&page=1&city=Catania&province=CT&postalCode=00100'), false);

    api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania').reply({ message: 'Synthetic parent lookup failure' }, 503);
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => document.body.textContent?.includes('Synthetic parent lookup failure') === true, 'failed explicit lookup');
    assert.equal(field(document, 'Province').disabled, true);
    reply(api, '?view=inbox&page=1&city=Catania', soleOptionDeliveries('DEMO/RETRY-SOURCE'));
    const retry = reply(api, '?view=inbox&page=1&city=Catania&province=CT&postalCode=00100', soleOptionDeliveries('DEMO/RETRY-AUTO'));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => retry.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/RETRY-AUTO') === true, 'retry preserves explicit selection intent');
    assert.deepEqual([field(document, 'Province').value, field(document, 'Postal code (CAP)').value], [JSON.stringify('CT'), JSON.stringify('00100')]);
  } finally { await page.close(); }
});

void test('automatic choices skip missing, zero-count and ambiguous facets without overriding a manual selection', async () => {
  const { selectSoleGeographyOptions } = await import('../src/components/inbox-geography-filters');
  const filters = { city: 'Catania' };
  for (const options of [
    [{ value: null, count: 2 }],
    [{ value: 'CT', count: 0 }],
    [{ value: 'CT', count: 1 }, { value: null, count: 1 }],
    [{ value: 'CT', count: 1 }, { value: 'ME', count: 1 }],
  ]) {
    assert.deepEqual(selectSoleGeographyOptions(filters, { cities: [], provinces: options, postalCodes: options }), filters);
  }
  const manual = { city: 'Catania', province: null, postalCode: '00999' };
  assert.deepEqual(selectSoleGeographyOptions(manual, { cities: [], provinces: [{ value: 'CT', count: 2 }], postalCodes: [{ value: '00100', count: 2 }] }), manual);
  assert.deepEqual(selectSoleGeographyOptions(filters, {
    cities: [], provinces: [{ value: 'CT', count: 1 }, { value: 'ME', count: 1 }], postalCodes: [{ value: '00100', count: 2 }],
  }), { city: 'Catania', postalCode: '00100' });
});

void test('choosing a province auto-selects the only matching city while retaining multiple CAP choices', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const provinceResult = soleOptionDeliveries('DEMO/PROVINCE-MATCH', 'Catania', 'CT', '95121');
  assert.ok(provinceResult.geographyFacets && provinceResult.matchingGeographyFacets);
  provinceResult.geographyFacets.provinces = [{ value: 'CT', count: 2 }, { value: 'ME', count: 2 }];
  provinceResult.geographyFacets.postalCodes = [{ value: '95121', count: 1 }, { value: '95122', count: 1 }];
  provinceResult.matchingGeographyFacets.cities = [{ value: 'CATANIA', count: 2 }];
  provinceResult.matchingGeographyFacets.postalCodes = provinceResult.geographyFacets.postalCodes;
  const finalResult = soleOptionDeliveries('DEMO/REVERSE-CITY', 'Catania', 'CT', '95121');
  assert.ok(finalResult.geographyFacets && finalResult.matchingGeographyFacets);
  finalResult.geographyFacets.postalCodes = provinceResult.geographyFacets.postalCodes;
  finalResult.matchingGeographyFacets.postalCodes = provinceResult.geographyFacets.postalCodes;
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    reply(api, '?view=inbox&page=1&province=CT', provinceResult);
    const automatic = reply(api, '?view=inbox&page=1&city=Catania&province=CT', finalResult);
    await select(field(document, 'Province'), 'CT');
    await waitFor(() => automatic.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/REVERSE-CITY') === true, 'province selects its city');
    assert.equal(field(document, 'City').value, JSON.stringify('Catania'));
    assert.equal(Array.from(field(document, 'City').options).filter((option) => option.value.toLowerCase() === JSON.stringify('catania')).length, 1);
    assert.equal(field(document, 'Province').value, JSON.stringify('CT'));
    assert.equal(field(document, 'Postal code (CAP)').value, '');
    assert.deepEqual(Array.from(field(document, 'Postal code (CAP)').options, (option) => option.value), ['', JSON.stringify('95121'), JSON.stringify('95122')]);
  } finally { await page.close(); }
});

void test('choosing CAP auto-selects matching city and province and keeps the chosen CAP visible during the follow-up', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    const cap = field(document, 'Postal code (CAP)');
    reply(api, '?view=inbox&page=1&postalCode=95121', soleOptionDeliveries('DEMO/CAP-MATCH', 'Catania', 'CT', '95121'));
    const automatic = api.defer('/deliveries', 'GET', '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121');
    await select(cap, '95121');
    await waitFor(() => automatic.called, 'CAP follow-up request');
    assert.equal(field(document, 'City').value, JSON.stringify('Catania'));
    assert.equal(field(document, 'Province').value, JSON.stringify('CT'));
    assert.equal(cap.value, JSON.stringify('95121'));
    assert.equal(cap.disabled, true);
    assert.ok(cap.selectedOptions[0]?.textContent?.includes('95121'));
    await act(async () => { automatic.reply(soleOptionDeliveries('DEMO/REVERSE-CAP', 'Catania', 'CT', '95121')); });
    await waitFor(() => !cap.disabled && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/REVERSE-CAP') === true, 'resolved CAP context');
    const allCaps = reply(api, '?view=inbox&page=1&city=Catania&province=CT', soleOptionDeliveries('DEMO/ALL-CAPS', 'Catania', 'CT', '95121'));
    await select(cap, '');
    await waitFor(() => allCaps.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/ALL-CAPS') === true, 'manual All CAP');
    reply(api, '?view=inbox&page=1&city=Catania&province=CT', soleOptionDeliveries('DEMO/REFRESH-ALL-CAPS', 'Catania', 'CT', '95121'));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/REFRESH-ALL-CAPS') === true, 'refresh manual All');
    assert.equal(cap.value, '');
  } finally { await page.close(); }
});

void test('matching ambiguity and missing matching metadata cannot infer city or province from dropdown options', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    const ambiguous = soleOptionDeliveries('DEMO/AMBIGUOUS-CAP', 'Catania', 'CT', '95121');
    ambiguous.matchingGeographyFacets = {
      cities: [{ value: 'Catania', count: 1 }, { value: 'Messina', count: 1 }],
      provinces: [{ value: 'CT', count: 1 }, { value: 'ME', count: 1 }], postalCodes: [{ value: '95121', count: 2 }],
    };
    reply(api, '?view=inbox&page=1&postalCode=95121', ambiguous);
    await select(field(document, 'Postal code (CAP)'), '95121');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/AMBIGUOUS-CAP') === true, 'ambiguous match');
    assert.equal(field(document, 'City').value, '');
    assert.equal(field(document, 'Province').value, '');
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').length, 2);
    const legacy = soleOptionDeliveries('DEMO/NO-MATCHING-METADATA');
    delete legacy.matchingGeographyFacets;
    reply(api, '?view=inbox&page=1&city=Catania', legacy);
    await select(field(document, 'City'), 'Catania');
    await waitFor(() => document.querySelector('.delivery-table')?.textContent?.includes('DEMO/NO-MATCHING-METADATA') === true, 'backwards-compatible response');
    assert.equal(field(document, 'Province').value, '');
    assert.equal(field(document, 'Postal code (CAP)').value, '');
    assert.equal(api.calls.filter((call) => call.pathname === '/deliveries').length, 3);
  } finally { await page.close(); }
});

void test('an outdated CAP response cannot auto-fill another selection, and the current failed lookup can be retried', async () => {
  const api = new ApiFixture();
  api.list = deliveries();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial data');
    const cap = field(document, 'Postal code (CAP)');
    const stale = api.defer('/deliveries', 'GET', '?view=inbox&page=1&postalCode=95121');
    await select(cap, '95121');
    await waitFor(() => stale.called, 'first CAP lookup');
    api.defer('/deliveries', 'GET', '?view=inbox&page=1&postalCode=98100').reply({ message: 'Synthetic CAP lookup failed' }, 503);
    await select(cap, '98100');
    await waitFor(() => document.body.textContent?.includes('Synthetic CAP lookup failed') === true, 'new CAP lookup failed');
    await act(async () => { stale.reply(soleOptionDeliveries('DEMO/STALE-CAP', 'Catania', 'CT', '95121')); });
    await settle();
    assert.equal(cap.value, JSON.stringify('98100'));
    assert.equal(field(document, 'City').value, '');
    assert.equal(field(document, 'Province').value, '');
    reply(api, '?view=inbox&page=1&postalCode=98100', soleOptionDeliveries('DEMO/RETRY-CAP', 'Messina', 'ME', '98100'));
    const automatic = reply(api, '?view=inbox&page=1&city=Messina&province=ME&postalCode=98100', soleOptionDeliveries('DEMO/RETRY-CAP-DONE', 'Messina', 'ME', '98100'));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => automatic.called && document.querySelector('.delivery-table')?.textContent?.includes('DEMO/RETRY-CAP-DONE') === true, 'current CAP retry auto-fills');
    assert.equal(field(document, 'City').value, JSON.stringify('Messina'));
    assert.equal(field(document, 'Province').value, JSON.stringify('ME'));
    assert.equal(cap.value, JSON.stringify('98100'));
    assert.equal(api.calls.some((call) => call.search === '?view=inbox&page=1&city=Catania&province=CT&postalCode=95121'), false);
  } finally { await page.close(); }
});
