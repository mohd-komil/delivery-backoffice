import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { rows } from '../src/database/database';
import { CrewVisitDetailSchema } from '../src/crew/contracts';
import { RouteAmendReviewSchema, RouteOperationsSchema, RouteRevisionSchema, type RouteReconcileInputSchema } from '../src/routing/lifecycle-contracts';
import { lifecycleFixture, type LifecycleFixture, type LifecycleRoute } from './support/route-lifecycle-fixture';

async function live(h: LifecycleFixture, id: string) { return RouteOperationsSchema.parse(await h.ok(`/routes/${id}/operations`)); }
function command(version: number, reason = 'DEMO dispatcher decision') { return { version, requestId: randomUUID(), reason }; }
function cancellation(version: number) { return { ...command(version), confirmNotLoaded: true, confirmNotDeparted: true, cancelAttachedAppointmentIds: [] }; }
async function depart(h: LifecycleFixture, route: LifecycleRoute, cookie: string) {
  const first = route.stops[0]; assert.ok(first);
  await h.confirm(first.deliveryId, first.appointmentId);
  const current = await live(h, route.id);
  return RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie,
    body: { version: current.version, requestId: randomUUID() } }));
}
async function dataSnapshot(h: LifecycleFixture) {
  const names = ['delivery', 'appointment', 'reservation', 'transport_reservation', 'route_publication', 'route_stop', 'route_reservation', 'route_command', 'route_revision', 'audit'] as const;
  const result: Record<string, string[]> = {};
  for (const table of names) result[table] = (await rows(h.database.source.manager, z.object({ value: z.string() }),
    `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`)).map(({ value }) => value);
  return result;
}

void test('stage 07: real Crew route access and explicit departure', async (context) => {
  const h = await lifecycleFixture();
  try {
    await context.test('assigned route is private; its responsible participant can depart after the next customer confirms', async () => {
      const f = await h.fixture(); const route = await h.publish(f);
      const first = route.stops[0]; const second = route.stops[1]; assert.ok(first && second);
      const initial = RouteRevisionSchema.parse(await h.ok(`/routes/${route.id}/revisions/1`));
      assert.equal(initial.version, 1); assert.equal(initial.status, 'published');
      assert.equal((await h.request('/crew/routes', { cookie: '' })).status, 401);
      assert.equal((await h.request(`/crew/routes/${route.id}`, { cookie: h.operatorCookie })).status, 401);
      const outsider = await h.person('Unassigned tester'); const outsiderCookie = await h.login(outsider.login ?? '');
      assert.equal((await h.request(`/crew/routes/${route.id}`, { cookie: outsiderCookie })).status, 404);
      const list = z.object({ routes: z.array(RouteOperationsSchema) }).parse(await h.ok('/crew/routes', { cookie: f.cookie }));
      assert.deepEqual(list.routes.map(({ id }) => id), [route.id]);
      let state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}`, { cookie: f.cookie }));
      assert.equal(state.capabilities.canDepart, false); assert.equal(state.nextAppointmentId, first.appointmentId);
      const body = { version: state.version, requestId: randomUUID() };
      assert.equal((await h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, body })).status, 409);
      await h.confirm(first.deliveryId, first.appointmentId);
      assert.equal((await h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.colleagueCookie, body })).status, 403);
      assert.equal((await h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, origin: 'https://untrusted.example.test', body })).status, 403);
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, body }));
      assert.equal(state.status, 'in_progress'); assert.ok(state.runtime.departed);
      const snapshot = await dataSnapshot(h);
      assert.equal((await h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.colleagueCookie, body })).status, 403,
        'A successful request receipt must not bypass current action authorization');
      const replay = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, body }));
      assert.equal(replay.runtime.departed?.at, state.runtime.departed.at);
      assert.deepEqual(await dataSnapshot(h), snapshot);
      const pending = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${second.appointmentId}`, { cookie: f.cookie }));
      assert.equal(pending.confirmationStatus, 'awaiting_customer_confirmation'); assert.equal(pending.canStart, false);
      const started = await h.start(first.appointmentId, f.cookie);
      const failed = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${first.appointmentId}/attempt-failure`, { method: 'POST', cookie: f.cookie,
        body: { version: started.version, requestId: randomUUID(), reason: 'DEMO customer absent; no furniture transferred' } }));
      assert.equal(failed.status, 'failed');
      state = await live(h, route.id); assert.equal(state.nextAppointmentId, second.appointmentId); assert.equal(state.status, 'in_progress');
      assert.equal(state.capabilities.canReturn, false);
      await h.confirm(second.deliveryId, second.appointmentId);
      assert.equal((await h.start(second.appointmentId, f.cookie)).status, 'in_progress');
      assert.equal((await h.detail(first.deliveryId)).lineServices[0]?.remainingDeliveryMilli, 2000);
    });

    await context.test('later confirmed stops cannot bypass the dispatcher-selected order or publication guards', async () => {
      const f = await h.fixture(); const route = await h.publish(f); const second = route.stops[1]; assert.ok(second);
      await depart(h, route, f.cookie); await h.confirm(second.deliveryId, second.appointmentId);
      const visit = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${second.appointmentId}`, { cookie: f.cookie }));
      assert.equal(visit.canStart, false);
      assert.equal((await h.request(`/crew/visits/${second.appointmentId}/start`, { method: 'POST', cookie: f.cookie,
        body: { version: visit.version, requestId: randomUUID() } })).status, 409);
      assert.equal((await live(h, route.id)).status, 'in_progress');
    });

    await context.test('a Crew session revoked while departure waits for scheduling locks cannot mutate the route', async () => {
      const f = await h.fixture({ count: 1 }); const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      await h.confirm(stop.deliveryId, stop.appointmentId);
      const blocker = h.database.source.createQueryRunner(); await blocker.connect(); await blocker.startTransaction();
      let pending: ReturnType<LifecycleFixture['request']> | undefined;
      try {
        await blocker.query('SELECT pg_advisory_xact_lock(7041001)');
        pending = h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie,
          body: { version: route.version, requestId: randomUUID() } });
        let waiting = false;
        const deadline = Date.now() + 10_000;
        while (!waiting && Date.now() < deadline) {
          const [locks] = await rows(h.database.source.manager, z.object({ waiting: z.boolean() }),
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory') AS waiting`, [h.schema]);
          waiting = locks?.waiting ?? false;
          if (!waiting) await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true, 'Departure must reach the lock before its session is revoked');
        await h.ok('/crew/auth/logout', { method: 'POST', cookie: f.cookie, body: {} });
        await blocker.rollbackTransaction();
        assert.equal((await pending).status, 401);
        assert.equal((await live(h, route.id)).status, 'published');
        const receipts = await rows(h.database.source.manager, z.object({ count: z.number() }),
          'SELECT count(*)::integer AS count FROM route_command WHERE route_id=$1', [route.id]);
        assert.equal(receipts[0]?.count, 0);
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await blocker.release();
        if (pending) await pending;
      }
    });
  } finally { await h.close(); }
});

void test('stage 08: atomic route amendments, cancellation and retained history', async (context) => {
  const h = await lifecycleFixture();
  try {
    await context.test('cancel restores an attached booking by default and only cancels route-created visits', async () => {
      const f = await h.fixture(); const route = await h.publish(f, true); const attached = route.stops[0]; const created = route.stops[1]; assert.ok(attached && created);
      // A later confirmation remains a fact; provenance is not a licence to overwrite the current aggregate.
      await h.confirm(created.deliveryId, created.appointmentId);
      const before = (await h.detail(attached.deliveryId)).delivery.appointments.find(({ id }) => id === attached.appointmentId); assert.ok(before);
      const state = await live(h, route.id); const body = cancellation(state.version);
      const original = await dataSnapshot(h);
      assert.equal((await h.request(`/routes/${route.id}/cancel`, { method: 'POST', body: { ...body, confirmNotLoaded: false } })).status, 400);
      assert.deepEqual(await dataSnapshot(h), original);
      const cancelled = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/cancel`, { method: 'POST', body }));
      assert.equal(cancelled.status, 'cancelled');
      const restored = (await h.detail(attached.deliveryId)).delivery.appointments.find(({ id }) => id === attached.appointmentId); assert.ok(restored);
      assert.equal(restored.status, 'booked'); assert.deepEqual(restored.customerConfirmation, before.customerConfirmation);
      assert.deepEqual(restored.workScope, before.workScope); assert.deepEqual(restored.assignments, before.assignments);
      assert.equal(restored.transportAllocations?.filter(({ status }) => status === 'active').length ?? 0, 0);
      assert.equal((await h.detail(created.deliveryId)).delivery.appointments.find(({ id }) => id === created.appointmentId)?.status, 'cancelled');
      assert.equal((await h.detail(created.deliveryId)).lineServices[0]?.availableDeliveryMilli, 2000);
      const after = await dataSnapshot(h);
      await h.ok(`/routes/${route.id}/cancel`, { method: 'POST', body }); assert.deepEqual(await dataSnapshot(h), after);
      assert.equal((await h.request(`/routes/${route.id}/cancel`, { method: 'POST', body: { ...body, reason: 'Different payload' } })).status, 409);
      const crewRoutes = z.object({ routes: z.array(RouteOperationsSchema) }).parse(await h.ok('/crew/routes', { cookie: f.cookie }));
      assert.ok(crewRoutes.routes.every(({ id }) => id !== route.id));
      const standalone = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${attached.appointmentId}`, { cookie: f.cookie }));
      assert.equal(standalone.canStart, true);
    });

    await context.test('attached cancellation requires explicit selection and rollback prevents a partial cancellation', async () => {
      const f = await h.fixture(); const route = await h.publish(f, true); const first = route.stops[0]; assert.ok(first);
      const body = { ...cancellation(route.version), cancelAttachedAppointmentIds: [first.appointmentId] };
      await h.database.source.query(`CREATE FUNCTION reject_lifecycle_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DEMO lifecycle rollback'; END $$;
        CREATE TRIGGER reject_lifecycle_write BEFORE INSERT ON route_command FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_write()`);
      const before = await dataSnapshot(h);
      try { assert.equal((await h.request(`/routes/${route.id}/cancel`, { method: 'POST', body })).status, 500); }
      finally { await h.database.source.query('DROP TRIGGER reject_lifecycle_write ON route_command; DROP FUNCTION reject_lifecycle_write()'); }
      assert.deepEqual(await dataSnapshot(h), before);
      await h.ok(`/routes/${route.id}/cancel`, { method: 'POST', body });
      for (const stop of route.stops) assert.equal((await h.detail(stop.deliveryId)).delivery.appointments.find(({ id }) => id === stop.appointmentId)?.status, 'cancelled');
    });

    await context.test('amendment reorders and reschedules exact scopes with new review, confirmation reset and immutable revisions', async () => {
      const f = await h.fixture(); const route = await h.publish(f, true);
      for (const stop of route.stops) await h.confirm(stop.deliveryId, stop.appointmentId);
      const original = await live(h, route.id);
      const changed = { version: original.version, reason: 'DEMO afternoon route in reverse order', confirmNotLoaded: true, confirmNotDeparted: true,
        plan: { ...original.draft, departAt: new Date(Date.parse(original.draft.departAt) + 3 * 60 * 60_000).toISOString(), stops: [...original.draft.stops].reverse() },
        responsibleParticipants: original.stops.map(({ appointmentId }) => ({ appointmentId, participantId: f.participant.id })) };
      const review = RouteAmendReviewSchema.parse(await h.ok(`/routes/${route.id}/amend-review`, { method: 'POST', body: changed }));
      assert.equal(review.review.feasibility.status, 'feasible_estimate');
      assert.deepEqual(new Set(review.confirmationResetAppointmentIds), new Set(route.stops.map(({ appointmentId }) => appointmentId)));
      const before = await dataSnapshot(h);
      assert.equal((await h.request(`/routes/${route.id}/amend`, { method: 'POST', body: { ...changed, requestId: randomUUID(), fingerprint: '0'.repeat(64), acknowledgeEstimates: true } })).status, 409);
      assert.deepEqual(await dataSnapshot(h), before);
      const body = { ...changed, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true };
      const amended = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/amend`, { method: 'POST', body }));
      assert.equal(amended.version, original.version + 1); assert.equal(amended.status, 'published');
      assert.deepEqual(amended.stops.map(({ appointmentId }) => appointmentId), [...route.stops].reverse().map(({ appointmentId }) => appointmentId));
      for (const stop of amended.stops) {
        const old = original.stops.find(({ appointmentId }) => appointmentId === stop.appointmentId); assert.ok(old);
        assert.deepEqual(stop.workScope?.lines, old.workScope?.lines);
        assert.equal(stop.confirmationStatus, 'awaiting_customer_confirmation');
      }
      const revision = RouteRevisionSchema.parse(await h.ok(`/routes/${route.id}/revisions/1`));
      assert.equal(revision.data.draft.departAt, original.draft.departAt);
      assert.deepEqual(revision.data.review.stops.map(({ appointmentId }) => appointmentId), original.stops.map(({ appointmentId }) => appointmentId));
      const after = await dataSnapshot(h); await h.ok(`/routes/${route.id}/amend`, { method: 'POST', body }); assert.deepEqual(await dataSnapshot(h), after);
    });

    await context.test('amended actual participants lose/gain Crew access without replacing source-line work or task snapshots', async () => {
      const f = await h.fixture({ count: 1 }); const route = await h.publish(f);
      const replacement = await h.person('Giovanni replacement'); const cookie = await h.login(replacement.login ?? '');
      const original = await live(h, route.id); const stop = original.stops[0]; const availability = original.draft.planning?.participantAvailability[0]; assert.ok(stop && availability && original.draft.planning);
      const changed = { version: original.version, reason: 'DEMO substitute available participant before loading', confirmNotLoaded: true, confirmNotDeparted: true,
        plan: { ...original.draft, planning: { ...original.draft.planning, participantIds: [replacement.id],
          participantAvailability: [{ ...availability, participantId: replacement.id }], driver: { kind: 'participant', participantId: replacement.id } } },
        responsibleParticipants: [{ appointmentId: stop.appointmentId, participantId: replacement.id }] };
      const preview = RouteAmendReviewSchema.parse(await h.ok(`/routes/${route.id}/amend-review`, { method: 'POST', body: changed }));
      await h.ok(`/routes/${route.id}/amend`, { method: 'POST', body: { ...changed, requestId: randomUUID(), fingerprint: preview.fingerprint, acknowledgeEstimates: true } });
      assert.equal((await h.request(`/crew/routes/${route.id}`, { cookie: f.cookie })).status, 404);
      assert.equal((await h.request(`/crew/visits/${stop.appointmentId}`, { cookie: f.cookie })).status, 404);
      assert.equal((await h.request(`/crew/routes/${route.id}`, { cookie })).status, 200);
      const visit = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${stop.appointmentId}`, { cookie }));
      assert.equal(visit.responsibleParticipant?.id, replacement.id); assert.equal(visit.tasks.length, 1);
      assert.deepEqual(visit.workScope?.lines.map(({ sourceLineId, deliveryMilli }) => ({ sourceLineId, deliveryMilli })), [{ sourceLineId: 31, deliveryMilli: 1000 }, { sourceLineId: 32, deliveryMilli: 1000 }]);
    });

    await context.test('cancellation racing departure leaves a valid serial state', async () => {
      const f = await h.fixture({ count: 1 }); const route = await h.publish(f); const first = route.stops[0]; assert.ok(first);
      await h.confirm(first.deliveryId, first.appointmentId);
      const replies = await Promise.all([
        h.request(`/routes/${route.id}/cancel`, { method: 'POST', body: cancellation(route.version) }),
        h.request(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } }),
      ]);
      assert.equal(replies.filter(({ status }) => status === 200).length, 1);
      assert.ok(replies.some(({ status }) => status === 409 || status === 404));
      const state = await live(h, route.id);
      const visit = (await h.detail(first.deliveryId)).delivery.appointments.find(({ id }) => id === first.appointmentId); assert.ok(visit);
      assert.ok(state.status === 'cancelled' && visit.status === 'cancelled' || state.status === 'in_progress' && visit.status === 'booked');
    });

    await context.test('driverless publication and amendment preserve and restore original standalone transport on detachment', async () => {
      const f = await h.fixture({ count: 1 }); const route = await h.publish(f, true, true); const stop = route.stops[0]; assert.ok(stop);
      const old = (await h.detail(stop.deliveryId)).delivery.appointments.find(({ id }) => id === stop.appointmentId); assert.ok(old);
      const originalAllocation = old.transportAllocations?.find(({ driver }) => driver.kind === 'participant'); assert.ok(originalAllocation);
      assert.equal(originalAllocation.status, 'replaced');
      assert.deepEqual(old.transportAllocations?.find(({ status }) => status === 'active')?.driver, { kind: 'none' });
      const replacement = await h.fixture({ count: 1 }); const state = await live(h, route.id);
      const changed = { version: state.version, reason: 'DEMO replacement van before loading', confirmNotLoaded: true, confirmNotDeparted: true,
        plan: { ...state.draft, vehicleId: replacement.vehicle.id }, responsibleParticipants: [{ appointmentId: stop.appointmentId, participantId: f.participant.id }] };
      const preview = RouteAmendReviewSchema.parse(await h.ok(`/routes/${route.id}/amend-review`, { method: 'POST', body: changed }));
      const amended = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/amend`, { method: 'POST', body: { ...changed, requestId: randomUUID(), fingerprint: preview.fingerprint, acknowledgeEstimates: true } }));
      assert.deepEqual(amended.resources.driver, { kind: 'none' });
      await h.ok(`/routes/${route.id}/cancel`, { method: 'POST', body: cancellation(amended.version) });
      const detached = (await h.detail(stop.deliveryId)).delivery.appointments.find(({ id }) => id === stop.appointmentId); assert.ok(detached);
      const restored = detached.transportAllocations?.filter(({ status }) => status === 'active'); assert.equal(restored?.length, 1);
      assert.equal(restored?.[0]?.vehicle.id, f.vehicle.id); assert.notEqual(restored?.[0]?.id, originalAllocation.id);
      assert.deepEqual(restored?.[0]?.driver, originalAllocation.driver);
      assert.equal(detached.transportAllocations?.find(({ id }) => id === originalAllocation.id)?.status, 'replaced');
      assert.deepEqual(detached.customerConfirmation, old.customerConfirmation);
    });
  } finally { await h.close(); }
});

type ReconciliationInput = z.infer<typeof RouteReconcileInputSchema>;
async function reconciliation(h: LifecycleFixture, routeId: string): Promise<ReconciliationInput> {
  const state = await live(h, routeId);
  const owners = z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(await h.ok('/routes/reconciliation-owners'));
  const owner = owners[0]; assert.ok(owner);
  return { ...command(state.version, 'DEMO exact line reconciliation'), lines: state.lines.map((line) => ({
    appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId: owner.id, note: 'DEMO custody and remaining work checked by dispatcher',
    nextActions: [
      ...(line.remainingDeliveryMilli > 0 ? [{ operation: 'delivery' as const, action: 'ready_for_repeat' as const, ownerUserId: owner.id, note: 'Arrange remaining furniture only', followUpAppointmentId: null }] : []),
      ...(line.remainingInstallationMilli > 0 ? [{ operation: 'installation' as const, action: 'installation_visit' as const, ownerUserId: owner.id, note: 'Arrange installation of delivered furniture', followUpAppointmentId: null }] : []),
      ...(line.remainingCollectionMilli > 0 ? [{ operation: 'collection' as const, action: 'ready_for_repeat' as const, ownerUserId: owner.id, note: 'Arrange outstanding collection only', followUpAppointmentId: null }] : []),
    ],
    cargo: [
      ...(line.plannedDeliveryMilli > line.deliveredMilli ? [{ kind: 'undelivered' as const, location: 'warehouse' as const,
        quantityMilli: line.plannedDeliveryMilli - line.deliveredMilli, note: 'DEMO dispatcher verifies these units stayed at warehouse' }] : []),
      ...(line.collectedMilli > 0 ? [{ kind: 'collection' as const, location: 'awaiting_receipt' as const, quantityMilli: line.collectedMilli,
        note: 'Collected furniture has returned; warehouse receipt is pending' }] : []),
    ],
  })) };
}

void test('stage 09: actual return, separate cargo receipt and remaining-work reconciliation', async (context) => {
  const h = await lifecycleFixture();
  try {
    await context.test('partial delivery preserves exact facts; return and route closure do not close the picking or installation remainder', async () => {
      const f = await h.fixture({ count: 1, service: 'delivery_installation' }); const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      await depart(h, route, f.cookie); await h.start(stop.appointmentId, f.cookie);
      await h.finish(stop.appointmentId, f.cookie,
        [{ sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 32, deliveredMilli: 500, installedMilli: 0 }],
        [{ sourceLineId: 31, operation: 'installation', reason: 'time_shortage', note: 'DEMO installation on another day' },
          { sourceLineId: 32, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'DEMO remaining chair at warehouse' },
          { sourceLineId: 32, operation: 'installation', reason: 'time_shortage', note: 'DEMO installation on another day' }]);
      const before = await h.detail(stop.deliveryId);
      const report = before.delivery.appointments.find(({ id }) => id === stop.appointmentId)?.results[0]; assert.ok(report);
      let state = await live(h, route.id); assert.equal(state.status, 'in_progress');
      assert.deepEqual(state.lines.map(({ sourceLineId, deliveredMilli, installedMilli }) => ({ sourceLineId, deliveredMilli, installedMilli })),
        [{ sourceLineId: 31, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 32, deliveredMilli: 500, installedMilli: 0 }]);
      assert.ok(state.lines.every(({ packagingStatus }) => packagingStatus === 'unknown'));
      assert.equal(state.capabilities.canReturn, true);
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/returning`, { method: 'POST', cookie: f.cookie,
        body: { version: state.version, requestId: randomUUID() } }));
      assert.equal(state.status, 'returning');
      const returnedBody = { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'DEMO physically returned' };
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/return`, { method: 'POST', cookie: f.cookie, body: returnedBody }));
      assert.equal(state.status, 'returned'); assert.equal(state.runtime.warehouseReceipts.length, 0);
      const afterReturn = await dataSnapshot(h);
      await h.ok(`/crew/routes/${route.id}/return`, { method: 'POST', cookie: f.cookie, body: returnedBody }); assert.deepEqual(await dataSnapshot(h), afterReturn);
      assert.equal((await h.request(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) })).status, 409);
      const reconcileBody = await reconciliation(h, route.id);
      const missingOwner = { ...reconcileBody, lines: reconcileBody.lines.map((line) => ({ ...line, ownerUserId: randomUUID() })) };
      assert.equal((await h.request(`/routes/${route.id}/reconcile`, { method: 'POST', body: missingOwner })).status, 409);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: reconcileBody }));
      const closeBody = command(state.version, 'DEMO reviewed route, picking still has remaining work');
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/close`, { method: 'POST', body: closeBody }));
      assert.equal(state.status, 'closed');
      const final = await h.detail(stop.deliveryId);
      assert.equal(final.delivery.completedAt, null);
      assert.deepEqual(final.delivery.appointments.find(({ id }) => id === stop.appointmentId)?.results[0], report);
      assert.deepEqual(final.lineServices.map(({ sourceLineId, remainingDeliveryMilli, remainingInstallationMilli }) => ({ sourceLineId, remainingDeliveryMilli, remainingInstallationMilli })),
        [{ sourceLineId: 31, remainingDeliveryMilli: 1000, remainingInstallationMilli: 2000 }, { sourceLineId: 32, remainingDeliveryMilli: 1500, remainingInstallationMilli: 2000 }]);
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const install = { version: final.delivery.version, requestId: randomUUID(), startsAt: tomorrow,
        endsAt: new Date(Date.parse(tomorrow) + 60 * 60_000).toISOString(), workLines: [{ sourceLineId: 31, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }] };
      const planned = await h.ok(`/deliveries/${stop.deliveryId}/appointments`, { method: 'POST', body: install });
      const visits = z.object({ delivery: z.object({ version: z.number(), appointments: z.array(z.object({ id: z.string(), workScope: z.object({ lines: z.array(z.object({ sourceLineId: z.number(), deliveryMilli: z.number(), installationMilli: z.number() })) }).optional() })) }) }).parse(planned);
      assert.ok(visits.delivery.appointments.some(({ id, workScope }) => id !== stop.appointmentId && workScope?.lines[0]?.deliveryMilli === 0 && workScope.lines[0].installationMilli === 1000));
      assert.equal((await h.request(`/deliveries/${stop.deliveryId}/appointments`, { method: 'POST', body: { ...install, version: visits.delivery.version, requestId: randomUUID(),
        workLines: [{ sourceLineId: 31, deliveryMilli: 0, installationMilli: 1500, collectionMilli: 0 }] } })).status, 409);
    });

    await context.test('collected furniture requires a separate bounded warehouse receipt; replay never doubles quantities', async () => {
      const f = await h.fixture({ count: 1, service: 'collection_only' }); const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      await depart(h, route, f.cookie); await h.start(stop.appointmentId, f.cookie);
      await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 0, collectedMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 0, collectedMilli: 1000 }]);
      let state = await live(h, route.id);
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/returning`, { method: 'POST', cookie: f.cookie, body: { version: state.version, requestId: randomUUID() } }));
      state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/return`, { method: 'POST', cookie: f.cookie,
        body: { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } }));
      assert.ok(state.lines.every(({ collectedMilli, warehouseReceivedCollectionMilli }) => collectedMilli === 1000 && warehouseReceivedCollectionMilli === 0));
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: await reconciliation(h, route.id) }));
      assert.equal((await h.request(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) })).status, 409);
      const receipt = { ...command(state.version, 'DEMO warehouse confirms physical receipt'), items: [31, 32].map((sourceLineId) => ({
        appointmentId: stop.appointmentId, sourceLineId, kind: 'collection', quantityMilli: 1000, note: `DEMO received source line ${sourceLineId}` })) };
      assert.equal((await h.request(`/routes/${route.id}/warehouse-receipts`, { method: 'POST', cookie: f.cookie, body: receipt })).status, 401);
      assert.equal((await h.request(`/routes/${route.id}/warehouse-receipts`, { method: 'POST', body: { ...receipt, items: receipt.items.map((item) => ({ ...item, quantityMilli: 1001 })) } })).status, 409);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/warehouse-receipts`, { method: 'POST', body: receipt }));
      assert.ok(state.lines.every(({ warehouseReceivedCollectionMilli }) => warehouseReceivedCollectionMilli === 1000));
      assert.equal(state.runtime.warehouseReceipts.length, 1);
      const before = await dataSnapshot(h);
      await h.ok(`/routes/${route.id}/warehouse-receipts`, { method: 'POST', body: receipt }); assert.deepEqual(await dataSnapshot(h), before);
      assert.equal((await h.request(`/routes/${route.id}/warehouse-receipts`, { method: 'POST', body: { ...receipt, version: state.version, requestId: randomUUID() } })).status, 409);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) }));
      assert.equal(state.status, 'closed');
      const delivery = await h.detail(stop.deliveryId);
      assert.deepEqual(delivery.lineServices.map(({ collectedMilli, remainingCollectionMilli }) => ({ collectedMilli, remainingCollectionMilli })),
        [{ collectedMilli: 1000, remainingCollectionMilli: 1000 }, { collectedMilli: 1000, remainingCollectionMilli: 1000 }]);
    });

    await context.test('missing reports do not block factual return; buffered resource reuse and closure exceptions remain explicit', async () => {
      const f = await h.fixture({ count: 1, buffer: 30 }); const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      let state = await depart(h, route, f.cookie); await h.start(stop.appointmentId, f.cookie);
      assert.equal((await h.request(`/crew/routes/${route.id}/returning`, { method: 'POST', cookie: f.cookie,
        body: { version: state.version, requestId: randomUUID() } })).status, 409);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/abort`, { method: 'POST', body: command(state.version, 'DEMO vehicle problem; report remains unresolved') }));
      assert.equal(state.status, 'returning');
      const returnBody = { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'Physically returned, unfinished report is visible' };
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/return`, { method: 'POST', body: returnBody }));
      assert.equal(state.status, 'returned'); assert.ok(state.lines.every(({ reportMissing }) => reportMissing));
      assert.equal((await h.detail(stop.deliveryId)).delivery.appointments.find(({ id }) => id === stop.appointmentId)?.status, 'in_progress');
      assert.ok(state.capabilities.closureBlockers.length > 0);
      assert.equal((await h.request(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) })).status, 409);
      const [reservation] = await rows(h.database.source.manager, z.object({ endsAt: z.date(), buffer: z.number() }),
        'SELECT ends_at AS "endsAt",buffer_minutes AS buffer FROM route_reservation WHERE route_id=$1 LIMIT 1', [route.id]);
      assert.equal(reservation?.endsAt.toISOString(), returnBody.actualReturnedAt); assert.equal(reservation.buffer, 30);
      const next = await h.fixture({ count: 1, departAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString() });
      next.participant = f.participant; next.colleague = f.colleague; next.crew = f.crew; next.vehicle = f.vehicle; next.cookie = f.cookie;
      next.draft = { ...next.draft, crewId: f.crew.id, vehicleId: f.vehicle.id, planning: f.draft.planning };
      const future = await h.publish(next); const futureStop = future.stops[0]; assert.ok(futureStop); await h.confirm(futureStop.deliveryId, futureStop.appointmentId);
      assert.equal((await h.request(`/crew/routes/${future.id}/depart`, { method: 'POST', cookie: f.cookie,
        body: { version: future.version, requestId: randomUUID() } })).status, 409, 'Actual-return turnaround buffer still blocks immediate departure');
      assert.equal((await live(h, future.id)).status, 'published', 'A dependency conflict does not erase the future booking');
      const standalone = await h.fixture({ count: 1 }); const delivery = standalone.deliveries[0]; assert.ok(delivery);
      const startsAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
      let detail = z.object({ delivery: z.object({ version: z.number(), appointments: z.array(z.object({ id: z.string().uuid() })) }) }).parse(await h.ok(`/deliveries/${delivery.id}/appointments`,
        { method: 'POST', body: { version: delivery.version, requestId: randomUUID(), startsAt, endsAt: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(), workLines: standalone.workLines } }));
      const independentVisit = detail.delivery.appointments[0]; assert.ok(independentVisit);
      const visitPath = `/deliveries/${delivery.id}/appointments/${independentVisit.id}`;
      detail = z.object({ delivery: z.object({ version: z.number(), appointments: z.array(z.object({ id: z.string().uuid() })) }) }).parse(await h.ok(`${visitPath}/assign`, { method: 'POST', body: {
        version: detail.delivery.version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id],
        staffing: [{ crewId: f.crew.id, participantIds: [f.participant.id] }] } }));
      await h.confirm(delivery.id, independentVisit.id);
      const independent = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${independentVisit.id}`, { cookie: f.cookie }));
      assert.equal(independent.canStart, false);
      assert.equal((await h.request(`/crew/visits/${independentVisit.id}/start`, { method: 'POST', cookie: f.cookie,
        body: { version: independent.version, requestId: randomUUID() } })).status, 409, 'Standalone Start cannot bypass the same actual-return buffer');

      const unknown = await reconciliation(h, route.id);
      unknown.lines = unknown.lines.map((line) => ({ ...line,
        nextActions: line.nextActions.map((action) => ({ ...action, action: 'manual_review', note: 'Report is missing; investigate without assuming a delivery' })),
        cargo: [{ kind: 'undelivered', location: 'unknown', quantityMilli: null, note: 'Actual custody is not verified yet' }],
      }));
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: unknown }));
      assert.equal((await h.request(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) })).status, 409);
      const exceptionReason = 'DEMO dispatcher accepts an unresolved report for investigation, without completing the delivery';
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/close`, { method: 'POST', body: { ...command(state.version), exceptionReason } }));
      const closed = state.runtime.closed; assert.ok(closed); assert.equal(state.runtime.closureException, exceptionReason);
      assert.equal((await h.detail(stop.deliveryId)).delivery.completedAt, null);
      await h.finish(stop.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000 }]);
      const corrected = await reconciliation(h, route.id);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: corrected }));
      assert.equal(state.status, 'closed'); assert.deepEqual(state.runtime.closed, closed);
      assert.equal(state.runtime.closureException, exceptionReason); assert.ok(state.lines.every(({ reportMissing }) => !reportMissing));
    });

    await context.test('dispatcher skip releases only the future work and retains the trip reservation and signed history', async () => {
      const f = await h.fixture(); const route = await h.publish(f); const first = route.stops[0]; const second = route.stops[1]; assert.ok(first && second);
      await depart(h, route, f.cookie); await h.start(first.appointmentId, f.cookie);
      await h.finish(first.appointmentId, f.cookie, [{ sourceLineId: 31, deliveredMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000 }]);
      const original = (await h.detail(first.deliveryId)).delivery.appointments.find(({ id }) => id === first.appointmentId)?.results[0]; assert.ok(original);
      const state = await live(h, route.id);
      assert.equal((await h.request(`/routes/${route.id}/stops/${first.appointmentId}/skip`, { method: 'POST', body: command(state.version) })).status, 409);
      const skipped = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/stops/${second.appointmentId}/skip`, { method: 'POST', body: command(state.version, 'DEMO customer rescheduled before visit') }));
      assert.equal(skipped.stops.find(({ appointmentId }) => appointmentId === second.appointmentId)?.skipped, true);
      assert.equal((await h.detail(second.deliveryId)).lineServices[0]?.availableDeliveryMilli, 2000);
      const resources = await rows(h.database.source.manager, z.object({ resource: z.string() }), 'SELECT resource FROM route_reservation WHERE route_id=$1', [route.id]);
      assert.equal(resources.length, 4, 'Crew, two people and vehicle remain reserved through return');
      assert.deepEqual((await h.detail(first.deliveryId)).delivery.appointments.find(({ id }) => id === first.appointmentId)?.results[0], original);
      assert.equal((await h.request(`/crew/visits/${second.appointmentId}`, { cookie: f.cookie })).status, 404);
    });

    await context.test('closing an aborted loaded route requires explicit skip of unstarted work even with an exception', async () => {
      const f = await h.fixture({ count: 1 }); const route = await h.publish(f); const stop = route.stops[0]; assert.ok(stop);
      let state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/abort`, { method: 'POST',
        body: command(route.version, 'DEMO loaded vehicle did not leave the depot') }));
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/return`, { method: 'POST',
        body: { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } }));
      assert.equal((await h.request(`/routes/${route.id}/close`, { method: 'POST',
        body: { ...command(state.version), exceptionReason: 'DEMO cannot hide the reserved unstarted work' } })).status, 409);
      assert.equal((await h.detail(stop.deliveryId)).lineServices[0]?.reservedDeliveryMilli, 1000);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/stops/${stop.appointmentId}/skip`, { method: 'POST',
        body: command(state.version, 'DEMO explicitly release unattempted work for repeat planning') }));
      assert.equal((await h.detail(stop.deliveryId)).lineServices[0]?.reservedDeliveryMilli, 0);
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: await reconciliation(h, route.id) }));
      state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/close`, { method: 'POST', body: command(state.version) }));
      assert.equal(state.status, 'closed'); assert.equal((await h.detail(stop.deliveryId)).delivery.completedAt, null);
    });
  } finally { await h.close(); }
});
