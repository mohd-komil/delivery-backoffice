import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { LineWorkTimeStatusSchema, type WorkTimeRates } from '../src/domain/model';
import { estimateWorkMinutes } from '../src/domain/rules';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { DeliveryStore } from '../src/operations/store';
import { RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema, RouteRevisionSchema } from '../src/routing/lifecycle-contracts';
import { routeJob } from '../src/routing/service';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const Detail = DeliveryDetail.extend({ lineWorkTimes: z.array(LineWorkTimeStatusSchema) });
const rates: WorkTimeRates = { deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null };

void test('local work times use authenticated versioned commands and the shared remaining-work calculation', async (context) => {
  const h = await lifecycleFixture();
  try {
    async function read(id: string) { return Detail.parse(await h.ok(`/deliveries/${id}`)); }
    async function save(id: string, sourceLineId: number, values: WorkTimeRates) {
      const current = await read(id);
      return Detail.parse(await h.ok(`/deliveries/${id}/work-times`, { method: 'PATCH', body: { version: current.delivery.version, sourceLineId, ...values } }));
    }

    await context.test('auth, Origin, strict quantities and optimistic versions protect exact order-line estimates', async () => {
      const f = await h.fixture({ count: 2, service: 'delivery_installation' });
      const first = f.deliveries[0]; const second = f.deliveries[1]; assert.ok(first && second);
      const path = `/deliveries/${first.id}/work-times`;
      const input = { version: first.version, sourceLineId: 31, ...rates };
      assert.equal((await h.request(path, { method: 'PATCH', body: input, cookie: '' })).status, 401);
      assert.equal((await h.request(path, { method: 'PATCH', body: input, cookie: f.cookie })).status, 401);
      assert.equal((await h.request(path, { method: 'PATCH', body: input, origin: 'https://untrusted.example.test' })).status, 403);
      for (const value of [0, -1, 0.5, 1441]) assert.equal((await h.request(path, { method: 'PATCH', body: { ...input, deliveryMinutesPerUnit: value } })).status, 400);
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...input, origin: 'source' } })).status, 400);
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...input, sourceLineId: 999 } })).status, 404);
      let detail = Detail.parse(await h.ok(path, { method: 'PATCH', body: input }));
      assert.equal(detail.lineWorkTimes[0]?.remainingMinutes, 80);
      assert.equal(detail.lineWorkTimes[0]?.basis, 'local');
      assert.equal((await h.request(path, { method: 'PATCH', body: input })).status, 409);
      detail = await save(first.id, 32, { ...rates, deliveryMinutesPerUnit: 20, installationMinutesPerUnit: 40 });
      assert.deepEqual(detail.delivery.source, first.source);
      assert.equal(detail.history.filter(({ action }) => action === 'work_times.updated').length, 2);
      assert.equal(detail.lineWorkTimes[1]?.remainingMinutes, 120);
      assert.equal((await read(second.id)).lineWorkTimes[0]?.deliveryMinutesPerUnit, null);
      const listed = DeliveryListSchema.parse(await h.ok(`/deliveries?search=${encodeURIComponent(first.source.pickingName)}`));
      assert.equal(listed.items.find(({ id }) => id === first.id)?.planning.remainingWorkEstimate.minutes, 200);
      const nearby = RouteJobsSchema.parse(await h.ok(`/routes/jobs?anchorId=${first.id}&radiusKm=20`));
      assert.equal(nearby.anchorJob?.remainingWorkEstimate?.minutes, 200);
      assert.equal(nearby.anchorJob?.remainingWorkEstimate?.basis, 'local_operation_rates');
      assert.equal(nearby.jobs.find(({ deliveryId }) => deliveryId === second.id)?.remainingWorkEstimate?.basis, 'proportional_remaining_operations');
      const draft = { ...f.draft, stops: [{ ...f.draft.stops[0], deliveryId: first.id, workDurationSource: 'remaining_estimate',
        workMinutes: 999, workFingerprint: routeJob(detail.delivery).workFingerprint }] };
      const preview = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft }));
      assert.equal(preview.timeline.stops[0]?.workMinutes, 200);
      await save(first.id, 31, { ...rates, installationMinutesPerUnit: 35 });
      const stale = RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft }));
      assert.equal(stale.timeline.stops[0]?.workMinutes, 210);
      assert.ok(stale.feasibility.findings.some(({ code }) => code === 'work_changed_or_unreviewed'));
    });

    await context.test('published timings and signed reports remain immutable; repeats estimate only residual operations', async () => {
      const f = await h.fixture({ count: 1, service: 'delivery_installation' });
      const first = f.deliveries[0]; assert.ok(first);
      await save(first.id, 31, rates);
      let detail = await save(first.id, 32, { ...rates, deliveryMinutesPerUnit: 20, installationMinutesPerUnit: 40 });
      const stop = f.draft.stops[0]; assert.ok(stop);
      stop.workFingerprint = routeJob(detail.delivery).workFingerprint;
      const published = await h.publish(f);
      const revision = RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`));
      detail = await save(first.id, 31, { ...rates, deliveryMinutesPerUnit: 11 });
      assert.deepEqual(RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`)), revision);
      await save(first.id, 31, rates);
      const route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
      const visit = route.stops[0]; assert.ok(visit);
      await h.confirm(first.id, visit.appointmentId);
      await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
      await h.start(visit.appointmentId, f.cookie);
      detail = await read(first.id);
      assert.ok(detail.lineWorkTimes.every(({ canEdit }) => !canEdit));
      const locked = await h.request(`/deliveries/${first.id}/work-times`, { method: 'PATCH', body: { version: detail.delivery.version, sourceLineId: 31, ...rates } });
      assert.equal(ErrorCode.parse(locked.data).code, 'WORK_TIME_LOCKED');
      await h.finish(visit.appointmentId, f.cookie, [
        { sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0 },
        { sourceLineId: 32, deliveredMilli: 1000, installedMilli: 1000, collectedMilli: 0 },
      ], [{ sourceLineId: 31, operation: 'installation', reason: 'time_shortage', note: 'Assembly requires a separate visit' }]);
      detail = await read(first.id);
      const report = detail.delivery.appointments[0]?.results[0]; assert.ok(report);
      assert.equal(report.servicePlanSnapshot?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === 31)?.installationMinutesPerUnit, 30);
      assert.equal(detail.lineWorkTimes.find(({ sourceLineId }) => sourceLineId === 31)?.remainingMinutes, 70);
      assert.equal(detail.lineWorkTimes.find(({ sourceLineId }) => sourceLineId === 32)?.remainingMinutes, 60);
      detail = await save(first.id, 31, { ...rates, installationMinutesPerUnit: 35 });
      assert.deepEqual(detail.delivery.appointments[0]?.results[0], report);
      const repeat = { sourceLineId: 31, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 };
      assert.equal(estimateWorkMinutes(detail.delivery, [repeat]).minutes, 35);
      detail = Detail.parse(await h.ok(`/deliveries/${first.id}/appointments`, { method: 'POST', body: {
        version: detail.delivery.version, requestId: randomUUID(), startsAt: '2031-02-01T08:00:00Z', endsAt: '2031-02-01T09:00:00Z', workLines: [repeat] } }));
      const repeatVisit = detail.delivery.appointments.find(({ id }) => id !== visit.appointmentId); assert.ok(repeatVisit);
      const repeatJob = routeJob(detail.delivery, undefined, repeatVisit.id);
      assert.equal(repeatJob.remainingWorkEstimate?.minutes, 35);
      assert.equal(repeatJob.remaining[0]?.deliveryMilli, 0);
      assert.equal(repeatJob.remaining[0]?.installationMilli, 1000);
    });

    await context.test('unknown service, source review and closure remain explicit edit boundaries', async () => {
      const f = await h.fixture({ count: 1 });
      const first = f.deliveries[0]; assert.ok(first);
      const store = new DeliveryStore(h.database);
      const unknown = { ...first, servicePlan: { defaultService: null, overrides: [] }, source: { ...first.source, serviceType: null, estimatedMinutes: null } };
      await store.save(h.database.source.manager, unknown);
      const path = `/deliveries/${first.id}/work-times`;
      const body = { version: first.version, sourceLineId: 31, deliveryMinutesPerUnit: 5, installationMinutesPerUnit: null, collectionMinutesPerUnit: null };
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body })).data).code, 'SERVICE_REQUIRED');
      let detail = Detail.parse(await h.ok(`/deliveries/${first.id}/services`, { method: 'PATCH', body: { version: first.version, defaultService: 'delivery_only' } }));
      detail = Detail.parse(await h.ok(path, { method: 'PATCH', body: { ...body, version: detail.delivery.version } }));
      assert.equal(detail.lineServices[0]?.serviceOrigin, 'local');
      assert.equal(detail.lineWorkTimes[0]?.remainingMinutes, 10);
      await store.save(h.database.source.manager, { ...detail.delivery, sourceReview: true });
      assert.equal((await read(first.id)).lineWorkTimes[0]?.canEdit, false);
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...body, version: detail.delivery.version } })).data).code, 'SOURCE_REVIEW_REQUIRED');
      await store.save(h.database.source.manager, { ...detail.delivery, completedAt: new Date().toISOString() });
      assert.equal((await read(first.id)).lineWorkTimes[0]?.canEdit, false);
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...body, version: detail.delivery.version } })).data).code, 'DELIVERY_CLOSED');
    });
  } finally { await h.close(); }
});
