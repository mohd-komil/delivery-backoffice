import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { type Appointment, type CrewActor, type OperatorActor, type TaskTemplate } from '../src/domain/model';
import { changeServicePlan, confirmCustomerVisit, instantiateTask, planVisitWork, recordExecution, startVisit } from '../src/domain/rules';
import { Importer } from '../src/integration/importer';
import { DeliveryStore } from '../src/operations/store';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { DestinationEntrances } from '../src/routing/entrances';
import { destinationAddressKey } from '../src/domain/destination-address';

class IsolatedDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({
      type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}` },
    });
  }
}

void test('real PostgreSQL importer: isolated source, idempotency, related changes, failures, and snapshots', async (context) => {
  const suffix = randomUUID().replaceAll('-', '');
  const appSchema = `importer_app_${suffix}`;
  const sourceSchema = `importer_source_${suffix}`;
  assert.match(appSchema, /^importer_app_[0-9a-f]{32}$/);
  assert.match(sourceSchema, /^importer_source_[0-9a-f]{32}$/);
  const environment = config();
  const originalSourceUrl = environment.ODOO_DATABASE_URL;
  const sourceOwnerSchema = z.string().length(48).regex(/^[0-9a-f]{48}$/);
  let sourceOwnerPassword: string;
  if (environment.BACKOFFICE_RUNTIME === 'docker') {
    sourceOwnerPassword = sourceOwnerSchema.parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  } else {
    const credentialsValue: unknown = JSON.parse(await readFile('.local/postgres-credentials.json', 'utf8'));
    sourceOwnerPassword = z.object({ sourceOwner: sourceOwnerSchema }).parse(credentialsValue).sourceOwner;
  }
  const ownerUrl = new URL(originalSourceUrl);
  ownerUrl.username = 'odoo_seed';
  ownerUrl.password = sourceOwnerPassword;
  const appAdmin = makeDataSource(true);
  const sourceAdmin = new DataSource({ type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false });
  const sourceOwner = new DataSource({
    type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false,
    extra: { options: `-c search_path=${sourceSchema}` },
  });
  const database = new IsolatedDatabase(appSchema);
  let appCreated = false;
  let sourceCreated = false;
  try {
    await appAdmin.initialize();
    await sourceAdmin.initialize();
    const appTarget = await rows(appAdmin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    const sourceTarget = await rows(sourceAdmin.manager, z.object({ name: z.literal('odoo_mock') }), 'SELECT current_database() AS name');
    assert.equal(appTarget.length, 1);
    assert.equal(sourceTarget.length, 1);
    // Identifiers are generated internally and checked above; cleanup is limited to these exact owned schemas.
    await appAdmin.query(`CREATE SCHEMA "${appSchema}"`);
    appCreated = true;
    await sourceAdmin.query(`CREATE SCHEMA "${sourceSchema}"`);
    sourceCreated = true;
    await sourceOwner.initialize();
    await sourceOwner.query(await readFile('local/source-schema.sql', 'utf8'));
    await sourceOwner.query(await readFile('local/source-seed.sql', 'utf8'));
    await sourceOwner.query(`GRANT USAGE ON SCHEMA "${sourceSchema}" TO odoo_reader`);
    await sourceOwner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sourceSchema}" TO odoo_reader`);
    const readerUrl = new URL(originalSourceUrl);
    readerUrl.searchParams.set('options', `-c search_path=${sourceSchema}`);
    process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
    await database.onModuleInit();
    await database.source.runMigrations({ transaction: 'all' });
    const store = new DeliveryStore(database);
    const importer = new Importer(database, store);
    const actor: OperatorActor = { id: randomUUID(), name: 'DEMO importer test operator', role: 'operator' };

    await context.test('exact source filters and picking-specific quantities persist without duplicates', async () => {
      const first = await importer.run(actor);
      assert.equal(first.status, 'succeeded');
      assert.equal(first.processed, 20);
      const deliveries = await store.all();
      assert.deepEqual(deliveries.map((delivery) => delivery.source.pickingId), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
      assert.deepEqual(deliveries[0]?.source.items.map((item) => item.sourceLineId), [11,12]);
      assert.deepEqual(deliveries[1]?.source.items.map((item) => item.sourceLineId), [21,22]);
      assert.deepEqual(deliveries[0]?.servicePlan, { defaultService: 'delivery_only', overrides: [] });
      assert.deepEqual(deliveries[1]?.servicePlan, { defaultService: 'delivery_installation', overrides: [] });
      assert.equal(deliveries.find((delivery) => delivery.source.pickingId === 12)?.servicePlan, undefined, 'Unknown source service stays explicit');
      assert.equal(deliveries[4]?.source.items[1]?.quantity, 1.5);
      const multipleOrders = deliveries.find((delivery) => delivery.source.pickingId === 20);
      assert.ok(multipleOrders);
      assert.deepEqual(multipleOrders.source.salesOrders, [{ id: 20, name: 'DEMO/SO/0020' }, { id: 1001, name: 'DEMO/SO/1001' }]);
      assert.deepEqual(multipleOrders.source.items.map((item) => [item.sourceLineId, item.saleOrderId]), [[201, 20], [202, 20], [20001, 1001]]);
      const second = await importer.run(actor);
      assert.equal(second.status, 'succeeded');
      assert.deepEqual(await store.all(), deliveries);
    });

    await context.test('a secondary sales order with Magento linkage excludes the whole picking without dropping its lines', async () => {
      const delivery = (await store.all()).find((entry) => entry.source.pickingId === 20);
      assert.ok(delivery);
      await sourceOwner.query('UPDATE sale_order SET magento_id=$1 WHERE id=$2', ['DEMO secondary Magento', 1001]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      const reviewed = await store.get(delivery.id);
      assert.equal(reviewed.sourceReview, true);
      assert.equal(reviewed.source.items.length, 3);
      assert.equal(reviewed.source.salesOrders?.length, 2);
      await sourceOwner.query('UPDATE sale_order SET magento_id=NULL WHERE id=$1', [1001]);
      await importer.run(actor);
      assert.equal((await store.get(delivery.id)).sourceReview, false);
    });

    const first = (await store.all())[0];
    assert.ok(first);
    const crewActor: CrewActor = { kind: 'crew', id: randomUUID(), name: 'DEMO responsible crew member' };
    const template: TaskTemplate = { id: randomUUID(), version: 1, title: 'DEMO inspect', severity: 'high', order: 0, checklist: ['Inspect goods'], enabled: true };
    const appointment: Appointment = {
      id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T10:00:00Z', status: 'booked',
      cancellationReason: null, returnRequestId: null, results: [],
      assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO crew',
        people: [{ id: crewActor.id, name: crewActor.name, external: false }], tasks: [instantiateTask(template)] }],
    };
    const worked = await store.mutate(first.id, first.version, actor, 'test.fixture_execution', (current) => {
      const delivery = changeServicePlan(current, { defaultService: 'delivery_only' });
      delivery.instructions.notes = 'Local instructions must survive source refresh';
      appointment.workScope = planVisitWork(delivery, [
        { sourceLineId: 11, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 },
        { sourceLineId: 12, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 },
      ], actor, '2026-11-03T07:00:00Z');
      delivery.appointments.push(appointment);
      const confirmed = confirmCustomerVisit(delivery, appointment.id, actor, '2026-11-03T07:00:00Z');
      return recordExecution(startVisit(confirmed, appointment.id, crewActor), {
        id: randomUUID(), appointmentId: appointment.id, actualStart: '2026-11-03T08:10:00Z', actualEnd: '2026-11-03T09:00:00Z',
        summary: 'DEMO received work through shared domain rules', responsiblePersonId: crewActor.id,
        supersedesResultId: null, correctionReason: null,
        quantities: [{ sourceLineId: 11, deliveredMilli: 1000 }, { sourceLineId: 12, deliveredMilli: 2000 }],
        completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))),
        evidence: [], customerSignature: { status: 'signed', signerName: 'DEMO Customer', text: 'DEMO customer signature', at: '2026-11-03T09:00:00Z' },
        crewSignature: { status: 'signed', signerName: crewActor.name, text: 'DEMO crew signature', at: '2026-11-03T09:00:00Z' },
      }, crewActor, '2026-11-03T10:00:00Z');
    });
    const signedSnapshot = structuredClone(worked.appointments);

    await context.test('an order ownership change after booking requires review without changing quantities or signed history', async () => {
      assert.equal((await store.get(first.id)).sourceChanged, false);
      await sourceOwner.query('INSERT INTO sale_order(id,name,magento_id,partner_id) VALUES($1,$2,NULL,$3)', [1002, 'DEMO/SO/1002', 1]);
      await sourceOwner.query('UPDATE sale_order_line SET order_id=$1 WHERE id=$2', [1002, 11]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      const changed = await store.get(first.id);
      assert.deepEqual(changed.source.salesOrders?.map((order) => order.id), [1, 1002]);
      assert.equal(changed.source.items[0]?.saleOrderId, 1002);
      assert.equal(changed.source.items[0]?.quantity, first.source.items[0]?.quantity);
      assert.equal(changed.sourceChanged, true);
      assert.deepEqual(changed.appointments, signedSnapshot);
      await sourceOwner.query('UPDATE sale_order_line SET order_id=$1 WHERE id=$2', [1, 11]);
      await importer.run(actor);
    });

    await context.test('related address and quantities refresh without rewriting local work or signed snapshots', async () => {
      const entrances = new DestinationEntrances(store, new DeliveryPoints(store));
      const shared = (await store.all()).find((delivery) => delivery.source.pickingId === 2);
      assert.ok(shared);
      const before = await entrances.get(shared.id);
      const verified = { latitude: 37.51, longitude: 15.08 };
      await entrances.confirm(shared.id, {
        addressKey: before.addressKey, deliveryVersion: before.deliveryVersion, version: null, point: verified, confirmed: true,
      }, actor);
      assert.deepEqual((await entrances.get(first.id)).entrance?.point, verified);
      const original = await store.get(first.id);
      await store.mutate(original.id, original.version, actor, 'test.fixture_reference_point', (delivery) => {
        delivery.routePoint = { latitude: 37.5, longitude: 15.07 };
        delivery.addressGeography = { addressKey: destinationAddressKey(delivery.source.customer),
          sourceCustomerId: delivery.source.customer.id, province: 'CT', postalCode: '095121', source: 'synthetic_fixture' };
        return delivery;
      });
      const localGeography = (await store.get(first.id)).addressGeography;
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.deepEqual((await store.get(first.id)).addressGeography, localGeography, 'Unchanged source preserves local geography');
      await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=$2', ['DEMO Changed street', 1]);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', ['1.500', 11]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      const updated = await store.get(first.id);
      assert.equal(updated.source.customer.address, 'DEMO Changed street');
      assert.equal(updated.source.items[0]?.quantity, 1.5);
      assert.equal(updated.instructions.notes, 'Local instructions must survive source refresh');
      assert.equal(updated.sourceChanged, true);
      assert.ok(updated.sourceWarnings.some((warning) => warning.includes('after booking')));
      assert.deepEqual(updated.appointments, signedSnapshot);
      assert.equal(updated.completedAt, null);
      const entrance = await entrances.get(first.id);
      assert.equal(entrance.entrance, null);
      assert.equal(entrance.stale, true, 'Refresh flags an entrance inherited through another delivery');
      assert.equal(entrance.referencePoint, null, 'Refresh clears the old source point');
      assert.equal(updated.addressGeography, undefined, 'A new source address invalidates local geography');
    });

    await context.test('sales team, Magento linkage, and source done require review without deletion or local completion', async () => {
      await sourceOwner.query('UPDATE crm_team SET name=$1 WHERE id=$2', ['DEMO no longer allowed', 1]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.equal((await store.get(first.id)).sourceReview, true);
      await sourceOwner.query('UPDATE crm_team SET name=$1 WHERE id=$2', ['MOHD MESSINA', 1]);
      await sourceOwner.query('UPDATE sale_order SET magento_id=$1 WHERE id=$2', ['DEMO changed Magento linkage', 1]);
      await importer.run(actor);
      assert.equal((await store.get(first.id)).sourceReview, true);
      await sourceOwner.query('UPDATE sale_order SET magento_id=NULL WHERE id=$1', [1]);
      await sourceOwner.query('UPDATE stock_picking SET state=$1 WHERE id=$2', ['done', 1]);
      await importer.run(actor);
      const changed = await store.get(first.id);
      assert.equal(changed.source.sourceState, 'done');
      assert.equal(changed.sourceReview, true);
      assert.equal(changed.completedAt, null);
      assert.deepEqual(changed.appointments, signedSnapshot);
      assert.equal((await store.all()).length, 20);
      await sourceOwner.query('UPDATE stock_picking SET state=$1 WHERE id=$2', ['assigned', 1]);
      await importer.run(actor);
      assert.equal((await store.get(first.id)).sourceReview, false);
    });

    await context.test('invalid records produce visible partial log, retain old data, and recover on rerun', async () => {
      const third = (await store.all()).find((delivery) => delivery.source.pickingId === 3);
      assert.ok(third);
      await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', ['', 31]);
      const partial = await importer.run(actor);
      assert.equal(partial.status, 'partial');
      assert.equal(partial.processed, 19);
      assert.equal(partial.details.length, 1);
      assert.match(partial.details[0] ?? '', /Picking 3: source validation failed/);
      assert.equal((await store.get(third.id)).sourceReview, true);
      assert.deepEqual((await store.get(third.id)).source, third.source);
      await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', ['unit', 31]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.equal((await store.get(third.id)).sourceReview, false);
    });

    await context.test('source unavailability is recorded as failure and the next run recovers', async () => {
      const invalidPasswordUrl = new URL(readerUrl);
      invalidPasswordUrl.password = 'DEMO-intentionally-invalid-password';
      process.env['ODOO_DATABASE_URL'] = invalidPasswordUrl.toString();
      const failure = await importer.run(actor);
      assert.equal(failure.status, 'failed');
      assert.equal(failure.processed, 0);
      assert.ok(failure.error);
      assert.equal((await store.all()).length, 20);
      process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
      assert.equal((await importer.run(actor)).status, 'succeeded');
    });

    await context.test('single active importer lock and stale interrupted-run recovery are real database behavior', async () => {
      const lock = database.source.createQueryRunner();
      await lock.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(7041002)');
        await assert.rejects(importer.run(actor), (error: unknown) => error instanceof ConflictException);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(7041002)');
        await lock.release();
      }
      const interruptedId = randomUUID();
      await database.source.query('INSERT INTO import_run(id,status,processed) VALUES($1,$2,$3)', [interruptedId, 'running', 3]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      const interrupted = (await importer.list()).find((run) => run.id === interruptedId);
      assert.equal(interrupted?.status, 'interrupted');
      assert.equal(interrupted?.processed, 3);
      assert.ok(interrupted?.finishedAt);
      assert.deepEqual((await store.get(first.id)).appointments, signedSnapshot);
    });
  } finally {
    process.env['ODOO_DATABASE_URL'] = originalSourceUrl;
    await database.onModuleDestroy();
    if (sourceOwner.isInitialized) await sourceOwner.destroy();
    if (appCreated) await appAdmin.query(`DROP SCHEMA "${appSchema}" CASCADE`);
    if (sourceCreated) await sourceAdmin.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
    if (appAdmin.isInitialized) await appAdmin.destroy();
    if (sourceAdmin.isInitialized) await sourceAdmin.destroy();
  }
});
