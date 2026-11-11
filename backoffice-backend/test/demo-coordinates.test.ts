import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { seedDemoCoordinates } from '../scripts/demo-coordinates';
import { Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, DeliverySchema, type Delivery, type OperatorActor } from '../src/domain/model';
import { DeliveryStore } from '../src/operations/store';

const principal: OperatorActor = { id: '00000000-0000-4000-8000-000000000002', name: 'Demo operator', role: 'operator' };

function fixture(sourceId: number): Delivery {
  const customerId = sourceId === 2 ? 1 : ((sourceId - 1) % 12) + 1;
  const delivery = createDelivery({
    pickingId: sourceId, pickingName: `DEMO/OUT/${String(sourceId).padStart(4, '0')}`,
    saleOrderId: sourceId, saleOrderName: `DEMO/SO/${sourceId}`, sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
    customer: {
      id: customerId, name: `DEMO Customer ${String(customerId).padStart(2, '0')}`,
      address: customerId === 12 ? null : `Via Dimostrativa ${customerId}`,
      city: customerId % 2 === 0 ? 'Messina' : 'Catania', country: 'IT', phones: [], email: null, contact: null,
    },
    items: [{ sourceLineId: sourceId * 10, productId: 1, name: 'DEMO Chair', description: null,
      quantity: 2, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: 'delivery', estimatedMinutes: 60, notes: null,
  }, randomUUID());
  return { ...delivery, instructions: { ...delivery.instructions, notes: 'Preserve dispatcher input' },
    servicePlan: { defaultService: 'collection_only', overrides: [] } };
}

void test('demo coordinates fill missing verified points atomically and preserve edits, entrances and repeat runs', async () => {
  const schema = `demo_coordinates_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^demo_coordinates_[0-9a-f]{32}$/);
  const previousTest = process.env['BACKOFFICE_TEST'];
  process.env['BACKOFFICE_TEST'] = '1';
  const db = new Database();
  db.source.setOptions({ schema, extra: { options: `-c search_path=${schema}` } });
  const control = makeDataSource(true);
  const store = new DeliveryStore(db);
  let created = false;
  try {
    await control.initialize();
    const target = await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    assert.equal(target.length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.onModuleInit();
    await db.source.runMigrations({ transaction: 'all' });
    const fixtures = Array.from({ length: 20 }, (_, index) => fixture(index + 1));
    const first = fixtures[0];
    const edited = fixtures[2];
    const entranceDelivery = fixtures[5];
    assert.ok(first && edited && entranceDelivery);
    first.routePoint = { latitude: 37.6, longitude: 15.1 };
    edited.source.customer.address = 'Dispatcher changed address';
    for (const delivery of fixtures) {
      await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [delivery.id, 'odoo_mock', delivery.source.pickingId, delivery.version, JSON.stringify(delivery)]);
    }
    const unrelated = fixture(9);
    await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [unrelated.id, 'another_source', 9, unrelated.version, JSON.stringify(unrelated)]);
    await db.source.query(`INSERT INTO destination_entrance
      (source_instance,source_customer_id,address_key,latitude,longitude,version,confirmed_by_id,confirmed_by_name)
      VALUES($1,$2,$3,$4,$5,1,$6,$7)`, ['odoo_mock', entranceDelivery.source.customer.id,
      destinationAddressKey(entranceDelivery.source.customer), 38.24, 15.57, principal.id, principal.name]);
    const snapshot = () => rows(db.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery ORDER BY id');
    const before = await snapshot();
    const entrancesBefore: unknown = await db.source.query('SELECT * FROM destination_entrance');
    const runs = await Promise.all([seedDemoCoordinates(store, principal), seedDemoCoordinates(store, principal)]);
    assert.deepEqual(runs.map(({ updated }) => updated.length).sort((a, b) => a - b), [0, 15]);
    const applied = runs.flatMap(({ updated }) => updated);
    const after = await snapshot();
    for (const { data: previous } of before) {
      const observed = after.find(({ data }) => data.id === previous.id)?.data;
      const change = applied.find(({ id }) => id === previous.id);
      assert.deepEqual(observed, change ? { ...previous, version: previous.version + 1, routePoint: change.point } : previous);
    }
    const [anchor] = await rows(db.source.manager, z.object({ data: DeliverySchema }),
      'SELECT data FROM delivery WHERE source_instance=$1 AND source_id=9', ['odoo_mock']);
    assert.deepEqual(anchor?.data.routePoint, { latitude: 37.5079, longitude: 15.083 });
    const entrancesAfter: unknown = await db.source.query('SELECT * FROM destination_entrance');
    assert.deepEqual(entrancesAfter, entrancesBefore);
    const [audit] = await rows(db.source.manager, z.object({ count: z.number() }),
      'SELECT count(*)::integer AS count FROM audit WHERE action=$1', ['demo.coordinates_added']);
    assert.equal(audit?.count, 15);
    assert.equal((await seedDemoCoordinates(store, principal)).updated.length, 0);
    assert.deepEqual(await snapshot(), after);
    const previousMode = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      await assert.rejects(seedDemoCoordinates(store, principal), /cannot run in production mode/);
      assert.deepEqual(await snapshot(), after);
    } finally {
      if (previousMode === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousMode;
    }
  } finally {
    try {
      await db.onModuleDestroy();
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      if (control.isInitialized) await control.destroy();
      if (previousTest === undefined) delete process.env['BACKOFFICE_TEST'];
      else process.env['BACKOFFICE_TEST'] = previousTest;
    }
  }
});
