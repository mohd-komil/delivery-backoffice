import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { LineWorkTimeStatusSchema, RemainingWorkEstimateSchema } from '../src/domain/model';
import { estimateWorkMinutes } from '../src/domain/rules';
import { apiDocument } from '../src/openapi';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { DeliveryStore } from '../src/operations/store';
import { RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema, RouteRevisionSchema } from '../src/routing/lifecycle-contracts';
import { routeJob } from '../src/routing/service';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const Detail = DeliveryDetail.extend({ remainingWorkEstimate: RemainingWorkEstimateSchema, lineWorkTimes: z.array(LineWorkTimeStatusSchema) });
const fields = { factorPercent: 150, visitMinutes: 5, deliveryMinutes: 7, installationMinutes: 11, collectionMinutes: null,
  sourceEstimateExcludesAdjustments: false, sourceReference: 'Isolated team observation',
  assumptions: 'Local unit times exclude the fixed visit and operation allowances.' };

void test('work-time adjustments enforce session, input, optimistic concurrency and actor-bound retry contracts', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 2, service: 'delivery_installation' });
    const first = f.deliveries[0]; const second = f.deliveries[1]; assert.ok(first && second);
    const path = `/deliveries/${first.id}/work-time-adjustments`;
    const command = { ...fields, version: first.version, requestId: randomUUID(), reason: 'Review this site estimate' };
    assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: '' })).status, 401);
    assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: f.cookie })).status, 401);
    assert.equal((await h.request(path, { method: 'PATCH', body: command, origin: 'https://untrusted.example.test' })).status, 403);
    for (const change of [{ factorPercent: 0 }, { factorPercent: 1001 }, { factorPercent: 1.5 }, { visitMinutes: -1 },
      { deliveryMinutes: 1441 }, { installationMinutes: 0.5 }, { collectionMinutes: '10' }, { sourceReference: ' ' },
      { assumptions: ' ' }, { reason: '' }, { sourceEstimateExcludesAdjustments: 'yes' }, { origin: 'source' }]) {
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, ...change } })).status, 400);
    }
    assert.equal((await h.request(`/deliveries/${randomUUID()}/work-time-adjustments`, { method: 'PATCH', body: command })).status, 404);
    const saved = Detail.parse(await h.ok(path, { method: 'PATCH', body: command }));
    assert.equal(saved.delivery.workTimeAdjustments?.version, 1);
    assert.equal(saved.delivery.version, first.version + 1);
    assert.equal(saved.remainingWorkEstimate.minutes, null, 'Source-total allowances require explicit exclusions acknowledgement');
    assert.deepEqual(saved.remainingWorkEstimate.calculation?.missingFields, ['sourceEstimateExcludesAdjustments']);
    assert.deepEqual(saved.delivery.source, first.source);
    assert.equal((await h.detail(second.id)).delivery.workTimeAdjustments, undefined, 'Same SKU on another Picking remains independent');
    const retry = Detail.parse(await h.ok(path, { method: 'PATCH', body: { ...command, requestId: command.requestId.toUpperCase() } }));
    assert.equal(retry.delivery.version, saved.delivery.version);
    assert.equal(retry.history.filter(({ action }) => action === 'work_times.adjustments_updated').length, 1);
    assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: h.adminCookie })).status, 409);
    assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, visitMinutes: 10 } })).status, 409);
    assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, requestId: randomUUID() } })).status, 409);
    const acknowledged = Detail.parse(await h.ok(path, { method: 'PATCH', body: { ...command, version: saved.delivery.version,
      requestId: randomUUID(), sourceEstimateExcludesAdjustments: true } }));
    assert.equal(acknowledged.remainingWorkEstimate.minutes, 113);
    assert.equal(acknowledged.delivery.workTimeAdjustments?.version, 2);
    assert.equal(acknowledged.delivery.workTimeAdjustments?.updatedBy.name, 'DEMO operator');
  } finally { await h.close(); }
});

void test('Inbox, Nearby and selected route work share allowances while manual durations and historical publication remain explicit', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1, service: 'delivery_installation' });
    const first = f.deliveries[0]; assert.ok(first);
    const deliveryId = first.id;
    async function read() { return Detail.parse(await h.ok(`/deliveries/${deliveryId}`)); }
    for (const [sourceLineId, deliveryMinutesPerUnit, installationMinutesPerUnit] of [[31, 10, 30], [32, 20, 40]]) {
      const current = await read();
      await h.ok(`/deliveries/${first.id}/work-times`, { method: 'PATCH', body: { version: current.delivery.version, sourceLineId,
        deliveryMinutesPerUnit, installationMinutesPerUnit, collectionMinutesPerUnit: null } });
    }
    async function save(change: Partial<typeof fields> = {}) {
      const current = await read();
      return Detail.parse(await h.ok(`/deliveries/${deliveryId}/work-time-adjustments`, { method: 'PATCH', body: { ...fields, ...change,
        version: current.delivery.version, requestId: randomUUID(), reason: 'Review exact local work and site context' } }));
    }
    let current = await save();
    assert.equal(current.remainingWorkEstimate.minutes, 323);
    assert.deepEqual(current.lineWorkTimes.map(({ remainingMinutes }) => remainingMinutes), [80, 120]);
    const listed = DeliveryListSchema.parse(await h.ok(`/deliveries?search=${encodeURIComponent(first.source.pickingName)}`));
    assert.deepEqual(listed.items.find(({ id }) => id === first.id)?.planning.remainingWorkEstimate, current.remainingWorkEstimate);
    const nearby = RouteJobsSchema.parse(await h.ok(`/routes/jobs?anchorId=${first.id}&radiusKm=20`));
    assert.deepEqual(nearby.anchorJob?.remainingWorkEstimate, current.remainingWorkEstimate);
    const stop = f.draft.stops[0]; assert.ok(stop);
    const estimated = { ...f.draft, stops: [{ ...stop, workDurationSource: 'remaining_estimate' as const,
      workFingerprint: routeJob(current.delivery).workFingerprint }] };
    const preview = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: estimated }));
    assert.equal(preview.timeline.stops[0]?.workMinutes, 323);
    const manual = { ...f.draft, stops: [{ ...stop, workMinutes: 123, workDurationSource: 'manual' as const,
      workFingerprint: routeJob(current.delivery).workFingerprint }] };
    current = await save({ factorPercent: 200 });
    const changedEstimate = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: estimated }));
    const changedManual = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: manual }));
    assert.equal(changedEstimate.timeline.stops[0]?.workMinutes, 423);
    assert.equal(changedManual.timeline.stops[0]?.workMinutes, 123);
    assert.ok(changedManual.feasibility.findings.some(({ code }) => code === 'work_changed_or_unreviewed'));
    stop.workMinutes = 123; stop.workFingerprint = routeJob(current.delivery).workFingerprint;
    const published = await h.publish(f);
    const revision = RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`));
    current = await save({ factorPercent: 200, visitMinutes: 15 });
    assert.deepEqual(RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`)), revision);
    const operations = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
    const visit = operations.stops[0]; assert.ok(visit);
    await h.confirm(first.id, visit.appointmentId);
    await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie,
      body: { version: operations.version, requestId: randomUUID() } });
    await h.start(visit.appointmentId, f.cookie);
    current = await read();
    const locked = await h.request(`/deliveries/${first.id}/work-time-adjustments`, { method: 'PATCH', body: { ...fields,
      version: current.delivery.version, requestId: randomUUID(), reason: 'Cannot change an active visit estimate' } });
    assert.equal(ErrorCode.parse(locked.data).code, 'WORK_TIME_LOCKED');
    await h.finish(visit.appointmentId, f.cookie, [
      { sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0 },
      { sourceLineId: 32, deliveredMilli: 1000, installedMilli: 1000, collectedMilli: 0 },
    ], [{ sourceLineId: 31, operation: 'installation', reason: 'time_shortage', note: 'Installation follows separately' }]);
    current = await read();
    const signed = structuredClone(current.delivery.appointments[0]?.results[0]); assert.ok(signed);
    assert.equal(estimateWorkMinutes(current.delivery, [{ sourceLineId: 31, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }]).minutes,
      86, 'One follow-up uses 30 × 200% + visit 15 + installation 11');
    current = await save({ factorPercent: 200, visitMinutes: 25 });
    assert.deepEqual(current.delivery.appointments[0]?.results[0], signed);
    assert.deepEqual(RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`)), revision);
    current = Detail.parse(await h.ok(`/deliveries/${first.id}/instructions`, { method: 'PATCH', body: {
      ...current.delivery.instructions, floor: 4, version: current.delivery.version } }));
    assert.equal(current.remainingWorkEstimate.minutes, null);
    assert.equal(current.remainingWorkEstimate.calculation?.adjustmentStatus, 'needs_review');
    current = await save({ factorPercent: 200, visitMinutes: 25 });
    assert.equal(current.remainingWorkEstimate.calculation?.adjustmentStatus, 'current');
  } finally { await h.close(); }
});

void test('source review and closed delivery prevent allowance changes without losing saved settings', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1 });
    const first = f.deliveries[0]; assert.ok(first);
    const store = new DeliveryStore(h.database);
    const body = { ...fields, version: first.version, requestId: randomUUID(), reason: 'Review this isolated setting' };
    const path = `/deliveries/${first.id}/work-time-adjustments`;
    await store.save(h.database.source.manager, { ...first, sourceReview: true });
    assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body })).data).code, 'SOURCE_REVIEW_REQUIRED');
    await store.save(h.database.source.manager, { ...first, completedAt: new Date().toISOString() });
    assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body })).data).code, 'DELIVERY_CLOSED');
    assert.equal((await h.detail(first.id)).delivery.workTimeAdjustments, undefined);
  } finally { await h.close(); }
});

void test('OpenAPI exposes the adjustment command and derived calculation on delivery detail', () => {
  const document = apiDocument();
  const operation = z.object({ security: z.array(z.record(z.string(), z.array(z.string()))), requestBody: z.object({ content:
    z.object({ 'application/json': z.object({ schema: z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) }) }) }) }),
  responses: z.record(z.string(), z.object({ content: z.object({ 'application/json': z.object({ schema: z.unknown() }) }).optional() }))
  }).parse(document.paths['/deliveries/{id}/work-time-adjustments']?.['patch']);
  assert.deepEqual(operation.security, [{ session: [] }]);
  const request = operation.requestBody.content['application/json'].schema;
  for (const name of ['version', 'requestId', 'reason', 'factorPercent', 'visitMinutes', 'sourceReference', 'assumptions']) {
    assert.ok(request.required.includes(name), name);
  }
  assert.deepEqual(operation.responses['200']?.content?.['application/json'].schema, { $ref: '#/components/schemas/DeliveryDetail' });
  const response = z.object({ properties: z.object({ remainingWorkEstimate: z.object({ properties: z.object({ calculation: z.object({
    properties: z.object({ algorithmVersion: z.object({ const: z.literal('remaining_work_v2') }) }) }) }) }) }) })
    .parse(document.components.schemas.DeliveryDetail);
  assert.equal(response.properties.remainingWorkEstimate.properties.calculation.properties.algorithmVersion.const, 'remaining_work_v2');
});
