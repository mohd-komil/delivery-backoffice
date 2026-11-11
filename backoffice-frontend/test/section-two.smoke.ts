import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import { API_URL, apiRequest } from '../src/lib/api';
import { deliveryListSchema, detailSchema, userSchema } from '../src/lib/contracts';
import { inboxMapSchema } from '../src/lib/inbox-map';
import { routeJobsSchema } from '../src/lib/route-drafts';

void test('local demo list, map and nearby expose consistent remaining work and current visits', async () => {
  assert.equal(API_URL, 'http://127.0.0.1:3001/api', 'This smoke targets only the local demo');
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
    const list = await apiRequest('/deliveries', deliveryListSchema, options);
    const deliveries = [...list.items];
    for (let page = 2; page <= Math.ceil(list.total / list.pageSize); page++) {
      const next = await apiRequest(`/deliveries?page=${page}`, deliveryListSchema, options);
      deliveries.push(...next.items);
    }
    assert.ok(deliveries.length > 0);
    const jobs = await apiRequest('/routes/jobs', routeJobsSchema, options);
    for (const delivery of deliveries) {
      const { planning } = delivery;
      assert.ok(planning, 'Deployed backend must supply the new planning summary');
      const detail = await apiRequest(`/deliveries/${delivery.id}`, detailSchema, options);
      assert.equal(planning.status, detail.progress);
      const active = delivery.appointments.filter((visit) => visit.status === 'booked' || visit.status === 'in_progress');
      assert.deepEqual(planning.activeVisits.map((visit) => visit.id).sort(), active.map((visit) => visit.id).sort());
      for (const visit of planning.activeVisits) {
        const actual = active.find(({ id }) => id === visit.id);
        assert.ok(actual);
        assert.equal(visit.startsAt, actual.startsAt);
        assert.equal(visit.endsAt, actual.endsAt);
        assert.deepEqual(visit.crews.map(({ id }) => id).sort(), [...new Set(actual.assignments.map(({ crewId }) => crewId))].sort());
      }
      const job = jobs.jobs.find(({ deliveryId }) => deliveryId === delivery.id);
      if (job) assert.deepEqual(job.remainingWorkEstimate, planning.remainingWorkEstimate);
    }
    const map = await apiRequest('/deliveries/map?view=inbox', inboxMapSchema, options);
    assert.ok(map.markers.length > 0);
    // Fixed Sicily area independently covers Catania and excludes Messina.
    const areaQuery = 'north=37.7&south=37.3&east=15.3&west=14.9';
    const expectedIds = map.markers.filter(({ point }) => point.latitude >= 37.3 && point.latitude <= 37.7
      && point.longitude >= 14.9 && point.longitude <= 15.3).map(({ deliveryId }) => deliveryId).sort();
    assert.ok(expectedIds.length > 0 && expectedIds.length < map.markers.length);
    const [areaMap, areaList] = await Promise.all([
      apiRequest(`/deliveries/map?view=inbox&${areaQuery}`, inboxMapSchema, options),
      apiRequest(`/deliveries?view=inbox&${areaQuery}`, deliveryListSchema, options),
    ]);
    const areaIds = areaList.items.map(({ id }) => id);
    for (let page = 2; page <= Math.ceil(areaList.total / areaList.pageSize); page++) {
      const next = await apiRequest(`/deliveries?view=inbox&${areaQuery}&page=${page}`, deliveryListSchema, options);
      areaIds.push(...next.items.map(({ id }) => id));
    }
    assert.deepEqual(areaIds.sort(), expectedIds);
    assert.deepEqual(areaMap.markers.map(({ deliveryId }) => deliveryId).sort(), expectedIds);
    assert.equal(areaList.area?.excludedMissingCoordinates, map.missingCount);
    assert.equal(areaMap.area?.excludedMissingCoordinates, map.missingCount);
    const combined = await apiRequest(`/deliveries?view=inbox&city=Messina&${areaQuery}`, deliveryListSchema, options);
    assert.equal(combined.total, 0);
    assert.equal((await fetch(`${API_URL}/deliveries?view=inbox&north=37.7`, options)).status, 400);
    assert.equal((await fetch(`${API_URL}/deliveries/map?view=inbox&${areaQuery}`)).status, 401);
  } finally {
    const logout = await fetch(`${API_URL}/auth/logout`, {
      method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(logout.status, 201);
  }
});
