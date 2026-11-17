import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { hashPassword } from '../src/identity/identity';
import { ImportSchema } from '../src/operations/contracts';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { DeliveryStore } from '../src/operations/store';
import { GeoapifyClient, type GeoapifyLookupResult } from '../src/routing/geoapify-client';

class ImportGeocodingDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}` } });
  }
}

function accepted(): GeoapifyLookupResult {
  return { status: 'accepted', reason: null, candidate: { point: { latitude: 38.188, longitude: 15.554 },
    formattedAddress: 'Synthetic import test address', precision: 'building', confidence: 1, matchType: 'full_match',
    attribution: 'Powered by Geoapify · © OpenStreetMap contributors' } };
}

void test('automatic import geocoding uses real guards, released source locks and a persistent scoped cache', async (context) => {
  const suffix = randomUUID().replaceAll('-', '');
  const appSchema = `import_geo_app_${suffix}`;
  const sourceSchema = `import_geo_source_${suffix}`;
  assert.match(appSchema, /^import_geo_app_[0-9a-f]{32}$/);
  assert.match(sourceSchema, /^import_geo_source_[0-9a-f]{32}$/);
  const environment = config();
  assert.equal(environment.ODOO_SOURCE_MODE, 'mock', 'Importer fixtures must never mutate an external Odoo source');
  const previousSourceUrl = process.env['ODOO_DATABASE_URL'];
  const PasswordSchema = z.string().length(48).regex(/^[0-9a-f]{48}$/);
  let sourceOwnerPassword: string;
  if (environment.BACKOFFICE_RUNTIME === 'docker') {
    sourceOwnerPassword = PasswordSchema.parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  } else {
    const raw: unknown = JSON.parse(await readFile('.local/postgres-credentials.json', 'utf8'));
    sourceOwnerPassword = z.object({ sourceOwner: PasswordSchema }).parse(raw).sourceOwner;
  }
  const ownerUrl = new URL(environment.ODOO_DATABASE_URL);
  ownerUrl.username = 'odoo_seed';
  ownerUrl.password = sourceOwnerPassword;
  const appAdmin = makeDataSource(true);
  const sourceAdmin = new DataSource({ type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false });
  const sourceOwner = new DataSource({ type: 'postgres', url: ownerUrl.toString(), schema: sourceSchema, entities: [],
    synchronize: false, logging: false, extra: { options: `-c search_path=${sourceSchema}` } });
  const database = new ImportGeocodingDatabase(appSchema);
  const store = new DeliveryStore(database);
  const points = new DeliveryPoints(store);
  const password = randomBytes(24).toString('base64url');
  let appCreated = false;
  let sourceCreated = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let cookie = '';
  let crewCookie = '';
  let calls = 0;
  let lookup = () => Promise.resolve(accepted());
  const observed: { sourceLocks: number; importUnlocked: boolean; runningImports: number }[] = [];
  const submittedAddresses: (string | null)[] = [];
  const provider: Pick<GeoapifyClient, 'getSettings' | 'lookup'> = {
    getSettings: () => Promise.resolve({ configured: true, dailyLimit: 100 }),
    lookup: async (address) => {
      calls++;
      submittedAddresses.push(address.address);
      // Observe real PostgreSQL locks at the network boundary instead of mocking the importer.
      const [sourceLocks] = await rows(sourceAdmin.manager, z.object({ count: z.number().int() }), `
        SELECT count(*)::integer AS count FROM pg_locks l
        JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND l.locktype='relation' AND l.pid<>pg_backend_pid()`, [sourceSchema]);
      const runner = database.source.createQueryRunner();
      await runner.connect();
      let importUnlocked = false;
      try {
        const [lock] = await rows(runner.manager, z.object({ locked: z.boolean() }), 'SELECT pg_try_advisory_lock(7041002) AS locked');
        importUnlocked = lock?.locked === true;
      } finally {
        if (importUnlocked) await runner.query('SELECT pg_advisory_unlock(7041002)');
        await runner.release();
      }
      const [running] = await rows(database.source.manager, z.object({ count: z.number().int() }),
        "SELECT count(*)::integer AS count FROM import_run WHERE status='running' OR finished_at IS NULL");
      assert.ok(sourceLocks);
      assert.ok(running);
      observed.push({ sourceLocks: sourceLocks.count, importUnlocked, runningImports: running.count });
      return lookup();
    },
  };

  async function request(path: string, method = 'GET', body?: unknown, session = cookie, origin: string = config().FRONTEND_ORIGIN) {
    const response = await fetch(base + '/api' + path, { method,
      headers: { Origin: origin, Cookie: session, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw: unknown = await response.json();
    return { response, raw };
  }
  async function runImport() {
    const result = await request('/imports', 'POST', {});
    assert.equal(result.response.status, 201, JSON.stringify(result.raw));
    return ImportSchema.parse(result.raw);
  }
  async function deliverySnapshots() {
    return rows(database.source.manager, z.object({ id: z.string(), data: z.string() }), 'SELECT id,data::text AS data FROM delivery ORDER BY id');
  }

  try {
    await appAdmin.initialize();
    await sourceAdmin.initialize();
    assert.equal((await rows(appAdmin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    assert.equal((await rows(sourceAdmin.manager, z.object({ name: z.literal('odoo_mock') }), 'SELECT current_database() AS name')).length, 1);
    await appAdmin.query(`CREATE SCHEMA "${appSchema}"`);
    appCreated = true;
    await sourceAdmin.query(`CREATE SCHEMA "${sourceSchema}"`);
    sourceCreated = true;
    await sourceOwner.initialize();
    assert.equal((await rows(sourceOwner.manager, z.object({ name: z.literal(sourceSchema) }), 'SELECT current_schema() AS name')).length, 1);
    await sourceOwner.query(await readFile('local/source-schema.sql', 'utf8'));
    await sourceOwner.query(await readFile('local/source-seed.sql', 'utf8'));
    // This owned fixture supplies an actual address revision; absent clocks are separately tested as unverified.
    await sourceOwner.query('ALTER TABLE res_partner ADD COLUMN write_date timestamptz NOT NULL DEFAULT now()');
    await sourceOwner.query(`CREATE FUNCTION fixture_address_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      NEW.write_date=clock_timestamp(); RETURN NEW; END $$`);
    await sourceOwner.query('CREATE TRIGGER fixture_address_clock BEFORE UPDATE ON res_partner FOR EACH ROW EXECUTE FUNCTION fixture_address_clock()');
    await sourceOwner.query(`GRANT USAGE ON SCHEMA "${sourceSchema}" TO odoo_reader`);
    await sourceOwner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sourceSchema}" TO odoo_reader`);
    // Four pickings, two recipients, one exact address; all other source streets remain synthetic placeholders.
    await sourceOwner.query("UPDATE res_partner SET street='Via Test 19',city='Messina' WHERE id IN (1,2)");
    await sourceOwner.query('UPDATE stock_picking SET demo_service_type=NULL,demo_estimated_minutes=NULL WHERE partner_id IN (1,2)');
    const readerUrl = new URL(environment.ODOO_DATABASE_URL);
    readerUrl.searchParams.set('options', `-c search_path=${sourceSchema}`);
    process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    const passwordHash = await hashPassword(password);
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'import-geo-operator@example.test', 'Import Geocoding Operator', 'operator', passwordHash]);
    await database.source.query('INSERT INTO person(id,first_name,last_name,external,enabled,login,password_hash) VALUES($1,$2,$3,false,true,$4,$5)',
      [randomUUID(), 'Test', 'Participant', 'import-geo-crew@example.test', passwordHash]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database).useValue(database).overrideProvider(GeoapifyClient).useValue(provider).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await request('/auth/login', 'POST', { email: 'import-geo-operator@example.test', password });
    assert.equal(login.response.status, 201);
    const session = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session); cookie = session;
    const crewLogin = await request('/crew/auth/login', 'POST', { login: 'import-geo-crew@example.test', password }, '', config().CREW_FRONTEND_ORIGIN);
    assert.equal(crewLogin.response.status, 201);
    const participantSession = crewLogin.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(participantSession); crewCookie = participantSession;

    await context.test('anonymous, Crew and invalid-origin callers cannot import or spend provider quota', async () => {
      assert.equal((await request('/imports', 'POST', {}, '')).response.status, 401);
      assert.equal((await request('/imports', 'POST', {}, crewCookie)).response.status, 401);
      assert.equal((await request('/imports', 'POST', {}, cookie, 'https://untrusted.example.test')).response.status, 403);
      assert.equal((await store.all()).length, 0);
      assert.equal(calls, 0);
    });

    await context.test('completed import geocodes one shared valid address after releasing both locks and skips placeholders', async () => {
      const imported = await runImport();
      assert.equal(imported.status, 'succeeded');
      assert.equal(imported.error, null);
      assert.equal(imported.processed, 20);
      assert.equal(calls, 1);
      assert.deepEqual(submittedAddresses, ['Via Test 19']);
      assert.deepEqual(observed, [{ sourceLocks: 0, importUnlocked: true, runningImports: 0 }]);
      assert.ok(imported.details.some((detail) => detail.includes('1 accepted') && detail.includes('16 invalid/placeholder')));
      const deliveries = await store.all();
      assert.equal(deliveries.length, 20);
      const effective = await points.effectiveFor(deliveries);
      assert.equal(effective.size, 4);
      for (const delivery of deliveries) {
        assert.equal(delivery.version, 1, 'Geocoding must not rewrite imported delivery JSON');
        assert.equal(delivery.routePoint, undefined);
        if (effective.has(delivery.id)) assert.equal(delivery.source.serviceType, null, 'Unknown service does not prevent mapping');
      }
    });

    await context.test('unchanged repeat imports reuse persisted coordinates without lookup or snapshot changes', async () => {
      const before = await deliverySnapshots();
      const imported = await runImport();
      assert.equal(imported.status, 'succeeded');
      assert.equal(calls, 1);
      assert.deepEqual(await deliverySnapshots(), before);
      assert.ok(imported.details.some((detail) => detail.includes('4 already mapped')));
      const [audit] = await rows(database.source.manager, z.object({ count: z.number().int() }),
        "SELECT count(*)::integer AS count FROM audit WHERE action='import.geocoding'");
      assert.equal(audit?.count, 2);
    });

    await context.test('provider outage is reported separately and backoff preserves successful source imports', async () => {
      await sourceOwner.query("UPDATE res_partner SET street='Via Failure 33' WHERE id=3");
      lookup = () => Promise.reject(new Error('Synthetic provider outage'));
      const imported = await runImport();
      assert.equal(imported.status, 'succeeded');
      assert.equal(imported.error, null);
      assert.equal(imported.processed, 20);
      assert.equal(calls, 2);
      assert.ok(imported.details.some((detail) => detail.includes('1 failed') && detail.includes('provider_unavailable')));
      const repeat = await runImport();
      assert.equal(repeat.status, 'succeeded');
      assert.equal(calls, 2, 'A repeated import must respect the provider failure backoff');
      assert.equal((await store.all()).filter((delivery) => delivery.source.customer.address === 'Via Failure 33').length, 2);
    });

    await context.test('partial imports geocode valid new destinations and retain invalid records for source review', async () => {
      lookup = () => Promise.resolve(accepted());
      await sourceOwner.query("UPDATE res_partner SET street='Via Partial 44' WHERE id=4");
      await sourceOwner.query("UPDATE stock_move SET product_uom='' WHERE id=41");
      const imported = await runImport();
      assert.equal(imported.status, 'partial');
      assert.equal(imported.processed, 19);
      assert.equal(calls, 3);
      assert.equal(submittedAddresses.at(-1), 'Via Partial 44');
      const deliveries = await store.all();
      const invalid = deliveries.find((delivery) => delivery.source.pickingId === 4);
      const valid = deliveries.find((delivery) => delivery.source.pickingId === 16);
      assert.ok(invalid); assert.ok(valid);
      assert.equal(invalid.sourceImport?.eligible, false);
      assert.ok(invalid.sourceImport?.pending?.reasons.includes('source_invalid'));
      const effective = await points.effectiveFor(deliveries);
      assert.equal(effective.has(invalid.id), false);
      assert.equal(effective.has(valid.id), true);
      assert.ok(imported.details.some((detail) => detail.includes('1 source review')));
    });

    await context.test('a failed source scan never starts provider calls for unrefreshed local snapshots', async () => {
      await sourceOwner.query('ALTER TABLE stock_picking RENAME TO stock_picking_unavailable');
      try {
        const imported = await runImport();
        assert.equal(imported.status, 'failed');
        assert.equal(calls, 3);
        assert.equal(imported.details.some((detail) => detail.startsWith('Geocoding:')), false);
      } finally {
        await sourceOwner.query('ALTER TABLE stock_picking_unavailable RENAME TO stock_picking');
      }
      assert.equal(observed.length, 3);
      for (const boundary of observed) assert.deepEqual(boundary, { sourceLocks: 0, importUnlocked: true, runningImports: 0 });
    });
  } finally {
    if (previousSourceUrl === undefined) delete process.env['ODOO_DATABASE_URL'];
    else process.env['ODOO_DATABASE_URL'] = previousSourceUrl;
    if (app) await app.close();
    await database.onModuleDestroy();
    if (sourceOwner.isInitialized) await sourceOwner.destroy();
    // Exact generated schemas only; neither the shared app data nor the source fixture schema is reset.
    if (appCreated) await appAdmin.query(`DROP SCHEMA "${appSchema}" CASCADE`);
    if (sourceCreated) await sourceAdmin.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
    if (appAdmin.isInitialized) await appAdmin.destroy();
    if (sourceAdmin.isInitialized) await sourceAdmin.destroy();
  }
});
