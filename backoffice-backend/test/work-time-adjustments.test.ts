import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDelivery, DeliverySchema, RemainingWorkEstimateSchema, WorkTimeAdjustmentFieldsSchema,
  type Delivery, type OperatorActor, type WorkLineInput } from '../src/domain/model';
import { changeServicePlan, changeWorkTimeAdjustments, changeWorkTimes, estimateWorkMinutes, lineWorkTimes, remainingWorkEstimate } from '../src/domain/rules';
import { routeJob } from '../src/routing/service';

const actor: OperatorActor = { id: randomUUID(), name: 'Synthetic planner', role: 'operator' };
const at = '2031-01-01T08:00:00Z';
const neutral = WorkTimeAdjustmentFieldsSchema.parse({ factorPercent: 100, visitMinutes: 0, deliveryMinutes: 0,
  installationMinutes: 0, collectionMinutes: 0, sourceReference: 'Isolated test observation',
  assumptions: 'Elapsed team minutes, with travel and waiting excluded.' });

function fixture(): Delivery {
  const item = { productId: 5, sku: 'SAME', name: 'Test product', description: null, quantity: 2, uom: 'unit', uomId: 1,
    configuration: null, ambient: null, notes: null, photoUrl: null };
  let delivery = createDelivery({ pickingId: 1, pickingName: 'ADJUSTMENTS/1', saleOrderId: 11, saleOrderName: 'ORDER/11',
    salesOrders: [{ id: 11, name: 'ORDER/11' }, { id: 22, name: 'ORDER/22' }], sourceState: 'assigned', salesTeam: 'Test',
    customer: { id: 1, name: 'Synthetic customer', address: 'Via Roma 1', city: 'Messina', country: 'IT', phones: [], email: null, contact: null },
    items: [{ ...item, sourceLineId: 31, saleOrderId: 11 }, { ...item, sourceLineId: 32, saleOrderId: 22 }],
    serviceType: null, estimatedMinutes: null, notes: null }, randomUUID());
  delivery = changeServicePlan(delivery, { defaultService: 'delivery_installation' });
  for (const [sourceLineId, deliveryMinutesPerUnit, installationMinutesPerUnit] of [[31, 10, 30], [32, 20, 40]]) {
    assert.ok(sourceLineId && deliveryMinutesPerUnit && installationMinutesPerUnit);
    delivery = changeWorkTimes(delivery, { sourceLineId, deliveryMinutesPerUnit, installationMinutesPerUnit,
      collectionMinutesPerUnit: null }, actor, at);
  }
  return delivery;
}
function work(sourceLineId: number, deliveryMilli = 0, installationMilli = 0, collectionMilli = 0): WorkLineInput {
  return { sourceLineId, deliveryMilli, installationMilli, collectionMilli };
}
function adjust(delivery: Delivery, fields: Partial<typeof neutral> = {}) {
  return changeWorkTimeAdjustments(delivery, { ...neutral, ...fields }, actor, at);
}

void test('one selected visit charges fixed allowances once and excludes completed operations from follow-ups', () => {
  const delivery = adjust(fixture(), { factorPercent: 150, visitMinutes: 5, deliveryMinutes: 7, installationMinutes: 11,
    collectionMinutes: null });
  const selected = estimateWorkMinutes(delivery, [work(31, 1000, 1000), work(32, 1000, 1000)]);
  assert.equal(selected.minutes, 173, '100 variable minutes × 150% + one 5+7+11 allowance');
  assert.deepEqual(selected.calculation, { algorithmVersion: 'remaining_work_v2', baseMinutes: 100, factorPercent: 150,
    fixedMinutes: 23, adjustmentVersion: 1, adjustmentStatus: 'current' });
  assert.equal(remainingWorkEstimate(delivery).minutes, 323);
  assert.deepEqual(lineWorkTimes(delivery).map(({ remainingMinutes }) => remainingMinutes), [80, 120], 'Line estimates are base-only');
  assert.equal(estimateWorkMinutes(delivery, [work(31, 0, 1000)]).minutes, 61, 'Installation follow-up excludes the delivery allowance');
  const none = estimateWorkMinutes(delivery, []);
  assert.equal(none.minutes, 0);
  assert.equal(none.calculation?.fixedMinutes, 0);
  const unknown = adjust(delivery, { factorPercent: null, visitMinutes: null, deliveryMinutes: null, installationMinutes: null });
  assert.equal(estimateWorkMinutes(unknown, []).minutes, 0, 'No selected work has no fixed charge');
  assert.equal(estimateWorkMinutes(unknown, []).calculation?.fixedMinutes, 0);
});

void test('percentage applies to exact fractional unit work before a single final rounding', () => {
  let delivery = fixture();
  delivery = changeWorkTimes(delivery, { sourceLineId: 31, deliveryMinutesPerUnit: 1, installationMinutesPerUnit: 2,
    collectionMinutesPerUnit: null }, actor, at);
  delivery = adjust(delivery, { factorPercent: 125 });
  assert.equal(estimateWorkMinutes(delivery, [work(31, 100)]).minutes, 1, '0.1 × 1 × 125% rounds once to one minute');
  assert.equal(estimateWorkMinutes(delivery, [work(31, 100, 100)]).minutes, 1, 'Mixed operations share the exact rational sum');
  assert.equal(estimateWorkMinutes(delivery, [work(31, 900)]).minutes, 2);
  const oversized = changeWorkTimes(delivery, { sourceLineId: 31, deliveryMinutesPerUnit: 1440, installationMinutesPerUnit: null,
    collectionMinutesPerUnit: null }, actor, at);
  const reduced = estimateWorkMinutes(adjust(oversized, { factorPercent: 50 }), [work(31, 10000)]);
  assert.equal(reduced.minutes, 7200);
  assert.equal(reduced.calculation?.baseMinutes, 14400);
  assert.ok(RemainingWorkEstimateSchema.safeParse(reduced).success);
  assert.equal(estimateWorkMinutes(adjust(oversized, { factorPercent: 1000 }), [work(31, 10000)]).exceedsLimit, true);
});

void test('unknown active allowances and changed site input require explicit review', () => {
  let delivery = adjust(fixture(), { collectionMinutes: null });
  assert.equal(estimateWorkMinutes(delivery, [work(31, 1000)]).minutes, 10, 'Unselected collection stays irrelevant');
  delivery = adjust(delivery, { deliveryMinutes: null });
  const incomplete = estimateWorkMinutes(delivery, [work(31, 1000)]);
  assert.equal(incomplete.minutes, null);
  assert.deepEqual(incomplete.calculation?.missingFields, ['deliveryMinutes']);
  assert.equal(incomplete.calculation?.adjustmentStatus, 'incomplete');
  const before = routeJob(delivery).workFingerprint;
  delivery.instructions.floor = 3;
  const stale = estimateWorkMinutes(delivery, [work(31, 1000)]);
  assert.equal(stale.minutes, null);
  assert.equal(stale.calculation?.adjustmentStatus, 'needs_review', 'Changed site input takes precedence over missing fields');
  assert.notEqual(routeJob(delivery).workFingerprint, before);
  delivery = adjust(delivery);
  assert.equal(estimateWorkMinutes(delivery, [work(31, 1000)]).minutes, 10);
  assert.equal(delivery.workTimeAdjustments?.version, 3);
  delivery.source.customer.address = 'Via Roma 2';
  assert.equal(remainingWorkEstimate(delivery).calculation?.adjustmentStatus, 'needs_review');
});

void test('source aggregate adjustments require acknowledged exclusions while neutral settings preserve the source basis', () => {
  const original = fixture();
  original.source.estimatedMinutes = 80;
  delete original.servicePlan?.timeEstimates;
  const legacy = remainingWorkEstimate(original);
  assert.equal(legacy.minutes, 80);
  assert.equal(legacy.calculation?.adjustmentStatus, 'not_configured');
  const neutralSource = remainingWorkEstimate(adjust(original));
  assert.equal(neutralSource.minutes, 80);
  assert.equal(neutralSource.basis, 'proportional_remaining_operations');
  const incomplete = remainingWorkEstimate(adjust(original, { factorPercent: 150, visitMinutes: 5 }));
  assert.equal(incomplete.minutes, null);
  assert.deepEqual(incomplete.calculation?.missingFields, ['sourceEstimateExcludesAdjustments']);
  const approved = remainingWorkEstimate(adjust(original, { factorPercent: 150, visitMinutes: 5, sourceEstimateExcludesAdjustments: true }));
  assert.equal(approved.minutes, 125);
  let mixed = changeWorkTimes(original, { sourceLineId: 31, deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 30,
    collectionMinutesPerUnit: null }, actor, at);
  mixed = adjust(mixed, { visitMinutes: 5 });
  assert.equal(remainingWorkEstimate(mixed).minutes, null);
  mixed = adjust(mixed, { visitMinutes: 5, sourceEstimateExcludesAdjustments: true });
  assert.equal(remainingWorkEstimate(mixed).minutes, 125, '80 local and 40 provisional source minutes plus one visit allowance');
});

void test('local settings are delivery-owned and legacy delivery JSON keeps its original representation', () => {
  const first = fixture(); const second = fixture();
  assert.deepEqual(DeliverySchema.parse(first), first);
  const saved = adjust(first, { visitMinutes: 15 });
  assert.equal(remainingWorkEstimate(saved).minutes, 215);
  assert.equal(remainingWorkEstimate(second).minutes, 200);
  assert.equal(second.workTimeAdjustments, undefined);
  assert.equal(first.workTimeAdjustments, undefined, 'Domain command returns a new aggregate');
  assert.deepEqual(saved.source, first.source);
});
