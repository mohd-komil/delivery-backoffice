import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoapifyCandidateSchema, GeoapifyClient, geoapifyAddressProblem } from '../src/routing/geoapify-client';

const settings = { apiKey: 'synthetic-geoapify-key-only-for-tests' };
const destination = { address: 'Via Test 19', city: 'Messina', province: 'ME', postalCode: '98123', country: 'IT' };
const building = {
  lat: 38.188, lon: 15.554, formatted: 'Via Test 19, 98123 Messina, Italia',
  result_type: 'building', country_code: 'it', postcode: '98123', city: 'Messina', housenumber: '19',
  rank: { confidence: 1, confidence_city_level: 1, confidence_street_level: 1, confidence_building_level: 1, match_type: 'full_match' },
  datasource: { attribution: '© OpenStreetMap contributors', license: 'Open Database License', url: 'https://www.openstreetmap.org/copyright' },
};

function clientWith(payload: unknown): GeoapifyClient {
  return new GeoapifyClient({ settings, fetch: () => Promise.resolve(Response.json(payload)) });
}

void test('Geoapify sends only address components to the fixed HTTPS endpoint and returns attributed validated coordinates', async () => {
  let requests = 0;
  const provider = new GeoapifyClient({ settings, fetch: (input, init) => {
    requests++;
    assert.ok(input instanceof URL);
    assert.equal(input.origin, 'https://api.geoapify.com');
    assert.equal(input.pathname, '/v1/geocode/search');
    assert.deepEqual(Object.fromEntries(input.searchParams), {
      text: 'Via Test 19, Messina, ME, 98123, IT', format: 'json', limit: '2',
      bias: 'countrycode:none', filter: 'countrycode:it', apiKey: settings.apiKey,
    });
    assert.equal(init?.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
    return Promise.resolve(Response.json({ results: [{ ...building, name: 'Must not be propagated' }] }));
  } });
  const sourceCustomer = { ...destination, name: 'Private customer', phone: 'private phone', email: 'private@example.test', id: 233774 };
  const result = await provider.lookup(sourceCustomer);
  assert.equal(result.status, 'accepted');
  assert.equal(result.reason, null);
  assert.ok(result.candidate);
  assert.deepEqual(result.candidate.point, { latitude: 38.188, longitude: 15.554 });
  assert.equal(result.candidate.precision, 'building');
  assert.match(result.candidate.attribution, /Geoapify/);
  assert.match(result.candidate.attribution, /OpenStreetMap/);
  assert.match(result.candidate.attribution, /Open Database License/);
  assert.equal(GeoapifyCandidateSchema.safeParse(result.candidate).success, true);
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
  assert.equal(JSON.stringify(result).includes('Must not be propagated'), false);
  assert.equal(requests, 1);
});

void test('Geoapify settings expose only configured state and bounded daily quota', async () => {
  let requests = 0;
  const mockFetch: typeof fetch = () => { requests++; return Promise.resolve(Response.json({ results: [building] })); };
  const invalidSettings: unknown[] = [undefined, null, {}, { apiKey: 'short' }, { apiKey: 'spaces are invalid in a key' },
    { ...settings, dailyLimit: 0 }, { ...settings, dailyLimit: 2901 }, { ...settings, dailyLimit: 1.5 },
    { ...settings, dailyLimit: '100' }, { ...settings, endpoint: 'https://other.example.test' }];
  for (const value of invalidSettings) {
    const provider = new GeoapifyClient({ settings: value, fetch: mockFetch });
    assert.deepEqual(await provider.getSettings(), { configured: false, dailyLimit: 100 });
    assert.deepEqual(await provider.lookup(destination), { status: 'failed', reason: 'unconfigured', candidate: null });
  }
  assert.deepEqual(await new GeoapifyClient({ settings }).getSettings(), { configured: true, dailyLimit: 100 });
  assert.deepEqual(await new GeoapifyClient({ settings: { ...settings, dailyLimit: 2900 } }).getSettings(), { configured: true, dailyLimit: 2900 });
  assert.equal(requests, 0);
});

void test('Geoapify never submits incomplete or known placeholder addresses', async () => {
  let requests = 0;
  const provider = new GeoapifyClient({ settings, fetch: () => { requests++; return Promise.resolve(Response.json({ results: [] })); } });
  for (const address of ['Street example 176448', ' STREET   EXAMPLE 23 ', 'Via Dimostrativa 3', 'ViaDimostrativa 3', 'DEMO address']) {
    assert.equal(geoapifyAddressProblem({ ...destination, address }), 'placeholder_address');
    assert.equal((await provider.lookup({ ...destination, address })).reason, 'placeholder_address');
  }
  for (const incomplete of [{ ...destination, address: null }, { ...destination, address: ' ' }, { ...destination, city: null }, { ...destination, country: '' }]) {
    assert.equal(geoapifyAddressProblem(incomplete), 'missing_address');
    assert.equal((await provider.lookup(incomplete)).reason, 'missing_address');
  }
  assert.equal(requests, 0);
});

void test('City, street and amenity matches remain review-only even at full confidence', async () => {
  for (const result_type of ['street', 'city', 'postcode', 'amenity', 'unknown']) {
    const result = await clientWith({ results: [{ ...building, result_type }] }).lookup(destination);
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'approximate_result');
    assert.ok(result.candidate);
  }
});

void test('A full building match still requires reliable confidence at every address level', async () => {
  for (const rank of [undefined, { confidence: 1, match_type: 'full_match' },
    { ...building.rank, confidence: 0.94 }, { ...building.rank, confidence_street_level: 0.8 },
    { ...building.rank, confidence_building_level: 0 }, { ...building.rank, confidence_city_level: 0.7 }]) {
    const result = await clientWith({ results: [{ ...building, rank }] }).lookup(destination);
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'low_confidence');
  }
});

void test('Automatic acceptance checks the requested country, city, postcode and civic number', async () => {
  for (const changed of [{ country_code: 'fr' }, { country_code: undefined }, { city: 'Catania' },
    { postcode: '98122' }, { postcode: undefined }, { housenumber: '191' }, { housenumber: undefined }]) {
    const result = await clientWith({ results: [{ ...building, ...changed }] }).lookup(destination);
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'address_mismatch');
  }
  const civicWithSlash = await clientWith({ results: [{ ...building, housenumber: '191' }] }).lookup({ ...destination, address: 'Via Test 19/1' });
  assert.equal(civicWithSlash.reason, 'address_mismatch');
  const noCivic = await clientWith({ results: [building] }).lookup({ ...destination, address: 'Via Test' });
  assert.equal(noCivic.reason, 'address_mismatch');
  const sameCivic = await clientWith({ results: [{ ...building, housenumber: '19/A' }] }).lookup({ ...destination, address: 'Via Test, 19 / A' });
  assert.equal(sameCivic.status, 'accepted');
});

void test('Multiple candidates need review and an empty result has no coordinates', async () => {
  const ambiguous = await clientWith({ results: [building, { ...building, lon: 15.6 }] }).lookup(destination);
  assert.equal(ambiguous.status, 'review_required');
  assert.equal(ambiguous.reason, 'ambiguous_results');
  assert.ok(ambiguous.candidate);
  assert.deepEqual(await clientWith({ results: [] }).lookup(destination), { status: 'not_found', reason: null, candidate: null });
});

void test('Geoapify rejects invalid or excessive payloads, sanitizes provider errors and never retries', async () => {
  const responses = [
    Response.json({}), Response.json({ results: [{ ...building, lat: 91 }] }),
    Response.json({ results: [{ ...building, lat: 0, lon: 0 }] }),
    Response.json({ results: [{ ...building, rank: { confidence: 2 } }] }),
    Response.json({ results: Array.from({ length: 11 }, () => building) }),
    new Response(' '.repeat(256 * 1024 + 1)), new Response('invalid json'),
    Response.json({ key: settings.apiKey, message: 'secret provider details' }, { status: 403 }),
    Response.json({ key: settings.apiKey }, { status: 429 }),
  ];
  let requests = 0;
  const provider = new GeoapifyClient({ settings, fetch: () => {
    requests++;
    const response = responses.shift();
    return response ? Promise.resolve(response) : Promise.reject(new Error(`request failed with ${settings.apiKey}`));
  } });
  for (const reason of ['invalid_response', 'invalid_response', 'invalid_response', 'invalid_response', 'invalid_response',
    'provider_unavailable', 'provider_unavailable', 'provider_unavailable', 'provider_rate_limited', 'provider_unavailable']) {
    const result = await provider.lookup(destination);
    assert.deepEqual(result, { status: 'failed', reason, candidate: null });
    assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
  }
  assert.equal(requests, 10);
});
