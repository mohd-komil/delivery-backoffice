import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { estimateWorkMinutes } from '../src/domain/rules';
import { ApplyTimeStandardSchema, TimeStandardDetailSchema, TimeStandardFieldsSchema, TimeStandardSchema } from '../src/planning/time-standard-contracts';
import { RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { routeJob } from '../src/routing/service';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const fields = TimeStandardFieldsSchema.parse({
  name: 'Confirmed test chair operations', service: 'delivery_installation', unit: 'unit', category: 'Chairs',
  rates: { deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null },
  basis: 'elapsed_team_minutes', assumptions: 'Two people, ground-floor unloading; no waiting or travel.',
  exclusions: 'Travel, loading and waiting are separate.', examples: 'One chair: 10 delivery + 30 installation.',
  sourceReference: 'Isolated test dispatcher observation', status: 'confirmed', enabled: true,
});

void test('time standards validate service, units and the meaning of minutes before use', () => {
  assert.ok(TimeStandardFieldsSchema.safeParse(fields).success);
  for (const invalid of [
    { ...fields, assumptions: '' }, { ...fields, sourceReference: ' ' }, { ...fields, basis: 'unspecified' },
    { ...fields, rates: { ...fields.rates, installationMinutesPerUnit: null } },
    { ...fields, rates: { ...fields.rates, collectionMinutesPerUnit: 15 } },
  ]) assert.equal(TimeStandardFieldsSchema.safeParse(invalid).success, false);
  assert.ok(TimeStandardFieldsSchema.safeParse({ ...fields, status: 'draft', assumptions: '', sourceReference: '', basis: 'unspecified',
    rates: { deliveryMinutesPerUnit: null, installationMinutesPerUnit: null, collectionMinutesPerUnit: null } }).success);
  assert.equal(ApplyTimeStandardSchema.safeParse({ version: 1, requestId: randomUUID(), sourceLineId: 31,
    standardId: randomUUID(), standardVersion: 1, reason: '' }).success, false);
});

void test('planning catalogue commands enforce auth, immutable history, version and actor-bound retries', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1 });
    const path = '/planning/time-standards';
    const command = { ...fields, requestId: randomUUID(), reason: 'Record the agreed test observation' };
    assert.equal((await h.request(path, { method: 'POST', body: command, cookie: '' })).status, 401);
    assert.equal((await h.request(path, { method: 'POST', body: command, cookie: f.cookie })).status, 401);
    assert.equal((await h.request(path, { method: 'POST', body: command, origin: 'https://untrusted.example.test' })).status, 403);
    assert.equal((await h.request(path, { method: 'POST', body: { ...command, updatedBy: { id: randomUUID(), name: 'Forged' } } })).status, 400);
    const first = TimeStandardSchema.parse(await h.ok(path, { method: 'POST', body: command }));
    assert.deepEqual(TimeStandardSchema.parse(await h.ok(path, { method: 'POST', body: command })), first);
    assert.deepEqual(TimeStandardSchema.parse(await h.ok(path, { method: 'POST', body: { ...command, requestId: command.requestId.toUpperCase() } })), first);
    assert.equal((await h.request(path, { method: 'POST', body: { ...command, name: 'Changed retry' } })).status, 409);
    assert.equal((await h.request(path, { method: 'POST', body: command, cookie: h.adminCookie })).status, 409);
    const update = { ...fields, enabled: false, version: first.version, requestId: randomUUID(), reason: 'Temporarily unavailable' };
    const disabled = TimeStandardSchema.parse(await h.ok(`${path}/${first.id}`, { method: 'PATCH', body: update }));
    assert.equal(disabled.version, 2);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(TimeStandardSchema.parse(await h.ok(`${path}/${first.id}`, { method: 'PATCH', body: update })), disabled);
    assert.deepEqual(TimeStandardSchema.parse(await h.ok(`${path}/${first.id.toUpperCase()}`, { method: 'PATCH', body: { ...update, requestId: update.requestId.toUpperCase() } })), disabled);
    assert.deepEqual(TimeStandardSchema.parse(await h.ok(path, { method: 'POST', body: command })), first, 'Create retry preserves its original response');
    assert.equal((await h.request(`${path}/${first.id}`, { method: 'PATCH', body: { ...update, requestId: randomUUID() } })).status, 409);
    const detail = TimeStandardDetailSchema.parse(await h.ok(`${path}/${first.id}`));
    assert.equal(detail.history.length, 2);
    assert.deepEqual(detail.history[0]?.before, first);
    assert.deepEqual(detail.history[0]?.after, disabled);
    assert.deepEqual(detail.history[1]?.after, first);
    assert.equal(z.array(TimeStandardSchema).parse(await h.ok(path)).length, 1);
    assert.match((await h.request(path)).headers.get('cache-control') ?? '', /no-store/);
  } finally { await h.close(); }
});

void test('explicit standard application isolates identical SKUs and preserves copied versions through catalogue edits', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 2, service: 'delivery_installation' });
    const first = f.deliveries[0]; const second = f.deliveries[1]; assert.ok(first && second);
    const standard = TimeStandardSchema.parse(await h.ok('/planning/time-standards', { method: 'POST', body: { ...fields,
      requestId: randomUUID(), reason: 'Create an isolated confirmed estimate' } }));
    const path = `/deliveries/${first.id}/work-times/standard`;
    const command = { version: first.version, requestId: randomUUID(), sourceLineId: 31, standardId: standard.id,
      standardVersion: standard.version, reason: 'Use this observation for this exact order line' };
    const applied = DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: command }));
    assert.equal(applied.delivery.servicePlan?.timeEstimates?.length, 1);
    const saved = applied.delivery.servicePlan?.timeEstimates?.[0]; assert.ok(saved?.timeStandard);
    assert.equal(saved.timeStandard.version, 1);
    assert.equal(saved.sourceLineId, 31);
    assert.equal(saved.timeStandard.sourceReference, fields.sourceReference);
    assert.equal((await h.detail(second.id)).delivery.servicePlan?.timeEstimates?.length ?? 0, 0);
    assert.deepEqual(applied.delivery.source, first.source, 'The source remains read-only');
    const retry = DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: command }));
    assert.equal(retry.delivery.version, applied.delivery.version);
    assert.equal(retry.history.filter(({ action }) => action === 'work_times.standard_applied').length, 1);
    assert.equal((await h.request(path, { method: 'POST', body: command, cookie: h.adminCookie })).status, 409);
    const updated = TimeStandardSchema.parse(await h.ok(`/planning/time-standards/${standard.id}`, { method: 'PATCH', body: {
      ...fields, rates: { ...fields.rates, installationMinutesPerUnit: 40 }, version: 1, requestId: randomUUID(), reason: 'New observation' } }));
    assert.deepEqual((await h.detail(first.id)).delivery.servicePlan?.timeEstimates?.[0], saved, 'Editing a standard does not rewrite copied rates or provenance');
    assert.equal((await h.request(path, { method: 'POST', body: { ...command, version: applied.delivery.version, requestId: randomUUID(), sourceLineId: 32 } })).status, 409);
    const twice = DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: { ...command, version: applied.delivery.version,
      requestId: randomUUID(), sourceLineId: 32, standardVersion: updated.version } }));
    assert.equal(estimateWorkMinutes(twice.delivery, [31, 32].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 }))).minutes, 180);
    const nearby = RouteJobsSchema.parse(await h.ok(`/routes/jobs?anchorId=${first.id}&radiusKm=20`));
    assert.equal(nearby.anchorJob?.remainingWorkEstimate?.minutes, 180);
    const stop = f.draft.stops[0]; assert.ok(stop);
    const preview = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: { ...f.draft, stops: [{ ...stop,
      workDurationSource: 'remaining_estimate', workFingerprint: routeJob(twice.delivery).workFingerprint }] } }));
    assert.equal(preview.timeline.stops[0]?.workMinutes, 180);
    const manual = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/work-times`, { method: 'PATCH', body: {
      version: twice.delivery.version, sourceLineId: 31, ...fields.rates, deliveryMinutesPerUnit: 15 } }));
    assert.equal(manual.delivery.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === 31)?.timeStandard, undefined);
    assert.equal(manual.delivery.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === 32)?.timeStandard?.version, 2);
    assert.equal(TimeStandardDetailSchema.parse(await h.ok(`/planning/time-standards/${standard.id}`)).history[1]?.after.version, 1);
  } finally { await h.close(); }
});

void test('draft, disabled, person-minute, mismatched and started-work standards cannot be applied', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1, service: 'delivery_installation' });
    const first = f.deliveries[0]; assert.ok(first);
    const deliveryId = first.id;
    async function create(change: Partial<z.infer<typeof TimeStandardFieldsSchema>>) {
      return TimeStandardSchema.parse(await h.ok('/planning/time-standards', { method: 'POST', body: {
        ...fields, ...change, requestId: randomUUID(), reason: 'Test declared limitation' } }));
    }
    async function apply(id: string, standardVersion = 1) {
      const current = await h.detail(deliveryId);
      return h.request(`/deliveries/${deliveryId}/work-times/standard`, { method: 'POST', body: { version: current.delivery.version,
        requestId: randomUUID(), sourceLineId: 31, standardId: id, standardVersion, reason: 'Explicit application test' } });
    }
    for (const change of [{ status: 'draft' as const }, { enabled: false }, { basis: 'person_minutes' as const }]) {
      const response = await apply((await create(change)).id);
      assert.equal(response.status, 409);
      assert.equal(ErrorCode.parse(response.data).code, 'TIME_STANDARD_NOT_APPLICABLE');
    }
    for (const change of [{ unit: 'box' }, { service: 'delivery_only' as const, rates: { ...fields.rates, installationMinutesPerUnit: null } }]) {
      const response = await apply((await create(change)).id);
      assert.equal(ErrorCode.parse(response.data).code, 'TIME_STANDARD_CONTEXT_MISMATCH');
    }
    const valid = await create({});
    const published = await h.publish(f);
    const operations = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
    const stop = operations.stops[0]; assert.ok(stop);
    await h.confirm(first.id, stop.appointmentId);
    await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: operations.version, requestId: randomUUID() } });
    await h.start(stop.appointmentId, f.cookie);
    const locked = await apply(valid.id);
    assert.equal(locked.status, 409);
    assert.equal(ErrorCode.parse(locked.data).code, 'WORK_TIME_LOCKED');
  } finally { await h.close(); }
});
