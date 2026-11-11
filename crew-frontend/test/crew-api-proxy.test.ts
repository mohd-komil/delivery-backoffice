import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyCrewRequest } from '../src/_app/crew-api/proxy';

const origin = 'http://127.0.0.1:3002';

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
