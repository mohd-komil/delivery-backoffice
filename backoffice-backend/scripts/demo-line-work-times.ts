import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { DeliverySchema, IdSchema } from '../src/domain/model';
import { Files } from '../src/evidence/files';
import { hashPassword } from '../src/identity/identity';
import { ImportSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';
import { RouteDraftInputSchema } from '../src/routing/contracts';
import { GeoapifyClient } from '../src/routing/geoapify-client';
import { GoogleRoads } from '../src/routing/google-maps';
import { RouteDetailSchema, RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { PublicDemoAddressesSchema } from './demo-public-addresses';

const directory = path.resolve('.local/line-work-browser-demo');
const connectionFile = path.join(directory, 'connection.json');
let phase = 'validate_runtime';
const AccountSchema = z.object({ email: z.string().email(), password: z.string().min(24).max(256) }).strict();
const ConnectionSchema = z.object({
  version: z.literal(1), appSchema: z.string().regex(/^line_work_app_[a-f0-9]{32}$/),
  sourceSchema: z.string().regex(/^line_work_source_[a-f0-9]{32}$/),
  database: z.literal('delivery_backoffice_test'), sourceDatabase: z.literal('odoo_mock'),
  api: z.literal('http://127.0.0.1:3013/api'), frontend: z.literal('http://127.0.0.1:3010'),
  createdAt: z.iso.datetime(), setupStatus: z.enum(['seeded', 'ready']), admin: AccountSchema, operator: AccountSchema,
  deliveries: z.array(z.object({ id: IdSchema, pickingId: z.number().int().positive(), pickingName: z.string(), sourceLineId: z.number().int().positive() }).strict()).max(3),
  routeId: IdSchema.nullable(),
}).strict().refine(({ appSchema, sourceSchema }) => appSchema.slice('line_work_app_'.length) === sourceSchema.slice('line_work_source_'.length),
  'The source and application schemas must belong to the same demo');
type Connection = z.infer<typeof ConnectionSchema>;
const DetailSchema = z.object({ delivery: DeliverySchema });
const ActorSchema = z.object({ id: IdSchema, name: z.string(), role: z.enum(['admin', 'operator']) });

class LineWorkDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

class LineWorkFiles extends Files {
  override readonly directory = path.join(directory, 'files');
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function saveConnection(connection: Connection) {
  await writeFile(connectionFile, JSON.stringify(ConnectionSchema.parse(connection), null, 2), { mode: 0o600 });
}

/** All source writes are fixture setup inside a newly created schema of the local odoo_mock database. */
async function seedSource(source: DataSource, schema: string) {
  const ddl = await readFile('local/source-schema.sql', 'utf8');
  const sharedGrant = 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO odoo_reader;';
  if (ddl.split(sharedGrant).length !== 2) throw new Error('The source fixture DDL changed; review its scoped grants');
  await source.query(ddl.replace(sharedGrant, `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO odoo_reader;`));
  const raw: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const addresses = PublicDemoAddressesSchema.parse(raw).filter(({ city }) => city === 'Catania').slice(0, 3);
  assert.equal(addresses.length, 3);
  await source.transaction(async (manager) => {
    await manager.query("INSERT INTO stock_picking_type(id,code) VALUES(1,'outgoing')");
    await manager.query("INSERT INTO stock_location(id,name) VALUES(1,'Customer')");
    await manager.query("INSERT INTO crm_team(id,name) VALUES(1,'MOHD CATANIA')");
    await manager.query("INSERT INTO product_template(id,name,description) VALUES(94001,'DEMO Oak chair · CHAIR-DEMO-01','Same synthetic SKU across three distinct sales orders')");
    await manager.query("INSERT INTO product_product(id,product_tmpl_id,default_code) VALUES(94001,94001,'CHAIR-DEMO-01')");
    const quantities = [2, 3, 1];
    const names = ['Giulia Rizzo', 'Davide Russo', 'Elena Marino'];
    for (const [index, address] of addresses.entries()) {
      const quantity = quantities[index]; const name = names[index];
      assert.ok(quantity); assert.ok(name);
      const pickingId = 91001 + index; const orderId = 92001 + index; const sourceLineId = 93001 + index;
      await manager.query('INSERT INTO res_partner(id,name,street,city,country_code,phone,contact_name) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [address.customerId, `DEMO ${name}`, address.street, address.city, 'IT', '+39 000 000 1111', 'Fictional customer at a public building reference']);
      await manager.query('INSERT INTO sale_order(id,name,magento_id,partner_id) VALUES($1,$2,NULL,$3)', [orderId, `DEMO/LINE-TIMES/SO/${index + 1}`, address.customerId]);
      await manager.query(`INSERT INTO stock_picking(id,name,state,picking_type_id,location_dest_id,team_id,sale_id,partner_id,demo_service_type,demo_estimated_minutes,demo_notes)
        VALUES($1,$2,'assigned',1,1,1,$3,$4,NULL,NULL,$5)`,
      [pickingId, `DEMO/LINE-TIMES/${index + 1}`, orderId, address.customerId, 'Isolated teaching source; service and work duration must be set locally in Backoffice.']);
      await manager.query(`INSERT INTO sale_order_line(id,order_id,product_id,name,product_uom_qty,product_uom)
        VALUES($1,$2,94001,'DEMO Oak chair · CHAIR-DEMO-01',$3,'unit')`, [sourceLineId, orderId, quantity]);
      await manager.query(`INSERT INTO stock_move(id,picking_id,sale_line_id,product_id,name,product_uom_qty,product_uom)
        VALUES($1,$2,$1,94001,'DEMO Oak chair · CHAIR-DEMO-01',$3,'unit')`, [sourceLineId, pickingId, quantity]);
    }
    await manager.query(`GRANT USAGE ON SCHEMA "${schema}" TO odoo_reader`);
    await manager.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO odoo_reader`);
  });
  return addresses;
}

async function main() {
  const environment = config();
  if (environment.BACKOFFICE_RUNTIME !== 'docker' || environment.PORT !== 3001 || environment.BACKOFFICE_TEST !== '1'
    || process.env['NODE_ENV'] === 'production' || environment.ODOO_SOURCE_MODE !== 'mock'
    || environment.FRONTEND_ORIGIN !== 'http://127.0.0.1:3010') {
    throw new Error('Use the isolated Docker test runtime, API container port 3001 and frontend origin 3010');
  }
  if (process.argv.slice(2).some((argument) => argument !== '--resume')) throw new Error('Only --resume is supported');
  const resume = process.argv.includes('--resume');
  if (!resume && await exists(connectionFile)) throw new Error('A demo connection already exists; use --resume without reseeding');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const suffix = randomUUID().replaceAll('-', '');
  const parsed: unknown = resume ? JSON.parse(await readFile(connectionFile, 'utf8')) : null;
  let connection: Connection = resume ? ConnectionSchema.parse(parsed) : {
    version: 1, appSchema: `line_work_app_${suffix}`, sourceSchema: `line_work_source_${suffix}`,
    database: 'delivery_backoffice_test', sourceDatabase: 'odoo_mock', api: 'http://127.0.0.1:3013/api', frontend: 'http://127.0.0.1:3010',
    createdAt: new Date().toISOString(), setupStatus: 'seeded',
    admin: { email: 'admin@line-work-demo.example.test', password: randomBytes(24).toString('base64url') },
    operator: { email: 'francesca@line-work-demo.example.test', password: randomBytes(24).toString('base64url') }, deliveries: [], routeId: null,
  };
  connection = ConnectionSchema.parse(connection);
  const sourceUrl = new URL(environment.ODOO_DATABASE_URL);
  if (sourceUrl.username !== 'odoo_reader' || sourceUrl.pathname !== '/odoo_mock' || sourceUrl.search !== '') throw new Error('Use the ordinary isolated mock reader connection');
  if (!resume) {
    sourceUrl.username = 'odoo_seed';
    sourceUrl.password = z.string().regex(/^[0-9a-f]{48}$/).parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  }
  const sourceControl = new DataSource({ type: 'postgres', url: sourceUrl.toString(), entities: [], synchronize: false, logging: false });
  const source = new DataSource({ type: 'postgres', url: sourceUrl.toString(), schema: connection.sourceSchema, entities: [], synchronize: false, logging: false,
    extra: { options: `-c search_path=${connection.sourceSchema}` } });
  const control = makeDataSource(true);
  const database = new LineWorkDatabase(connection.appSchema);
  let app: NestExpressApplication | undefined;
  let retained = false;
  try {
    phase = 'verify_databases';
    await control.initialize(); await sourceControl.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test'), port: z.literal(55432) }),
      'SELECT current_database() AS name,inet_server_port() AS port')).length, 1);
    assert.equal((await rows(sourceControl.manager, z.object({ name: z.literal('odoo_mock'), port: z.literal(55432) }),
      'SELECT current_database() AS name,inet_server_port() AS port')).length, 1);
    if (resume) {
      for (const [manager, schema] of [[control.manager, connection.appSchema], [sourceControl.manager, connection.sourceSchema]] as const) {
        const found = await rows(manager, z.object({ name: z.string() }), 'SELECT nspname AS name FROM pg_namespace WHERE nspname=$1', [schema]);
        if (found.length !== 1) throw new Error('A saved demo schema is missing; no replacement or seed was created');
      }
    } else {
      phase = 'create_owned_schemas';
      await control.query(`CREATE SCHEMA "${connection.appSchema}"`);
      await sourceControl.query(`CREATE SCHEMA "${connection.sourceSchema}"`);
    }
    await source.initialize();
    assert.equal((await rows(source.manager, z.object({ name: z.literal(connection.sourceSchema) }), 'SELECT current_schema() AS name')).length, 1);
    phase = 'source_fixture';
    const addresses = resume ? [] : await seedSource(source, connection.sourceSchema);
    phase = 'application_fixture';
    await database.source.initialize();
    if (!resume) {
      await database.source.runMigrations({ transaction: 'all' });
      for (const [role, account] of [['admin', connection.admin], ['operator', connection.operator]] as const) {
        await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), account.email, role === 'admin' ? 'DEMO Admin' : 'DEMO Francesca', role, await hashPassword(account.password)]);
      }
      await saveConnection(connection);
    }
    await database.source.destroy();
    const readerUrl = new URL(environment.ODOO_DATABASE_URL);
    readerUrl.searchParams.set('options', `-c search_path=${connection.sourceSchema}`);
    process.env['ODOO_DATABASE_URL'] = readerUrl.toString();
    phase = 'start_server';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database)
      .overrideProvider(Files).useFactory({ factory: (store: DeliveryStore) => new LineWorkFiles(store), inject: [DeliveryStore] })
      .overrideProvider(GeoapifyClient).useValue(new GeoapifyClient({ settings: null }))
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({ settings: null })).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(environment.PORT, environment.HOST);
    const base = 'http://127.0.0.1:3001/api';
    let cookie = '';
    async function request<T>(endpoint: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(base + endpoint, { method, headers: { Origin: environment.FRONTEND_ORIGIN, 'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Demo ${method} ${endpoint} returned HTTP ${response.status}`);
      if (endpoint === '/auth/login') { const session = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(session); cookie = session; }
      const raw: unknown = await response.json(); return schema.parse(raw);
    }
    if (!resume) {
      phase = 'authenticated_import';
      const principal = await request('/auth/login', ActorSchema, 'POST', connection.operator);
      const firstImport = await request('/imports', ImportSchema, 'POST', {});
      assert.equal(firstImport.status, 'succeeded'); assert.equal(firstImport.processed, 3);
      const store = app.get(DeliveryStore);
      const deliveries = await store.all(); assert.equal(deliveries.length, 3);
      phase = 'local_services_and_rates';
      const services = ['delivery_installation', 'delivery_only', 'collection_only'] as const;
      const rates = [
        { deliveryMinutesPerUnit: 10, installationMinutesPerUnit: 20, collectionMinutesPerUnit: null },
        { deliveryMinutesPerUnit: 15, installationMinutesPerUnit: null, collectionMinutesPerUnit: null },
        { deliveryMinutesPerUnit: null, installationMinutesPerUnit: null, collectionMinutesPerUnit: 25 },
      ];
      for (const [index, imported] of deliveries.entries()) {
        const address = addresses[index]; const service = services[index]; const rate = rates[index]; const item = imported.source.items[0];
        assert.ok(address); assert.ok(service); assert.ok(rate); assert.ok(item);
        assert.equal(imported.source.serviceType, null); assert.equal(imported.source.estimatedMinutes, null);
        assert.equal(imported.source.customer.address, address.street);
        let detail = await request(`/deliveries/${imported.id}/services`, DetailSchema, 'PATCH', { version: imported.version, defaultService: service });
        detail = await request(`/deliveries/${imported.id}/work-times`, DetailSchema, 'PATCH', { version: detail.delivery.version, sourceLineId: item.sourceLineId, ...rate });
        await store.mutate(imported.id, detail.delivery.version, principal, { name: 'demo.public_address_reference_added', details: () => ({
          synthetic: true, accuracy: address.accuracy, addressSource: address.addressSource, coordinateSource: address.coordinateSource,
          checkedAt: address.checkedAt, entranceConfirmed: false,
        }) }, (delivery) => ({ ...delivery, routePoint: address.point,
          addressGeography: { addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: delivery.source.customer.id,
            province: address.province, postalCode: address.postalCode, source: 'synthetic_fixture' } }));
      }
      const before = await store.all();
      phase = 'verify_repeat_import';
      const repeated = await request('/imports', ImportSchema, 'POST', {});
      assert.equal(repeated.status, 'succeeded'); assert.deepEqual(await store.all(), before);
      const first = before[0]; const firstRate = rates[0]; assert.ok(first); assert.ok(firstRate);
      phase = 'verify_nearby';
      const jobs = await request(`/routes/jobs?anchorId=${first.id}&radiusKm=5`, RouteJobsSchema);
      assert.equal(jobs.anchorHasCoordinates, true); assert.equal(jobs.jobs.length, 2); assert.ok(jobs.anchorJob);
      const byId = new Map([jobs.anchorJob, ...jobs.jobs].map((job) => [job.deliveryId, job]));
      assert.deepEqual(before.map((delivery) => byId.get(delivery.id)?.suggestedWorkMinutes), [60, 45, 25]);
      const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(8, 0, 0, 0);
      const input = RouteDraftInputSchema.parse({ name: 'DEMO · Local line services and time · 130 min', departAt: day.toISOString(),
        crewId: null, vehicleId: null, startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', manualEstimates: [], useLocalEstimates: true,
        stops: before.map((delivery) => { const job = byId.get(delivery.id); assert.ok(job); return { deliveryId: delivery.id,
          workMinutes: job.suggestedWorkMinutes, workDurationSource: 'remaining_estimate', workFingerprint: job.workFingerprint, customerWindow: { kind: 'unrestricted' } }; }),
      });
      const saved = await request('/routes', RouteDetailSchema, 'POST', { ...input, requestId: randomUUID() });
      phase = 'verify_route_timing';
      assert.equal(saved.timeline.workMinutes, 130); assert.ok(saved.timeline.returnAt);
      assert.ok(saved.timeline.stops.every((stop) => stop.travelSource === 'local_demo'));
      const firstLine = first.source.items[0]; assert.ok(firstLine);
      phase = 'verify_rate_change_and_restore';
      let current = await request(`/deliveries/${first.id}`, DetailSchema);
      current = await request(`/deliveries/${first.id}/work-times`, DetailSchema, 'PATCH', { version: current.delivery.version,
        sourceLineId: firstLine.sourceLineId, ...firstRate, installationMinutesPerUnit: 25 });
      const changed = await request('/routes/preview', RoutePreviewSchema, 'POST', input);
      assert.equal(changed.timeline.workMinutes, 140);
      assert.ok(changed.feasibility.findings.some(({ code }) => code === 'work_changed_or_unreviewed'));
      assert.ok(changed.timeline.returnAt); assert.equal(Date.parse(changed.timeline.returnAt) - Date.parse(saved.timeline.returnAt), 600_000);
      await request(`/deliveries/${first.id}/work-times`, DetailSchema, 'PATCH', { version: current.delivery.version, sourceLineId: firstLine.sourceLineId, ...firstRate });
      const refreshedJobs = await request('/routes/jobs', RouteJobsSchema);
      const freshById = new Map(refreshedJobs.jobs.map((job) => [job.deliveryId, job]));
      const refreshedInput = { ...input, stops: input.stops.map((stop) => { const job = freshById.get(stop.deliveryId); assert.ok(job);
        return { ...stop, workMinutes: job.suggestedWorkMinutes, workFingerprint: job.workFingerprint }; }) };
      const restored = await request(`/routes/${saved.id}`, RouteDetailSchema, 'PATCH', { ...refreshedInput, version: saved.version });
      assert.equal(restored.timeline.workMinutes, 130); assert.equal(restored.timeline.returnAt, saved.timeline.returnAt);
      connection = { ...connection, setupStatus: 'ready', routeId: saved.id, deliveries: before.map((delivery) => {
        const line = delivery.source.items[0]; assert.ok(line);
        return { id: delivery.id, pickingId: delivery.source.pickingId, pickingName: delivery.source.pickingName, sourceLineId: line.sourceLineId };
      }) };
      await saveConnection(connection);
      phase = 'persist_verification';
      const result = { verifiedAt: new Date().toISOString(), api: connection.api, frontend: connection.frontend,
        deliveries: connection.deliveries, routeId: saved.id, imported: 3, sourceServiceAndDuration: null, repeatImportPreservedLocalData: true,
        nearbyRadiusKm: 5, nearbyCountIncludingAnchor: 3, workMinutes: [60, 45, 25], totalWorkMinutes: 130,
        changedRateWorkMinutes: 140, changedReturnMinutes: 10, restoredWorkMinutes: restored.timeline.workMinutes,
        timeline: restored.timeline, feasibility: restored.feasibility.status,
        notes: ['Fictional customers at verified public building references; unloading entrances are not confirmed.',
          'Travel uses local approximations, not road routing. Teams, vehicles and working hours remain explicitly unassigned.'] };
      await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
      await request('/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
    }
    retained = true;
    const server = app;
    const close = () => { void server.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    console.log(JSON.stringify({ ready: true, resumed: resume, setupStatus: connection.setupStatus, api: connection.api, frontend: connection.frontend,
      routeId: connection.routeId, credentialsFile: '.local/line-work-browser-demo/connection.json', resultFile: '.local/line-work-browser-demo/result.json' }));
  } finally {
    if (source.isInitialized) await source.destroy();
    if (sourceControl.isInitialized) await sourceControl.destroy();
    if (control.isInitialized) await control.destroy();
    if (!retained) { if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy(); }
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  // Driver errors can include connection details; never print arbitrary exceptions or credentials.
  console.error(error instanceof z.ZodError ? 'Line-work demo validation failed; inspect the owned fixture schemas.'
    : 'Line-work demo setup failed; existing data and owned schemas were retained for inspection.');
  console.error(`Demo phase: ${phase}`);
  process.exitCode = 1;
});
