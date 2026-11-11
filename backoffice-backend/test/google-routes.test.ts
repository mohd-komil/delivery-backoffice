import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleRoads } from '../src/routing/google-maps';
import { computeRoadRoute, MAX_GOOGLE_ROUTE_STOPS, RoadRouteError } from '../src/routing/google-routes';

const origin = { latitude: 45.46, longitude: 9.18 };
const first = { latitude: 45.53, longitude: 9.23 };
const second = { latitude: 45.58, longitude: 9.27 };
const points = [origin, first, second, origin];
const encodedPolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const route = { legSeconds: [85.25, 0, 211], encodedPolyline };
const key = 'test-routes-key';
const providerResponse = {
  routes: [{ legs: [{ duration: '85.25s' }, { duration: '0s' }, { duration: '211s' }], polyline: { encodedPolyline } }],
};

void test('Google route uses one fixed-order request with coordinate-only data and returns each leg', async () => {
  const requests: Request[] = [];
  const request: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(Response.json(providerResponse));
  };
  const pointWithLocalMetadata = { ...first, name: 'Synthetic delivery', id: 'local-order' };
  const result = await computeRoadRoute(key, [origin, pointWithLocalMetadata, second, origin], { fetch: request });
  assert.deepEqual(result, route);
  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.ok(sent);
  assert.equal(sent.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.cache, 'no-store');
  assert.equal(sent.headers.get('X-Goog-Api-Key'), key);
  assert.equal(sent.headers.get('X-Goog-FieldMask'), 'routes.legs.duration,routes.polyline.encodedPolyline');
  const body: unknown = await sent.json();
  assert.deepEqual(body, {
    origin: { location: { latLng: origin } },
    destination: { location: { latLng: origin } },
    intermediates: [{ location: { latLng: first } }, { location: { latLng: second } }],
    travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', optimizeWaypointOrder: false,
    polylineEncoding: 'ENCODED_POLYLINE', polylineQuality: 'OVERVIEW',
  });
});

void test('Google route rejects invalid coordinates, keys and excess stops before requesting', async () => {
  let calls = 0;
  const request: typeof fetch = () => {
    calls++;
    return Promise.resolve(Response.json(providerResponse));
  };
  await assert.rejects(computeRoadRoute(key, [origin], { fetch: request }), { reason: 'invalid_input' });
  await assert.rejects(computeRoadRoute(key, [origin, { ...second, latitude: 91 }], { fetch: request }), { reason: 'invalid_input' });
  await assert.rejects(computeRoadRoute('invalid\nkey', points, { fetch: request }), { reason: 'invalid_input' });
  const tooMany = [origin, ...Array.from({ length: MAX_GOOGLE_ROUTE_STOPS + 1 }, () => first), second];
  await assert.rejects(computeRoadRoute(key, tooMany, { fetch: request }), { reason: 'unsupported_waypoints' });
  assert.equal(calls, 0);
});

void test('Google route distinguishes no route from invalid or incomplete provider data', async () => {
  for (const body of [{}, { routes: [] }]) {
    const request: typeof fetch = () => Promise.resolve(Response.json(body));
    await assert.rejects(computeRoadRoute(key, points, { fetch: request }), { reason: 'no_route' });
  }
  const missingLeg = { routes: [{ legs: [{ duration: '80s' }], polyline: { encodedPolyline } }] };
  const invalidDuration = { routes: [{ legs: [{ duration: '-1s' }, { duration: '0s' }, { duration: '3s' }], polyline: { encodedPolyline } }] };
  const invalidPolyline = { routes: [{ ...providerResponse.routes[0], polyline: { encodedPolyline: '<html>' } }] };
  for (const body of [missingLeg, invalidDuration, invalidPolyline, { routes: null }]) {
    const request: typeof fetch = () => Promise.resolve(Response.json(body));
    await assert.rejects(computeRoadRoute(key, points, { fetch: request }), { reason: 'unavailable' });
  }
  const largeResponse: typeof fetch = () => Promise.resolve(new Response('x'.repeat(257 * 1024)));
  await assert.rejects(computeRoadRoute(key, points, { fetch: largeResponse }), { reason: 'unavailable' });
});

void test('Google failures and aborts expose a safe reason and do not retry', async () => {
  const upstreamDetail = 'raw provider message with sensitive fields';
  let calls = 0;
  const request: typeof fetch = () => {
    calls++;
    return Promise.resolve(new Response(upstreamDetail, { status: 429 }));
  };
  await assert.rejects(computeRoadRoute(key, points, { fetch: request }), (error: unknown) => {
    assert.ok(error instanceof RoadRouteError);
    assert.equal(error.reason, 'unavailable');
    assert.doesNotMatch(error.message, /sensitive|test-routes-key/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);

  const controller = new AbortController();
  const waitingRequest: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error(upstreamDetail)), { once: true });
  });
  const pending = computeRoadRoute(key, points, { fetch: waitingRequest, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { reason: 'unavailable' });
  await assert.rejects(computeRoadRoute(key, points, { fetch: request, signal: controller.signal }), { reason: 'unavailable' });
  assert.equal(calls, 1);
});

void test('Google road provider fails closed and only returns the distinct browser key', async () => {
  const settings = { browserKey: 'test-browser-key', routesKey: key, mapId: 'DEMO_MAP_ID' };
  const keys: string[] = [];
  const compute: typeof computeRoadRoute = (usedKey) => {
    keys.push(usedKey);
    return Promise.resolve(route);
  };
  const configured = new GoogleRoads({ settings, compute });
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.browserConfig, { key: settings.browserKey, mapId: settings.mapId });
  await configured.compute(points);
  assert.deepEqual(keys, [settings.routesKey]);

  for (const invalid of [undefined, { browserKey: key, routesKey: key }, { browserKey: settings.browserKey }]) {
    const provider = new GoogleRoads({ settings: invalid, compute });
    assert.equal(provider.configured, false);
    assert.equal(provider.browserConfig, null);
    await assert.rejects(provider.compute(points), { reason: 'not_configured' });
  }
  assert.deepEqual(keys, [settings.routesKey]);
});

void test('Google road provider limits concurrent and recent calls and releases a failed slot', async () => {
  const gate = new AbortController();
  const release = new Promise<void>((resolve) => gate.signal.addEventListener('abort', () => resolve(), { once: true }));
  let attempts = 0;
  let now = 0;
  const compute: typeof computeRoadRoute = async () => {
    const attempt = ++attempts;
    await release;
    if (attempt === 1) throw new RoadRouteError('unavailable');
    return route;
  };
  const provider = new GoogleRoads({ settings: { browserKey: 'test-browser-key', routesKey: key }, compute, now: () => now });
  const firstResult = assert.rejects(provider.compute(points), { reason: 'unavailable' });
  const secondResult = provider.compute(points);
  await assert.rejects(provider.compute(points), { reason: 'rate_limited' });
  gate.abort();
  await firstResult;
  assert.deepEqual(await secondResult, route);
  for (let attempt = 2; attempt < 30; attempt++) await provider.compute(points);
  await assert.rejects(provider.compute(points), { reason: 'rate_limited' });
  assert.equal(attempts, 30);
  now = 60_000;
  assert.deepEqual(await provider.compute(points), route);
  assert.equal(attempts, 31);
});
