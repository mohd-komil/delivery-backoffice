import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { CrewVisitDetailSchema } from '../src/crew/contracts';
import type { WorkLineInput } from '../src/domain/model';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { RouteJobsSchema } from '../src/routing/http-contracts';
import { DeliveryDetail, lifecycleFixture } from './support/route-lifecycle-fixture';

const firstLine = 31;
const otherLine = 32;
const visitWork = (sourceLineId: number, deliveryMilli: number, installationMilli: number): WorkLineInput =>
  ({ sourceLineId, deliveryMilli, installationMilli, collectionMilli: 0 });

void test('Francesca sets per-line obligations and Crew installs two of four units across two visits', async () => {
  const h = await lifecycleFixture();
  try {
    const f = await h.fixture({ service: 'delivery_installation', lineQuantity: 4 });
    const [delivery, otherPicking] = f.deliveries;
    assert.ok(delivery && otherPicking);
    const deliveryId = delivery.id;
    const path = `/deliveries/${deliveryId}`;
    const quantitiesPath = `${path}/work-quantities`;
    const quantities = { deliveryMilli: 4000, installationMilli: 2000, collectionMilli: 0 };
    const command = { version: delivery.version, sourceLineId: firstLine, quantities, reason: 'Customer requested installation for two of the four units' };

    const patch = (body: typeof command, cookie?: string) => h.request(quantitiesPath, {
      method: 'PATCH', body, ...(cookie === undefined ? {} : { cookie }),
    });
    assert.equal((await patch(command, '')).status, 401);
    assert.equal((await patch(command, f.cookie)).status, 401);
    assert.equal((await patch({ ...command, reason: ' ' })).status, 400);
    const edited = DeliveryDetail.parse(await h.ok(quantitiesPath, { method: 'PATCH', body: command }));
    assert.equal((await patch(command)).status, 409);
    assert.deepEqual(edited.lineServices.map(({ sourceLineId, totalDeliveryMilli, totalInstallationMilli }) =>
      [sourceLineId, totalDeliveryMilli, totalInstallationMilli]), [[firstLine, 4000, 2000], [otherLine, 4000, 4000]]);
    assert.equal(edited.delivery.source.items[0]?.quantity, 4);
    assert.equal(edited.delivery.source.items[0]?.productId, edited.delivery.source.items[1]?.productId);
    assert.notEqual(edited.delivery.source.items[0]?.saleOrderId, edited.delivery.source.items[1]?.saleOrderId);
    const audit = edited.history.find(({ action }) => action === 'work_quantities.updated');
    assert.ok(audit);
    assert.equal(audit.actorName, 'DEMO operator');
    const auditDetails = z.object({ reason: z.string(), previous: z.object({ installationMilli: z.number() }),
      current: z.object({ installationMilli: z.number() }), sourceItem: z.object({ sourceLineId: z.number() }) }).parse(audit.details);
    assert.equal(auditDetails.reason, command.reason);
    assert.equal(auditDetails.previous.installationMilli, 4000);
    assert.equal(auditDetails.current.installationMilli, 2000);
    assert.equal(auditDetails.sourceItem.sourceLineId, firstLine);
    assert.equal((await h.detail(otherPicking.id)).lineServices[0]?.totalInstallationMilli, 4000);

    const configureRate = (version: number, sourceLineId: number) => h.ok(`${path}/work-times`, { method: 'PATCH', body: {
      version, sourceLineId, deliveryMinutesPerUnit: 5, installationMinutesPerUnit: 10, collectionMinutesPerUnit: null,
    } }).then((data) => DeliveryDetail.parse(data));
    const firstRate = await configureRate(edited.delivery.version, firstLine);
    const configured = await configureRate(firstRate.delivery.version, otherLine);
    const list = DeliveryListSchema.parse(await h.ok('/deliveries?view=inbox'));
    assert.equal(list.items.find(({ id }) => id === delivery.id)?.planning.remainingWorkEstimate.minutes, 100);
    const nearbyPath = `/routes/jobs?anchorId=${otherPicking.id}&radiusKm=5`;
    const nearby = RouteJobsSchema.parse(await h.ok(nearbyPath));
    const plannedJob = nearby.jobs.find(({ deliveryId }) => deliveryId === delivery.id);
    assert.equal(plannedJob?.remaining.find(({ sourceLineId }) => sourceLineId === firstLine)?.installationMilli, 2000);
    assert.equal(plannedJob?.suggestedWorkMinutes, 100);

    const book = (version: number, offset: number, workLines: WorkLineInput[]) => ({
      version, requestId: randomUUID(), startsAt: new Date(Date.now() + offset * 3600_000).toISOString(),
      endsAt: new Date(Date.now() + (offset + 1) * 3600_000).toISOString(), workLines,
    });
    const bookPath = `${path}/appointments`;
    const firstBooked = DeliveryDetail.parse(await h.ok(bookPath, { method: 'POST', body: book(configured.delivery.version, -3,
      [visitWork(firstLine, 4000, 1000), visitWork(otherLine, 4000, 4000)]) }));
    const firstVisit = firstBooked.delivery.appointments[0];
    assert.ok(firstVisit);
    assert.equal(firstBooked.lineServices[0]?.availableInstallationMilli, 1000);
    assert.equal((await patch({ ...command, version: firstBooked.delivery.version,
      quantities: { ...quantities, installationMilli: 0 } })).status, 409);

    async function assignAndStart(appointmentId: string, version: number) {
      const visitPath = `${bookPath}/${appointmentId}`;
      const assigned = DeliveryDetail.parse(await h.ok(`${visitPath}/assign`, { method: 'POST', body: {
        version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id],
      } }));
      await h.ok(`${visitPath}/responsible`, { method: 'PATCH', body: {
        version: assigned.delivery.version, participantId: f.participant.id,
      } });
      await h.confirm(deliveryId, appointmentId);
      return h.start(appointmentId, f.cookie);
    }
    const firstActive = await assignAndStart(firstVisit.id, firstBooked.delivery.version);
    assert.equal(firstActive.items[0]?.serviceWork?.plannedDeliveryMilli, 4000);
    assert.equal(firstActive.items[0]?.serviceWork?.plannedInstallationMilli, 1000);
    assert.equal(firstActive.items[0]?.serviceWork?.remainingInstallationMilli, 2000);
    await h.finish(firstVisit.id, f.cookie, [{ sourceLineId: firstLine, deliveredMilli: 4000, installedMilli: 1000 },
      { sourceLineId: otherLine, deliveredMilli: 4000, installedMilli: 4000 }]);
    const partial = await h.detail(delivery.id);
    const signed = partial.delivery.appointments[0]?.results[0];
    assert.ok(signed?.crewSignature && signed.customerSignature);
    assert.equal(partial.lineServices[0]?.remainingDeliveryMilli, 0);
    assert.equal(partial.lineServices[0]?.remainingInstallationMilli, 1000);
    assert.equal((await patch({ ...command, version: partial.delivery.version, quantities: { ...quantities, installationMilli: 0 } })).status, 409);
    const repeatJob = RouteJobsSchema.parse(await h.ok(nearbyPath)).jobs.find(({ deliveryId }) => deliveryId === delivery.id);
    assert.deepEqual(repeatJob?.remaining.map(({ sourceLineId, deliveryMilli, installationMilli }) => [sourceLineId, deliveryMilli, installationMilli]),
      [[firstLine, 0, 1000]]);
    assert.equal(repeatJob?.suggestedWorkMinutes, 10);

    const remaining = [visitWork(firstLine, 0, 1000)];
    const competing = await Promise.all([-2, -1].map((offset) => h.request(bookPath, {
      method: 'POST', body: book(partial.delivery.version, offset, remaining),
    })));
    assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 409]);
    const secondBooked = DeliveryDetail.parse(competing.find(({ status }) => status === 201)?.data);
    assert.equal(secondBooked.lineServices[0]?.availableInstallationMilli, 0);
    const secondVisit = secondBooked.delivery.appointments[1];
    assert.ok(secondVisit);
    assert.equal((await h.request(bookPath, { method: 'POST', body: book(secondBooked.delivery.version, 1, remaining) })).status, 409);
    const secondActive = await assignAndStart(secondVisit.id, secondBooked.delivery.version);
    assert.deepEqual(secondActive.workScope?.lines.map(({ sourceLineId, deliveryMilli, installationMilli }) =>
      [sourceLineId, deliveryMilli, installationMilli]), [[firstLine, 0, 1000]]);
    await h.finish(secondVisit.id, f.cookie, [{ sourceLineId: firstLine, deliveredMilli: 0, installedMilli: 1000 }]);
    const finished = await h.detail(delivery.id);
    assert.deepEqual(finished.delivery.appointments[0]?.results[0], signed);
    assert.deepEqual(finished.lineServices.map(({ remainingDeliveryMilli, remainingInstallationMilli }) =>
      [remainingDeliveryMilli, remainingInstallationMilli]), [[0, 0], [0, 0]]);
    assert.equal((await h.request(`${path}/complete`, { method: 'POST', body: { version: finished.delivery.version } })).status, 201);
    const completed = await h.detail(delivery.id);
    assert.ok(completed.delivery.completedAt);
    const completedVisit = CrewVisitDetailSchema.parse(await h.ok(`/crew/visits/${secondVisit.id}`, { cookie: f.cookie }));
    assert.equal(completedVisit.status, 'completed');
  } finally {
    await h.close();
  }
});
