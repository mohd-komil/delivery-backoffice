import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import { API_URL, apiRequest } from '../src/lib/api';
import { detailSchema, userSchema } from '../src/lib/contracts';
import { routeDraftInputSchema, routeJobsSchema, routeListSchema, routePreviewSchema, type RouteDraftInput } from '../src/lib/route-drafts';

// Explicit local stand smoke: only preview calculations and reads, no saved drafts or delivery mutations.
void test('Catania public-address routes recalculate directed travel, work and return through the real API', async () => {
  assert.equal(API_URL, 'http://127.0.0.1:3001/api');
  const raw: unknown = JSON.parse(await readFile('../backoffice-backend/.local/demo-accounts.json', 'utf8'));
  const { operator } = z.object({ operator: z.object({ email: z.email(), password: z.string() }) }).parse(raw);
  const origin = 'http://127.0.0.1:3000';
  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(operator),
  });
  assert.equal(login.status, 201);
  const loginBody: unknown = await login.json();
  assert.equal(userSchema.parse(loginBody).role, 'operator');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const options = { headers: { Cookie: cookie, Origin: origin } };
  try {
    const catalog = await apiRequest('/routes', routeListSchema, options);
    const jobs = await apiRequest('/routes/jobs', routeJobsSchema, options);
    const start = catalog.points.find(({ id }) => id === 'demo-start-catania');
    const first = jobs.jobs.find(({ pickingName }) => pickingName === 'DEMO/OUT/0003');
    const second = jobs.jobs.find(({ pickingName }) => pickingName === 'DEMO/OUT/0009');
    assert.ok(start && first && second, 'The public Catania demo and local departure must be available');
    assert.equal(first.address, "Piazza San Francesco d'Assisi 3");
    assert.equal(second.address, 'Piazza Federico II di Svevia');
    const before = await Promise.all([first, second].map(({ deliveryId }) => apiRequest(`/deliveries/${deliveryId}`, detailSchema, options)));
    const base = routeDraftInputSchema.parse({
      name: 'DEMO Catania timing preview', departAt: '2026-11-10T09:00:00+01:00',
      crewId: null, vehicleId: null, startPointId: start.id, endPointId: start.id, useLocalEstimates: true,
      stops: [{ deliveryId: first.deliveryId, workMinutes: 40 }, { deliveryId: second.deliveryId, workMinutes: 35 }], manualEstimates: [],
    });
    const preview = (input: RouteDraftInput) => apiRequest('/routes/preview', routePreviewSchema, {
      ...options, method: 'POST', body: JSON.stringify({ ...input, useGoogleRoads: false }),
    });
    const local = await preview(base);
    assert.equal(local.road, undefined);
    assert.ok(local.timeline.returnAt);
    assert.ok(local.timeline.stops.every(({ travelSource }) => travelSource === 'local_demo'));
    assert.equal(local.timeline.returnTravelSource, 'local_demo');
    assert.equal(local.timeline.workMinutes, 75);
    const withoutEstimates = await preview({ ...base, useLocalEstimates: false });
    assert.equal(withoutEstimates.timeline.returnAt, null, 'Unknown legs must not become zero minutes');
    const contexts = new Map(local.pointContexts.map(({ pointId, ...context }) => [pointId, context]));
    const manual = (fromPointId: string, toPointId: string, minutes: number) => {
      const from = contexts.get(fromPointId);
      const to = contexts.get(toPointId);
      assert.ok(from && to);
      return { fromPointId, toPointId, minutes, context: { from, to } };
    };
    const directed = {
      ...base,
      manualEstimates: [
        manual(start.id, first.deliveryId, 30), manual(first.deliveryId, second.deliveryId, 20), manual(second.deliveryId, start.id, 25),
        manual(start.id, second.deliveryId, 42), manual(second.deliveryId, first.deliveryId, 28), manual(first.deliveryId, start.id, 22),
      ],
    };
    const forward = await preview(directed);
    assert.deepEqual(forward.warnings, []);
    assert.equal(forward.timeline.stops[0]?.eta, '2026-11-10T08:30:00.000Z');
    assert.equal(forward.timeline.stops[1]?.eta, '2026-11-10T09:30:00.000Z');
    assert.equal(forward.timeline.returnAt, '2026-11-10T10:30:00.000Z');
    assert.equal(forward.timeline.totalMinutes, 150);
    const reversedInput = { ...directed, stops: [...directed.stops].reverse() };
    const reversed = await preview(reversedInput);
    assert.equal(reversed.timeline.returnAt, '2026-11-10T10:47:00.000Z');
    assert.equal(reversed.timeline.totalMinutes, 167);
    assert.equal(reversed.timeline.stops[0]?.deliveryId, second.deliveryId);
    assert.equal(reversed.timeline.stops[0]?.travelMinutes, 42);
    const longer = await preview({ ...reversedInput, stops: reversedInput.stops.map((stop, index) => ({
      ...stop, workMinutes: stop.workMinutes === null ? null : stop.workMinutes + (index === 0 ? 10 : 0),
    })) });
    assert.equal(longer.timeline.returnAt, '2026-11-10T10:57:00.000Z');
    assert.equal(longer.timeline.totalMinutes, 177);
    const later = await preview({ ...directed, departAt: '2026-11-10T10:00:00+01:00' });
    assert.equal(later.timeline.returnAt, '2026-11-10T11:30:00.000Z');
    assert.deepEqual(await Promise.all([first, second].map(({ deliveryId }) => apiRequest(`/deliveries/${deliveryId}`, detailSchema, options))), before);
    assert.deepEqual((await apiRequest('/routes', routeListSchema, options)).drafts, catalog.drafts);
  } finally {
    const logout = await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 201);
  }
});
