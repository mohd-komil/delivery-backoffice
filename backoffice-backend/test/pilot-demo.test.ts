import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { seedMvpPilot } from '../scripts/demo-pilot';
import { applicationUrl } from '../src/config';
import { applicationMigrations, makeDataSource, rows } from '../src/database/database';
import { DeliverySchema, type Delivery } from '../src/domain/model';

void test('MVP pilot seed isolates address deliveries and preserves edits when repeated', async () => {
  const schema = `mvp_pilot_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^mvp_pilot_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new DataSource({
    type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
    synchronize: false, logging: false, extra: { options: `-c search_path=${schema}` },
  });
  let created = false;
  try {
    await control.initialize();
    const target = await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    assert.equal(target.length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
    assert.equal(await seedMvpPilot(database), 3);
    const [addressA, addressB, addressC] = await rows(database.manager, z.object({ data: DeliverySchema }),
      'SELECT data FROM delivery WHERE source_instance=$1 ORDER BY source_id', ['mvp_demo']);
    assert.ok(addressA && addressB && addressC);
    assert.equal(addressA.data.source.pickingId, addressB.data.source.pickingId);
    assert.notEqual(addressA.data.source.pickingId, addressC.data.source.pickingId);
    assert.equal(new Set([addressA, addressB, addressC].map(({ data }) => data.source.customer.address)).size, 3);
    assert.deepEqual([addressA, addressB, addressC].map(({ data }) => data.routePoint), [
      { latitude: 45.4642, longitude: 9.1900 },
      { latitude: 45.5346, longitude: 9.2343 },
      { latitude: 45.5845, longitude: 9.2744 },
    ]);
    const chairs = addressA.data.source.items.filter((item) => item.name.includes('MVP-CHAIR'));
    assert.deepEqual(chairs.map(({ sourceLineId, saleOrderId, productId, quantity }) =>
      [sourceLineId, saleOrderId, productId, quantity]), [[910011, 9101, 9101, 2], [910021, 9102, 9101, 1]]);
    assert.deepEqual(addressA.data.servicePlan, { defaultService: 'delivery_installation', overrides: [
      { sourceLineId: 910021, service: 'delivery_only' }, { sourceLineId: 910022, service: 'installation_only' },
    ] });
    assert.equal(addressB.data.servicePlan?.defaultService, 'collection_only');
    assert.equal(addressC.data.servicePlan?.defaultService, 'delivery_only');
    assert.equal(addressC.data.source.items[0]?.productId, 9101);

    const edited: Delivery = { ...addressA.data, version: 2, routePoint: { latitude: 45.46, longitude: 9.19 },
      instructions: { ...addressA.data.instructions, notes: 'Manual pilot edit' } };
    await database.query('UPDATE delivery SET version=$2,data=$3::jsonb WHERE id=$1', [edited.id, edited.version, JSON.stringify(edited)]);
    const existing: Delivery = { ...addressC.data, id: randomUUID() };
    await database.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [existing.id, 'odoo_mock', 910003, existing.version, JSON.stringify(existing)]);
    const snapshot = () => rows(database.manager, z.object({ version: z.number(), data: DeliverySchema }),
      'SELECT version,data FROM delivery ORDER BY source_instance,source_id');
    const before = await snapshot();
    assert.equal(before.length, 4);
    assert.equal(await seedMvpPilot(database), 0);
    assert.deepEqual(await snapshot(), before);
  } finally {
    try {
      if (database.isInitialized) await database.destroy();
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      if (control.isInitialized) await control.destroy();
    }
  }
});
