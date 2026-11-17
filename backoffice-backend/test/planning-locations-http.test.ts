import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { PlanningLocationDetailSchema, PlanningLocationFieldsSchema, PlanningLocationsSchema, type PlanningLocation } from '../src/planning/location-contracts';
import { RouteDetailSchema, RouteDraftListSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteAmendReviewSchema, RouteOperationsSchema, RouteRevisionSchema } from '../src/routing/lifecycle-contracts';
import { PublicationReviewSchema, PublicationSummarySchema } from '../src/routing/publication-contracts';
import { ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const fields = (name = 'Isolated test warehouse') => PlanningLocationFieldsSchema.parse({ name, kind: 'warehouse',
  address: { street: 'Test street 1', city: 'Catania', province: 'CT', postalCode: '95100', country: 'IT' },
  point: { latitude: 37.515, longitude: 15.083 }, unloadingEntrance: null, coordinateSource: 'manual',
  verification: 'operator_confirmed', enabled: true, demo: false });

void test('shared planning locations preserve history, normal authorization and route endpoint provenance', async (context) => {
  const h = await lifecycleFixture();
  async function create(input = fields()) {
    return PlanningLocationDetailSchema.parse(await h.ok('/planning/locations', { method: 'POST', body: { ...input, requestId: randomUUID(), reason: 'Isolated test location' } }));
  }
  async function change(location: PlanningLocation, patch: Partial<z.infer<typeof PlanningLocationFieldsSchema>>) {
    // The saved record is trusted, but explicitly strip metadata for the editable request boundary.
    const input = PlanningLocationFieldsSchema.strip().parse({ ...location, ...patch });
    return PlanningLocationDetailSchema.parse(await h.ok(`/planning/locations/${location.id}`, { method: 'PATCH',
      body: { ...input, version: location.version, requestId: randomUUID(), reason: 'Isolated test revision' } }));
  }
  async function live(id: string) { return RouteOperationsSchema.parse(await h.ok(`/routes/${id}/operations`)); }
  try {
    await context.test('existing four demo points migrate once; guards, receipts, conflicts and immutable history are enforced', async () => {
      const initial = PlanningLocationsSchema.parse(await h.ok('/planning/locations'));
      assert.equal(initial.locations.length, 4);
      assert.ok(initial.locations.every(({ demo, version, updatedBy }) => demo && version === 1 && updatedBy === null));
      assert.equal(initial.locations.find(({ id }) => id === 'demo-start-catania')?.point?.latitude, 37.5154798);
      const f = await h.fixture({ count: 1 });
      const body = { ...fields(), requestId: randomUUID(), reason: 'Create with an explicit operator confirmation' };
      assert.equal((await h.request('/planning/locations', { cookie: '' })).status, 401);
      assert.equal((await h.request('/planning/locations', { cookie: f.cookie })).status, 401);
      assert.equal((await h.request('/planning/locations', { method: 'POST', body, origin: 'https://untrusted.example.test' })).status, 403);
      for (const invalid of [{ reason: '' }, { confirmedBy: { id: randomUUID(), name: 'spoof' } }, { coordinateSource: 'public_demo' }, { point: null }]) {
        assert.equal((await h.request('/planning/locations', { method: 'POST', body: { ...body, ...invalid } })).status, 400);
      }
      const saved = PlanningLocationDetailSchema.parse(await h.ok('/planning/locations', { method: 'POST', body }));
      assert.equal(saved.location.id, body.requestId); assert.equal(saved.location.confirmedBy?.name, 'DEMO operator');
      assert.equal(saved.history.length, 1);
      assert.deepEqual(await h.ok('/planning/locations', { method: 'POST', body }), saved);
      assert.equal((await h.request('/planning/locations', { method: 'POST', body, cookie: h.adminCookie })).status, 409);
      const original = structuredClone(saved.history[0]);
      const update = { ...fields('Renamed test warehouse'), version: saved.location.version, requestId: randomUUID(), reason: 'Explain the rename' };
      const path = `/planning/locations/${saved.location.id}`;
      const responses = await Promise.all([h.request(path, { method: 'PATCH', body: update }), h.request(path, { method: 'PATCH', body: { ...update, requestId: randomUUID() } })]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
      const current = PlanningLocationDetailSchema.parse(await h.ok(path));
      assert.equal(current.location.version, 2); assert.deepEqual(current.history[1], original);
      const winner = responses[0]?.status === 200 ? update : null;
      if (winner) assert.deepEqual(await h.ok(path, { method: 'PATCH', body: winner }), current);
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...update, requestId: randomUUID() } })).status, 409);
      await h.database.source.runMigrations({ transaction: 'all' });
      assert.equal(PlanningLocationDetailSchema.parse(await h.ok(path)).location.name, 'Renamed test warehouse');
      const doc = z.object({ paths: z.record(z.string(), z.object({ get: z.object({ parameters: z.array(z.object({ name: z.string(), schema: z.object({ pattern: z.string().optional() }) })) }).optional() })) }).parse(await h.ok('/openapi.json'));
      assert.equal(doc.paths['/planning/locations/{id}']?.get?.parameters[0]?.schema.pattern, '^[a-z0-9][a-z0-9-]{0,79}$');
    });

    await context.test('independent departure and return use unloading points; unknown/disabled coordinates remain unpublishable', async () => {
      const f = await h.fixture({ count: 1 });
      const start = await create(fields('Separate start'));
      const end = await create({ ...fields('Separate return'), unloadingEntrance: { point: { latitude: 37.53, longitude: 15.07 }, note: 'Use test unloading entrance' } });
      const draft = { ...f.draft, startPointId: start.location.id, endPointId: end.location.id };
      let preview = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft }));
      assert.equal(preview.locations?.start.id, start.location.id); assert.equal(preview.locations?.end.id, end.location.id);
      assert.equal(preview.pointContexts.find(({ pointId }) => pointId === end.location.id)?.point?.latitude, 37.53);
      assert.ok(preview.timeline.returnAt);
      const unverified = await change(start.location, { verification: 'unverified' });
      preview = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft }));
      assert.ok(preview.feasibility.findings.some(({ code }) => code === 'location_unverified'));
      const saved = RouteDetailSchema.parse(await h.ok('/routes', { method: 'POST', body: { ...draft, requestId: randomUUID() } }));
      const input = { version: saved.version, stops: f.deliveries.map(({ id }) => ({ mode: 'create', deliveryId: id,
        responsibleParticipantId: f.participant.id, workLines: f.workLines, templateIds: [f.template.id] })) };
      const review = PublicationReviewSchema.parse(await h.ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: input }));
      assert.equal(review.feasibility.status, 'insufficient_data');
      assert.equal((await h.request(`/routes/${saved.id}/publish`, { method: 'POST', body: { ...input, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true } })).status, 409);
      const disabled = await change(unverified.location, { enabled: false });
      assert.ok(RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft })).feasibility.findings.some(({ code }) => code === 'location_disabled'));
      const missing = await change(disabled.location, { enabled: true, point: null });
      assert.ok(RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft })).feasibility.findings.some(({ code }) => code === 'location_point_missing'));
      assert.ok(RouteDraftListSchema.parse(await h.ok('/routes')).points.every(({ id }) => id !== missing.location.id));
    });

    await context.test('editing an endpoint invalidates reviewed manual leg context and publication fingerprints', async () => {
      const f = await h.fixture({ count: 1 }); const location = await create(fields('Mutable start'));
      f.draft.startPointId = location.location.id; f.draft.endPointId = location.location.id;
      const initial = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: f.draft }));
      const stop = f.draft.stops[0]; assert.ok(stop);
      const from = initial.pointContexts.find(({ pointId }) => pointId === location.location.id);
      const to = initial.pointContexts.find(({ pointId }) => pointId === stop.deliveryId); assert.ok(from && to);
      const context = { from: { point: from.point, addressKey: from.addressKey }, to: { point: to.point, addressKey: to.addressKey } };
      const manual = { ...f.draft, manualEstimates: [{ fromPointId: location.location.id, toPointId: stop.deliveryId, minutes: 20, context }] };
      const saved = RouteDetailSchema.parse(await h.ok('/routes', { method: 'POST', body: { ...f.draft, requestId: randomUUID() } }));
      const input = { version: saved.version, stops: f.deliveries.map(({ id }) => ({ mode: 'create', deliveryId: id,
        responsibleParticipantId: f.participant.id, workLines: f.workLines, templateIds: [f.template.id] })) };
      const review = PublicationReviewSchema.parse(await h.ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: input }));
      await change(location.location, { point: { latitude: 37.518, longitude: 15.084 } });
      const changed = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: manual }));
      assert.ok(changed.warnings.some(({ code }) => code === 'manual_estimate_stale'));
      assert.notEqual(changed.feasibility.fingerprint, initial.feasibility.fingerprint);
      const rejected = await h.request(`/routes/${saved.id}/publish`, { method: 'POST', body: { ...input, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true } });
      assert.equal(rejected.status, 409);
      assert.equal(ErrorCode.parse(rejected.data).code, 'ROUTE_PREVIEW_STALE');
      const fresh = PublicationReviewSchema.parse(await h.ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: input }));
      PublicationSummarySchema.parse(await h.ok(`/routes/${saved.id}/publish`, { method: 'POST', body: { ...input, requestId: randomUUID(), fingerprint: fresh.fingerprint, acknowledgeEstimates: true } }));
    });

    await context.test('published endpoints stay frozen; amendment adopts changes while departed work and return remain possible', async () => {
      const f = await h.fixture({ count: 1 }); const location = await create(fields('Frozen endpoint'));
      f.draft.startPointId = location.location.id; f.draft.endPointId = location.location.id;
      const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      await h.confirm(stop.deliveryId, stop.appointmentId);
      const originalRevision = await h.ok(`/routes/${route.id}/revisions/1`);
      const original = await live(route.id); assert.equal(original.capabilities.canDepart, true);
      const edited = await change(location.location, { name: 'Revised endpoint', point: { latitude: 37.516, longitude: 15.083 } });
      const stale = await live(route.id);
      assert.equal(stale.capabilities.canDepart, false);
      assert.equal(stale.resources.start.name, 'Frozen endpoint');
      assert.equal((await h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: stale.version, requestId: randomUUID() } })).status, 409);
      const command = { version: stale.version, reason: 'Review the updated start and return point', confirmNotDeparted: true, confirmNotLoaded: true,
        plan: stale.draft, responsibleParticipants: [{ appointmentId: stop.appointmentId, participantId: f.participant.id }] };
      const review = RouteAmendReviewSchema.parse(await h.ok(`/routes/${route.id}/amend-review`, { method: 'POST', body: command }));
      assert.equal(review.review.locations?.start.version, edited.location.version);
      const amended = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/amend`, { method: 'POST', body: { ...command,
        requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true } }));
      assert.equal(amended.resources.start.name, 'Revised endpoint');
      await h.confirm(stop.deliveryId, stop.appointmentId);
      let state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie,
        body: { version: amended.version, requestId: randomUUID() } }));
      await change(edited.location, { enabled: false });
      await h.start(stop.appointmentId, f.cookie);
      await h.finish(stop.appointmentId, f.cookie, f.workLines.map(({ sourceLineId }) => ({ sourceLineId, deliveredMilli: 1000 })));
      state = await live(route.id);
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/returning`, { method: 'POST', cookie: f.cookie, body: { version: state.version, requestId: randomUUID() } }));
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/return`, { method: 'POST', cookie: f.cookie,
        body: { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'Returned despite later catalogue edit' } }));
      assert.equal(state.status, 'returned');
      assert.deepEqual(await h.ok(`/routes/${route.id}/revisions/1`), originalRevision);
      assert.equal(RouteRevisionSchema.parse(originalRevision).data.review.locations?.start.name, 'Frozen endpoint');
    });
  } finally { await h.close(); }
});
