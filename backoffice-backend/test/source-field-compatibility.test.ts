import assert from 'node:assert/strict';
import test from 'node:test';
import { destinationAddressKey } from '../src/domain/destination-address';
import { deliveryGeography } from '../src/domain/delivery-geography';
import { CompletionSchema, createDelivery, SourceSchema, type SourceSnapshot } from '../src/domain/model';
import { lineServiceStatuses, remainingWorkEstimate, workSourceFingerprint } from '../src/domain/rules';

function legacySource(): SourceSnapshot {
  return {
    pickingId: 1, pickingName: 'TEST/OUT/1', saleOrderId: 10, saleOrderName: 'TEST/SO/10',
    sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
    customer: { id: 1, name: 'Test recipient', address: ' Via Test 1 ', city: 'Messina', country: 'IT',
      phones: [], email: null, contact: null },
    items: [{ sourceLineId: 101, productId: 1001, name: 'Test chair', description: null, quantity: 2,
      uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: null, estimatedMinutes: null, notes: null,
  };
}

void test('new source fields never backfill a historical completion snapshot', () => {
  const source = legacySource();
  const completion = {
    id: '11000000-0000-4000-8000-000000000001', at: '2026-11-01T12:00:00Z',
    actorId: '11000000-0000-4000-8000-000000000002', actorName: 'Test dispatcher',
    sourceSnapshot: source, resultIds: [], reopenedAt: null, reopenReason: null,
  };
  const before = JSON.stringify(completion);
  assert.equal(JSON.stringify(CompletionSchema.parse(completion)), before);
  assert.deepEqual(SourceSchema.parse(source), source);
  assert.equal(Object.hasOwn(SourceSchema.parse(source).customer, 'postalCode'), false);
  assert.equal(Object.hasOwn(SourceSchema.parse(source).items[0] ?? {}, 'uomId'), false);
  assert.equal(Object.hasOwn(SourceSchema.parse(source).items[0] ?? {}, 'saleOrderLineId'), false);
  assert.equal(Object.hasOwn(SourceSchema.parse(source).items[0] ?? {}, 'orderLinkBasis'), false);
  assert.equal(Object.hasOwn(SourceSchema.parse(source).customer, 'addressSource'), false);
});

void test('source relationship provenance preserves physical line identity and does not invalidate agreed work', () => {
  const source = legacySource();
  const direct = SourceSchema.parse({ ...source,
    customer: { ...source.customer, addressSource: 'picking' },
    items: source.items.map((item) => ({ ...item, saleOrderLineId: 8001, orderLinkBasis: 'sale_order_line' })),
  });
  const group = SourceSchema.parse({ ...source,
    customer: { ...source.customer, addressSource: 'move_order_shipping' },
    items: source.items.map((item) => ({ ...item, saleOrderLineId: null, orderLinkBasis: 'procurement_group' })),
  });
  assert.equal(direct.items[0]?.sourceLineId, 101);
  assert.equal(direct.items[0]?.saleOrderLineId, 8001);
  assert.equal(group.items[0]?.sourceLineId, 101);
  assert.equal(group.items[0]?.saleOrderLineId, null);
  assert.equal(group.items[0]?.orderLinkBasis, 'procurement_group');
  for (const annotated of [direct, group]) {
    assert.equal(workSourceFingerprint({ source: annotated }), workSourceFingerprint({ source }));
    assert.equal(destinationAddressKey(annotated.customer), destinationAddressKey(source.customer));
  }

  const multipleOrders = SourceSchema.parse({ ...group,
    salesOrders: [{ id: 10, name: 'TEST/SO/10' }, { id: 11, name: 'TEST/SO/11' }],
    items: group.items.map((item) => ({ ...item, saleOrderId: 10 })),
  });
  const changedOwner = SourceSchema.parse({ ...multipleOrders,
    items: multipleOrders.items.map((item) => ({ ...item, saleOrderId: 11 })),
  });
  assert.notEqual(workSourceFingerprint({ source: changedOwner }), workSourceFingerprint({ source: multipleOrders }));
  const changedDestination = { ...group, customer: { ...group.customer, address: 'Via Test 2' } };
  assert.notEqual(destinationAddressKey(changedDestination.customer), destinationAddressKey(group.customer));
  assert.notEqual(workSourceFingerprint({ source: changedDestination }), workSourceFingerprint({ source: group }));
});

void test('source provenance rejects invalid identities and unknown relationship labels', () => {
  const source = legacySource();
  for (const saleOrderLineId of [0, -1, 1.5, '8001']) {
    assert.equal(SourceSchema.safeParse({ ...source, items: source.items.map((item) => ({ ...item, saleOrderLineId })) }).success, false);
  }
  for (const orderLinkBasis of ['sku_match', 'picking_guess', '', null]) {
    assert.equal(SourceSchema.safeParse({ ...source, items: source.items.map((item) => ({ ...item, orderLinkBasis })) }).success, false);
  }
  for (const addressSource of ['billing_partner', 'unknown', '', null]) {
    assert.equal(SourceSchema.safeParse({ ...source, customer: { ...source.customer, addressSource } }).success, false);
  }
});

void test('legacy destination and work fingerprints remain byte-identical without meaningful new fields', () => {
  const source = legacySource();
  assert.equal(destinationAddressKey(source.customer), '4340cab0a404500aea7f4e16075a348fcda92885edf71e46543b0d1ee0d1cd57');
  assert.equal(workSourceFingerprint({ source }), 'd07b8471068064e37d40c88ae7abcfdd3e370ef3cb4e78726c01ea127f1801bd');
  for (const area of [{ province: null, postalCode: null }, { province: ' ', postalCode: '' }]) {
    const emptyArea = { ...source, customer: { ...source.customer, ...area } };
    assert.equal(destinationAddressKey(emptyArea.customer), destinationAddressKey(source.customer));
    assert.equal(workSourceFingerprint({ source: emptyArea }), workSourceFingerprint({ source }));
  }
});

void test('postal code, province and UoM identity invalidate work, but SKU remains descriptive', () => {
  const source = legacySource();
  for (const area of [{ province: 'ME' }, { postalCode: '098100' }]) {
    const changed = { ...source, customer: { ...source.customer, ...area } };
    assert.notEqual(destinationAddressKey(changed.customer), destinationAddressKey(source.customer));
    assert.notEqual(workSourceFingerprint({ source: changed }), workSourceFingerprint({ source }));
  }
  const withUnit = { ...source, items: source.items.map((item) => ({ ...item, sku: 'CHAIR-01', uomId: 1 })) };
  assert.notEqual(workSourceFingerprint({ source: withUnit }), workSourceFingerprint({ source }));
  assert.notEqual(workSourceFingerprint({ source: withUnit }), workSourceFingerprint({
    source: { ...withUnit, items: withUnit.items.map((item) => ({ ...item, uomId: 2 })) },
  }));
  assert.equal(workSourceFingerprint({ source: withUnit }), workSourceFingerprint({
    source: { ...withUnit, items: withUnit.items.map((item) => ({ ...item, sku: 'RENAMED-SKU' })) },
  }));
});

void test('source geography takes precedence, preserves leading zeros and never fills a missing value with demo geography', () => {
  const delivery = createDelivery(legacySource(), '11000000-0000-4000-8000-000000000003');
  delivery.addressGeography = { addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: 1,
    province: 'CT', postalCode: '95121', source: 'synthetic_fixture' };
  assert.deepEqual(deliveryGeography(delivery), { city: 'Messina', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' });
  delivery.source.customer = { ...delivery.source.customer, province: 'ME', postalCode: '098100' };
  assert.deepEqual(deliveryGeography(delivery), { city: 'Messina', province: 'ME', postalCode: '098100', source: 'odoo' });
  delivery.source.customer = { ...delivery.source.customer, province: null, postalCode: null };
  assert.deepEqual(deliveryGeography(delivery), { city: 'Messina', province: null, postalCode: null, source: null });
  assert.equal(delivery.routePoint, undefined);
});

void test('optional source fields validate bounds while unknown services and estimates remain unplanned', () => {
  const source = legacySource();
  const extended = { ...source, customer: { ...source.customer, province: 'ME', postalCode: '00100' },
    items: source.items.map((item) => ({ ...item, sku: 'CHAIR-01', uomId: 1 })) };
  assert.deepEqual(SourceSchema.parse(extended), extended);
  assert.equal(SourceSchema.safeParse({ ...extended, customer: { ...extended.customer, postalCode: '1'.repeat(21) } }).success, false);
  assert.equal(SourceSchema.safeParse({ ...extended, customer: { ...extended.customer, province: 'a'.repeat(101) } }).success, false);
  assert.equal(SourceSchema.safeParse({ ...extended, items: extended.items.map((item) => ({ ...item, sku: 'a'.repeat(201) })) }).success, false);
  assert.equal(SourceSchema.safeParse({ ...extended, items: extended.items.map((item) => ({ ...item, uomId: 0 })) }).success, false);
  const delivery = createDelivery(SourceSchema.parse(extended), '11000000-0000-4000-8000-000000000004');
  assert.equal(delivery.servicePlan, undefined);
  assert.equal(lineServiceStatuses(delivery)[0]?.planningBlockedReason, 'unknown_service');
  assert.deepEqual(remainingWorkEstimate(delivery), { minutes: null, basis: 'unknown', sourceMinutes: null });
});
