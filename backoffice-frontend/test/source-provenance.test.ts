import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverySchema } from '../src/lib/contracts';
import { detailFixture } from './refresh-fixtures';

void test('browser contracts preserve optional source provenance and historical snapshot absence', () => {
  const legacy = detailFixture().delivery;
  const completion = {
    id: '11000000-0000-4000-8000-000000000001', at: '2026-11-01T12:00:00Z',
    actorId: '11000000-0000-4000-8000-000000000002', actorName: 'Test dispatcher',
    sourceSnapshot: legacy.source, resultIds: [], reopenedAt: null, reopenReason: null,
  };
  const priorCompletion = deliverySchema.parse({ ...legacy, completions: [completion] }).completions[0];
  assert.ok(priorCompletion);
  const before = JSON.stringify(priorCompletion);
  const current = deliverySchema.parse({ ...legacy, completions: [priorCompletion], source: { ...legacy.source,
    customer: { ...legacy.source.customer, addressSource: 'move_order_shipping' },
    items: legacy.source.items.map((item) => ({ ...item, saleOrderLineId: null, orderLinkBasis: 'procurement_group' })),
  } });
  assert.equal(current.source.customer.addressSource, 'move_order_shipping');
  assert.equal(current.source.items[0]?.saleOrderLineId, null);
  assert.equal(current.source.items[0]?.orderLinkBasis, 'procurement_group');
  assert.equal(JSON.stringify(current.completions[0]), before);
  assert.equal(Object.hasOwn(priorCompletion.sourceSnapshot.customer, 'addressSource'), false);
  assert.equal(Object.hasOwn(priorCompletion.sourceSnapshot.items[0] ?? {}, 'saleOrderLineId'), false);
  assert.equal(Object.hasOwn(priorCompletion.sourceSnapshot.items[0] ?? {}, 'orderLinkBasis'), false);
  const direct = deliverySchema.parse({ ...legacy, source: { ...legacy.source,
    customer: { ...legacy.source.customer, addressSource: 'picking' },
    items: legacy.source.items.map((item) => ({ ...item, saleOrderLineId: 8001, orderLinkBasis: 'sale_order_line' })),
  } });
  assert.equal(direct.source.items[0]?.saleOrderLineId, 8001);
  assert.equal(direct.source.items[0]?.sourceLineId, legacy.source.items[0]?.sourceLineId);
});

void test('browser contracts reject unsupported source provenance instead of accepting guessed relationships', () => {
  const legacy = detailFixture().delivery;
  for (const saleOrderLineId of [0, -1, 1.5, '8001']) {
    assert.equal(deliverySchema.safeParse({ ...legacy, source: { ...legacy.source,
      items: legacy.source.items.map((item) => ({ ...item, saleOrderLineId })),
    } }).success, false);
  }
  assert.equal(deliverySchema.safeParse({ ...legacy, source: { ...legacy.source,
    items: legacy.source.items.map((item) => ({ ...item, orderLinkBasis: 'sku_match' })),
  } }).success, false);
  assert.equal(deliverySchema.safeParse({ ...legacy, source: { ...legacy.source,
    customer: { ...legacy.source.customer, addressSource: 'billing_partner' },
  } }).success, false);
});
