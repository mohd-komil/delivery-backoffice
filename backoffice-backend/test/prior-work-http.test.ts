import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { PriorWorkStatusSchema } from '../src/domain/model';
import { CrewVisitDetailSchema } from '../src/crew/contracts';
import { deliveredMilli, priorWorkReviewReasons } from '../src/domain/rules';
import { DeliveryStore } from '../src/operations/store';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { routeJob } from '../src/routing/service';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const Detail = DeliveryDetail.extend({ priorWork: PriorWorkStatusSchema, closureBlockers: z.array(z.string()), progress: z.string() });

void test('prior work uses authorized exact-line opening balances throughout planning, Crew and closure', async (context) => {
  const h = await lifecycleFixture();
  const store = new DeliveryStore(h.database);
  async function read(id: string) { return Detail.parse(await h.ok(`/deliveries/${id}`)); }
  async function input(id: string, sourceLineId: number, delivered = 0, installed = 0, collected = 0) {
    return { version: (await read(id)).delivery.version, requestId: randomUUID(), sourceLineId, deliveredMilli: delivered,
      installedMilli: installed, collectedMilli: collected, sourceReference: 'Synthetic signed warehouse record REF-14',
      reason: 'Operator verified the work belongs to this current picking line, not an earlier backorder', acknowledgeCurrentPicking: true };
  }
  async function save(id: string, sourceLineId: number, delivered = 0, installed = 0, collected = 0) {
    return Detail.parse(await h.ok(`/deliveries/${id}/prior-work`, { method: 'PATCH', body: await input(id, sourceLineId, delivered, installed, collected) }));
  }
  try {
    await context.test('unknown is not zero; authorization, validated quantities, replay and immutable replacement revisions', async () => {
      const f = await h.fixture({ count: 2, service: 'delivery_installation' });
      const first = f.deliveries[0]; const second = f.deliveries[1]; assert.ok(first && second);
      const initial = await read(first.id);
      assert.ok(initial.priorWork.lines.every(({ status, current }) => status === 'unknown' && current === null));
      assert.equal(initial.lineServices[0]?.remainingDeliveryMilli, 2000);
      const path = `/deliveries/${first.id}/prior-work`;
      const command = await input(first.id, 31, 1000);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: '' })).status, 401);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: f.cookie })).status, 401);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, origin: 'https://untrusted.example.test' })).status, 403);
      for (const invalid of [{ deliveredMilli: -1 }, { deliveredMilli: 0.5 }, { sourceReference: ' ' }, { reason: '' },
        { acknowledgeCurrentPicking: false }, { sourceItem: first.source.items[0] }]) {
        assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, ...invalid } })).status, 400);
      }
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...command, deliveredMilli: 2001 } })).data).code, 'EXCESS_PRIOR_WORK');
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...command, installedMilli: 1001 } })).data).code, 'INSTALLATION_REQUIRES_DELIVERY');
      let detail = Detail.parse(await h.ok(path, { method: 'PATCH', body: command }));
      const revision = detail.delivery.priorWorkRevisions?.[0]; assert.ok(revision);
      assert.equal(revision.saleOrderId, first.source.items[0]?.saleOrderId);
      assert.equal(revision.confirmedBy.name, 'DEMO operator');
      assert.equal(detail.priorWork.lines[0]?.status, 'confirmed');
      assert.equal(detail.priorWork.lines[0]?.crewDeliveredMilli, 0);
      assert.equal(detail.lineServices[0]?.remainingDeliveryMilli, 1000);
      assert.equal(detail.lineServices[1]?.remainingDeliveryMilli, 2000, 'The same SKU from another order remains separate');
      assert.equal((await read(second.id)).lineServices[0]?.remainingDeliveryMilli, 2000, 'Another picking remains separate');
      assert.notEqual(routeJob(detail.delivery).workFingerprint, routeJob(first).workFingerprint);
      assert.deepEqual(Detail.parse(await h.ok(path, { method: 'PATCH', body: command })), detail, 'Identical retries use the receipt before the old version check');
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, reason: 'Different request body' } })).status, 409);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: h.adminCookie })).status, 409, 'Receipt cannot impersonate a different confirmer');
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, requestId: randomUUID() } })).status, 409);
      detail = await save(first.id, 31, 1500, 500);
      assert.equal(detail.delivery.priorWorkRevisions?.length, 2);
      assert.deepEqual(detail.delivery.priorWorkRevisions?.[0], revision);
      assert.equal(deliveredMilli(detail.delivery, 31), 1500, 'A correction replaces the opening balance, never adds 1000+1500');
      assert.equal(detail.lineServices[0]?.remainingInstallationMilli, 1500);
      assert.equal(detail.history.filter(({ action }) => action === 'prior_work.confirmed').length, 2);
      detail = await save(first.id, 32);
      assert.equal(detail.priorWork.lines[1]?.status, 'confirmed');
      assert.equal(detail.priorWork.lines[1]?.priorDeliveredMilli, 0);
      assert.equal(detail.delivery.appointments.length, 0, 'Prior work never fabricates a Crew report');
      const list = DeliveryListSchema.parse(await h.ok(`/deliveries?search=${encodeURIComponent(first.source.pickingName)}`));
      assert.equal(list.items[0]?.planning.remainingWorkEstimate.minutes, 45);
      const nearby = RouteJobsSchema.parse(await h.ok(`/routes/jobs?anchorId=${first.id}&radiusKm=20`));
      assert.equal(nearby.anchorJob?.remaining.find(({ sourceLineId }) => sourceLineId === 31)?.deliveryMilli, 500);
      assert.equal(nearby.anchorJob?.remainingWorkEstimate?.minutes, 45);
      const draft = { ...f.draft, stops: [{ ...f.draft.stops[0], deliveryId: first.id, workDurationSource: 'remaining_estimate',
        workMinutes: 999, workFingerprint: routeJob(detail.delivery).workFingerprint }] };
      assert.equal(RoutePreviewSchema.parse(await h.ok('/routes/preview', { method: 'POST', body: draft })).timeline.stops[0]?.workMinutes, 45);
      detail = Detail.parse(await h.ok(`/deliveries/${first.id}/services`, { method: 'PATCH',
        body: { version: detail.delivery.version, sourceLineId: 32, service: 'collection_only' } }));
      assert.equal(detail.priorWork.reviewRequired, true, 'Changing operations after a known-zero balance requires explicit reconfirmation');
      detail = await save(first.id, 32, 0, 0, 1000);
      assert.equal(detail.priorWork.reviewRequired, false);
      assert.equal(detail.lineServices[1]?.collectedMilli, 1000);
      assert.equal(detail.lineServices[1]?.remainingCollectionMilli, 1000);
      assert.equal(detail.lineServices[1]?.deliveredMilli, 0, 'Prior collection does not fabricate customer delivery');
    });

    await context.test('prior delivery enables an installation-only remaining visit without changing signed local quantities', async () => {
      const f = await h.fixture({ count: 1, service: 'delivery_installation' });
      const first = f.deliveries[0]; const stop = f.draft.stops[0]; assert.ok(first && stop);
      let detail = await save(first.id, 31, 2000);
      f.workLines = [{ sourceLineId: 31, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }];
      stop.workFingerprint = routeJob(detail.delivery).workFingerprint;
      const published = await h.publish(f);
      const route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
      const visit = route.stops[0]; assert.ok(visit);
      detail = await read(first.id);
      assert.equal(detail.priorWork.lines[0]?.blockedReason, 'planned_work');
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/prior-work`, { method: 'PATCH', body: await input(first.id, 31, 1000) })).data).code, 'PRIOR_WORK_LOCKED');
      await h.confirm(first.id, visit.appointmentId);
      const crew = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${visit.appointmentId}`, { cookie: f.cookie }));
      assert.equal(crew.items.find(({ sourceLineId }) => sourceLineId === 31)?.serviceWork?.availableInstallationMilli, 2000);
      assert.equal(crew.items.find(({ sourceLineId }) => sourceLineId === 31)?.remainingMilli, 0);
      await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
      await h.start(visit.appointmentId, f.cookie);
      const scopedBefore = (await read(first.id)).delivery.appointments[0]?.workScope;
      await save(first.id, 32, 500);
      const unrelated = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${visit.appointmentId}`, { cookie: f.cookie }));
      assert.equal(unrelated.scopeReviewReason, null, 'Confirming unrelated line B must not strand the active signed scope for A');
      assert.deepEqual((await read(first.id)).delivery.appointments[0]?.workScope, scopedBefore);
      await h.finish(visit.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 0, installedMilli: 1000, collectedMilli: 0 }]);
      detail = await read(first.id);
      assert.equal(detail.priorWork.lines[0]?.blockedReason, 'recorded_work');
      assert.equal(detail.lineServices[0]?.deliveredMilli, 2000);
      assert.equal(detail.lineServices[0]?.installedMilli, 1000);
      assert.equal(detail.lineServices[0]?.remainingInstallationMilli, 1000);
      const result = detail.delivery.appointments[0]?.results[0]; assert.ok(result);
      assert.equal(result.quantities[0]?.deliveredMilli, 0);
      assert.equal(result.quantities[0]?.installedMilli, 1000);
      assert.equal(detail.priorWork.lines[0]?.crewInstalledMilli, 1000);
      const failure = await h.request(`/deliveries/${first.id}/prior-work`, { method: 'PATCH', body: await input(first.id, 31, 1000) });
      assert.equal(ErrorCode.parse(failure.data).code, 'PRIOR_WORK_LOCKED');
      assert.deepEqual((await read(first.id)).delivery.appointments[0]?.results[0], result);
      const reduced = structuredClone(detail.delivery); const item = reduced.source.items[0]; assert.ok(item); item.quantity = 1;
      await store.save(h.database.source.manager, reduced);
      const stale = await read(first.id);
      assert.equal(stale.priorWork.reviewRequired, true);
      assert.ok(stale.lineServices.every(({ planningBlockedReason }) => planningBlockedReason === 'prior_work_review'));
      assert.equal(routeJob(stale.delivery).planningStatus, 'unavailable');
      assert.ok(stale.closureBlockers.some((reason) => reason.includes('prior work')));
    });

    await context.test('verified complete prior work closes with its audit snapshot and without invented signatures', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      await save(first.id, 31, 2000);
      let detail = await save(first.id, 32, 2000);
      assert.deepEqual(detail.closureBlockers, []);
      assert.equal(detail.progress, 'awaiting_closure');
      detail = Detail.parse(await h.ok(`/deliveries/${first.id}/complete`, { method: 'POST', body: { version: detail.delivery.version } }));
      assert.equal(detail.delivery.appointments.length, 0);
      assert.equal(detail.delivery.completions[0]?.priorWorkSnapshot?.length, 2);
      assert.deepEqual(detail.delivery.completions[0]?.resultIds, []);
      assert.equal(detail.priorWork.lines[0]?.blockedReason, 'delivery_closed');
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/prior-work`, { method: 'PATCH', body: await input(first.id, 31, 1000) })).data).code, 'PRIOR_WORK_LOCKED');
    });

    await context.test('changed physical identity cannot inherit a prior balance through matching SKU; explicit new revision reconciles before local work', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      const confirmed = await save(first.id, 31, 1000);
      for (const change of [{ productId: 999 }, { saleOrderId: first.source.saleOrderId + 1 }, { uomId: 99 }, { saleOrderLineId: 10001 }, { uom: 'box' }]) {
        const changed = structuredClone(confirmed.delivery); const item = changed.source.items[0]; assert.ok(item); Object.assign(item, change);
        await store.save(h.database.source.manager, changed);
        const detail = await read(first.id);
        assert.equal(detail.priorWork.reviewRequired, true);
        assert.equal(detail.priorWork.lines[0]?.status, 'needs_review');
        assert.equal(detail.lineServices[0]?.deliveredMilli, 0, 'Stale facts are preserved for review, not attached to a different source item');
        assert.equal(detail.priorWork.lines[0]?.priorDeliveredMilli, 1000);
        assert.equal(priorWorkReviewReasons(detail.delivery).length, 1);
        assert.equal((await h.request(`/deliveries/${first.id}/appointments`, { method: 'POST', body: { version: detail.delivery.version,
          requestId: randomUUID(), startsAt: '2031-01-01T08:00:00Z', endsAt: '2031-01-01T09:00:00Z',
          workLines: [{ sourceLineId: 32, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }] } })).status, 409);
      }
      const reconciled = await save(first.id, 31);
      assert.equal(reconciled.priorWork.reviewRequired, false);
      assert.equal(reconciled.priorWork.lines[0]?.status, 'confirmed');
      assert.equal(reconciled.lineServices[0]?.remainingDeliveryMilli, 2000);
      assert.deepEqual(reconciled.delivery.priorWorkRevisions?.[0], confirmed.delivery.priorWorkRevisions?.[0]);
    });
  } finally { await h.close(); }
});
