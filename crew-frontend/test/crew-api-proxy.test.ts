import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyCrewRequest } from '../src/_app/crew-api/proxy';

const origin = 'http://127.0.0.1:3002';

void test('customer-development origins work outside test mode and preserve the Crew session boundary', async (t) => {
  const customerDevelopmentOrigin = 'http://127.0.0.1:3032';
  const previousOrigin = process.env.CREW_API_ORIGIN;
  const previousTest = process.env.BACKOFFICE_TEST;
  const forwarded: string[] = [];
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    forwarded.push(destination.href);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'crew_session=customer-development-session');
    assert.equal(headers.get('origin'), customerDevelopmentOrigin);
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    const responseHeaders = new Headers();
    responseHeaders.append('Set-Cookie', 'backoffice_session=not-forwarded');
    responseHeaders.append('Set-Cookie', 'crew_session=renewed-session; Path=/api/crew; HttpOnly');
    return Promise.resolve(Response.json({ id: 'customer-development-participant' }, { headers: responseHeaders }));
  });
  try {
    delete process.env.BACKOFFICE_TEST;
    for (const allowed of ['http://127.0.0.1:3031', 'http://localhost:3031']) {
      process.env.CREW_API_ORIGIN = allowed;
      const request = new Request(customerDevelopmentOrigin, { headers: {
        Origin: customerDevelopmentOrigin, Cookie: 'backoffice_session=dispatcher-session; crew_session=customer-development-session; locale=en',
      } });
      const response = await proxyCrewRequest(request, ['auth', 'me']);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(response.headers.getSetCookie(), ['crew_session=renewed-session; Path=/api/crew; HttpOnly']);
      assert.equal((await proxyCrewRequest(new Request(origin), ['..', 'deliveries'])).status, 404);
    }
    assert.deepEqual(forwarded, ['http://127.0.0.1:3031/api/crew/auth/me', 'http://localhost:3031/api/crew/auth/me']);
    assert.equal(upstream.mock.callCount(), 2);
  } finally {
    if (previousOrigin === undefined) delete process.env.CREW_API_ORIGIN; else process.env.CREW_API_ORIGIN = previousOrigin;
    if (previousTest === undefined) delete process.env.BACKOFFICE_TEST; else process.env.BACKOFFICE_TEST = previousTest;
  }
});

void test('adding the customer-development stand does not allow arbitrary or disguised upstream origins', async (t) => {
  const previousOrigin = process.env.CREW_API_ORIGIN;
  const previousTest = process.env.BACKOFFICE_TEST;
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream request'); });
  try {
    for (const mode of ['0', '1']) {
      process.env.BACKOFFICE_TEST = mode;
      for (const invalid of [
        'http://example.test:3031', 'http://169.254.169.254', 'http://127.0.0.1:3032', 'https://127.0.0.1:3031',
        'http://localhost:3031.example.test', 'http://user:password@127.0.0.1:3031',
        'http://127.0.0.1:3031/', 'http://127.0.0.1:3031/api', 'http://127.0.0.1:3031?target=other',
        'http://127.0.0.1:3031#other', 'http://localhost:3011',
      ]) {
        process.env.CREW_API_ORIGIN = invalid;
        assert.equal((await proxyCrewRequest(new Request(origin), ['visits'])).status, 503, invalid);
      }
    }
    assert.equal(upstream.mock.callCount(), 0);
  } finally {
    if (previousOrigin === undefined) delete process.env.CREW_API_ORIGIN; else process.env.CREW_API_ORIGIN = previousOrigin;
    if (previousTest === undefined) delete process.env.BACKOFFICE_TEST; else process.env.BACKOFFICE_TEST = previousTest;
  }
});

void test('an unconfigured Crew proxy still defaults to the original local backend', async (t) => {
  const previousOrigin = process.env.CREW_API_ORIGIN;
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL) => {
    assert.equal(destination.href, 'http://127.0.0.1:3001/api/crew/visits');
    return Promise.resolve(Response.json({ visits: [] }));
  });
  try {
    delete process.env.CREW_API_ORIGIN;
    assert.equal((await proxyCrewRequest(new Request(origin), ['visits'])).status, 200);
    assert.equal(upstream.mock.callCount(), 1);
  } finally {
    if (previousOrigin === undefined) delete process.env.CREW_API_ORIGIN; else process.env.CREW_API_ORIGIN = previousOrigin;
  }
});

void test('crew proxy cannot reach backoffice endpoints or write outside approved visit actions', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected upstream request');
  });
  const path = ['visits', '7e478ed3-3d44-41a5-8993-a69c8ed36248'];
  const response = await proxyCrewRequest(new Request(origin, { method: 'POST' }), path);
  const escape = await proxyCrewRequest(new Request(origin), ['..', 'deliveries']);
  assert.equal(response.status, 404);
  assert.equal(escape.status, 404);
  assert.equal(upstream.mock.callCount(), 0);
});

void test('crew route proxy only allows assigned-route reads and bounded execution actions', async (t) => {
  const routeId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
  const forwarded: string[] = [];
  t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    forwarded.push(`${init.method} ${destination.pathname}`);
    return Promise.resolve(Response.json({ ok: true }));
  });
  const command = (body = '{}') => new Request(origin, { method: 'POST', body, headers: { Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal((await proxyCrewRequest(new Request(origin), ['routes'])).status, 200);
  assert.equal((await proxyCrewRequest(new Request(origin), ['routes', routeId])).status, 200);
  for (const action of ['depart', 'returning', 'return']) assert.equal((await proxyCrewRequest(command(), ['routes', routeId, action])).status, 200);
  for (const action of ['cancel', 'close', 'amend', 'skip', 'reconcile', 'warehouse-receipt']) assert.equal((await proxyCrewRequest(command(), ['routes', routeId, action])).status, 404);
  assert.equal((await proxyCrewRequest(command(), ['routes', routeId, 'return', 'extra'])).status, 404);
  assert.equal((await proxyCrewRequest(new Request(origin), ['routes', '..'])).status, 404);
  assert.equal((await proxyCrewRequest(command('x'.repeat(16 * 1024 + 1)), ['routes', routeId, 'return'])).status, 413);
  assert.deepEqual(forwarded, ['GET /api/crew/routes', `GET /api/crew/routes/${routeId}`, `POST /api/crew/routes/${routeId}/depart`,
    `POST /api/crew/routes/${routeId}/returning`, `POST /api/crew/routes/${routeId}/return`]);
});

void test('isolated API origin is allowed only with explicit test mode and arbitrary hosts remain blocked', async (t) => {
  const previousOrigin = process.env.CREW_API_ORIGIN;
  const previousTest = process.env.BACKOFFICE_TEST;
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL) => {
    assert.equal(destination.origin, 'http://127.0.0.1:3011');
    return Promise.resolve(Response.json({ routes: [] }));
  });
  try {
    process.env.CREW_API_ORIGIN = 'http://127.0.0.1:3011';
    delete process.env.BACKOFFICE_TEST;
    assert.equal((await proxyCrewRequest(new Request(origin), ['routes'])).status, 503);
    process.env.BACKOFFICE_TEST = '1';
    assert.equal((await proxyCrewRequest(new Request(origin), ['routes'])).status, 200);
    process.env.CREW_API_ORIGIN = 'http://169.254.169.254';
    assert.equal((await proxyCrewRequest(new Request(origin), ['routes'])).status, 503);
    assert.equal(upstream.mock.callCount(), 1);
  } finally {
    if (previousOrigin === undefined) delete process.env.CREW_API_ORIGIN; else process.env.CREW_API_ORIGIN = previousOrigin;
    if (previousTest === undefined) delete process.env.BACKOFFICE_TEST; else process.env.BACKOFFICE_TEST = previousTest;
  }
});

void test('crew proxy forwards a full-size issue photo and supports scoped checklist patches', async (t) => {
  const visitId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
  const checkpointId = '7e478ed3-3d44-41a5-8993-a69c8ed36249';
  const report = JSON.stringify({ photo: { name: 'evidence.jpg', base64: Buffer.alloc(5 * 1024 * 1024).toString('base64') } });
  const checked = JSON.stringify({ done: true });
  const forwarded: string[] = [];
  t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    forwarded.push(`${init.method} ${destination.pathname}`);
    assert.equal(init.body, init.method === 'PATCH' ? checked : report);
    return Promise.resolve(Response.json({ ok: true }));
  });
  const command = (method: string, body: string) => new Request(origin, {
    method, body, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: 'crew_session=mock-crew-session' },
  });

  assert.equal((await proxyCrewRequest(command('POST', report), ['visits', visitId, 'issues'])).status, 200);
  assert.equal((await proxyCrewRequest(command('POST', report), ['visits', visitId, 'start'])).status, 413);
  assert.equal((await proxyCrewRequest(command('PATCH', checked), ['visits', visitId, 'checklist', checkpointId])).status, 200);
  assert.equal((await proxyCrewRequest(command('PATCH', checked), ['visits', visitId, 'checklist', 'other'])).status, 404);
  assert.deepEqual(forwarded, [`POST /api/crew/visits/${visitId}/issues`, `PATCH /api/crew/visits/${visitId}/checklist/${checkpointId}`]);
});

void test('crew proxy forwards a bounded customer-absent report only to its visit action', async (t) => {
  const visitId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
  const path = ['visits', visitId, 'attempt-failure'];
  const body = JSON.stringify({
    version: 2, requestId: '7e478ed3-3d44-41a5-8993-a69c8ed36249', reason: '客'.repeat(2000),
  });
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    assert.equal(destination.pathname, `/api/crew/visits/${visitId}/attempt-failure`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, body);
    return Promise.resolve(Response.json({ status: 'failed' }));
  });
  const command = (report: string) => new Request(origin, {
    method: 'POST', body: report, headers: { Origin: origin, 'Content-Type': 'application/json' },
  });

  assert.equal((await proxyCrewRequest(command(body), path)).status, 200);
  assert.equal((await proxyCrewRequest(command('x'.repeat(16 * 1024 + 1)), path)).status, 413);
  assert.equal((await proxyCrewRequest(command(body), [...path, 'extra'])).status, 404);
  assert.equal((await proxyCrewRequest(new Request(origin), path)).status, 404);
  assert.equal(upstream.mock.callCount(), 1);
});

void test('crew proxy accepts full photo capacity with signatures and item notes only for finish', async (t) => {
  const visitId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
  const drawing = (offset: number) => Array.from({ length: 8 }, (_, stroke) =>
    Array.from({ length: 256 }, (_, point) => ({ x: 900 + point % 100, y: offset + stroke * 8 + point % 50 })));
  const base64 = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  const note = `x${'\u0001'.repeat(498)}y`;
  const report = JSON.stringify({
    version: 10, requestId: '7e478ed3-3d44-41a5-8993-a69c8ed36249', summary: 'Partial delivery',
    quantities: Array.from({ length: 500 }, (_, index) => ({ sourceLineId: index + 1, deliveredMilli: 1 })),
    itemChecks: Array.from({ length: 500 }, (_, index) => ({ sourceLineId: index + 1, status: 'problem', note })),
    photos: Array.from({ length: 4 }, (_, index) => ({ name: `finish-${index + 1}.jpg`, base64, ...(index ? { sourceLineId: index } : {}) })),
    customerSignature: { signerName: 'DEMO recipient', strokes: drawing(200) },
    crewSignature: { strokes: drawing(500) },
  });
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    assert.equal(destination.pathname, `/api/crew/visits/${visitId}/finish`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, report);
    return Promise.resolve(Response.json({ status: 'completed' }, { status: 201 }));
  });
  const request = (body: string, length = String(Buffer.byteLength(body))) => new Request(origin, {
    method: 'POST', body, headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': length },
  });

  assert.equal((await proxyCrewRequest(request(report), ['visits', visitId, 'finish'])).status, 201);
  assert.equal((await proxyCrewRequest(request('{}'), ['visits', visitId, 'finish', 'extra'])).status, 404);
  assert.equal((await proxyCrewRequest(request('{}', String(Buffer.byteLength(report))), ['visits', visitId, 'issues'])).status, 413);
  assert.equal((await proxyCrewRequest(request('{}', String(32 * 1024 * 1024 + 1)), ['visits', visitId, 'finish'])).status, 413);
  assert.equal(upstream.mock.callCount(), 1);
});

void test('crew proxy carries only the crew cookie, forwards Origin, and forbids caching', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    assert.equal(destination.href, 'http://127.0.0.1:3001/api/crew/auth/logout');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'crew_session=mock-crew-session');
    assert.equal(headers.get('origin'), origin);
    assert.equal(init.redirect, 'error');
    const responseHeaders = new Headers();
    responseHeaders.append('Set-Cookie', 'backoffice_session=should-not-pass');
    responseHeaders.append('Set-Cookie', 'crew_session=; Path=/api/crew; Max-Age=0; HttpOnly');
    return Promise.resolve(Response.json({ ok: true }, { headers: responseHeaders }));
  });
  const request = new Request(origin, {
    method: 'POST', body: '{}', headers: {
      Origin: origin, 'Content-Type': 'application/json',
      Cookie: 'backoffice_session=mock-admin-session; crew_session=mock-crew-session; locale=en',
    },
  });
  const response = await proxyCrewRequest(request, ['auth', 'logout']);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(response.headers.getSetCookie(), ['crew_session=; Path=/api/crew; Max-Age=0; HttpOnly']);
});

void test('crew proxy bounds incoming credentials before contacting the backend', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected upstream request');
  });
  const request = new Request(origin, {
    method: 'POST', body: JSON.stringify({ password: 'x'.repeat(5000) }),
    headers: { Origin: origin, 'Content-Type': 'application/json' },
  });
  const response = await proxyCrewRequest(request, ['auth', 'login']);
  assert.equal(response.status, 413);
  assert.equal(upstream.mock.callCount(), 0);
});

void test('crew proxy exposes only the private document path and blocks active content', async (t) => {
  const visitId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
  const fileId = '7e478ed3-3d44-41a5-8993-a69c8ed36249';
  const segments = ['visits', visitId, 'documents', fileId];
  let contentType = 'text/plain; charset=utf-8';
  let status = 200;
  const disposition = "attachment; filename*=UTF-8''fixture.txt";
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    assert.equal(destination.href, `http://127.0.0.1:3001/api/crew/visits/${visitId}/documents/${fileId}`);
    assert.equal(new Headers(init.headers).get('cookie'), 'crew_session=mock-crew-session');
    return Promise.resolve(new Response('fixture contents', {
      status, headers: { 'Content-Type': contentType, 'Content-Disposition': disposition },
    }));
  });
  const request = (method = 'GET') => new Request(origin, {
    method, headers: { Cookie: 'backoffice_session=mock-admin-session; crew_session=mock-crew-session' },
  });
  const download = await proxyCrewRequest(request(), segments);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('content-disposition'), disposition);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await download.text(), 'fixture contents');
  assert.equal((await proxyCrewRequest(request('POST'), segments)).status, 404);
  assert.equal((await proxyCrewRequest(request(), ['visits', visitId, 'documents', '..'])).status, 404);

  contentType = 'text/html';
  const unsafe = await proxyCrewRequest(request(), segments);
  assert.equal(unsafe.status, 502);
  assert.equal(unsafe.headers.get('content-type'), 'application/json');
  status = 404;
  const error = await proxyCrewRequest(request(), segments);
  assert.equal(error.status, 404);
  assert.equal(error.headers.get('content-type'), 'application/json');
  assert.equal(upstream.mock.callCount(), 3);
});
