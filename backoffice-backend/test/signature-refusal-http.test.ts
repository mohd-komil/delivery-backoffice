import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { CrewVisitDetailSchema } from '../src/crew/contracts';
import { DispatcherDetailSchema, DispatcherListSchema } from '../src/dispatcher/contracts';
import type { WorkLineInput } from '../src/domain/model';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { DeliveryDetail, ErrorCode, lifecycleFixture } from './support/route-lifecycle-fixture';

const lines = [31, 32];
const work = (sourceLineId: number, deliveryMilli: number): WorkLineInput =>
  ({ sourceLineId, deliveryMilli, installationMilli: 0, collectionMilli: 0 });

void test('signature refusal preserves the Crew report and requires an authenticated dispatcher review', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ lineQuantity: 2 });
    const [full, partial] = f.deliveries;
    assert.ok(full && partial);
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3,
      background: { r: 25, g: 80, b: 142 } } }).png().toBuffer();
    const photos = [{ name: 'demo-handover.png', base64: bytes.toString('base64'), sourceLineId: 31 }];
    const crewSignature = { strokes: [[{ x: 150, y: 170 }, { x: 220, y: 100 }, { x: 310, y: 210 }]] };
    const book = (deliveryId: string, version: number, workLines: WorkLineInput[], offsetHours: number) => ({
      path: `/deliveries/${deliveryId}/appointments`, options: { method: 'POST' as const, body: {
        version, requestId: randomUUID(), workLines, startsAt: new Date(Date.now() + offsetHours * 3600000).toISOString(),
        endsAt: new Date(Date.now() + (offsetHours + 1) * 3600000).toISOString(),
      } },
    });
    async function start(deliveryId: string, version: number, offsetHours: number) {
      const booking = book(deliveryId, version, lines.map((id) => work(id, 2000)), offsetHours);
      const current = DeliveryDetail.parse(await h.ok(booking.path, booking.options));
      const visit = current.delivery.appointments[0];
      assert.ok(visit);
      const path = `${booking.path}/${visit.id}`;
      const assigned = DeliveryDetail.parse(await h.ok(`${path}/assign`, { method: 'POST', body: {
        version: current.delivery.version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id],
      } }));
      await h.ok(`${path}/responsible`, { method: 'PATCH', body: { version: assigned.delivery.version, participantId: f.participant.id } });
      await h.confirm(deliveryId, visit.id);
      let active = await h.start(visit.id, f.cookie);
      for (const checkpoint of active.tasks.flatMap(({ checklist }) => checklist)) {
        active = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${visit.id}/checklist/${checkpoint.id}`, { method: 'PATCH',
          cookie: f.cookie, body: { version: active.version, requestId: randomUUID(), done: true } }));
      }
      return { active, finishPath: `/crew/visits/${visit.id}/finish`, reviewBase: `${path}/results` };
    }
    const complete = (deliveryId: string, version: number) => h.request(`/deliveries/${deliveryId}/complete`, { method: 'POST', body: { version } });
    const queue = async (kind: 'signature_refusal' | 'evidence') => DispatcherListSchema.parse(await h.ok(`/dispatcher/queue?kind=${kind}`));
    const first = await start(full.id, full.version, -4);
    const command = {
      version: first.active.version, requestId: randomUUID(), summary: 'DEMO handover at the delivery address',
      quantities: lines.map((sourceLineId) => ({ sourceLineId, deliveredMilli: 2000 })),
      signatureRefusal: { reason: 'Customer received the furniture and declined to sign.' }, crewSignature, photos,
    };
    const finish = (path: string, body: unknown, cookie = f.cookie) => h.request(path, { method: 'POST', cookie, body });
    const invalid = await finish(first.finishPath, { ...command, photos: [] });
    assert.equal(invalid.status, 400);
    assert.equal(ErrorCode.parse(invalid.data).code, 'COMPLETION_PHOTO_REQUIRED');
    const empty = await finish(first.finishPath, { ...command, quantities: [] });
    assert.equal(empty.status, 400);
    assert.equal(ErrorCode.parse(empty.data).code, 'SIGNATURE_REFUSAL_REQUIRES_WORK');
    assert.equal((await finish(first.finishPath, command, f.colleagueCookie)).status, 403);
    const refused = await finish(first.finishPath, command);
    assert.equal(refused.status, 201);
    assert.equal(CrewVisitDetailSchema.parse(refused.data).signatureRefusalStatus, 'pending');
    assert.equal((await finish(first.finishPath, command)).status, 201);
    const pending = await h.detail(full.id);
    const original = pending.delivery.appointments[0]?.results[0];
    assert.ok(original && original.evidence[0]);
    assert.equal(pending.delivery.appointments[0]?.results.length, 1);
    assert.equal(original.customerSignature, null);
    assert.equal(original.crewSignature?.status, 'signed');
    assert.deepEqual(original.signatureRefusal, command.signatureRefusal);
    assert.equal(pending.history.filter(({ action }) => action === 'execution.crew_reported').length, 1);
    const [candidate] = (await queue('signature_refusal')).items;
    assert.ok(candidate);
    assert.equal(candidate.origin.resultId, original.id);
    assert.equal(candidate.target.tab, 'history');
    assert.equal((await queue('evidence')).total, 0);
    const evidence = await h.downloadEvidence(full.id, original.evidence[0].id);
    assert.equal(evidence.status, 200);
    assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), bytes);
    assert.equal((await h.downloadEvidence(full.id, original.evidence[0].id, '')).status, 401);
    assert.equal((await complete(full.id, pending.delivery.version)).status, 409);
    const duplicateBooking = book(full.id, pending.delivery.version, [work(31, 1000)], -1);
    assert.equal((await h.request(duplicateBooking.path, duplicateBooking.options)).status, 409);
    const reviewPath = `${first.reviewBase}/${original.id}/signature-refusal-review`;
    const approval = { version: pending.delivery.version, requestId: randomUUID(), decision: 'approved', reason: 'Verified handover and completion photo.' };
    assert.equal((await h.request(reviewPath, { method: 'POST', cookie: f.cookie, body: approval })).status, 401);
    assert.equal((await h.request(reviewPath, { method: 'POST', origin: 'http://127.0.0.1:3333', body: approval })).status, 403);
    const reviewed = DeliveryDetail.parse(await h.ok(reviewPath, { method: 'POST', body: approval }));
    assert.equal(reviewed.delivery.appointments[0]?.signatureRefusalReview?.reviewedBy.name, 'DEMO operator');
    assert.deepEqual(reviewed.delivery.appointments[0]?.results[0], original);
    assert.deepEqual(DeliveryDetail.parse(await h.ok(reviewPath, { method: 'POST', body: approval })), reviewed);
    assert.equal((await h.request(reviewPath, { method: 'POST', body: { ...approval, reason: 'Changed review.' } })).status, 409);
    assert.equal(await queue('signature_refusal').then(({ total }) => total), 0);
    assert.equal((await complete(full.id, reviewed.delivery.version)).status, 201);
    const resolved = DispatcherDetailSchema.parse(await h.ok(`/dispatcher/queue/${candidate.key}`));
    assert.equal(resolved.item.status, 'resolved');
    assert.equal(resolved.item.origin.resultId, original.id);
    assert.equal(resolved.item.facts.find(({ label }) => label === 'review_decision')?.value, 'approved');

    const second = await start(partial.id, partial.version, -2);
    const noPhoto = { ...command, version: second.active.version, requestId: randomUUID(), photos: [],
      quantities: [{ sourceLineId: 31, deliveredMilli: 1000 }, { sourceLineId: 32, deliveredMilli: 2000 }],
      incompleteWork: [{ sourceLineId: 31, operation: 'delivery', reason: 'missing_goods_or_parts', note: null }],
      signatureRefusal: { reason: 'Customer declined to sign for the partial handover.', noPhotoReason: 'Customer requested no photography in the home.' },
    };
    const contradictory = await finish(second.finishPath, { ...noPhoto, photos });
    assert.equal(contradictory.status, 400);
    assert.equal(ErrorCode.parse(contradictory.data).code, 'SIGNATURE_REFUSAL_PHOTO_CONFLICT');
    await h.ok(second.finishPath, { method: 'POST', cookie: f.cookie, body: noPhoto });
    const pendingPartial = await h.detail(partial.id);
    const report = pendingPartial.delivery.appointments[0]?.results[0];
    assert.ok(report);
    assert.equal(report.evidence.length, 0);
    assert.deepEqual(report.signatureRefusal, noPhoto.signatureRefusal);
    assert.deepEqual(pendingPartial.lineServices.map(({ remainingDeliveryMilli }) => remainingDeliveryMilli), [1000, 0]);
    const blocked = book(partial.id, pendingPartial.delivery.version, [work(31, 2000)], 1);
    assert.equal((await h.request(blocked.path, blocked.options)).status, 409);
    const correctionPath = `${second.reviewBase}/${report.id}/signature-refusal-review`;
    const correction = { version: pendingPartial.delivery.version, requestId: randomUUID(), decision: 'corrected',
      reason: 'Verified that only the second order was handed over.',
      quantities: [{ sourceLineId: 31, deliveredMilli: 0 }, { sourceLineId: 32, deliveredMilli: 2000 }] };
    const excess = { ...correction, quantities: [{ sourceLineId: 31, deliveredMilli: 2000 }, correction.quantities[1]] };
    assert.equal((await h.request(correctionPath, { method: 'POST', body: excess })).status, 400);
    const corrected = DeliveryDetail.parse(await h.ok(correctionPath, { method: 'POST', body: correction }));
    assert.deepEqual(corrected.delivery.appointments[0]?.results[0], report);
    assert.equal(corrected.delivery.appointments[0]?.signatureRefusalReview?.decision, 'corrected');
    assert.equal(corrected.history.filter(({ action }) => action === 'execution.signature_refusal_reviewed').length, 1);
    assert.deepEqual(DeliveryDetail.parse(await h.ok(correctionPath, { method: 'POST', body: correction })), corrected);
    assert.equal((await h.request(correctionPath, { method: 'POST', body: {
      ...correction, requestId: randomUUID(), version: corrected.delivery.version,
    } })).status, 409);
    assert.deepEqual(corrected.lineServices.map(({ sourceLineId, remainingDeliveryMilli }) => [sourceLineId, remainingDeliveryMilli]), [[31, 2000], [32, 0]]);
    assert.equal((await complete(partial.id, corrected.delivery.version)).status, 409);
    const repeat = book(partial.id, corrected.delivery.version, [work(31, 2000)], 1);
    assert.equal((await h.request(repeat.path, repeat.options)).status, 201);
    const crewReviewed = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${second.active.id}`, { cookie: f.cookie }));
    assert.equal(crewReviewed.signatureRefusalStatus, 'corrected');
  } finally {
    await h.close();
  }
});

void test('a refusal review cannot reduce a collection below actual warehouse receipts', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ count: 1, service: 'collection_only', lineQuantity: 1 });
    const published = await h.publish(f);
    const [stop] = published.stops;
    assert.ok(stop);
    await h.confirm(stop.deliveryId, stop.appointmentId);
    const path = `/crew/routes/${published.id}`;
    let route = RouteOperationsSchema.parse(await h.ok(path, { cookie: f.cookie }));
    await h.ok(`${path}/depart`, { method: 'POST', cookie: f.cookie, body: { version: route.version, requestId: randomUUID() } });
    const visit = await h.start(stop.appointmentId, f.cookie);
    const quantities = lines.map((sourceLineId) => ({ sourceLineId, deliveredMilli: 0, collectedMilli: 1000 }));
    await h.ok(`/crew/visits/${stop.appointmentId}/finish`, { method: 'POST', cookie: f.cookie, body: {
      version: visit.version, requestId: randomUUID(), summary: 'DEMO two items collected', quantities,
      signatureRefusal: { reason: 'Customer declined to sign for collection.', noPhotoReason: 'Customer prohibited photography.' }, photos: [],
      crewSignature: { strokes: [[{ x: 100, y: 200 }, { x: 180, y: 220 }, { x: 300, y: 150 }]] },
    } });
    route = RouteOperationsSchema.parse(await h.ok(path, { cookie: f.cookie }));
    route = RouteOperationsSchema.parse(await h.ok(`${path}/return`, { method: 'POST', cookie: f.cookie, body: {
      version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(),
    } }));
    assert.equal(route.status, 'returned');
    await h.ok(`/routes/${published.id}/warehouse-receipts`, { method: 'POST', body: {
      version: route.version, requestId: randomUUID(), reason: 'Warehouse counted the collected goods.',
      items: [{ appointmentId: stop.appointmentId, sourceLineId: 31, kind: 'collection', quantityMilli: 1000, note: 'One unit in warehouse.' }],
    } });
    const pending = await h.detail(stop.deliveryId);
    const report = pending.delivery.appointments[0]?.results[0];
    assert.ok(report);
    const endpoint = `/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}/results/${report.id}/signature-refusal-review`;
    const rejected = await h.request(endpoint, { method: 'POST', body: {
      version: pending.delivery.version, requestId: randomUUID(), decision: 'corrected', reason: 'Disputed quantity.',
      quantities: quantities.map((line) => line.sourceLineId === 31 ? { ...line, collectedMilli: 500 } : line),
    } });
    assert.equal(rejected.status, 409);
    assert.equal(ErrorCode.parse(rejected.data).code, 'SIGNATURE_REFUSAL_CARGO_CONFLICT');
    const approved = DeliveryDetail.parse(await h.ok(endpoint, { method: 'POST', body: {
      version: pending.delivery.version, requestId: randomUUID(), decision: 'approved', reason: 'Warehouse receipt confirms the Crew report.',
    } }));
    assert.deepEqual(approved.delivery.appointments[0]?.results[0], report);
  } finally {
    await h.close();
  }
});
