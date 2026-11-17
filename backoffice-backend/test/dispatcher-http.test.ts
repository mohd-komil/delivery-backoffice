import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { rows } from '../src/database/database';
import { DeliverySchema } from '../src/domain/model';
import { DispatcherDetailSchema, DispatcherListSchema, DispatcherOwnerSchema, type DispatcherCaseSchema } from '../src/dispatcher/contracts';
import { deliveryDispatcherCases } from '../src/dispatcher/projections';
import { DeliveryStore } from '../src/operations/store';
import { EntranceResponseSchema } from '../src/routing/entrances';
import { RouteOperationsSchema, RouteRevisionSchema } from '../src/routing/lifecycle-contracts';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

type Case = z.infer<typeof DispatcherCaseSchema>;

void test('dispatcher queue derives exact cases and persists only authorized follow-up coordination', async (context) => {
  const h = await lifecycleFixture();
  const store = new DeliveryStore(h.database);
  async function list(query = '') { return DispatcherListSchema.parse(await h.ok(`/dispatcher/queue${query}`)); }
  async function detail(key: string) { return DispatcherDetailSchema.parse(await h.ok(`/dispatcher/queue/${key}`)); }
  const owners = z.array(DispatcherOwnerSchema).parse(await h.ok('/dispatcher/owners'));
  const operator = owners.find(({ name }) => name === 'DEMO operator'); const admin = owners.find(({ name }) => name === 'DEMO admin'); assert.ok(operator && admin);
  const operatorId = operator.id;
  function input(item: Case, ownerUserId: string | null = operatorId) {
    return { version: item.version, requestId: randomUUID(), fingerprint: item.fingerprint, ownerUserId,
      nextAction: 'Review the exact original work and contact its dispatcher', note: 'Synthetic coordination note; this does not approve or change the original workflow' };
  }
  async function coordinate(item: Case, ownerUserId: string | null = operatorId) {
    return DispatcherDetailSchema.parse(await h.ok(`/dispatcher/queue/${item.key}`, { method: 'PATCH', body: input(item, ownerUserId) }));
  }
  async function live(id: string) { return RouteOperationsSchema.parse(await h.ok(`/routes/${id}/operations`)); }
  try {
    await context.test('read-only pagination, role/Origin/input guards, concurrency, receipts and automatic address resolution', async () => {
      const f = await h.fixture({ count: 14 });
      for (const initial of f.deliveries) { const delivery = structuredClone(initial); delete delivery.routePoint; await store.save(h.database.source.manager, delivery); }
      const closed = f.deliveries.at(-1); const prior = f.deliveries.at(-2); const first = f.deliveries[0]; assert.ok(closed && prior && first);
      await store.save(h.database.source.manager, { ...(await store.get(closed.id)), completedAt: new Date().toISOString() });
      for (const sourceLineId of [31, 32]) {
        const current = await store.get(prior.id);
        await h.ok(`/deliveries/${prior.id}/prior-work`, { method: 'PATCH', body: { version: current.version, requestId: randomUUID(), sourceLineId,
          deliveredMilli: 2000, installedMilli: 0, collectedMilli: 0, sourceReference: 'Synthetic verified prior work',
          reason: 'No work remains requiring a map location', acknowledgeCurrentPicking: true } });
      }
      const original = await store.get(first.id);
      const [before] = await rows(h.database.source.manager, z.object({ count: z.number() }), 'SELECT count(*)::int AS count FROM dispatcher_case');
      const page = await list('?kind=address_review');
      assert.equal(page.total, 12); assert.equal(page.items.length, 10); assert.equal(page.pageSize, 10);
      assert.equal((await list('?kind=address_review&page=2')).items.length, 2);
      await list(); await list();
      const [after] = await rows(h.database.source.manager, z.object({ count: z.number() }), 'SELECT count(*)::int AS count FROM dispatcher_case');
      assert.equal(after?.count, before?.count, 'GET cannot materialize coordination records');
      assert.deepEqual(await store.get(first.id), original);
      assert.equal((await h.request('/dispatcher/queue', { cookie: '' })).status, 401);
      assert.equal((await h.request('/dispatcher/queue', { cookie: f.cookie })).status, 401);
      assert.equal((await h.request('/dispatcher/owners', { cookie: f.cookie })).status, 401);
      assert.equal((await h.request('/dispatcher/queue?pageSize=500')).status, 400);
      const document = z.object({ paths: z.record(z.string(), z.object({ get: z.object({ parameters: z.array(z.object({ name: z.string(),
        schema: z.object({ pattern: z.string().optional() }) })) }).optional() })) }).parse(await h.ok('/openapi.json'));
      assert.equal(document.paths['/dispatcher/queue/{key}']?.get?.parameters.find(({ name }) => name === 'key')?.schema.pattern, '^[a-f0-9]{64}$');
      const item = [...page.items, ...(await list('?kind=address_review&page=2')).items].find(({ origin }) => origin.deliveryId === first.id); assert.ok(item);
      assert.equal(item.version, 0); assert.equal(item.ownerSource, 'unassigned');
      const path = `/dispatcher/queue/${item.key}`; const command = input(item);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: f.cookie })).status, 401);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, origin: 'https://untrusted.example.test' })).status, 403);
      for (const invalid of [{ note: '' }, { nextAction: '' }, { status: 'resolved' }, { version: -1 }]) {
        assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, ...invalid } })).status, 400);
      }
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...command, version: 1 } })).data).code, 'DISPATCHER_VERSION_CHANGED');
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...command, fingerprint: '0'.repeat(64) } })).data).code, 'DISPATCHER_FACTS_CHANGED');
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: { ...command, ownerUserId: randomUUID() } })).data).code, 'DISPATCHER_OWNER_UNAVAILABLE');
      let saved = DispatcherDetailSchema.parse(await h.ok(path, { method: 'PATCH', body: command }));
      const initialHistory = structuredClone(saved.history[0]); assert.ok(initialHistory);
      assert.equal(saved.item.version, 1); assert.equal(saved.item.ownerSource, 'coordination'); assert.equal(saved.item.status, 'open');
      assert.deepEqual(DispatcherDetailSchema.parse(await h.ok(path, { method: 'PATCH', body: command })), saved);
      assert.equal((await h.request(path, { method: 'PATCH', body: { ...command, note: 'Changed retry' } })).status, 409);
      assert.equal((await h.request(path, { method: 'PATCH', body: command, cookie: h.adminCookie })).status, 409);
      assert.deepEqual(await store.get(first.id), original, 'Coordination cannot change source, quantities, appointments or delivery version');
      assert.equal((await list('?owner=mine')).total, 1);
      const updates = await Promise.all(['A', 'B'].map((note) => h.request(path, { method: 'PATCH', body: { ...input(saved.item), note } })));
      assert.deepEqual(updates.map(({ status }) => status).sort(), [200, 409]);
      saved = await detail(item.key); assert.equal(saved.item.version, 2); assert.equal(saved.history.length, 2);
      assert.deepEqual(saved.history[1], initialHistory);
      const changed = await store.get(first.id); changed.source.customer.address = 'Synthetic corrected address 33'; changed.version++;
      await store.save(h.database.source.manager, changed);
      const current = await detail(item.key); assert.equal(current.item.coordinationStale, true); assert.notEqual(current.item.fingerprint, saved.item.fingerprint);
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: input(saved.item) })).data).code, 'DISPATCHER_FACTS_CHANGED');
      saved = await coordinate(current.item, null); assert.equal(saved.item.owner, null); assert.equal(saved.item.coordinationStale, false);
      const entrance = EntranceResponseSchema.parse(await h.ok(`/deliveries/${first.id}/entrance`));
      await h.ok(`/deliveries/${first.id}/entrance`, { method: 'PATCH', body: { addressKey: entrance.addressKey, deliveryVersion: entrance.deliveryVersion,
        version: entrance.entrance?.version ?? null, point: { latitude: 37.5, longitude: 15.084 }, confirmed: true } });
      const resolved = await detail(item.key); assert.equal(resolved.item.status, 'resolved'); assert.equal(resolved.history.length, 3);
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'PATCH', body: input(resolved.item) })).data).code, 'DISPATCHER_CASE_RESOLVED');
      assert.equal(DispatcherDetailSchema.parse(await h.ok(path, { method: 'PATCH', body: command })).history.length, 3, 'A retry cannot reapply or reopen a resolved case');
    });

    await context.test('source flags are factual and damage readiness remains in the original issue workflow', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      await store.save(h.database.source.manager, { ...first, sourceChanged: true });
      assert.equal((await list('?kind=source_review')).items.some(({ origin }) => origin.deliveryId === first.id), false, 'A legacy informational flag alone is not a pending decision');
      await store.save(h.database.source.manager, { ...first, sourceReview: true });
      const source = (await list('?kind=source_review')).items.find(({ origin }) => origin.deliveryId === first.id); assert.ok(source);
      await coordinate(source);
      await store.save(h.database.source.manager, { ...first, sourceChanged: true });
      assert.equal((await detail(source.key)).item.status, 'resolved');
      let delivery = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/issues`, { method: 'POST', body: { version: first.version,
        type: 'damage', description: 'Synthetic damage on the first order only', itemIds: [31] } })).delivery;
      const damaged = delivery.issues[0]; assert.ok(damaged);
      delivery = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/issues`, { method: 'POST', body: { version: delivery.version,
        type: 'missing_parts', description: 'Synthetic missing parts in the other order', itemIds: [32] } })).delivery;
      const issues = (await list('?kind=issue')).items.filter(({ origin }) => origin.deliveryId === first.id);
      assert.equal(issues.length, 2); assert.notEqual(issues[0]?.key, issues[1]?.key);
      assert.notEqual(issues[0]?.orderName, issues[1]?.orderName, 'Matching products retain exact commercial order ownership');
      const queueDamage = issues.find(({ origin }) => origin.issueId === damaged.id); assert.ok(queueDamage); await coordinate(queueDamage);
      await list('?kind=issue'); assert.equal((await store.get(first.id)).issues.length, 2, 'Queue reads never duplicate Issues');
      delivery = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/issues/${damaged.id}/resolve`, { method: 'POST', body: {
        version: delivery.version, resolution: 'Replacement arranged; readiness will be confirmed separately' } })).delivery;
      assert.equal((await detail(queueDamage.key)).item.status, 'open');
      assert.ok((await detail(queueDamage.key)).item.reasons.includes('damaged_work_on_hold'));
      const orphan = deliveryDispatcherCases({ ...delivery, issues: [] }, true, new Map()).find(({ kind }) => kind === 'issue');
      assert.equal(orphan?.target.tab, 'issues', 'An orphan readiness hold links to the actionable release workflow');
      await h.ok(`/deliveries/${first.id}/work-readiness/31`, { method: 'PATCH', body: { version: delivery.version, note: 'Synthetic replacement verified ready for another visit' } });
      assert.equal((await detail(queueDamage.key)).item.status, 'resolved');
      const large = structuredClone(delivery); const template = large.source.items[0]; const issue = large.issues[1]; assert.ok(template && issue);
      large.source.items = Array.from({ length: 500 }, (_, index) => ({ ...template, sourceLineId: 2_000_000_000 + index }));
      issue.itemIds = large.source.items.map(({ sourceLineId }) => sourceLineId); large.issues = [issue]; large.workHolds = [];
      const projected = deliveryDispatcherCases(DeliverySchema.parse(large), true, new Map());
      assert.ok(projected.find(({ kind }) => kind === 'issue')?.facts.every(({ value }) => value.length <= 4000), 'A valid 500-line issue has an explicitly bounded display summary');
    });

    await context.test('effective report evidence resolves only through original facts; Customer absent is not missing signatures', async () => {
      const f = await h.fixture({ count: 1 }); const published = await h.publish(f); const stop = published.stops[0]; assert.ok(stop);
      await h.confirm(stop.deliveryId, stop.appointmentId);
      let route = await live(published.id);
      await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
      await h.start(stop.appointmentId, f.cookie);
      await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000 }]);
      const valid = await store.get(stop.deliveryId); const appointment = valid.appointments[0]; const report = appointment?.results[0]; assert.ok(appointment && report);
      assert.equal((await list('?kind=evidence')).items.some(({ origin }) => origin.appointmentId === stop.appointmentId), false);
      const legacy = structuredClone(valid); const legacyVisit = legacy.appointments[0]; assert.ok(legacyVisit);
      const refused = { ...structuredClone(report), customerSignature: { status: 'refused' as const, signerName: 'Synthetic customer', reason: 'Legacy disputed proof', at: report.actualEnd } };
      legacyVisit.results = [refused]; await store.save(h.database.source.manager, legacy);
      const multiple = { ...legacy, appointments: [{ ...legacyVisit, results: [refused, { ...report, id: randomUUID() }] }] };
      assert.equal(deliveryDispatcherCases(multiple, true, new Map()).find(({ kind }) => kind === 'evidence')?.origin.resultId, null,
        'A visit-wide evidence review cannot point arbitrarily at its last report');
      const item = (await list('?kind=evidence')).items.find(({ origin }) => origin.appointmentId === stop.appointmentId); assert.ok(item);
      await coordinate(item);
      const blockers = z.object({ closureBlockers: z.array(z.string()) }).parse(await h.ok(`/deliveries/${stop.deliveryId}`)).closureBlockers;
      assert.ok(blockers.some((entry) => entry.includes('requires the customer signature')), 'A coordinator note cannot waive a signature');
      assert.deepEqual((await store.get(stop.deliveryId)).appointments[0]?.results[0], refused);
      const failed = structuredClone(legacy); const failedVisit = failed.appointments[0]; assert.ok(failedVisit); failedVisit.status = 'failed'; failedVisit.results = [];
      assert.equal(deliveryDispatcherCases(failed, true, new Map()).some(({ kind }) => kind === 'evidence'), false);
      const corrected = { ...structuredClone(report), id: randomUUID(), supersedesResultId: report.id, correctionReason: 'Synthetic corrected historical evidence' };
      legacyVisit.results.push(corrected); await store.save(h.database.source.manager, legacy);
      const resolved = await detail(item.key); assert.equal(resolved.item.status, 'resolved');
      assert.ok(resolved.history[0]?.snapshot.reasons.includes('customer_signature_unconfirmed'));
      assert.deepEqual((await store.get(stop.deliveryId)).appointments[0]?.results[0], refused);
      route = await live(published.id);
      await h.ok(`/crew/routes/${published.id}/return`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } });
    });

    await context.test('returned cargo keeps workflow ownership, exact order lines and closed exceptions until physical receipt', async () => {
      const f = await h.fixture({ count: 1, service: 'collection_only' }); const published = await h.publish(f); const stop = published.stops[0]; assert.ok(stop);
      const originalRevision = RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`));
      await h.confirm(stop.deliveryId, stop.appointmentId);
      let route = await live(published.id);
      await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
      await h.start(stop.appointmentId, f.cookie);
      await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 0, collectedMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 0, collectedMilli: 1000 }]);
      assert.equal((await list('?kind=cargo')).items.some(({ origin }) => origin.routeId === published.id), false, 'Before physical return goods are not waiting at the warehouse');
      route = await live(published.id);
      route = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${published.id}/return`, { method: 'POST', cookie: f.cookie,
        body: { version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } }));
      route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/reconcile`, { method: 'POST', body: { version: route.version,
        requestId: randomUUID(), reason: 'Synthetic cargo verification', lines: route.lines.map((line) => ({
          appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId: operator.id, note: 'Original workflow responsibility',
          nextActions: [{ operation: 'collection', action: 'ready_for_repeat', ownerUserId: operator.id, note: 'Plan remaining collection', followUpAppointmentId: null }],
          cargo: [{ kind: 'collection', location: 'vehicle', quantityMilli: 1000, note: 'Collected product remains in the vehicle' }],
        })) } }));
      route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/close`, { method: 'POST', body: { version: route.version,
        requestId: randomUUID(), reason: 'Administrative closure only', exceptionReason: 'Warehouse receipt remains pending with a named owner' } }));
      const cases = (await list('?kind=cargo')).items.filter(({ origin }) => origin.routeId === published.id);
      assert.equal(cases.length, 2); const item = cases.find(({ origin }) => origin.sourceLineId === 31); assert.ok(item);
      assert.notEqual(cases[0]?.orderName, cases[1]?.orderName);
      assert.equal(item.owner?.id, operator.id); assert.equal(item.ownerSource, 'source'); assert.equal(item.quantityMilli, 1000);
      const coordinated = await coordinate(item, admin.id);
      assert.equal(coordinated.item.owner?.id, admin.id); assert.equal(coordinated.item.sourceOwner?.id, operator.id);
      assert.equal((await live(published.id)).runtime.reconciliation?.lines[0]?.ownerUserId, operator.id);
      assert.deepEqual(RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`)), originalRevision);
      route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/warehouse-receipts`, { method: 'POST', body: { version: route.version,
        requestId: randomUUID(), reason: 'Synthetic partial physical receipt', items: [{ appointmentId: stop.appointmentId, sourceLineId: 31, kind: 'collection', quantityMilli: 400, note: 'First receipt' }] } }));
      const partial = await detail(item.key); assert.equal(partial.item.quantityMilli, 600); assert.equal(partial.item.coordinationStale, true);
      assert.equal(ErrorCode.parse((await h.request(`/dispatcher/queue/${item.key}`, { method: 'PATCH', body: input(coordinated.item) })).data).code, 'DISPATCHER_FACTS_CHANGED');
      await h.ok(`/routes/${published.id}/warehouse-receipts`, { method: 'POST', body: { version: route.version, requestId: randomUUID(),
        reason: 'Synthetic final physical receipt', items: [{ appointmentId: stop.appointmentId, sourceLineId: 31, kind: 'collection', quantityMilli: 600, note: 'Remaining first-order product received' }] } });
      assert.equal((await detail(item.key)).item.status, 'resolved');
      assert.equal((await list('?kind=cargo')).items.find(({ origin }) => origin.routeId === published.id && origin.sourceLineId === 32)?.quantityMilli, 1000,
        'Receiving the same SKU from one order cannot receive the other order');
    });
  } finally { await h.close(); }
});
