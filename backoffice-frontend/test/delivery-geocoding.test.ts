import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryGeocodingSchema, entranceSuggestionFromGeocoding, type DeliveryGeocoding } from '../src/lib/delivery-geocoding';
import { inboxMapSchema } from '../src/lib/inbox-map';
import { importSchema } from '../src/lib/contracts';
import { en, it, ru, uz } from '../src/i18n/messages/geocoding';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, waitFor } from './refresh-fixtures';

const resource = `/deliveries/${deliveryId}/geocoding`;
const addressKey = '1'.repeat(64);
const candidate = {
  point: { latitude: 38.18, longitude: 15.55 }, formattedAddress: 'Test address <script>notHTML()</script>',
  precision: 'building' as const, confidence: 1, matchType: 'full_match', attribution: 'Test source <img src=x> · OpenStreetMap',
};
function record(overrides: Partial<DeliveryGeocoding> = {}): DeliveryGeocoding {
  return deliveryGeocodingSchema.parse({ provider: 'geoapify', configured: true, addressKey, deliveryVersion: 1,
    recordVersion: null, status: 'not_requested', reason: null, retryAt: null, candidate: null, acceptance: null, ...overrides });
}
function accepted() { return record({ status: 'accepted', recordVersion: 2, candidate, acceptance: 'automatic' }); }

void test('geocoding contracts preserve provenance and reject invalid or unversioned acceptance', () => {
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), provider: 'unknown' }).success, false);
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), candidate: null }).success, false);
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), recordVersion: null }).success, false);
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), acceptance: null }).success, false);
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), candidate: { ...candidate, point: { latitude: 100, longitude: 15 } } }).success, false);
  assert.equal(deliveryGeocodingSchema.safeParse({ ...accepted(), candidate: { ...candidate, confidence: 2 } }).success, false);
  const suggestion = entranceSuggestionFromGeocoding(accepted());
  assert.equal(suggestion.source, 'geoapify');
  assert.equal(suggestion.status, 'exact');
  assert.equal(entranceSuggestionFromGeocoding({ ...accepted(), acceptance: 'operator', candidate: { ...candidate, confidence: 0.6 } }).status, 'approximate');
  assert.equal(entranceSuggestionFromGeocoding(record({ status: 'review_required', recordVersion: 1, candidate: { ...candidate, precision: 'street', confidence: 0.7 } })).status, 'approximate');
  assert.equal(entranceSuggestionFromGeocoding(record()).point, null);
  const map = inboxMapSchema.parse({ total: 1, mappedCount: 1, missingCount: 0, missingCoordinates: [], markers: [{
    deliveryId, pickingName: 'TEST/01', orderNames: ['SO/01'], customerName: 'Test', address: 'Test address',
    geography: { city: 'Messina', province: 'ME', postalCode: '98100', source: 'odoo' }, point: candidate.point,
    pointSource: 'geocoded', geocoding: { provider: 'geoapify', precision: 'building', confidence: 1, attribution: candidate.attribution, acceptance: 'automatic' },
  }] });
  assert.equal(map.markers[0]?.geocoding?.acceptance, 'automatic');
});

void test('Locate saves through guarded API once, keeps input drafts and refreshes only saved location data', async () => {
  const api = new ApiFixture();
  api.defer(resource).reply(record());
  const lookup = api.defer(resource, 'POST');
  const page = await domHarness(api);
  let changed = 0;
  try {
    const { DeliveryGeocoding: Location } = await import('../src/components/delivery-geocoding');
    await page.render(createElement('div', null,
      createElement('input', { name: 'unsavedNote', defaultValue: 'Original note' }),
      createElement(Location, { deliveryId, revision: '1', onChanged: () => { changed += 1; } })));
    const doc = page.dom.window.document;
    await waitFor(() => !button(doc, 'Locate address').disabled, 'lookup ready');
    const note = doc.querySelector('input[name="unsavedNote"]');
    assert.ok(note instanceof HTMLInputElement);
    await editInput(note, 'Keep this unsaved note');
    await click(button(doc, 'Locate address'));
    assert.equal(button(doc, 'Locating…').disabled, true);
    await act(async () => { button(doc, 'Locating…').click(); });
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 1);
    assert.deepEqual(api.calls.find((call) => call.method === 'POST')?.body, { deliveryVersion: 1, addressKey });
    await act(async () => { lookup.reply(accepted()); });
    await waitFor(() => changed === 1 && doc.querySelector('.entrance-leaflet-map') !== null, 'saved point');
    assert.ok(doc.body.textContent?.includes(en.automatic));
    assert.ok(doc.body.textContent?.includes(candidate.formattedAddress));
    assert.ok(doc.body.textContent?.includes(candidate.attribution));
    assert.equal(doc.querySelector('section[aria-label="Address location"] script'), null);
    assert.equal(doc.querySelector('section[aria-label="Address location"] img[src="x"]'), null);
    assert.ok(doc.querySelector('a[href="https://www.geoapify.com/"]'));
    const canvas = doc.querySelector('.entrance-leaflet-map');
    const reload = api.defer(resource);
    await click(button(doc, 'Refresh location'));
    assert.equal(doc.querySelector('.entrance-leaflet-map'), canvas);
    await act(async () => { reload.reply(accepted()); });
    await waitFor(() => !button(doc, 'Refresh location').disabled, 'saved record refreshed');
    assert.equal(doc.querySelector('.entrance-leaflet-map'), canvas);
    assert.equal(note.value, 'Keep this unsaved note');
    assert.equal(changed, 1);
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 1, 'Refresh must not geocode again');
    assert.equal(api.calls.some((call) => call.pathname.endsWith('/entrance')), false, 'An address match is not a confirmed entrance');
  } finally { await page.close(); }
});

void test('an approximate candidate requires explicit versioned acceptance and a stale candidate cannot be silently accepted', async () => {
  const api = new ApiFixture();
  const approximate = record({ status: 'review_required', recordVersion: 2, candidate: { ...candidate, precision: 'street', confidence: 0.7 } });
  api.defer(resource).reply(approximate);
  const conflict = api.defer(`${resource}/accept`, 'POST');
  const page = await domHarness(api);
  let changed = 0;
  try {
    const { DeliveryGeocoding: Location } = await import('../src/components/delivery-geocoding');
    await page.render(createElement(Location, { deliveryId, revision: '1', onChanged: () => { changed += 1; } }));
    const doc = page.dom.window.document;
    await waitFor(() => doc.body.textContent?.includes(en.candidateOnly) === true, 'candidate awaiting review');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    await click(button(doc, 'Accept this address point'));
    assert.deepEqual(api.calls.find((call) => call.method === 'POST')?.body, { deliveryVersion: 1, addressKey, recordVersion: 2 });
    await act(async () => { conflict.reply({ message: 'Location candidate changed' }, 409); });
    await waitFor(() => doc.body.textContent?.includes(en.conflict) === true, 'stale candidate error');
    assert.equal(button(doc, 'Accept this address point').disabled, true);
    assert.equal(changed, 0);
    const newer = { ...approximate, recordVersion: 3 };
    api.defer(resource).reply(newer);
    await click(button(doc, 'Refresh location'));
    await waitFor(() => !button(doc, 'Accept this address point').disabled, 'new candidate version');
    const acceptance = api.defer(`${resource}/accept`, 'POST');
    acceptance.reply({ ...newer, status: 'accepted', acceptance: 'operator' });
    await click(button(doc, 'Accept this address point'));
    await waitFor(() => changed === 1 && doc.body.textContent?.includes(en.operator) === true, 'operator accepted candidate');
    assert.deepEqual(api.calls.filter((call) => call.method === 'POST').at(-1)?.body, { deliveryVersion: 1, addressKey, recordVersion: 3 });
    assert.equal(api.calls.some((call) => call.pathname.endsWith('/entrance')), false);
  } finally { await page.close(); }
});

void test('configuration, placeholder, not-found and provider limit states are translated without a provider request', async () => {
  for (const status of ['not_configured', 'invalid_address', 'not_found', 'failed', 'rate_limited', 'quota_exceeded'] as const) {
    const api = new ApiFixture();
    api.defer(resource).reply(record({ status, configured: status !== 'not_configured', reason: status === 'invalid_address' ? 'placeholder_address' : null }));
    const page = await domHarness(api);
    try {
      const { DeliveryGeocoding: Location } = await import('../src/components/delivery-geocoding');
      const element = createElement(Location, { deliveryId, revision: '1', onChanged: () => undefined });
      await page.render(element);
      const doc = page.dom.window.document;
      await waitFor(() => doc.body.textContent?.includes(en[status]) === true, 'lookup status');
      if (status === 'not_configured' || status === 'invalid_address') assert.equal(button(doc, 'Locate address').disabled, true);
      for (const [locale, messages] of [['en', en], ['it', it], ['ru', ru], ['uz', uz]] as const) {
        await page.render(element, locale);
        assert.ok(doc.body.textContent?.includes(messages[status]));
      }
      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0]?.method, 'GET');
    } finally { await page.close(); }
  }
});

void test('a stale location read cannot overwrite the current address response', async () => {
  const api = new ApiFixture();
  const old = api.defer(resource);
  const page = await domHarness(api);
  try {
    const { DeliveryGeocoding: Location } = await import('../src/components/delivery-geocoding');
    const props = { deliveryId, onChanged: () => undefined };
    await page.render(createElement(Location, { ...props, revision: '1' }));
    await waitFor(() => old.called, 'first read');
    api.defer(resource).reply(record({ deliveryVersion: 2, addressKey: '2'.repeat(64), status: 'not_found' }));
    await page.render(createElement(Location, { ...props, revision: '2' }));
    const doc = page.dom.window.document;
    await waitFor(() => doc.body.textContent?.includes(en.not_found) === true, 'current address');
    await act(async () => { old.reply(accepted()); });
    await settle();
    assert.ok(doc.body.textContent?.includes(en.not_found));
    assert.equal(doc.body.textContent?.includes(candidate.formattedAddress), false);
    assert.equal(api.calls[0]?.signal?.aborted, true);
  } finally { await page.close(); }
});

void test('locating an Inbox delivery refreshes Map and Nearby without resetting the open panel or its notes when service is unknown', async () => {
  const api = new ApiFixture();
  assert.equal(api.detail.delivery.source.serviceType, null);
  const job = { deliveryId, pickingName: 'TEST/GEO/01', orderNames: ['TEST/SO/01'], customerName: 'Test customer',
    address: 'Test address', geography: { city: 'Messina', province: 'ME', postalCode: '98100', source: 'odoo' } };
  api.defer('/deliveries/map', 'GET', '?view=inbox').reply({ total: 1, mappedCount: 0, missingCount: 1, markers: [], missingCoordinates: [job], area: null });
  api.defer(resource).reply(record());
  for (let index = 0; index < 2; index += 1) {
    api.defer('/routes').reply({ drafts: [], points: [] });
    api.defer('/routes/jobs').reply({ jobs: [], anchorJob: null, anchorHasCoordinates: index > 0 });
  }
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.delivery-table') !== null, 'Inbox loaded');
    await click(button(doc, 'Map'));
    await waitFor(() => doc.querySelector('button[aria-label="Open TEST/GEO/01"]') !== null, 'missing-coordinate delivery');
    const mapCanvas = doc.querySelector('.inbox-leaflet-map');
    assert.ok(mapCanvas);
    const open = doc.querySelector('button[aria-label="Open TEST/GEO/01"]');
    assert.ok(open instanceof HTMLButtonElement);
    await click(open);
    await waitFor(() => doc.querySelector('textarea[name="notes"]') !== null && !button(doc, 'Locate address').disabled, 'address action regardless of service');
    await waitFor(() => api.calls.filter((call) => call.pathname === '/routes/jobs').length === 1, 'initial Nearby query completes before locating');
    const panel = doc.querySelector('.delivery-panel');
    const notes = doc.querySelector('textarea[name="notes"]');
    assert.ok(panel instanceof HTMLElement);
    assert.ok(notes instanceof HTMLTextAreaElement);
    notes.value = 'Keep unsaved access instructions';
    panel.scrollTop = 96;
    api.defer(resource, 'POST').reply(accepted());
    api.defer(resource).reply(accepted());
    const mapped = api.defer('/deliveries/map', 'GET', '?view=inbox');
    mapped.reply({ total: 1, mappedCount: 1, missingCount: 0, missingCoordinates: [], area: null,
      markers: [{ ...job, point: candidate.point, pointSource: 'geocoded', geocoding: {
        provider: 'geoapify', precision: 'building', confidence: 1, attribution: candidate.attribution, acceptance: 'automatic',
      } }],
    });
    await click(button(doc, 'Locate address'));
    await waitFor(() => mapped.called && doc.querySelector('section[aria-label="Delivery map"]')?.textContent?.includes('1 of 1 deliveries on the map') === true, 'saved location reaches Inbox map');
    await waitFor(() => api.calls.filter((call) => call.pathname === '/routes/jobs').length >= 2, 'Nearby refreshed');
    assert.equal(doc.querySelector('.delivery-panel'), panel);
    assert.equal(doc.querySelector('.inbox-leaflet-map'), mapCanvas);
    assert.equal(notes.value, 'Keep unsaved access instructions');
    assert.equal(panel.scrollTop, 96);
    assert.equal(button(doc, 'Map').getAttribute('aria-pressed'), 'true');
    assert.equal(api.calls.filter((call) => call.method !== 'GET').length, 1);
    assert.equal(api.calls.some((call) => call.pathname.endsWith('/entrance')), false);
  } finally { await page.close(); }
});

void test('import completion refreshes an already-open delivery, geocoding and Nearby without a Locate request or UI reset', async () => {
  const api = new ApiFixture();
  const job = { deliveryId, pickingName: 'TEST/IMPORT/GEO', orderNames: ['TEST/SO/01'], customerName: 'Test customer',
    address: 'Test address', geography: { city: 'Messina', province: 'ME', postalCode: '98100', source: 'odoo' } };
  const imported = importSchema.parse({ id: '50000000-0000-4000-8000-000000000031', status: 'succeeded',
    startedAt: '2026-11-12T08:00:00Z', finishedAt: '2026-11-12T08:00:10Z', processed: 1, error: null,
    details: ['Automatic geocoding completed: one address accepted'] });
  const importResponse = api.defer('/imports', 'POST');
  api.defer('/deliveries/map', 'GET', '?view=inbox').reply({ total: 1, mappedCount: 0, missingCount: 1, markers: [], missingCoordinates: [job], area: null });
  api.defer(resource).reply(record());
  for (let index = 0; index < 2; index += 1) {
    api.defer('/routes').reply({ drafts: [], points: [] });
    api.defer('/routes/jobs').reply({ jobs: [], anchorJob: null, anchorHasCoordinates: index > 0 });
  }
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.delivery-table') !== null, 'Inbox ready before import');
    const imports = Array.from(doc.querySelectorAll('nav[aria-label="Backoffice sections"] button')).find((entry) => entry.textContent?.includes('Source sync'));
    assert.ok(imports instanceof HTMLButtonElement);
    await click(imports);
    await waitFor(() => Array.from(doc.querySelectorAll('button')).some((entry) => entry.textContent?.includes('Run import') && !entry.disabled), 'import command');
    await click(button(doc, '⇄ Run import'));
    assert.equal(importResponse.called, true);
    const deliveries = Array.from(doc.querySelectorAll('nav[aria-label="Backoffice sections"] button')).find((entry) => entry.textContent?.includes('Deliveries'));
    assert.ok(deliveries instanceof HTMLButtonElement);
    await click(deliveries);
    await click(button(doc, 'Map'));
    await waitFor(() => doc.querySelector('button[aria-label="Open TEST/IMPORT/GEO"]') !== null, 'missing point while import is pending');
    const mapCanvas = doc.querySelector('.inbox-leaflet-map');
    const open = doc.querySelector('button[aria-label="Open TEST/IMPORT/GEO"]');
    assert.ok(mapCanvas);
    assert.ok(open instanceof HTMLButtonElement);
    await click(open);
    await waitFor(() => doc.querySelector('textarea[name="notes"]') !== null && !button(doc, 'Locate address').disabled, 'opened delivery during import');
    await waitFor(() => api.calls.filter((call) => call.pathname === '/routes/jobs').length === 1, 'initial Nearby read');
    const panel = doc.querySelector('.delivery-panel');
    const location = doc.querySelector('section[aria-label="Address location"]');
    const notes = doc.querySelector('textarea[name="notes"]');
    assert.ok(panel instanceof HTMLElement);
    assert.ok(location);
    assert.ok(notes instanceof HTMLTextAreaElement);
    notes.value = 'Keep my access note while import finishes';
    panel.scrollTop = 112;
    const nextDetail = api.defer(`/deliveries/${deliveryId}`);
    const nextLocation = api.defer(resource);
    api.defer('/deliveries/map', 'GET', '?view=inbox').reply({ total: 1, mappedCount: 1, missingCount: 0, missingCoordinates: [], area: null,
      markers: [{ ...job, point: candidate.point, pointSource: 'geocoded', geocoding: {
        provider: 'geoapify', precision: 'building', confidence: 1, attribution: candidate.attribution, acceptance: 'automatic',
      } }],
    });
    api.imports = [imported];
    await act(async () => { importResponse.reply(imported); });
    await waitFor(() => nextDetail.called && nextLocation.called, 'completion invalidates the open panel and its separate geocoding cache');
    assert.equal(button(doc, 'Locate address').disabled, true, 'Do not act on a stale location while refreshing');
    assert.equal(panel.querySelector('.panel-body')?.getAttribute('aria-busy'), 'true');
    assert.equal(doc.querySelector('.delivery-panel'), panel);
    assert.equal(doc.querySelector('section[aria-label="Address location"]'), location);
    assert.equal(notes.value, 'Keep my access note while import finishes');
    await act(async () => { nextDetail.reply(api.detail); nextLocation.reply(accepted()); });
    await waitFor(() => location.textContent?.includes(en.automatic) === true && panel.querySelector('.panel-body')?.getAttribute('aria-busy') === 'false', 'accepted location with unchanged delivery version');
    await waitFor(() => api.calls.filter((call) => call.pathname === '/routes/jobs').length === 2, 'Nearby sees the new address point');
    assert.equal(api.detail.delivery.version, 1);
    assert.equal(doc.querySelector('.inbox-leaflet-map'), mapCanvas);
    assert.equal(panel.scrollTop, 112);
    assert.equal(notes.value, 'Keep my access note while import finishes');
    assert.equal(button(panel, 'Overview').getAttribute('aria-pressed'), 'true');
    assert.equal(button(doc, 'Map').getAttribute('aria-pressed'), 'true');
    assert.ok(doc.querySelector('section[aria-label="Delivery map"]')?.textContent?.includes('1 of 1 deliveries on the map'));
    assert.deepEqual(api.calls.filter((call) => call.method !== 'GET').map((call) => call.pathname), ['/imports']);
  } finally { await page.close(); }
});
