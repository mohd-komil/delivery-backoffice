import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDelivery, DeliverySchema, LineWorkTimeStatusSchema, type Delivery, type OperatorActor, type WorkTimeRates } from '../src/domain/model';
import { changeServicePlan, changeWorkTimes, DomainError, estimateWorkMinutes, lineServiceStatuses, lineWorkTimes, remainingWorkEstimate } from '../src/domain/rules';
import { routeJob } from '../src/routing/service';

const actor: OperatorActor = { id: randomUUID(), name: 'Synthetic operator', role: 'operator' };
const at = '2031-01-01T08:00:00Z';
function fixture(): Delivery {
  const shared = { productId: 5, name: 'Identical chair', sku: 'SAME-SKU', description: null, quantity: 2, uom: 'unit', uomId: 1,
    configuration: null, ambient: null, notes: null, photoUrl: null };
  return createDelivery({ pickingId: 1, pickingName: 'WORK-TIME/1', saleOrderId: 11, saleOrderName: 'ORDER/11',
    salesOrders: [{ id: 11, name: 'ORDER/11' }, { id: 22, name: 'ORDER/22' }], sourceState: 'assigned', salesTeam: 'Test',
    customer: { id: 1, name: 'Synthetic customer', address: 'Via Roma 10', city: 'Messina', country: 'IT', province: 'ME', postalCode: '98123', phones: [], email: null, contact: null },
    items: [{ ...shared, sourceLineId: 101, saleOrderId: 11 }, { ...shared, sourceLineId: 202, saleOrderId: 22 }],
    serviceType: null, estimatedMinutes: null, notes: null }, randomUUID());
}
function times(delivery: Delivery, sourceLineId: number, deliveryMinutesPerUnit: number | null, installationMinutesPerUnit: number | null,
  collectionMinutesPerUnit: number | null = null) {
  return changeWorkTimes(delivery, { sourceLineId, deliveryMinutesPerUnit, installationMinutesPerUnit, collectionMinutesPerUnit }, actor, at);
}
function work(sourceLineId: number, deliveryMilli = 0, installationMilli = 0, collectionMilli = 0) {
  return { sourceLineId, deliveryMilli, installationMilli, collectionMilli };
}

void test('local team minutes distinguish same-SKU order lines and selected fractional work', () => {
  let delivery: Delivery = changeServicePlan(fixture(), { defaultService: 'delivery_installation' });
  delivery = times(delivery, 101, 10, 30);
  delivery = times(delivery, 202, 20, 40);
  assert.deepEqual(remainingWorkEstimate(delivery), { minutes: 200, basis: 'local_operation_rates', sourceMinutes: null });
  assert.equal(estimateWorkMinutes(delivery, [work(101, 0, 1000)]).minutes, 30);
  assert.equal(estimateWorkMinutes(delivery, [work(202, 500, 250)]).minutes, 20);
  assert.equal(estimateWorkMinutes(delivery, [work(101, 125)]).minutes, 2);
  assert.deepEqual(lineWorkTimes(delivery).map((entry) => LineWorkTimeStatusSchema.parse(entry).remainingMinutes), [80, 120]);
  const separate = changeServicePlan(fixture(), { defaultService: 'delivery_installation' });
  assert.equal(remainingWorkEstimate(separate).minutes, null, 'Another Picking never inherits these rates through matching SKU/line IDs');
  assert.equal(delivery.source.estimatedMinutes, null);
  assert.ok(lineServiceStatuses(delivery).every(({ serviceOrigin }) => serviceOrigin === 'local'));
});

void test('source total remains proportional; mixed fallback is explicit and stale local rates never fall through', () => {
  let delivery: Delivery = changeServicePlan(fixture(), { defaultService: 'delivery_installation' });
  delivery.source.estimatedMinutes = 80;
  delivery = times(delivery, 101, 5, null);
  const selected = [work(101, 1000, 1000)];
  assert.deepEqual(estimateWorkMinutes(delivery, selected), { minutes: 15, basis: 'mixed_operation_rates', sourceMinutes: 80 });
  assert.equal(lineWorkTimes(delivery)[0]?.basis, 'mixed');
  delivery.source.customer.postalCode = '98124';
  assert.deepEqual(estimateWorkMinutes(delivery, selected), { minutes: null, basis: 'unknown', sourceMinutes: 80, staleSourceLineIds: [101] });
  assert.equal(lineWorkTimes(delivery)[0]?.deliveryMinutesPerUnit, 5, 'Stale saved input stays reviewable');
  delivery = times(delivery, 101, 5, null);
  assert.equal(estimateWorkMinutes(delivery, selected).minutes, 15);
  delivery = times(delivery, 101, null, null);
  assert.deepEqual(estimateWorkMinutes(delivery, selected), { minutes: 20, basis: 'proportional_remaining_operations', sourceMinutes: 80 });
});

void test('local rates allow mixed units and selected known work while missing selected operations remain unknown', () => {
  let delivery: Delivery = changeServicePlan(fixture(), { sourceLineId: 101, service: 'delivery_installation' });
  delivery = times(delivery, 101, 7, null);
  assert.equal(remainingWorkEstimate(delivery).minutes, null, 'The whole delivery cannot hide another line with unknown service');
  assert.equal(remainingWorkEstimate(times(delivery, 101, 7, 8)).minutes, null, 'Complete local rates on known lines do not define the unknown line');
  assert.equal(estimateWorkMinutes(delivery, [work(101, 1000)]).minutes, 7);
  assert.equal(estimateWorkMinutes(delivery, [work(101, 1000, 1000)]).minutes, null);
  assert.deepEqual(lineWorkTimes(delivery)[0]?.missingOperations, ['installation']);
  delivery = changeServicePlan(delivery, { sourceLineId: 202, service: 'collection_only' });
  const other = delivery.source.items[1]; assert.ok(other); other.uom = 'kg'; other.uomId = 2;
  delivery = times(delivery, 202, null, null, 11);
  assert.deepEqual(estimateWorkMinutes(delivery, [work(101, 1000), work(202, 0, 0, 1000)]),
    { minutes: 18, basis: 'local_operation_rates', sourceMinutes: null });
  const changed = structuredClone(delivery); const first = changed.source.items[0]; assert.ok(first); first.productId++;
  assert.equal(estimateWorkMinutes(changed, [work(202, 0, 0, 1000)]).minutes, 11, 'An unrelated stale line cannot poison selected work');
});

void test('service changes preserve local estimates, and route work fingerprints track rates without changing source identity', () => {
  let delivery: Delivery = changeServicePlan(fixture(), { defaultService: 'delivery_installation' });
  delivery = times(delivery, 101, 10, 30); delivery = times(delivery, 202, 20, 40);
  const snapshot = structuredClone(delivery);
  const before = routeJob(delivery);
  const changed = times(delivery, 101, 11, 30);
  assert.notEqual(routeJob(changed).workFingerprint, before.workFingerprint);
  assert.deepEqual(delivery, snapshot);
  const same = changeWorkTimes(delivery, { sourceLineId: 101, deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null },
    actor, '2031-01-02T08:00:00Z');
  assert.equal(routeJob(same).workFingerprint, before.workFingerprint, 'Reconfirming identical rates does not invent a timing change');
  const service = changeServicePlan(delivery, { sourceLineId: 202, service: 'delivery_only' });
  assert.deepEqual(service.servicePlan?.timeEstimates, delivery.servicePlan?.timeEstimates);
  const legacy = structuredClone(delivery); delete legacy.servicePlan?.defaultOrigin;
  assert.equal(lineServiceStatuses(legacy)[0]?.serviceOrigin, 'unknown');
  assert.deepEqual(DeliverySchema.parse(legacy).servicePlan, legacy.servicePlan);
});

void test('unsupported work and oversized estimates require explicit review', () => {
  const empty = fixture(); empty.source.items = [];
  assert.deepEqual(remainingWorkEstimate(empty), { minutes: null, basis: 'unknown', sourceMinutes: null });
  let delivery: Delivery = changeServicePlan(fixture(), { defaultService: 'delivery_only' });
  assert.throws(() => times(delivery, 101, 10, 20), (error: unknown) => error instanceof DomainError && error.code === 'WORK_TIME_OPERATION_UNAVAILABLE');
  const rates: WorkTimeRates = { deliveryMinutesPerUnit: 1440, installationMinutesPerUnit: null, collectionMinutesPerUnit: null };
  delivery = changeWorkTimes(delivery, { sourceLineId: 101, ...rates }, actor, at);
  const item = delivery.source.items[0]; assert.ok(item); item.quantity = 10;
  assert.deepEqual(estimateWorkMinutes(delivery, [work(101, 10_000)]), { minutes: null, basis: 'unknown', sourceMinutes: null, exceedsLimit: true });
  delivery.sourceReview = true;
  assert.throws(() => times(delivery, 101, 10, null), (error: unknown) => error instanceof DomainError && error.code === 'SOURCE_REVIEW_REQUIRED');
});
