import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { proxyCrewRequest } from '../src/_app/crew-api/proxy';
import { request } from '../src/shared/api/client';

const origin = 'http://127.0.0.1:3002';
const visitId = '7e478ed3-3d44-41a5-8993-a69c8ed36248';
const requestId = '7e478ed3-3d44-41a5-8993-a69c8ed36249';

void test('uncertain upstream failure does not retry silently and an explicit retry preserves the report identity', async (t) => {
  const report = JSON.stringify({ version: 7, requestId, reason: 'Customer absent; nothing handed over.' });
  const forwarded: string[] = [];
  const upstream = t.mock.method(globalThis, 'fetch', (destination: URL, init: RequestInit) => {
    assert.equal(destination.pathname, `/api/crew/visits/${visitId}/attempt-failure`);
    assert.equal(init.method, 'POST');
    assert.equal(typeof init.body, 'string');
    assert.equal(init.body, report);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    if (typeof init.body !== 'string') throw new Error('Expected serialized report');
    forwarded.push(init.body);
    if (forwarded.length === 1) throw new Error('Internal connection detail must not reach the browser');
    return Promise.resolve(Response.json({ status: 'failed', version: 8 }));
  });
  const command = () => new Request(origin, {
    method: 'POST', body: report,
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: 'crew_session=synthetic-session' },
  });

  const uncertain = await proxyCrewRequest(command(), ['visits', visitId, 'attempt-failure']);
  assert.equal(uncertain.status, 502);
  assert.equal(uncertain.headers.get('cache-control'), 'private, no-store');
  const problem: unknown = await uncertain.json();
  assert.deepEqual(problem, { statusCode: 502, message: 'Crew API could not be reached.' });
  assert.equal(upstream.mock.callCount(), 1, 'The proxy must not retry a command with an unknown outcome');

  const retried = await proxyCrewRequest(command(), ['visits', visitId, 'attempt-failure']);
  assert.equal(retried.status, 200);
  const result: unknown = await retried.json();
  assert.deepEqual(result, { status: 'failed', version: 8 });
  assert.deepEqual(forwarded, [report, report]);
});

void test('Crew client keeps commands unchanged across an explicit retry and rejects unvalidated success responses', async (t) => {
  const body = JSON.stringify({ version: 7, requestId, reason: 'Customer absent' });
  const calls: RequestInit[] = [];
  const responseSchema = z.object({ version: z.number().int().positive() });
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    assert.equal(path, `/api/crew/visits/${visitId}/attempt-failure`);
    calls.push(init);
    if (calls.length === 1) return Promise.reject(new TypeError('Network disconnected'));
    if (calls.length === 2) return Promise.resolve(Response.json({ version: '8' }));
    return Promise.resolve(Response.json({ version: 8 }));
  });
  const send = () => request(`/visits/${visitId}/attempt-failure`, responseSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });

  assert.deepEqual(await send(), { ok: false, status: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await send(), { ok: false, status: 502 });
  assert.equal(calls.length, 2, 'A malformed success response must not cause a hidden retry');
  assert.deepEqual(await send(), { ok: true, data: { version: 8 } });
  for (const call of calls) {
    assert.equal(call.body, body);
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.redirect, 'error');
  }
});
