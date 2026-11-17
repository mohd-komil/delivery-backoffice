import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, WorkTimeStandardSnapshotSchema, type Appointment, type CrewActor, type OperatorActor, type TaskTemplate } from '../src/domain/model';
import { changeServicePlan, changeWorkTimeAdjustments, changeWorkTimes, confirmCustomerVisit, confirmPriorWork, estimateWorkMinutes, instantiateTask, lineServiceStatuses, lineWorkTimes, planVisitWork, priorWorkStatus, recordExecution, startVisit } from '../src/domain/rules';
import { Importer } from '../src/integration/importer';
import { ImportGeocoding } from '../src/integration/import-geocoding';
import { AddressGeocoding } from '../src/routing/geocoding';
import { GeoapifyClient } from '../src/routing/geoapify-client';
import { OdooSource } from '../src/integration/source';
import { DeliveryStore } from '../src/operations/store';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { DestinationEntrances } from '../src/routing/entrances';
import { destinationAddressKey } from '../src/domain/destination-address';
import { SourceReview } from '../src/integration/source-review';
import { compareSourceEvidence, revisionCoverage, sourceHash } from '../src/domain/source-import';

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
  assert.equal(environment.ODOO_SOURCE_MODE, 'mock', 'Mutating importer fixtures must never connect to an external Odoo source');
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
    // Owned revision-aware fixture only: emulate Odoo's write_date maintenance, including microseconds.
    await sourceOwner.query(`CREATE FUNCTION fixture_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.write_date IS NOT DISTINCT FROM OLD.write_date THEN NEW.write_date=clock_timestamp(); END IF; RETURN NEW; END $$`);
    for (const table of ['stock_picking_type','stock_location','crm_team','res_partner','sale_order','stock_picking','product_template','product_product','sale_order_line','stock_move']) {
      await sourceOwner.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS write_date timestamptz NOT NULL DEFAULT now()`);
      await sourceOwner.query(`UPDATE ${table} SET write_date=clock_timestamp()`);
      await sourceOwner.query(`CREATE TRIGGER fixture_clock BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fixture_clock()`);
    }
    await sourceOwner.query(`GRANT USAGE ON SCHEMA "${sourceSchema}" TO odoo_reader`);
    await sourceOwner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sourceSchema}" TO odoo_reader`);
    const readerUrl = new URL(originalSourceUrl);
    readerUrl.searchParams.set('options', `-c search_path=${sourceSchema}`);
    process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
    await database.onModuleInit();
    await database.source.runMigrations({ transaction: 'all' });
    const store = new DeliveryStore(database);
    const importer = new Importer(database, store, new ImportGeocoding(store, new DeliveryPoints(store),
      new AddressGeocoding(store, new GeoapifyClient({ settings: null }))));
    const actor: OperatorActor = { id: randomUUID(), name: 'DEMO importer test operator', role: 'operator' };
    const sourceReview = new SourceReview(store);
    async function acceptPending(id: string) {
      const review = await sourceReview.get(id);
      if (!review.candidate) return;
      assert.equal(review.canAccept, true, JSON.stringify(review.blockers));
      await sourceReview.decide(id, { version: review.deliveryVersion, requestId: randomUUID(), candidateId: review.candidate.id,
        candidateHash: review.candidate.hash, action: 'accept', reason: 'Test dispatcher verified this source revision and retained local work decisions' }, actor);
    }

    await context.test('source namespaces isolate overlapping IDs, missing source rows and invalid-record flags', async () => {
      const snapshot = await new OdooSource().snapshot((reader) => reader.picking(1));
      assert.ok(snapshot);
      const foreignInstance = 'customer_test_copy';
      const foreign = [1, 99999].map((pickingId) => createDelivery({ ...snapshot, pickingId,
        pickingName: `FOREIGN/OUT/${pickingId}`, customer: { ...snapshot.customer, name: 'Preserved foreign recipient' },
      }, randomUUID()));
      for (const delivery of foreign) {
        delivery.instructions.notes = 'Unrelated source planning must remain unchanged';
        await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
          [delivery.id, foreignInstance, delivery.source.pickingId, delivery.version, JSON.stringify(delivery)]);
      }
      const firstLine = snapshot.items[0];
      assert.ok(firstLine);
      try {
        const imported = await importer.run(actor);
        assert.equal(imported.status, 'succeeded');
        assert.equal(imported.processed, 20, 'Foreign tracked IDs must not enter this source scan');
        const own = await rows(database.source.manager, z.object({ total: z.number().int() }),
          'SELECT count(*)::int AS total FROM delivery WHERE source_instance=$1', ['odoo_mock']);
        assert.equal(own[0]?.total, 20, 'Overlapping source IDs must create distinct application deliveries');
        for (const delivery of foreign) assert.deepEqual(await store.get(delivery.id), delivery);
        await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', ['', firstLine.sourceLineId]);
        const partial = await importer.run(actor);
        assert.equal(partial.status, 'partial');
        assert.equal(partial.processed, 19);
        for (const delivery of foreign) assert.deepEqual(await store.get(delivery.id), delivery);
        const foreignAudit = await rows(database.source.manager, z.object({ total: z.number().int() }),
          'SELECT count(*)::int AS total FROM audit WHERE delivery_id=ANY($1::uuid[])', [foreign.map(({ id }) => id)]);
        assert.equal(foreignAudit[0]?.total, 0, 'Neither refresh nor invalid-source auditing may attach to another namespace');
      } finally {
        await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', [firstLine.uom, firstLine.sourceLineId]);
        await database.source.query('DELETE FROM delivery WHERE source_instance=$1 AND id=ANY($2::uuid[])',
          [foreignInstance, foreign.map(({ id }) => id)]);
      }
    });

    await context.test('exact source filters and picking-specific quantities persist without duplicates', async () => {
      const first = await importer.run(actor);
      assert.equal(first.status, 'succeeded');
      assert.equal(first.processed, 20);
      const deliveries = await store.all();
      assert.deepEqual(deliveries.map((delivery) => delivery.source.pickingId), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
      assert.deepEqual(deliveries[0]?.source.items.map((item) => item.sourceLineId), [11,12]);
      assert.deepEqual(deliveries[1]?.source.items.map((item) => item.sourceLineId), [21,22]);
      assert.deepEqual(deliveries[0]?.servicePlan, { defaultService: 'delivery_only', defaultOrigin: 'source', overrides: [] });
      assert.deepEqual(deliveries[1]?.servicePlan, { defaultService: 'delivery_installation', defaultOrigin: 'source', overrides: [] });
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
      assert.equal(reviewed.sourceImport?.eligible, false);
      assert.ok(reviewed.sourceImport?.pending?.reasons.includes('source_ineligible'));
      assert.equal(reviewed.source.items.length, 3);
      assert.equal(reviewed.source.salesOrders?.length, 2);
      await sourceOwner.query('UPDATE sale_order SET magento_id=NULL WHERE id=$1', [1001]);
      await importer.run(actor);
      assert.equal((await store.get(delivery.id)).sourceReview, false);
    });

    const timedPicking = (await store.all()).find((delivery) => delivery.source.pickingId === 20);
    assert.ok(timedPicking);
    const firstOrderRates = { sourceLineId: 202, deliveryMinutesPerUnit: 12, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null };
    const secondOrderRates = { sourceLineId: 20001, deliveryMinutesPerUnit: 15, installationMinutesPerUnit: 45, collectionMinutesPerUnit: null };
    const firstTimedWork = { sourceLineId: 202, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 };
    const secondTimedWork = { sourceLineId: 20001, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 };
    const timedWork = [firstTimedWork, secondTimedWork];

    await context.test('local line services and operation times survive source changes and repeated imports for the same product in two orders', async () => {
      const items = timedPicking.source.items.filter((item) => item.sourceLineId === 202 || item.sourceLineId === 20001);
      assert.equal(items.length, 2);
      assert.equal(items[0]?.productId, items[1]?.productId, 'The two commercial lines share the same physical product/SKU');
      assert.deepEqual(items.map((item) => item.saleOrderId), [20, 1001]);
      const configured = await store.mutate(timedPicking.id, timedPicking.version, actor, 'test.configure_line_work', (current) => {
        const first = changeWorkTimes(current, firstOrderRates, actor, '2026-11-12T10:00:00Z');
        const saved = first.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === 202);
        assert.ok(saved);
        // A valid persisted catalogue snapshot is fixture input for import retention; HTTP application is tested separately.
        saved.timeStandard = WorkTimeStandardSnapshotSchema.parse({ id: randomUUID(), version: 3, name: 'Isolated standard snapshot',
          service: 'delivery_installation', unit: saved.context.uom, category: null,
          rates: { deliveryMinutesPerUnit: 12, installationMinutesPerUnit: 30, collectionMinutesPerUnit: null },
          basis: 'elapsed_team_minutes', assumptions: 'Two-person ground-floor test', exclusions: 'Travel and waiting',
          examples: 'Fixture only', sourceReference: 'Isolated dispatcher observation' });
        const second = changeWorkTimes(first, secondOrderRates, actor, '2026-11-12T10:01:00Z');
        // Changing a service after setting its rates must retain the other local fields in the service plan.
        return changeServicePlan(changeServicePlan(second, { sourceLineId: 202, service: 'delivery_only' }),
          { sourceLineId: 20001, service: 'installation_only' });
      });
      assert.equal(estimateWorkMinutes(configured, timedWork).minutes, 69);
      const plan = structuredClone(configured.servicePlan);
      assert.ok(plan?.timeEstimates);
      assert.equal(plan.timeEstimates.length, 2);
      assert.equal(plan.timeEstimates[0]?.timeStandard?.version, 3);
      assert.deepEqual(plan.timeEstimates.map(({ sourceLineId, context }) => [sourceLineId, context.saleOrderId]), [[202, 20], [20001, 1001]]);
      await sourceOwner.query('UPDATE stock_picking SET demo_service_type=$1,demo_estimated_minutes=NULL WHERE id=$2', ['collection_only', 20]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      await acceptPending(timedPicking.id);
      const refreshed = await store.get(timedPicking.id);
      assert.equal(refreshed.source.serviceType, 'collection_only');
      assert.equal(refreshed.source.estimatedMinutes, null);
      assert.deepEqual(refreshed.servicePlan, { ...plan, defaultOrigin: 'local' }, 'Explicit review retains services and rates; the old source default becomes a local decision');
      assert.equal(estimateWorkMinutes(refreshed, timedWork).minutes, 69);
      const services = lineServiceStatuses(refreshed);
      assert.equal(services.find((line) => line.sourceLineId === 202)?.service, 'delivery_only');
      assert.equal(services.find((line) => line.sourceLineId === 20001)?.service, 'installation_only');
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.deepEqual(await store.get(timedPicking.id), refreshed, 'An unchanged reimport must not update local rates, attribution or version');
    });

    await context.test('quantity changes rescale local rates and a replacement move never inherits a removed same-SKU line setting', async () => {
      const before = await store.get(timedPicking.id);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', ['3.500', 202]);
      try {
        assert.equal((await importer.run(actor)).status, 'succeeded');
        const increased = await store.get(timedPicking.id);
        assert.deepEqual(increased.servicePlan, before.servicePlan);
        assert.equal(lineWorkTimes(increased).find((line) => line.sourceLineId === 202)?.stale, false);
        assert.equal(estimateWorkMinutes(increased, [{ ...firstTimedWork, deliveryMilli: 3500 }, secondTimedWork]).minutes, 87);
      } finally {
        await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', ['2.000', 202]);
        await importer.run(actor);
      }
      await sourceOwner.query('UPDATE stock_move SET id=$1 WHERE id=$2', [20002, 20001]);
      try {
        assert.equal((await importer.run(actor)).status, 'succeeded');
        await acceptPending(timedPicking.id);
        const replaced = await store.get(timedPicking.id);
        assert.deepEqual(replaced.servicePlan, before.servicePlan, 'Removed line settings remain available for history, without reassignment');
        assert.equal(replaced.source.items.some((line) => line.sourceLineId === 20001), false);
        assert.equal(replaced.source.items.find((line) => line.sourceLineId === 20002)?.productId, 3);
        assert.equal(replaced.source.items.find((line) => line.sourceLineId === 20002)?.saleOrderId, 1001);
        assert.equal(lineServiceStatuses(replaced).find((line) => line.sourceLineId === 20002)?.service, 'delivery_installation');
        assert.equal(replaced.servicePlan?.timeEstimates?.some((line) => line.sourceLineId === 20002), false);
        assert.equal(estimateWorkMinutes(replaced, [{ sourceLineId: 20002, deliveryMilli: 1000, installationMilli: 1000, collectionMilli: 0 }]).minutes, null);
        assert.equal(estimateWorkMinutes(replaced, [{ sourceLineId: 202, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 }]).minutes, 24);
      } finally {
        await sourceOwner.query('UPDATE stock_move SET id=$1 WHERE id=$2', [20001, 20002]);
        await importer.run(actor);
        await acceptPending(timedPicking.id);
      }
    });

    await context.test('source product, order, unit and destination changes retain local rates but require review before reuse', async () => {
      const cases = [
        { name: 'product', update: 'UPDATE stock_move SET product_id=$1 WHERE id=$2', changed: 1, original: 3, id: 202 },
        { name: 'sales order', update: 'UPDATE sale_order_line SET order_id=$1 WHERE id=$2', changed: 1001, original: 20, id: 202 },
        { name: 'unit of measure', update: 'UPDATE stock_move SET product_uom=$1 WHERE id=$2', changed: 'm', original: 'unit', id: 202 },
      ];
      for (const scenario of cases) {
        const before = await store.get(timedPicking.id);
        await sourceOwner.query(scenario.update, [scenario.changed, scenario.id]);
        try {
          assert.equal((await importer.run(actor)).status, 'succeeded');
          await acceptPending(timedPicking.id);
          const changed = await store.get(timedPicking.id);
          assert.equal(changed.appointments.length, 0, 'A local rate requires source review even before the first booking');
          assert.deepEqual(changed.servicePlan, before.servicePlan, `${scenario.name}: source refresh must preserve the old estimate evidence`);
          assert.equal(lineWorkTimes(changed).find((line) => line.sourceLineId === 202)?.stale, true, scenario.name);
          assert.equal(lineWorkTimes(changed).find((line) => line.sourceLineId === 20001)?.stale, false, 'The same SKU in the other order remains independent');
          assert.equal(estimateWorkMinutes(changed, [{ sourceLineId: 202, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 }]).minutes, null, scenario.name);
          assert.equal(estimateWorkMinutes(changed, [{ sourceLineId: 20001, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }]).minutes, 45);
        } finally {
          await sourceOwner.query(scenario.update, [scenario.original, scenario.id]);
          await importer.run(actor);
          await acceptPending(timedPicking.id);
        }
      }
      const beforeAddressChange = await store.get(timedPicking.id);
      await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=$2', ['Via Test Changed Destination 8', timedPicking.source.customer.id]);
      try {
        assert.equal((await importer.run(actor)).status, 'succeeded');
        const changed = await store.get(timedPicking.id);
        assert.deepEqual(changed.servicePlan, beforeAddressChange.servicePlan);
        assert.equal(lineWorkTimes(changed).find((line) => line.sourceLineId === 202)?.stale, true);
        assert.equal(lineWorkTimes(changed).find((line) => line.sourceLineId === 20001)?.stale, true);
        assert.equal(estimateWorkMinutes(changed, timedWork).minutes, null);
      } finally {
        await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=$2', [timedPicking.source.customer.address, timedPicking.source.customer.id]);
        await sourceOwner.query('UPDATE stock_picking SET demo_service_type=$1,demo_estimated_minutes=$2 WHERE id=$3',
          [timedPicking.source.serviceType, timedPicking.source.estimatedMinutes, 20]);
        await importer.run(actor);
        await acceptPending(timedPicking.id);
      }
    });

    await context.test('reviewed visit allowances survive reimport and expose changed source destinations for review', async () => {
      const before = await store.get(timedPicking.id);
      const configured = await store.mutate(before.id, before.version, actor, 'test.configure_visit_allowances', (current) =>
        changeWorkTimeAdjustments(current, { factorPercent: 100, visitMinutes: 5, deliveryMinutes: 0, installationMinutes: 0,
          collectionMinutes: 0, sourceEstimateExcludesAdjustments: false, sourceReference: 'Isolated local observation',
          assumptions: 'Base unit times exclude five fixed minutes per visit.' }, actor, '2026-11-17T10:00:00Z'));
      const saved = structuredClone(configured.workTimeAdjustments);
      const originalMinutes = estimateWorkMinutes(before, timedWork).minutes;
      assert.equal(typeof originalMinutes, 'number');
      assert.equal(estimateWorkMinutes(configured, timedWork).minutes, (originalMinutes ?? 0) + 5);
      try {
        assert.equal((await importer.run(actor)).status, 'succeeded');
        assert.deepEqual((await store.get(before.id)).workTimeAdjustments, saved);
        await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=$2', ['Via Reviewed Site Changed 9', before.source.customer.id]);
        assert.equal((await importer.run(actor)).status, 'succeeded');
        await acceptPending(before.id);
        const changed = await store.get(before.id);
        assert.deepEqual(changed.workTimeAdjustments, saved, 'Source imports retain versioned local evidence');
        assert.equal(estimateWorkMinutes(changed, timedWork).calculation?.adjustmentStatus, 'needs_review');
        assert.equal(estimateWorkMinutes(changed, timedWork).minutes, null);
      } finally {
        await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=$2', [before.source.customer.address, before.source.customer.id]);
        await importer.run(actor);
        await acceptPending(before.id);
        const restored = await store.get(before.id);
        delete restored.workTimeAdjustments;
        await store.save(database.source.manager, restored);
      }
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
      assert.deepEqual(changed.source.salesOrders?.map((order) => order.id), [1]);
      assert.equal(changed.source.items[0]?.saleOrderId, 1);
      assert.equal(changed.sourceImport?.pending?.source?.items[0]?.saleOrderId, 1002);
      assert.equal((await sourceReview.get(first.id)).canAccept, false, 'A source refresh cannot reassign signed quantities to another order');
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
      const held = await store.get(first.id);
      assert.deepEqual(held.source, original.source, 'Protected accepted source stays intact until reviewed');
      assert.ok(held.sourceImport?.pending);
      await acceptPending(first.id);
      const updated = await store.get(first.id);
      assert.equal(updated.source.customer.address, 'DEMO Changed street');
      assert.equal(updated.source.items[0]?.quantity, 1.5);
      assert.equal(updated.instructions.notes, 'Local instructions must survive source refresh');
      assert.equal(updated.sourceImport?.pending, null);
      assert.equal(updated.sourceChanged, false);
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
      assert.equal((await store.get(first.id)).sourceImport?.eligible, false);
      await sourceOwner.query('UPDATE crm_team SET name=$1 WHERE id=$2', ['MOHD MESSINA', 1]);
      await sourceOwner.query('UPDATE sale_order SET magento_id=$1 WHERE id=$2', ['DEMO changed Magento linkage', 1]);
      await importer.run(actor);
      assert.equal((await store.get(first.id)).sourceImport?.eligible, false);
      await sourceOwner.query('UPDATE sale_order SET magento_id=NULL WHERE id=$1', [1]);
      await sourceOwner.query('UPDATE stock_picking SET state=$1 WHERE id=$2', ['done', 1]);
      await importer.run(actor);
      const changed = await store.get(first.id);
      assert.equal(changed.source.sourceState, 'assigned');
      assert.equal(changed.sourceImport?.pending?.source?.sourceState, 'done');
      assert.equal(changed.sourceImport?.eligible, false);
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
      assert.equal(partial.details.filter((detail) => detail.startsWith('Picking ')).length, 1);
      assert.match(partial.details[0] ?? '', /Picking 3: source validation failed/);
      assert.equal((await store.get(third.id)).sourceImport?.eligible, false);
      assert.ok((await store.get(third.id)).sourceImport?.pending?.reasons.includes('source_invalid'));
      assert.deepEqual((await store.get(third.id)).source, third.source);
      await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', ['unit', 31]);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.equal((await store.get(third.id)).sourceReview, false);
    });

    await context.test('confirmed prior work survives unchanged imports and never follows replaced physical identity', async () => {
      const delivery = (await store.all()).find((entry) => entry.source.pickingId === 19);
      assert.ok(delivery);
      const line = delivery.source.items[0]; assert.ok(line);
      const configured = await store.mutate(delivery.id, delivery.version, actor, 'test.confirm_prior_work', (current) => {
        const planned = changeServicePlan(current, { sourceLineId: line.sourceLineId, service: 'delivery_only' });
        return confirmPriorWork(planned, { requestId: randomUUID(), sourceLineId: line.sourceLineId,
          deliveredMilli: 500, installedMilli: 0, collectedMilli: 0, sourceReference: 'Synthetic receipt for this exact picking line',
          reason: 'Verified before using this application; previous backorders excluded', acknowledgeCurrentPicking: true }, actor, '2026-11-12T10:00:00Z');
      });
      const revisions = structuredClone(configured.priorWorkRevisions);
      const services = structuredClone(configured.servicePlan);
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.deepEqual(await store.get(delivery.id), configured, 'Repeated imports do not revise or add the opening balance');
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', ['0.250', line.sourceLineId]);
      await importer.run(actor);
      let refreshed = await store.get(delivery.id);
      assert.deepEqual(refreshed.priorWorkRevisions, revisions);
      assert.deepEqual(refreshed.servicePlan, services);
      assert.equal(priorWorkStatus(refreshed).reviewRequired, false, 'Accepted demand remains intact while a conflicting candidate waits');
      assert.equal((await sourceReview.get(delivery.id)).canAccept, false);
      assert.equal(refreshed.sourceImport?.pending?.source?.items[0]?.quantity, 0.25);
      assert.equal(lineServiceStatuses(refreshed).find(({ sourceLineId }) => sourceLineId === line.sourceLineId)?.planningBlockedReason, 'source_review');
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,product_uom=$2 WHERE id=$3', [line.quantity, 'box', line.sourceLineId]);
      await importer.run(actor);
      refreshed = await store.get(delivery.id);
      assert.deepEqual(refreshed.priorWorkRevisions, revisions);
      assert.equal(priorWorkStatus(refreshed).reviewRequired, false);
      assert.equal(refreshed.sourceImport?.pending?.source?.items[0]?.uom, 'box');
      assert.equal((await sourceReview.get(delivery.id)).canAccept, false);
      assert.equal(lineServiceStatuses(refreshed).find(({ sourceLineId }) => sourceLineId === line.sourceLineId)?.deliveredMilli, 500,
        'Accepted original units remain intact, never silently becoming completed boxes');
      await sourceOwner.query('UPDATE stock_move SET product_uom=$1 WHERE id=$2', [line.uom, line.sourceLineId]);
      await importer.run(actor);
      refreshed = await store.get(delivery.id);
      assert.equal(priorWorkStatus(refreshed).reviewRequired, false);
      assert.deepEqual(refreshed.priorWorkRevisions, revisions);
      assert.equal(lineServiceStatuses(refreshed).find(({ sourceLineId }) => sourceLineId === line.sourceLineId)?.deliveredMilli, 500);
    });

    await context.test('source revision evidence is canonical, exact to microseconds, and older exports never overwrite current quantities', async () => {
      const delivery = (await store.all()).find(({ source }) => source.pickingId === 15); assert.ok(delivery);
      const original = delivery.source.items[0]; assert.ok(original);
      const captured = await new OdooSource().snapshot((reader) => reader.readPicking(15)); assert.ok(captured.source);
      assert.equal(revisionCoverage(captured.evidence), 'complete');
      assert.equal(sourceHash(captured.source), sourceHash({ ...captured.source, items: [...captured.source.items].reverse(),
        salesOrders: [...(captured.source.salesOrders ?? [])].reverse(), customer: { ...captured.source.customer, phones: [...captured.source.customer.phones].reverse() } }));
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity + 1, '2090-01-01T00:00:00.000002Z', original.sourceLineId]);
      await importer.run(actor);
      const newer = await store.get(delivery.id);
      assert.equal(newer.source.items[0]?.quantity, original.quantity + 1);
      assert.equal(newer.sourceImport?.acceptedEvidence.rows.find(({ entity, id }) => entity === 'stock_move' && id === original.sourceLineId)?.writeDate, '2090-01-01T00:00:00.000002Z');
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity, '2090-01-01T00:00:00.000001Z', original.sourceLineId]);
      await importer.run(actor); await importer.run(actor);
      const retained = await store.get(delivery.id);
      assert.deepEqual(retained.source, newer.source);
      assert.equal(retained.sourceImport?.pending, null);
      const audit = (await store.detail(delivery.id)).history.filter(({ action }) => action === 'source.revision_rejected');
      assert.equal(audit.length, 1, 'The same rejected stale payload is audited once');
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity, '2090-01-01T00:00:00.000003Z', original.sourceLineId]);
      await importer.run(actor);
      assert.equal((await store.get(delivery.id)).source.items[0]?.quantity, original.quantity);
      await sourceOwner.query('ALTER TABLE stock_move DISABLE TRIGGER fixture_clock');
      try {
        await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', [original.quantity + 2, original.sourceLineId]);
      } finally { await sourceOwner.query('ALTER TABLE stock_move ENABLE TRIGGER fixture_clock'); }
      await importer.run(actor);
      const conflict = await store.get(delivery.id);
      assert.equal(conflict.source.items[0]?.quantity, original.quantity);
      assert.ok(conflict.sourceImport?.pending?.reasons.includes('revision_conflict'), 'Changed data at an equal source clock needs review');
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity, '2090-01-01T00:00:00.000004Z', original.sourceLineId]);
      await importer.run(actor);
    });

    await context.test('mixed linked-row revisions cannot lower the accepted revision through a newer pending candidate', async () => {
      const delivery = (await store.all()).find(({ source }) => source.pickingId === 16); assert.ok(delivery);
      const original = delivery.source.items[0]; assert.ok(original);
      await sourceOwner.query('UPDATE stock_picking SET write_date=$1 WHERE id=16', ['2090-01-01T00:00:10Z']);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity + 1, '2090-01-01T00:00:10Z', original.sourceLineId]);
      await importer.run(actor);
      const accepted = await store.get(delivery.id); assert.equal(accepted.source.items[0]?.quantity, original.quantity + 1);
      await sourceOwner.query('UPDATE stock_picking SET write_date=$1 WHERE id=16', ['2090-01-01T00:00:11Z']);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity + 2, '2090-01-01T00:00:05Z', original.sourceLineId]);
      await importer.run(actor);
      let current = await store.get(delivery.id); assert.ok(current.sourceImport?.pending);
      assert.deepEqual(current.source, accepted.source);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity + 3, '2090-01-01T00:00:06Z', original.sourceLineId]);
      await importer.run(actor);
      current = await store.get(delivery.id);
      assert.deepEqual(current.source, accepted.source, 'Being newer than a conflicting candidate cannot regress an accepted row');
      const review = await sourceReview.get(delivery.id);
      assert.equal(review.canAccept, false); assert.ok(review.blockers.some(({ code }) => code === 'SOURCE_REVISION_REGRESSION'));
      await sourceOwner.query('UPDATE stock_picking SET write_date=$1 WHERE id=16', ['2090-01-01T00:00:12Z']);
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=$1,write_date=$2 WHERE id=$3', [original.quantity, '2090-01-01T00:00:12Z', original.sourceLineId]);
      await importer.run(actor);
      assert.equal((await store.get(delivery.id)).sourceImport?.pending, null);
    });

    await context.test('an absent line in a readable copy remains accepted until explicit reconciliation', async () => {
      const delivery = (await store.all()).find(({ source }) => source.pickingId === 13); assert.ok(delivery);
      const line = delivery.source.items[0]; assert.ok(line);
      await sourceOwner.query('CREATE TEMP TABLE fixture_missing_move AS SELECT * FROM stock_move WHERE id=$1', [line.sourceLineId]);
      await sourceOwner.query('DELETE FROM stock_move WHERE id=$1', [line.sourceLineId]);
      try {
        await importer.run(actor);
        const current = await store.get(delivery.id);
        assert.deepEqual(current.source, delivery.source, 'A successful SQL scan does not prove that an upstream export is complete');
        assert.ok(current.sourceImport?.pending?.reasons.includes('line_scope_changed'));
        assert.equal(lineServiceStatuses(current)[0]?.planningBlockedReason, 'source_review');
        const pendingId = current.sourceImport?.pending?.id;
        await importer.run(actor);
        assert.equal((await store.get(delivery.id)).sourceImport?.pending?.id, pendingId, 'Repeated snapshots keep one review identity');
      } finally {
        await sourceOwner.query('INSERT INTO stock_move SELECT * FROM fixture_missing_move');
        await sourceOwner.query('DROP TABLE fixture_missing_move');
        await importer.run(actor);
      }
    });

    await context.test('a newer return to a kept candidate clears an obsolete pending proposal', async () => {
      const delivery = (await store.all()).find(({ source }) => source.pickingId === 18); assert.ok(delivery);
      const line = delivery.source.items[0]; assert.ok(line);
      await store.mutate(delivery.id, delivery.version, actor, 'test.prior_zero', (current) => confirmPriorWork(
        changeServicePlan(current, { defaultService: 'delivery_only' }), { requestId: randomUUID(), sourceLineId: line.sourceLineId,
          deliveredMilli: 0, installedMilli: 0, collectedMilli: 0, sourceReference: 'Confirmed exact fixture line',
          reason: 'Known zero before local work', acknowledgeCurrentPicking: true }, actor, '2026-11-12T12:00:00Z'));
      await sourceOwner.query('UPDATE stock_picking SET demo_notes=$1 WHERE id=18', ['Proposal B']);
      await importer.run(actor);
      const b = await sourceReview.get(delivery.id); assert.ok(b.candidate);
      await sourceReview.decide(delivery.id, { version: b.deliveryVersion, requestId: randomUUID(), candidateId: b.candidate.id,
        candidateHash: b.candidate.hash, action: 'keep_accepted', reason: 'Verified that the current accepted details remain correct' }, actor);
      await sourceOwner.query('UPDATE stock_picking SET demo_notes=$1 WHERE id=18', ['Proposal C']);
      await importer.run(actor);
      const c = await sourceReview.get(delivery.id); assert.ok(c.candidate); assert.notEqual(c.candidate.hash, b.candidate.hash);
      await sourceOwner.query('UPDATE stock_picking SET demo_notes=$1 WHERE id=18', ['Proposal B']);
      await importer.run(actor);
      const current = await sourceReview.get(delivery.id);
      assert.equal(current.candidate, null, 'The obsolete C proposal must not remain actionable after newer kept B');
      assert.equal((await store.get(delivery.id)).source.notes, delivery.source.notes);
      assert.equal((await store.get(delivery.id)).sourceChanged, false, 'Withdrawing the obsolete proposal clears its legacy change warning');
    });

    await context.test('a storage failure midway retains its committed prefix and retry does not duplicate that work', async () => {
      const seven = (await store.all()).find(({ source }) => source.pickingId === 7);
      const eight = (await store.all()).find(({ source }) => source.pickingId === 8);
      assert.ok(seven && eight); const a = seven.source.items[0]; const b = eight.source.items[0]; assert.ok(a && b);
      const countBefore = (await store.detail(seven.id)).history.filter(({ action }) => action === 'source.refreshed').length;
      await sourceOwner.query('UPDATE stock_move SET product_uom_qty=product_uom_qty+1 WHERE id=ANY($1::int[])', [[a.sourceLineId, b.sourceLineId]]);
      await database.source.query(`CREATE FUNCTION fixture_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.source_id=8 THEN RAISE EXCEPTION 'Owned fixture storage failure'; END IF; RETURN NEW; END $$`);
      await database.source.query('CREATE TRIGGER fixture_import_failure BEFORE UPDATE ON delivery FOR EACH ROW EXECUTE FUNCTION fixture_import_failure()');
      try {
        const failed = await importer.run(actor); assert.equal(failed.status, 'failed'); assert.equal(failed.processed, 7);
        assert.equal((await store.get(seven.id)).source.items[0]?.quantity, a.quantity + 1);
        assert.equal((await store.get(eight.id)).source.items[0]?.quantity, b.quantity);
      } finally {
        await database.source.query('DROP TRIGGER fixture_import_failure ON delivery');
        await database.source.query('DROP FUNCTION fixture_import_failure()');
      }
      assert.equal((await importer.run(actor)).status, 'succeeded');
      assert.equal((await store.get(eight.id)).source.items[0]?.quantity, b.quantity + 1);
      assert.equal((await store.detail(seven.id)).history.filter(({ action }) => action === 'source.refreshed').length, countBefore + 1);
      assert.equal((await store.all()).length, 20);
      const evidence = await new OdooSource().snapshot((reader) => reader.readPicking(7));
      assert.equal(compareSourceEvidence(evidence.evidence, { ...evidence.evidence, rows: [...evidence.evidence.rows].reverse() }), 'same');
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
