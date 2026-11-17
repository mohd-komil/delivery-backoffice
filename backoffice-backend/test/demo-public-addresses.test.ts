import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { PublicDemoAddressesSchema, seedPublicDemoDestinations, updatePublicDemoSource } from '../scripts/demo-public-addresses';
import { config } from '../src/config';
import { Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { type Appointment, type CrewActor, type OperatorActor } from '../src/domain/model';
import { changeServicePlan, confirmCustomerVisit, instantiateTask, planVisitWork, recordExecution, startVisit } from '../src/domain/rules';
import { Importer } from '../src/integration/importer';
import { ImportGeocoding } from '../src/integration/import-geocoding';
import { AddressGeocoding } from '../src/routing/geocoding';
import { GeoapifyClient } from '../src/routing/geoapify-client';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { DeliveryStore } from '../src/operations/store';
import { DestinationEntrances } from '../src/routing/entrances';
import { SourceReview } from '../src/integration/source-review';

// Test-owned addresses only. The executable reads the separately verified public venue manifest.
const fixtures = PublicDemoAddressesSchema.parse(Array.from({ length: 11 }, (_, index) => {
  const customerId = index + 1;
  const messina = customerId % 2 === 0;
  return {
    customerId, venue: `Test public venue ${customerId}`, street: `Piazza Test ${customerId}`,
    city: messina ? 'Messina' : 'Catania', province: messina ? 'ME' : 'CT', postalCode: messina ? '98122' : '95124',
    point: { latitude: messina ? 38.1938 : 37.5079, longitude: 15.08 + customerId / 1000 },
    addressSource: `https://example.test/venue/${customerId}`, coordinateSource: `https://example.test/map/${customerId}`,
    checkedAt: '2026-11-09', accuracy: 'building_reference',
  };
}));

void test('public demo manifest rejects duplicate identities, city/province mismatches and non-HTTPS provenance', () => {
  const first = fixtures[0];
  assert.ok(first);
  assert.equal(PublicDemoAddressesSchema.safeParse([first, ...fixtures.slice(0, 10)]).success, false);
  assert.equal(PublicDemoAddressesSchema.safeParse(fixtures.map((fixture) => ({ ...fixture, province: 'ME' }))).success, false);
  assert.equal(PublicDemoAddressesSchema.safeParse(fixtures.map((fixture) => ({ ...fixture, addressSource: 'http://example.test' }))).success, false);
});

void test('public fixture updates use isolated PostgreSQL, normal import, retain operations and protect dispatcher references on repeat', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const appSchema = `public_addresses_app_${suffix}`;
  const sourceSchema = `public_addresses_source_${suffix}`;
  assert.match(appSchema, /^public_addresses_app_[0-9a-f]{32}$/);
  assert.match(sourceSchema, /^public_addresses_source_[0-9a-f]{32}$/);
  const environment = config();
  const originalSourceUrl = environment.ODOO_DATABASE_URL;
  const originalTest = process.env['BACKOFFICE_TEST'];
  const originalMode = process.env['NODE_ENV'];
  const PasswordSchema = z.string().length(48).regex(/^[0-9a-f]{48}$/);
  let sourceOwnerPassword: string;
  if (environment.BACKOFFICE_RUNTIME === 'docker') {
    sourceOwnerPassword = PasswordSchema.parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  } else {
    const credentials: unknown = JSON.parse(await readFile('.local/postgres-credentials.json', 'utf8'));
    sourceOwnerPassword = z.object({ sourceOwner: PasswordSchema }).parse(credentials).sourceOwner;
  }
  const ownerUrl = new URL(originalSourceUrl);
  ownerUrl.username = 'odoo_seed';
  ownerUrl.password = sourceOwnerPassword;
  const sourceAdmin = new DataSource({ type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false });
  const sourceOwner = new DataSource({ type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false,
    schema: sourceSchema, extra: { options: `-c search_path=${sourceSchema}` } });
  const readerUrl = new URL(originalSourceUrl);
  readerUrl.searchParams.set('options', `-c search_path=${sourceSchema}`);
  const sourceReader = new DataSource({ type: 'postgres', url: readerUrl.toString(), entities: [], synchronize: false, logging: false });
  process.env['BACKOFFICE_TEST'] = '1';
  const database = new Database();
  database.source.setOptions({ schema: appSchema, extra: { options: `-c search_path=${appSchema}` } });
  const appAdmin = makeDataSource(true);
  let sourceCreated = false;
  let appCreated = false;
  try {
    await appAdmin.initialize();
    await sourceAdmin.initialize();
    const appTarget = await rows(appAdmin.manager, z.object({ name: z.literal('delivery_backoffice_test'), port: z.literal(55432) }),
      'SELECT current_database() AS name, inet_server_port() AS port');
    const sourceTarget = await rows(sourceAdmin.manager, z.object({ name: z.literal('odoo_mock'), port: z.literal(55432) }),
      'SELECT current_database() AS name, inet_server_port() AS port');
    assert.equal(appTarget.length, 1);
    assert.equal(sourceTarget.length, 1);
    await appAdmin.query(`CREATE SCHEMA "${appSchema}"`);
    appCreated = true;
    await sourceAdmin.query(`CREATE SCHEMA "${sourceSchema}"`);
    sourceCreated = true;
    await sourceOwner.initialize();
    const isolated = await rows(sourceOwner.manager, z.object({ schema: z.literal(sourceSchema) }), 'SELECT current_schema() AS schema');
    assert.equal(isolated.length, 1);
    await sourceOwner.query(await readFile('local/source-schema.sql', 'utf8'));
    await sourceOwner.query(await readFile('local/source-seed.sql', 'utf8'));
    await sourceOwner.query(`GRANT USAGE ON SCHEMA "${sourceSchema}" TO odoo_reader`);
    await sourceOwner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sourceSchema}" TO odoo_reader`);
    await sourceReader.initialize();
    process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
    await database.onModuleInit();
    await database.source.runMigrations({ transaction: 'all' });
    const store = new DeliveryStore(database);
    const importer = new Importer(database, store, new ImportGeocoding(store, new DeliveryPoints(store),
      new AddressGeocoding(store, new GeoapifyClient({ settings: null }))));
    const principal: OperatorActor = { id: randomUUID(), name: 'DEMO public-address test operator', role: 'operator' };
    for (const customerId of [7, 8]) {
      const fixture = fixtures.find((entry) => entry.customerId === customerId);
      assert.ok(fixture);
      await sourceOwner.query('UPDATE res_partner SET street=$2 WHERE id=$1', [customerId, fixture.street]);
    }
    assert.equal((await importer.run(principal)).status, 'succeeded');
    const initial = await store.all();
    const first = initial.find((delivery) => delivery.source.pickingId === 1);
    const dispatcherEdited = initial.find((delivery) => delivery.source.pickingId === 7);
    const confirmed = initial.find((delivery) => delivery.source.pickingId === 8);
    assert.ok(first && dispatcherEdited && confirmed);
    const crew: CrewActor = { kind: 'crew', id: randomUUID(), name: 'DEMO responsible participant' };
    const appointment: Appointment = {
      id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T10:00:00Z', status: 'booked',
      cancellationReason: null, returnRequestId: null, results: [],
      assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO assigned crew',
        people: [{ id: crew.id, name: crew.name, external: false }], tasks: [instantiateTask({
          id: randomUUID(), version: 1, title: 'DEMO inspect goods', severity: 'high', order: 0,
          checklist: ['Inspect goods'], enabled: true,
        })] }],
    };
    const worked = await store.mutate(first.id, first.version, principal, 'test.public_address_execution', (current) => {
      const delivery = changeServicePlan(current, { defaultService: 'delivery_only' });
      delivery.instructions.notes = 'Keep dispatcher instructions and all result history';
      appointment.workScope = planVisitWork(delivery, [
        { sourceLineId: 11, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0 },
        { sourceLineId: 12, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 },
      ], principal, '2026-11-03T07:00:00Z');
      delivery.appointments.push(appointment);
      delivery.routePoint = { latitude: 37.5, longitude: 15.1 };
      delivery.addressGeography = { addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: 1,
        province: 'CT', postalCode: '95121', source: 'synthetic_fixture' };
      return recordExecution(startVisit(confirmCustomerVisit(delivery, appointment.id, principal, '2026-11-03T07:00:00Z'), appointment.id, crew), {
        id: randomUUID(), appointmentId: appointment.id, actualStart: '2026-11-03T08:10:00Z', actualEnd: '2026-11-03T09:00:00Z',
        summary: 'Partial result remains in its original history', responsiblePersonId: crew.id, supersedesResultId: null, correctionReason: null,
        quantities: [{ sourceLineId: 11, deliveredMilli: 500 }, { sourceLineId: 12, deliveredMilli: 1000 }],
        completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))), evidence: [],
        customerSignature: { status: 'signed', signerName: 'DEMO Customer', text: 'DEMO signature', at: '2026-11-03T09:00:00Z' },
        crewSignature: { status: 'signed', signerName: crew.name, text: 'DEMO signature', at: '2026-11-03T09:00:00Z' },
      }, crew, '2026-11-03T10:00:00Z');
    });
    const preserved = await store.mutate(dispatcherEdited.id, dispatcherEdited.version, principal, 'test.public_address_dispatcher_reference', (delivery) => {
      delivery.routePoint = { latitude: 37.51, longitude: 15.09 };
      delivery.addressGeography = { addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: 7,
        province: 'CT', postalCode: '95100', source: 'synthetic_fixture' };
      return delivery;
    });
    for (const delivery of [first, confirmed]) {
      await database.source.query(`INSERT INTO destination_entrance
        (source_instance,source_customer_id,address_key,latitude,longitude,version,confirmed_by_id,confirmed_by_name)
        VALUES('odoo_mock',$1,$2,37.51,15.09,1,$3,$4)`,
      [delivery.source.customer.id, destinationAddressKey(delivery.source.customer), principal.id, principal.name]);
    }
    const entrancesBefore: unknown = await database.source.query('SELECT * FROM destination_entrance ORDER BY source_customer_id');
    const unrelated = { ...initial[0], id: randomUUID() };
    assert.ok(initial[0]);
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,$3,$4::jsonb)',
      [unrelated.id, 'unrelated_source', initial[0].version, JSON.stringify(unrelated)]);
    // These are deliberately user-edited fixtures; no automatic source patch may overwrite them.
    await sourceOwner.query('UPDATE res_partner SET street=$1 WHERE id=3', ['Dispatcher-selected different street']);
    await sourceOwner.query('UPDATE res_partner SET name=$1 WHERE id=4', ['Different customer']);
    await sourceOwner.query('UPDATE res_partner SET city=$1 WHERE id=5', ['Different city']);
    await sourceOwner.query('UPDATE res_partner SET country_code=$1 WHERE id=6', ['FR']);
    const sourceBefore: unknown = await sourceOwner.query('SELECT * FROM res_partner ORDER BY id');
    const readerPrivileges = await rows(sourceReader.manager, z.object({ canRead: z.literal(true), canWrite: z.literal(false) }),
      `SELECT has_table_privilege(current_user,'res_partner','SELECT') AS "canRead", has_table_privilege(current_user,'res_partner','UPDATE') AS "canWrite"`);
    assert.equal(readerPrivileges.length, 1);
    await assert.rejects(sourceReader.query('UPDATE res_partner SET street=$1 WHERE id=1', ['Not authorized']), /read-only transaction|permission denied/);
    await assert.rejects(updatePublicDemoSource(sourceReader, fixtures), /fixture-owner connection/);
    await assert.rejects(updatePublicDemoSource(sourceOwner, fixtures.slice(1)), z.ZodError);
    assert.deepEqual(await sourceOwner.query('SELECT * FROM res_partner ORDER BY id'), sourceBefore);
    const runs = await Promise.all([updatePublicDemoSource(sourceOwner, fixtures), updatePublicDemoSource(sourceOwner, fixtures)]);
    assert.deepEqual(runs.map((run) => run.updated.length).sort((a, b) => a - b), [0, 5]);
    assert.ok(runs.every((run) => [3, 4, 5, 6].every((id) => run.skipped.some((skip) => skip.customerId === id && skip.reason === 'fixture_changed'))));
    const sourceAfter = await rows(sourceOwner.manager, z.object({ id: z.number(), street: z.string().nullable(), name: z.string(), city: z.string().nullable(), country: z.string().nullable() }),
      'SELECT id,street,name,city,country_code AS country FROM res_partner ORDER BY id');
    assert.equal(sourceAfter.find((partner) => partner.id === 12)?.street, null);
    assert.equal(sourceAfter.find((partner) => partner.id === 3)?.street, 'Dispatcher-selected different street');
    assert.equal((await importer.run(principal)).status, 'succeeded');
    assert.deepEqual((await store.get(first.id)).source, worked.source, 'Even fixture addresses remain pending when historical work is protected');
    const reviews = new SourceReview(store);
    for (const delivery of await store.all()) {
      const review = await reviews.get(delivery.id);
      if (!review.candidate) continue;
      assert.equal(review.canAccept, true, JSON.stringify(review.blockers));
      await reviews.decide(delivery.id, { version: review.deliveryVersion, requestId: randomUUID(), candidateId: review.candidate.id,
        candidateHash: review.candidate.hash, action: 'accept', reason: 'Dispatcher explicitly verified the replacement demo address against its public fixture manifest' }, principal);
    }
    const imported = await store.get(first.id);
    assert.equal(imported.source.customer.address, fixtures[0]?.street);
    assert.deepEqual(imported.appointments, worked.appointments);
    assert.deepEqual(imported.instructions, worked.instructions);
    assert.equal(imported.sourceReview, false);
    assert.equal(imported.sourceChanged, false);
    assert.equal(imported.sourceImport?.pending, null);
    assert.equal(imported.routePoint, undefined);
    assert.equal(imported.addressGeography, undefined);
    assert.deepEqual(await store.get(dispatcherEdited.id), preserved);
    const references = await Promise.all([seedPublicDemoDestinations(store, principal, fixtures), seedPublicDemoDestinations(store, principal, fixtures)]);
    assert.deepEqual(references.map((run) => run.updated.length).sort((a, b) => a - b), [0, 10]);
    const refreshed = await store.get(first.id);
    assert.deepEqual(refreshed.routePoint, fixtures[0]?.point);
    assert.equal(refreshed.addressGeography?.addressKey, destinationAddressKey(refreshed.source.customer));
    assert.equal(refreshed.addressGeography?.source, 'synthetic_fixture');
    assert.deepEqual(refreshed.appointments, worked.appointments);
    assert.equal(refreshed.sourceChanged, false);
    assert.deepEqual(await store.get(dispatcherEdited.id), preserved);
    assert.equal((await store.get(confirmed.id)).routePoint, undefined, 'A confirmed new-address entrance is preserved without adding a competing point');
    assert.ok((await store.get(confirmed.id)).addressGeography);
    assert.deepEqual(await database.source.query('SELECT * FROM destination_entrance ORDER BY source_customer_id'), entrancesBefore);
    const entrances = new DestinationEntrances(store, new DeliveryPoints(store));
    assert.equal((await entrances.get(first.id)).entrance, null, 'The old address entrance cannot be silently reused');
    assert.equal((await entrances.get(first.id)).stale, true);
    assert.deepEqual((await entrances.get(confirmed.id)).entrance?.point, { latitude: 37.51, longitude: 15.09 });
    assert.deepEqual(await store.get(unrelated.id), unrelated);
    const audits = await rows(database.source.manager, z.object({ details: z.object({
      synthetic: z.literal(true), accuracy: z.literal('building_reference'), entranceConfirmed: z.literal(false),
      addressSource: z.string().url(), coordinateSource: z.string().url(), checkedAt: z.literal('2026-11-09'),
    }) }), 'SELECT details FROM audit WHERE action=$1', ['demo.public_address_reference_added']);
    assert.equal(audits.length, 10);
    const stable = await store.all();
    assert.equal((await updatePublicDemoSource(sourceOwner, fixtures)).updated.length, 0);
    assert.equal((await importer.run(principal)).status, 'succeeded');
    assert.equal((await seedPublicDemoDestinations(store, principal, fixtures)).updated.length, 0);
    assert.deepEqual(await store.all(), stable);
    process.env['NODE_ENV'] = 'production';
    await assert.rejects(updatePublicDemoSource(sourceOwner, fixtures), /cannot run in production mode/);
    await assert.rejects(seedPublicDemoDestinations(store, principal, fixtures), /cannot run in production mode/);
    assert.deepEqual(await store.all(), stable);
  } finally {
    process.env['ODOO_DATABASE_URL'] = originalSourceUrl;
    if (originalTest === undefined) delete process.env['BACKOFFICE_TEST'];
    else process.env['BACKOFFICE_TEST'] = originalTest;
    if (originalMode === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalMode;
    try {
      await database.onModuleDestroy();
      if (sourceReader.isInitialized) await sourceReader.destroy();
      if (sourceOwner.isInitialized) await sourceOwner.destroy();
      // Only these generated and verified test-owned schemas are removed.
      if (appCreated) await appAdmin.query(`DROP SCHEMA "${appSchema}" CASCADE`);
      if (sourceCreated) await sourceAdmin.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
    } finally {
      if (appAdmin.isInitialized) await appAdmin.destroy();
      if (sourceAdmin.isInitialized) await sourceAdmin.destroy();
    }
  }
});
