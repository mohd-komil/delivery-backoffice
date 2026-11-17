import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import { CrewFinishInput, CrewVisitDetailSchema } from '../src/crew/contracts';
import { rows } from '../src/database/database';
import type { WorkLineInput } from '../src/domain/model';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { DeliveryDetail, lifecycleFixture, type LifecycleFixture } from './support/route-lifecycle-fixture';

async function operations(h: LifecycleFixture, routeId: string) {
  return RouteOperationsSchema.parse(await h.ok(`/routes/${routeId}/operations`));
}

async function snapshot(h: LifecycleFixture) {
  const tables = ['delivery', 'appointment', 'reservation', 'transport_reservation', 'route_publication',
    'route_stop', 'route_reservation', 'route_command', 'route_revision', 'file_record', 'command_receipt', 'audit'] as const;
  const state: Record<string, string[]> = {};
  for (const table of tables) state[table] = (await rows(h.database.source.manager, z.object({ value: z.string() }),
    `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`)).map(({ value }) => value);
  return state;
}

async function checkedVisit(h: LifecycleFixture, appointmentId: string, cookie: string) {
  let visit = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${appointmentId}`, { cookie }));
  for (const item of visit.tasks.flatMap(({ checklist }) => checklist)) {
    visit = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${appointmentId}/checklist/${item.id}`, {
      method: 'PATCH', cookie, body: { version: visit.version, requestId: randomUUID(), done: true },
    }));
  }
  return visit;
}

async function bookRepeat(h: LifecycleFixture, deliveryId: string, workLines: WorkLineInput[], startsAt: string) {
  const original = await h.detail(deliveryId);
  const body = { version: original.delivery.version, requestId: randomUUID(), startsAt,
    endsAt: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(), workLines };
  const booked = DeliveryDetail.parse(await h.ok(`/deliveries/${deliveryId}/appointments`, { method: 'POST', body }));
  const appointment = booked.delivery.appointments.at(-1); assert.ok(appointment?.workScope);
  assert.deepEqual(appointment.workScope.lines.map(({ sourceLineId, deliveryMilli, installationMilli, collectionMilli }) =>
    ({ sourceLineId, deliveryMilli, installationMilli, collectionMilli })), workLines);
  assert.deepEqual(DeliveryDetail.parse(await h.ok(`/deliveries/${deliveryId}/appointments`, { method: 'POST', body })), booked);
  return { booked, appointment };
}

void test('stage 10: one authenticated journey preserves two Picking identities through partial, absent, retries and remaining-only follow-ups', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ service: 'delivery_installation' });
    const [pickingA, pickingB] = f.deliveries; assert.ok(pickingA && pickingB);
    assert.notEqual(pickingA.source.pickingId, pickingB.source.pickingId);
    assert.notEqual(pickingA.source.customer.address, pickingB.source.customer.address);
    assert.notEqual(pickingA.source.items[0]?.saleOrderId, pickingB.source.items[0]?.saleOrderId);
    assert.ok([...pickingA.source.items, ...pickingB.source.items].every(({ productId }) => productId === 7));
    // Repeated source line IDs across Pickings deliberately challenge aggregate scoping as well as SKU identity.
    f.workLines = [31, 32].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 }));
    const route = await h.publish(f);
    const [stopA, stopB] = route.stops; assert.ok(stopA && stopB);
    await h.confirm(stopA.deliveryId, stopA.appointmentId);
    await h.confirm(stopB.deliveryId, stopB.appointmentId);
    let state = await operations(h, route.id);
    await h.ok(`/crew/routes/${route.id}/depart`, { method: 'POST', cookie: f.cookie,
      body: { version: state.version, requestId: randomUUID() } });
    await h.start(stopA.appointmentId, f.cookie);
    const active = await checkedVisit(h, stopA.appointmentId, f.cookie);
    const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 140, b: 190 } } }).png().toBuffer();
    const report = CrewFinishInput.parse({ version: active.version, requestId: randomUUID(), summary: 'DEMO stage 10: partial delivery, installation remains',
      quantities: [{ sourceLineId: 31, deliveredMilli: 2000, installedMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000, installedMilli: 0 }],
      itemChecks: [{ sourceLineId: 31, status: 'ok', note: 'DEMO one installation remains' }, { sourceLineId: 32, status: 'ok', note: 'DEMO one chair remains at warehouse' }],
      incompleteWork: [{ sourceLineId: 31, operation: 'installation', reason: 'time_shortage', note: 'DEMO arrange installation-only follow-up' },
        { sourceLineId: 32, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'DEMO second chair was not loaded' },
        { sourceLineId: 32, operation: 'installation', reason: 'time_shortage', note: 'DEMO arrange installation after delivery' }],
      customerSignature: { signerName: 'DEMO customer A', strokes: [[{ x: 100, y: 100 }, { x: 180, y: 200 }, { x: 280, y: 120 }]] },
      crewSignature: { strokes: [[{ x: 120, y: 150 }, { x: 220, y: 100 }, { x: 300, y: 210 }]] },
      photos: [31, 32].map((sourceLineId) => ({ name: `demo-stage10-${sourceLineId}.png`, base64: photo.toString('base64'), sourceLineId })),
    });
    const finishPath = `/crew/visits/${stopA.appointmentId}/finish`;
    const beforeFailure = await snapshot(h);
    await h.database.source.query(`CREATE FUNCTION reject_stage10_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'DEMO stage 10 late receipt failure'; END $$;
      CREATE TRIGGER stage10_receipt_failure BEFORE INSERT ON command_receipt
      FOR EACH ROW EXECUTE FUNCTION reject_stage10_receipt()`);
    try {
      assert.equal((await h.request(finishPath, { method: 'POST', cookie: f.cookie, body: report })).status, 500);
    } finally {
      await h.database.source.query('DROP TRIGGER stage10_receipt_failure ON command_receipt; DROP FUNCTION reject_stage10_receipt()');
    }
    assert.deepEqual(await snapshot(h), beforeFailure, 'A late database failure must roll back both Picking state, evidence metadata, resources and receipt');
    assert.equal(CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${stopA.appointmentId}`, { cookie: f.cookie })).status, 'in_progress');

    // Model a lost success response by discarding it, then retrying the original request ID and old version.
    // This verifies ambiguous-outcome recovery; it does not claim a physical mobile network test.
    await h.ok(finishPath, { method: 'POST', cookie: f.cookie, body: report });
    const committed = await snapshot(h);
    const replay = CrewVisitDetailSchema.parse(await h.ok(finishPath, { method: 'POST', cookie: f.cookie, body: report }));
    assert.equal(replay.status, 'completed');
    assert.deepEqual(await snapshot(h), committed, 'Lost-response replay must not duplicate quantities, files, audit or receipts');
    assert.equal((await h.request(finishPath, { method: 'POST', cookie: f.colleagueCookie, body: report })).status, 403);
    assert.equal((await h.request(finishPath, { method: 'POST', cookie: f.cookie, body: { ...report, summary: 'Changed payload with the same key' } })).status, 409);
    assert.deepEqual(await snapshot(h), committed);
    const partialA = await h.detail(pickingA.id);
    const savedReport = partialA.delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0]; assert.ok(savedReport);
    assert.ok(savedReport.customerSignature && savedReport.crewSignature);
    assert.equal(savedReport.evidence.length, 2);
    assert.deepEqual(savedReport.evidence.map(({ itemIds }) => itemIds), [[31], [32]]);
    assert.equal(partialA.history.filter(({ action }) => action === 'execution.crew_reported').length, 1);
    assert.deepEqual(partialA.lineServices.map(({ sourceLineId, deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli }) =>
      [sourceLineId, deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli]), [[31, 2000, 1000, 0, 1000], [32, 1000, 0, 1000, 2000]]);
    assert.deepEqual((await h.detail(pickingB.id)).lineServices.map(({ deliveredMilli, installedMilli }) => [deliveredMilli, installedMilli]), [[0, 0], [0, 0]]);

    const second = await h.start(stopB.appointmentId, f.cookie);
    const absent = { version: second.version, requestId: randomUUID(), reason: 'DEMO customer B did not answer the door or phone; nothing handed over' };
    const absentPath = `/crew/visits/${stopB.appointmentId}/attempt-failure`;
    await h.ok(absentPath, { method: 'POST', cookie: f.cookie, body: absent });
    const absentCommitted = await snapshot(h);
    const absentReplay = CrewVisitDetailSchema.parse(await h.ok(absentPath, { method: 'POST', cookie: f.cookie, body: absent }));
    assert.equal(absentReplay.status, 'failed');
    assert.equal(absentReplay.failedAttempt?.reason, absent.reason);
    assert.deepEqual(await snapshot(h), absentCommitted);
    const absentB = await h.detail(pickingB.id);
    const failedVisit = absentB.delivery.appointments.find(({ id }) => id === stopB.appointmentId); assert.ok(failedVisit);
    assert.deepEqual(failedVisit.results, [], 'An absent customer does not produce an unsigned delivery report');
    assert.equal(absentB.history.filter(({ action }) => action === 'execution.customer_absent').length, 1);
    assert.deepEqual(absentB.history.find(({ action }) => action === 'execution.customer_absent')?.details,
      { appointmentId: stopB.appointmentId, reason: absent.reason, version: absentReplay.version });
    assert.deepEqual(absentB.lineServices.map(({ deliveredMilli, remainingDeliveryMilli, remainingInstallationMilli, reservedDeliveryMilli }) =>
      [deliveredMilli, remainingDeliveryMilli, remainingInstallationMilli, reservedDeliveryMilli]), [[0, 2000, 2000, 0], [0, 2000, 2000, 0]]);
    assert.deepEqual((await h.detail(pickingA.id)).delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0], savedReport);

    state = await operations(h, route.id);
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/returning`, { method: 'POST', cookie: f.cookie,
      body: { version: state.version, requestId: randomUUID() } }));
    state = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${route.id}/return`, { method: 'POST', cookie: f.cookie,
      body: { version: state.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString() } }));
    assert.equal(state.status, 'returned');
    const [owner] = z.array(z.object({ id: z.string().uuid() })).parse(await h.ok('/routes/reconciliation-owners')); assert.ok(owner);
    state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/reconcile`, { method: 'POST', body: {
      version: state.version, requestId: randomUUID(), reason: 'DEMO stage 10 dispatcher checked exact outstanding work',
      lines: state.lines.map((line) => ({ appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId: owner.id,
        note: 'DEMO dispatcher verified custody independently of the failed visit',
        nextActions: [
          ...(line.remainingDeliveryMilli > 0 ? [{ operation: 'delivery', action: 'ready_for_repeat', ownerUserId: owner.id, note: 'DEMO plan remaining delivery', followUpAppointmentId: null }] : []),
          ...(line.remainingInstallationMilli > 0 ? [{ operation: 'installation', action: 'installation_visit', ownerUserId: owner.id, note: 'DEMO plan remaining installation', followUpAppointmentId: null }] : []),
        ],
        cargo: line.plannedDeliveryMilli > line.deliveredMilli ? [{ kind: 'undelivered', location: 'warehouse',
          quantityMilli: line.plannedDeliveryMilli - line.deliveredMilli, note: 'DEMO dispatcher verified undelivered chairs at warehouse' }] : [],
      })),
    } }));
    state = RouteOperationsSchema.parse(await h.ok(`/routes/${route.id}/close`, { method: 'POST',
      body: { version: state.version, requestId: randomUUID(), reason: 'DEMO closed trip; both Pickings retain their own remainder' } }));
    assert.equal(state.status, 'closed');
    assert.equal((await h.detail(pickingA.id)).delivery.completedAt, null);
    assert.equal((await h.detail(pickingB.id)).delivery.completedAt, null);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const repeatA = await bookRepeat(h, pickingA.id, [
      { sourceLineId: 31, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 },
      { sourceLineId: 32, deliveryMilli: 1000, installationMilli: 2000, collectionMilli: 0 },
    ], tomorrow);
    const repeatB = await bookRepeat(h, pickingB.id, [
      { sourceLineId: 31, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 },
      { sourceLineId: 32, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 },
    ], new Date(Date.parse(tomorrow) + 2 * 60 * 60_000).toISOString());
    assert.ok(repeatA.booked.lineServices.every(({ availableDeliveryMilli, availableInstallationMilli }) => availableDeliveryMilli === 0 && availableInstallationMilli === 0));
    assert.ok(repeatB.booked.lineServices.every(({ availableDeliveryMilli, availableInstallationMilli }) => availableDeliveryMilli === 0 && availableInstallationMilli === 0));
    const beforeOverbooking = await snapshot(h);
    const attempts = await Promise.all([pickingA.id, pickingB.id].map(async (deliveryId) => {
      const current = await h.detail(deliveryId);
      return h.request(`/deliveries/${deliveryId}/appointments`, { method: 'POST', body: { version: current.delivery.version,
        requestId: randomUUID(), startsAt: tomorrow, endsAt: new Date(Date.parse(tomorrow) + 60 * 60_000).toISOString(),
        workLines: [{ sourceLineId: 31, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }] } });
    }));
    assert.deepEqual(attempts.map(({ status }) => status), [409, 409]);
    assert.deepEqual(await snapshot(h), beforeOverbooking, 'Completed or already-reserved same-SKU work cannot be booked again');
    assert.deepEqual((await h.detail(pickingA.id)).delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0], savedReport);
    assert.deepEqual((await h.detail(pickingB.id)).delivery.appointments.find(({ id }) => id === stopB.appointmentId), failedVisit);

    const repeats = [
      { deliveryId: pickingA.id, appointment: repeatA.appointment,
        quantities: [{ sourceLineId: 31, deliveredMilli: 0, installedMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 1000, installedMilli: 2000 }] },
      { deliveryId: pickingB.id, appointment: repeatB.appointment,
        quantities: [{ sourceLineId: 31, deliveredMilli: 2000, installedMilli: 2000 }, { sourceLineId: 32, deliveredMilli: 2000, installedMilli: 2000 }] },
    ];
    for (const repeat of repeats) {
      const path = `/deliveries/${repeat.deliveryId}/appointments/${repeat.appointment.id}`;
      let detail = await h.detail(repeat.deliveryId);
      detail = DeliveryDetail.parse(await h.ok(`${path}/assign`, { method: 'POST', body: {
        version: detail.delivery.version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id],
        staffing: [{ crewId: f.crew.id, participantIds: [f.participant.id, f.colleague.id] }],
      } }));
      await h.ok(`${path}/responsible`, { method: 'PATCH', body: { version: detail.delivery.version, participantId: f.participant.id } });
      await h.confirm(repeat.deliveryId, repeat.appointment.id);
      await h.start(repeat.appointment.id, f.cookie);
      await h.finish(repeat.appointment.id, f.cookie, repeat.quantities);
      detail = await h.detail(repeat.deliveryId);
      assert.deepEqual(detail.lineServices.map(({ deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli }) =>
        [deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli]), [[2000, 2000, 0, 0], [2000, 2000, 0, 0]]);
      const closed = DeliveryDetail.parse(await h.ok(`/deliveries/${repeat.deliveryId}/complete`, { method: 'POST', body: { version: detail.delivery.version } }));
      assert.ok(closed.delivery.completedAt, 'Only the fully performed Picking can close after its own repeat visit');
    }
    assert.deepEqual((await h.detail(pickingA.id)).delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0], savedReport);
    assert.deepEqual((await h.detail(pickingB.id)).delivery.appointments.find(({ id }) => id === stopB.appointmentId), failedVisit);
  } finally { await h.close(); }
});
