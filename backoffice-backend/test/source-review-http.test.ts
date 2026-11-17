import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { SourceEvidence, SourceSnapshot } from '../src/domain/model';
import { CrewVisitDetailSchema } from '../src/crew/contracts';
import { candidateHash, sourceHash } from '../src/domain/source-import';
import { SourceReviewSchema } from '../src/integration/source-review';
import { DeliveryStore } from '../src/operations/store';
import { RouteOperationsSchema, RouteRevisionSchema } from '../src/routing/lifecycle-contracts';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const acceptedAt = '2031-01-01T08:00:00.000001Z';
const proposedAt = '2031-01-01T09:00:00.000001Z';
function evidence(source: SourceSnapshot, writeDate: string, readComplete = true): SourceEvidence {
  return { rows: [{ entity: 'stock_picking', id: source.pickingId, writeDate, rowHash: sourceHash(source) }], readComplete };
}

void test('source review uses authenticated decisions while protecting accepted plans and immutable work', async (context) => {
  const h = await lifecycleFixture();
  const store = new DeliveryStore(h.database);
  async function review(id: string) { return SourceReviewSchema.parse(await h.ok(`/deliveries/${id}/source-review`)); }
  // Source-reader ordering is verified in importer PG tests. These owned fixtures isolate the decision HTTP boundary.
  async function candidate(id: string, change: (source: SourceSnapshot) => void,
    options: { acceptedEligible?: boolean; qualifies?: boolean; readComplete?: boolean } = {}) {
    const delivery = await store.get(id);
    const proposed = structuredClone(delivery.source); change(proposed);
    const qualifies = options.qualifies ?? true;
    const pending = { id: randomUUID(), hash: candidateHash(proposed, qualifies), firstSeenAt: new Date().toISOString(),
      source: proposed, qualifies, evidence: evidence(proposed, proposedAt, options.readComplete ?? true), reasons: ['source_changed_after_work'] };
    delivery.sourceImport = { acceptedHash: sourceHash(delivery.source), acceptedEvidence: evidence(delivery.source, acceptedAt),
      pending, keptHash: null, keptEvidence: null, lastRejectedHash: null, eligible: qualifies, acceptedEligible: options.acceptedEligible ?? true };
    delivery.sourceChanged = true;
    if (options.acceptedEligible === false) delivery.sourceReview = true;
    delivery.version++;
    await store.save(h.database.source.manager, delivery);
    return { accepted: structuredClone(delivery.source), proposed, pending, delivery };
  }
  async function command(id: string, action: 'accept' | 'keep_accepted' = 'accept') {
    const state = await review(id); assert.ok(state.candidate);
    return { version: state.deliveryVersion, requestId: randomUUID(), candidateId: state.candidate.id, candidateHash: state.candidate.hash,
      action, reason: 'Synthetic dispatcher decision after comparing the exact picking lines and recorded work' };
  }
  try {
    await context.test('auth, Origin, strict inputs, optimistic versions, actor-bound receipts and exact candidate identity', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      const staged = await candidate(first.id, (source) => { source.customer.address = 'Synthetic revised destination 17'; });
      const path = `/deliveries/${first.id}/source-review`;
      const input = await command(first.id);
      assert.equal((await h.request(path, { cookie: '' })).status, 401);
      assert.equal((await h.request(path, { cookie: f.cookie })).status, 401);
      assert.equal((await h.request(path, { method: 'POST', body: input, cookie: '' })).status, 401);
      assert.equal((await h.request(path, { method: 'POST', body: input, cookie: f.cookie })).status, 401);
      assert.equal((await h.request(path, { method: 'POST', body: input, origin: 'https://untrusted.example.test' })).status, 403);
      for (const invalid of [{ reason: '' }, { action: 'force' }, { candidateHash: 'not-a-hash' }, { force: true }, { version: 0 }]) {
        assert.equal((await h.request(path, { method: 'POST', body: { ...input, ...invalid } })).status, 400);
      }
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'POST', body: { ...input, candidateId: randomUUID() } })).data).code, 'SOURCE_CANDIDATE_CHANGED');
      assert.equal(ErrorCode.parse((await h.request(path, { method: 'POST', body: { ...input, candidateHash: 'a'.repeat(64) } })).data).code, 'SOURCE_CANDIDATE_CHANGED');
      assert.equal((await h.request(path, { method: 'POST', body: { ...input, version: input.version - 1 } })).status, 409);
      const before = await review(first.id);
      assert.equal(before.status, 'needs_reconciliation');
      assert.equal(before.revisionCoverage, 'complete');
      assert.equal(before.documentCoverage, 'not_mapped');
      assert.equal(before.canAccept, true);
      assert.ok(before.candidate?.changes.some(({ kind }) => kind === 'destination'));
      const result = DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: input }));
      assert.deepEqual(result.delivery.source, staged.proposed);
      assert.equal(result.delivery.routePoint, undefined, 'Accepting a changed address cannot retain its previous map point');
      assert.equal(result.delivery.sourceImport?.pending, null);
      assert.equal(result.delivery.sourceImport?.acceptedEligible, true);
      assert.deepEqual(DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: input })), result);
      assert.equal(result.history.filter(({ action }) => action === 'source.candidate_accepted').length, 1);
      assert.equal((await h.request(path, { method: 'POST', body: { ...input, reason: 'Changed retry payload' } })).status, 409);
      assert.equal((await h.request(path, { method: 'POST', body: input, cookie: h.adminCookie })).status, 409);
      assert.equal((await h.request(path, { method: 'POST', body: { ...input, requestId: randomUUID() } })).status, 409);
      assert.equal((await review(first.id)).status, 'current');
      const kept = await candidate(first.id, (source) => { source.notes = 'Synthetic source note requiring explicit comparison'; });
      const keep = await command(first.id, 'keep_accepted');
      const preserved = DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: keep }));
      assert.deepEqual(preserved.delivery.source, kept.accepted);
      assert.equal(preserved.delivery.sourceImport?.keptHash, kept.pending.hash);
      assert.equal(preserved.delivery.sourceImport?.pending, null);
      assert.deepEqual(DeliveryDetail.parse(await h.ok(path, { method: 'POST', body: keep })), preserved);
      assert.equal(preserved.history.filter(({ action }) => action === 'source.candidate_kept').length, 1);
    });

    await context.test('pending source retains a published plan, blocks new start and permits an already started visit to finish its accepted scope', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      const published = await h.publish(f);
      const revision = RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`));
      let route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
      const stop = route.stops[0]; assert.ok(stop);
      await h.confirm(first.id, stop.appointmentId);
      const initial = await h.detail(first.id);
      await candidate(first.id, (source) => { source.customer.address = 'Synthetic proposed address; not the accepted destination'; });
      let state = await review(first.id);
      assert.equal(state.canAccept, false);
      assert.ok(state.blockers.some(({ code }) => code === 'ROUTE_CHANGE_REQUIRED'));
      assert.deepEqual((await h.detail(first.id)).delivery.source, initial.delivery.source);
      assert.deepEqual(RouteRevisionSchema.parse(await h.ok(`/routes/${published.id}/revisions/1`)), revision);
      const blocked = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${stop.appointmentId}`, { cookie: f.cookie }));
      assert.equal(blocked.canStart, false);
      assert.equal((await h.request(`/crew/visits/${stop.appointmentId}/start`, { method: 'POST', cookie: f.cookie,
        body: { version: blocked.version, requestId: randomUUID() } })).status, 409);
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id) })).data).code, 'SOURCE_RECONCILIATION_BLOCKED');
      await h.ok(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id, 'keep_accepted') });
      await h.ok(`/crew/routes/${published.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
      await h.start(stop.appointmentId, f.cookie);
      const staged = await candidate(first.id, (source) => { const item = source.items[0]; assert.ok(item); item.quantity = 0.5; });
      state = await review(first.id);
      assert.equal(state.canAccept, false);
      assert.ok(state.blockers.some(({ code }) => code === 'VISIT_IN_PROGRESS'));
      const underway = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${stop.appointmentId}`, { cookie: f.cookie }));
      assert.equal(underway.canFinish, true);
      assert.equal(underway.scopeReviewReason, null);
      await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000 }]);
      const finished = await h.detail(first.id);
      const report = finished.delivery.appointments[0]?.results[0]; assert.ok(report);
      assert.deepEqual(finished.delivery.source, staged.accepted);
      assert.deepEqual(report.sourceSnapshot, staged.accepted);
      assert.equal(report.quantities[0]?.deliveredMilli, 1000, 'The unaccepted source decrease must not rewrite the planned handover');
      assert.equal(report.customerSignature?.status, 'signed');
      assert.equal(finished.delivery.sourceImport?.pending?.hash, staged.pending.hash);
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/complete`, { method: 'POST', body: { version: finished.delivery.version } })).data).code, 'CLOSURE_BLOCKED');
      route = RouteOperationsSchema.parse(await h.ok(`/routes/${published.id}/operations`));
      route = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${published.id}/returning`, { method: 'POST', cookie: f.cookie,
        body: { version: route.version, requestId: randomUUID() } }));
      await h.ok(`/crew/routes/${published.id}/return`, { method: 'POST', cookie: f.cookie,
        body: { version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } });
      state = await review(first.id);
      assert.ok(state.blockers.some(({ code }) => code === 'SOURCE_BELOW_RECORDED_WORK'));
      assert.equal(state.canAccept, false);
      assert.equal(state.blockers.some(({ code }) => code === 'ROUTE_CHANGE_REQUIRED'), false);
      await candidate(first.id, (source) => { const item = source.items[0]; assert.ok(item); item.productId = 999; });
      state = await review(first.id);
      assert.ok(state.blockers.some(({ code, sourceLineId }) => code === 'RECORDED_WORK_IDENTITY_CONFLICT' && sourceLineId === 31));
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id) })).data).code, 'SOURCE_RECONCILIATION_BLOCKED');
      assert.deepEqual((await h.detail(first.id)).delivery.appointments[0]?.results[0], report);
    });

    await context.test('a confirmed opening balance cannot follow another order through the same SKU', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      const confirmed = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/prior-work`, { method: 'PATCH', body: {
        version: first.version, requestId: randomUUID(), sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0,
        sourceReference: 'Synthetic verified receipt', reason: 'Current exact picking line, previous backorders excluded', acknowledgeCurrentPicking: true } }));
      await candidate(first.id, (source) => { const item = source.items[0]; const second = source.items[1]; assert.ok(item && second?.saleOrderId); item.saleOrderId = second.saleOrderId; });
      const state = await review(first.id);
      assert.equal(state.canAccept, false);
      assert.ok(state.blockers.some(({ code, sourceLineId }) => code === 'PRIOR_WORK_CONFLICT' && sourceLineId === 31));
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id) })).data).code, 'SOURCE_RECONCILIATION_BLOCKED');
      assert.deepEqual((await h.detail(first.id)).delivery.priorWorkRevisions, confirmed.delivery.priorWorkRevisions);
      assert.deepEqual((await h.detail(first.id)).delivery.source, confirmed.delivery.source);
    });

    await context.test('legacy ineligible accepted data cannot be requalified by keeping it; incomplete and ineligible proposals remain blocked', async () => {
      const f = await h.fixture({ count: 1 }); const first = f.deliveries[0]; assert.ok(first);
      await candidate(first.id, (source) => { source.notes = 'New eligible source after review'; }, { acceptedEligible: false });
      let state = await review(first.id);
      assert.equal(state.canKeepAccepted, false);
      assert.equal(state.canAccept, true);
      assert.equal(ErrorCode.parse((await h.request(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id, 'keep_accepted') })).data).code, 'SOURCE_RECONCILIATION_BLOCKED');
      const accepted = DeliveryDetail.parse(await h.ok(`/deliveries/${first.id}/source-review`, { method: 'POST', body: await command(first.id) }));
      assert.equal(accepted.delivery.sourceReview, false);
      assert.equal(accepted.delivery.sourceImport?.acceptedEligible, true);
      await candidate(first.id, (source) => { source.notes = 'Incomplete read'; }, { readComplete: false });
      state = await review(first.id);
      assert.equal(state.canAccept, false); assert.equal(state.canKeepAccepted, false);
      assert.ok(state.blockers.some(({ code }) => code === 'SOURCE_INCOMPLETE'));
      await candidate(first.id, (source) => { source.sourceState = 'done'; }, { qualifies: false });
      state = await review(first.id);
      assert.equal(state.canAccept, false); assert.equal(state.canKeepAccepted, false);
      assert.ok(state.blockers.some(({ code }) => code === 'SOURCE_INELIGIBLE'));
    });
  } finally { await h.close(); }
});
