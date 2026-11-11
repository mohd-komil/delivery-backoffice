import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppointmentSchema, createDelivery, type Delivery, type OperatorActor, type WorkLineInput } from '../src/domain/model';
import { planVisitWork } from '../src/domain/rules';
import { routeJob } from '../src/routing/service';

const operator: OperatorActor = { id: randomUUID(), name: 'DEMO Route Operator', role: 'operator' };
const at = '2026-11-10T08:00:00Z';

function fixture(): Delivery {
  const sharedItem = { productId: 7, name: 'DEMO identical chair', uom: 'unit', description: null,
    configuration: null, ambient: null, notes: null, photoUrl: null };
  const delivery = createDelivery({
    pickingId: 501, pickingName: 'DEMO/WORK/ROUTE', saleOrderId: 51, saleOrderName: 'DEMO/SO/A',
    salesOrders: [{ id: 51, name: 'DEMO/SO/A' }, { id: 52, name: 'DEMO/SO/B' }],
    sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
    customer: { id: 1, name: 'DEMO Customer', address: 'Teaching address 1', city: 'Messina', country: 'IT', phones: [], email: null, contact: null },
    items: [{ ...sharedItem, sourceLineId: 511, saleOrderId: 51, quantity: 2 }, { ...sharedItem, sourceLineId: 521, saleOrderId: 52, quantity: 1 }],
    serviceType: 'delivery_installation', estimatedMinutes: 100, notes: null,
  }, randomUUID());
  return { ...delivery, servicePlan: { defaultService: 'delivery_installation', overrides: [{ sourceLineId: 521, service: 'delivery_only' }] } };
}

function book(delivery: Delivery, workLines: WorkLineInput[]) {
  const appointment = AppointmentSchema.parse({
    id: randomUUID(), startsAt: '2026-11-11T09:00:00Z', endsAt: '2026-11-11T10:00:00Z',
    status: 'booked', assignments: [], results: [], cancellationReason: null, returnRequestId: null,
    customerConfirmation: { confirmedAt: at, confirmedBy: { id: operator.id, name: operator.name } },
    workScope: planVisitWork(delivery, workLines, operator, at),
  });
  delivery.appointments.push(appointment);
  return appointment;
}

void test('route projections keep identical SKU orders separate and use only each selected visit scope', () => {
  const delivery = fixture();
  const first = book(delivery, [{ sourceLineId: 511, deliveryMilli: 1000, installationMilli: 1000, collectionMilli: 0 }]);
  const second = book(delivery, [{ sourceLineId: 521, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }]);
  const available = routeJob(delivery);
  assert.equal(available.workBasis, 'available_remaining');
  assert.equal(available.appointmentId, null);
  assert.equal(available.suggestedWorkMinutes, 40);
  assert.deepEqual(available.remaining.map(({ sourceLineId, orderName, deliveryMilli, installationMilli }) =>
    ({ sourceLineId, orderName, deliveryMilli, installationMilli })), [{ sourceLineId: 511, orderName: 'DEMO/SO/A', deliveryMilli: 1000, installationMilli: 1000 }]);
  assert.equal(available.appointmentOptions.length, 2);
  const firstJob = routeJob(delivery, undefined, first.id);
  assert.equal(firstJob.suggestedWorkMinutes, 40);
  assert.equal(firstJob.workBasis, 'appointment');
  assert.equal(firstJob.appointmentId, first.id);
  assert.deepEqual(firstJob.remaining.map(({ sourceLineId }) => sourceLineId), [511]);
  const secondJob = routeJob(delivery, undefined, second.id);
  assert.equal(secondJob.suggestedWorkMinutes, 20);
  assert.deepEqual(secondJob.remaining.map(({ sourceLineId, orderName }) => ({ sourceLineId, orderName })), [{ sourceLineId: 521, orderName: 'DEMO/SO/B' }]);
});

void test('fully reserved work remains selectable through an explicit visit and cancellation releases only that scope', () => {
  const delivery = fixture();
  const first = book(delivery, [{ sourceLineId: 511, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 }]);
  const second = book(delivery, [{ sourceLineId: 521, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }]);
  const catalog = routeJob(delivery);
  assert.equal(catalog.hasAvailableRemaining, false);
  assert.deepEqual(catalog.remaining, []);
  assert.equal(catalog.planningStatus, 'confirmed');
  assert.equal(routeJob(delivery, undefined, first.id).suggestedWorkMinutes, 80);
  first.status = 'cancelled';
  const released = routeJob(delivery);
  assert.equal(released.hasAvailableRemaining, true);
  assert.equal(released.suggestedWorkMinutes, 80);
  assert.deepEqual(released.appointmentOptions.map(({ id }) => id), [second.id]);
  assert.equal(routeJob(delivery, undefined, first.id).workReviewReason, 'appointment_unavailable');
});

void test('legacy and changed source scopes remain visible as review-required instead of advertising their work as free', () => {
  const delivery = fixture();
  const appointment = book(delivery, [{ sourceLineId: 511, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }]);
  delete appointment.workScope;
  const legacy = routeJob(delivery);
  assert.equal(legacy.planningStatus, 'unavailable');
  assert.deepEqual(legacy.remaining, []);
  assert.equal(legacy.workReviewReason, 'legacy_scope_review');
  assert.equal(legacy.appointmentOptions[0]?.needsReview, true);
  assert.equal(routeJob(delivery, undefined, appointment.id).workReviewReason, 'missing_scope');
  appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 511, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], operator, at, appointment.id);
  const item = delivery.source.items[0];
  assert.ok(item);
  item.quantity = 3;
  const stale = routeJob(delivery, undefined, appointment.id);
  assert.equal(stale.planningStatus, 'unavailable');
  assert.equal(stale.workReviewReason, 'source_changed');
  assert.equal(stale.appointmentOptions[0]?.needsReview, true);
  assert.equal(routeJob(delivery).hasAvailableRemaining, false);
});

void test('future installation can be planned in a route while stock remains an execution prerequisite', () => {
  const delivery = fixture();
  const installation = book(delivery, [{ sourceLineId: 511, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }]);
  const job = routeJob(delivery, undefined, installation.id);
  assert.equal(job.workReviewReason, 'stock_pending');
  assert.equal(job.planningStatus, 'confirmed');
  assert.equal(job.appointmentOptions[0]?.needsReview, false);
  assert.equal(job.suggestedWorkMinutes, 20);
  assert.equal(job.remaining[0]?.deliveryMilli, 0);
  assert.equal(job.remaining[0]?.installationMilli, 1000);
  assert.equal(routeJob(delivery, undefined, randomUUID()).workReviewReason, 'appointment_unavailable');
});
