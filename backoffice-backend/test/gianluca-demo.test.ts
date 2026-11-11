import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { gianlucaDemoIds, gianlucaDemoSource, seedGianlucaDemo } from '../scripts/demo-gianluca';
import { applicationUrl } from '../src/config';
import { applicationMigrations, makeDataSource, rows } from '../src/database/database';
import { deliveryGeography } from '../src/domain/delivery-geography';
import { DeliverySchema, type Delivery } from '../src/domain/model';
import { lineServiceStatuses, remainingWorkEstimate } from '../src/domain/rules';

void test('Gianluca fixtures separate identical-SKU orders and preserve all existing state on repeat', async () => {
  const schema = `gianluca_demo_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^gianluca_demo_[0-9a-f]{32}$/);
  const catalog: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const control = makeDataSource(true);
  const database = new DataSource({
    type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
    synchronize: false, logging: false, extra: { options: `-c search_path=${schema}` },
  });
  let created = false;
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }),
      'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
    await assert.rejects(seedGianlucaDemo(database, catalog, false));
    assert.equal((await rows(database.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery')).length, 0);
    assert.equal(await seedGianlucaDemo(database, catalog, true), 2);
    const [primary, secondary] = await rows(database.manager, z.object({ data: DeliverySchema }),
      'SELECT data FROM delivery WHERE source_instance=$1 ORDER BY source_id', [gianlucaDemoSource]);
    assert.ok(primary && secondary);
    assert.equal(primary.data.id, gianlucaDemoIds.primary);
    assert.equal(secondary.data.id, gianlucaDemoIds.secondary);
    assert.deepEqual(primary.data.source.customer.phones, ['+39 000 000 9201']);
    assert.deepEqual(secondary.data.source.customer.phones, ['+39 000 000 9202']);
    assert.deepEqual(primary.data.source.items.map(({ sourceLineId, saleOrderId, productId, quantity }) =>
      [sourceLineId, saleOrderId, productId, quantity]), [[920011, 9201, 9201, 2], [920021, 9202, 9201, 1]]);
    assert.deepEqual(lineServiceStatuses(primary.data).map(({ sourceLineId, remainingDeliveryMilli, remainingInstallationMilli }) =>
      [sourceLineId, remainingDeliveryMilli, remainingInstallationMilli]), [[920011, 2000, 2000], [920021, 1000, 0]]);
    assert.equal(remainingWorkEstimate(primary.data).minutes, 90);
    assert.deepEqual(primary.data.routePoint, { latitude: 37.5025956, longitude: 15.0843868 });
    assert.deepEqual(deliveryGeography(primary.data), {
      city: 'Catania', province: 'CT', postalCode: '95124', source: 'synthetic_fixture',
    });
    assert.notEqual(primary.data.source.pickingId, secondary.data.source.pickingId);
    assert.notEqual(primary.data.source.customer.address, secondary.data.source.customer.address);
    assert.equal(primary.data.appointments.length, 0);
    assert.equal(secondary.data.appointments.length, 0);
    const edited: Delivery = { ...primary.data, version: 2,
      instructions: { ...primary.data.instructions, notes: 'Keep the dispatcher edit on repeat' } };
    await database.query('UPDATE delivery SET version=$2,data=$3::jsonb WHERE id=$1', [edited.id, edited.version, JSON.stringify(edited)]);
    const unrelated: Delivery = { ...secondary.data, id: randomUUID() };
    await database.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [unrelated.id, 'odoo_mock', 920001, unrelated.version, JSON.stringify(unrelated)]);
    const snapshot = () => rows(database.manager, z.object({ version: z.number(), data: DeliverySchema }),
      'SELECT version,data FROM delivery ORDER BY source_instance,source_id');
    const before = await snapshot();
    assert.equal(before.length, 3);
    assert.equal(await seedGianlucaDemo(database, catalog, true), 0);
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
