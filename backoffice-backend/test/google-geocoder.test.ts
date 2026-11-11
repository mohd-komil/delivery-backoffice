import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleGeocoder } from '../src/routing/google-geocoder';
import { GoogleRoads } from '../src/routing/google-maps';

const settings = { browserKey: 'test-browser-key', routesKey: 'test-routes-key', geocodingKey: 'test-geocoding-key' };
const approved = { address: ' Piazza della Scala, 2 ', city: 'MILANO', country: 'Italia' };
const point = { latitude: 45.4671, longitude: 9.1908 };
const exact = { location: point, granularity: 'ROOFTOP', types: ['street_address'] };

void test('Google geocoding sends only the fixed public fixture to the server API and returns the masked point', async () => {
  const requests: URL[] = [];
  const mockFetch: typeof fetch = (input, init) => {
    assert.ok(input instanceof URL);
    requests.push(input);
    assert.equal(input.origin, 'https://geocode.googleapis.com');
    assert.equal(input.pathname, '/v4/geocode/address');
    assert.deepEqual(Object.fromEntries(input.searchParams), {
      'address.addressLines': 'Piazza della Scala, 2', 'address.locality': 'Milano',
      'address.postalCode': '20121', 'address.regionCode': 'IT',
    });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Goog-Api-Key'), settings.geocodingKey);
    assert.equal(headers.get('X-Goog-FieldMask'), 'results.location,results.granularity,results.types');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
    return Promise.resolve(Response.json({ results: [{ ...exact, formattedAddress: 'Not returned' }] }));
  };
  const provider = new GoogleGeocoder({ settings, fetch: mockFetch });
  assert.deepEqual(await provider.suggest(approved), { status: 'exact', point, source: 'google' });
  assert.equal(requests.length, 1);
});

void test('Google geocoding never looks up arbitrary, missing, or unconfigured addresses', async () => {
  let requests = 0;
  const mockFetch: typeof fetch = () => {
    requests++;
    return Promise.resolve(Response.json({ results: [exact] }));
  };
  const provider = new GoogleGeocoder({ settings, fetch: mockFetch });
  assert.deepEqual(await provider.suggest({ ...approved, address: 'Piazza della Scala, 2 & address=private' }),
    { status: 'outside_demo', point: null, source: null });
  assert.equal((await provider.suggest({ ...approved, country: 'FR' })).status, 'outside_demo');
  assert.equal((await provider.suggest({ ...approved, city: 'Monza' })).status, 'outside_demo');
  assert.equal((await provider.suggest({ ...approved, address: ' ' })).status, 'missing_address');
  const unavailableSettings = [
    undefined,
    { browserKey: settings.browserKey, routesKey: settings.routesKey },
    { ...settings, geocodingKey: settings.browserKey },
    { ...settings, geocodingKey: settings.routesKey },
    { ...settings, geocodingKey: 'invalid key' },
  ];
  for (const value of unavailableSettings) {
    assert.equal((await new GoogleGeocoder({ settings: value, fetch: mockFetch }).suggest(approved)).status, 'unconfigured');
  }
  assert.equal(requests, 0);
  const roads = new GoogleRoads({ settings: { ...settings, geocodingKey: 'invalid key' } });
  assert.deepEqual(roads.browserConfig, { key: settings.browserKey });
});

void test('Google geocoding distinguishes approximate, ambiguous, and not found without choosing an ambiguous match', async () => {
  const responses = [
    { results: [{ ...exact, granularity: 'RANGE_INTERPOLATED' }] },
    { results: [{ ...exact, types: ['route'] }] },
    { results: [exact, { ...exact, location: { latitude: 45.5, longitude: 9.2 } }] },
    {},
  ];
  const provider = new GoogleGeocoder({ settings, fetch: () => Promise.resolve(Response.json(responses.shift())) });
  assert.deepEqual(await provider.suggest(approved), { status: 'approximate', point, source: 'google' });
  assert.deepEqual(await provider.suggest(approved), { status: 'approximate', point, source: 'google' });
  assert.deepEqual(await provider.suggest(approved), { status: 'ambiguous', point: null, source: null });
  assert.deepEqual(await provider.suggest(approved), { status: 'not_found', point: null, source: null });
});

void test('Google geocoding rejects out-of-range and oversized results and sanitizes provider errors without retrying', async () => {
  const responses = [
    Response.json({ results: [{ ...exact, location: { latitude: 90.1, longitude: 9 } }] }),
    new Response(' '.repeat(65_537)),
    Response.json({ error: 'provider message with sensitive request details' }, { status: 403 }),
    Response.json({ error: 'provider quota' }, { status: 429 }),
  ];
  let requests = 0;
  const provider = new GoogleGeocoder({
    settings,
    fetch: () => {
      requests++;
      const response = responses.shift();
      return response ? Promise.resolve(response) : Promise.reject(new Error('sensitive address and credential'));
    },
  });
  for (const status of ['unavailable', 'unavailable', 'unavailable', 'rate_limited', 'unavailable']) {
    assert.deepEqual(await provider.suggest(approved), { status, point: null, source: null });
  }
  assert.equal(requests, 5);
});

void test('Google geocoding bounds simultaneous and rolling calls and releases a failed slot', async () => {
  const gate = new AbortController();
  const wait = new Promise<void>((resolve) => gate.signal.addEventListener('abort', () => resolve(), { once: true }));
  let now = 0;
  let requests = 0;
  const provider = new GoogleGeocoder({
    settings, now: () => now,
    fetch: async () => {
      const attempt = ++requests;
      await wait;
      if (attempt === 1) throw new Error('failed request');
      return Response.json({ results: [exact] });
    },
  });
  const first = provider.suggest(approved);
  const second = provider.suggest(approved);
  assert.equal((await provider.suggest(approved)).status, 'rate_limited');
  gate.abort();
  assert.equal((await first).status, 'unavailable');
  assert.equal((await second).status, 'exact');
  for (let attempt = 2; attempt < 20; attempt++) assert.equal((await provider.suggest(approved)).status, 'exact');
  assert.equal((await provider.suggest(approved)).status, 'rate_limited');
  assert.equal(requests, 20);
  now = 60_000;
  assert.equal((await provider.suggest(approved)).status, 'exact');
  assert.equal(requests, 21);
});
