import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, type Delivery } from '../src/domain/model';
import { hashPassword } from '../src/identity/identity';
import { DeliveryStore } from '../src/operations/store';
import { GeoapifyClient, type GeoapifyLookupResult } from '../src/routing/geoapify-client';
import { GeocodingResponseSchema } from '../src/routing/geocoding';

class GeocodingDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

function fixture(index: number): Delivery {
  return createDelivery({
    pickingId: index, pickingName: `GEOCODING/OUT/${index}`, saleOrderId: index, saleOrderName: `GEOCODING/SO/${index}`,
    sourceState: 'assigned', salesTeam: 'Synthetic geocoding fixture',
    customer: { id: index, name: `Test customer ${index}`, address: `Via Test ${index}`, city: 'Messina',
      province: 'ME', postalCode: '98123', country: 'IT', phones: [], email: null, contact: null },
    items: [{ sourceLineId: index, productId: 1, name: 'Test chair', sku: 'SHARED-SKU', description: null,
      quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: 'delivery', estimatedMinutes: 30, notes: null,
  }, randomUUID());
}

function accepted(): GeoapifyLookupResult {
  return { status: 'accepted', reason: null, candidate: { point: { latitude: 38.188, longitude: 15.554 },
    formattedAddress: 'Synthetic test address', precision: 'building', confidence: 1, matchType: 'full_match',
    attribution: 'Powered by Geoapify · © OpenStreetMap contributors' } };
}

function deferredLookup() {
  let enter: (() => void) | undefined;
  let release: ((value: GeoapifyLookupResult) => void) | undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const result = new Promise<GeoapifyLookupResult>((resolve) => { release = resolve; });
  return { async entered() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered, new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('The synthetic provider was not called within five seconds')), 5000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  },
    resolve(value: GeoapifyLookupResult) { assert.ok(release); release(value); },
    lookup: () => { assert.ok(enter); enter(); return result; } };
}

void test('Address geocoding keeps real guards, scoped PostgreSQL cache, quota and stale-address protection', async (context) => {
  const schema = `geocoding_http_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^geocoding_http_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new GeocodingDatabase(schema);
  const store = new DeliveryStore(database);
  const password = randomBytes(24).toString('base64url');
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let cookie = '';
  let crewCookie = '';
  let calls = 0;
  let dailyLimit = 100;
  let lookup = () => Promise.resolve(accepted());
  const provider: Pick<GeoapifyClient, 'getSettings' | 'lookup'> = {
    getSettings: () => Promise.resolve({ configured: true, dailyLimit }),
    lookup: () => { calls++; return lookup(); },
  };

  async function insert(index: number, address?: string, sourceInstance = schema) {
    const delivery = fixture(index);
    if (address !== undefined) delivery.source.customer.address = address;
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, sourceInstance, index, delivery.version, JSON.stringify(delivery)]);
    return delivery;
  }

  function path(delivery: Delivery) { return `/deliveries/${delivery.id}/geocoding`; }
  function input(delivery: Delivery) { return { deliveryVersion: delivery.version, addressKey: destinationAddressKey(delivery.source.customer) }; }
  async function request(route: string, method = 'GET', body?: unknown, session = cookie, origin: string = config().FRONTEND_ORIGIN) {
    const response = await fetch(base + '/api' + route, { method,
      headers: { Origin: origin, Cookie: session, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw: unknown = await response.json();
    return { response, raw };
  }
  async function expectStatus(route: string, status: number, method = 'GET', body?: unknown, session = cookie, origin: string = config().FRONTEND_ORIGIN) {
    const result = await request(route, method, body, session, origin);
    assert.equal(result.response.status, status, `${method} ${route}: ${JSON.stringify(result.raw)}`);
    return result.raw;
  }
  async function locate(delivery: Delivery) {
    return GeocodingResponseSchema.parse(await expectStatus(path(delivery), 200, 'POST', input(delivery)));
  }
  async function read(delivery: Delivery) {
    return GeocodingResponseSchema.parse(await expectStatus(path(delivery), 200));
  }
  async function allowNextRequest() {
    await database.source.query("UPDATE geocoding_budget SET next_request_at=now()-interval '2 seconds'");
  }
  async function snapshots() {
    return rows(database.source.manager, z.object({ id: z.string(), data: z.string() }), 'SELECT id,data::text AS data FROM delivery ORDER BY id');
  }

  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    const passwordHash = await hashPassword(password);
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'geocoding-operator@example.test', 'Geocoding Operator', 'operator', passwordHash]);
    await database.source.query('INSERT INTO person(id,first_name,last_name,external,enabled,login,password_hash) VALUES($1,$2,$3,false,true,$4,$5)',
      [randomUUID(), 'Test', 'Participant', 'geocoding-crew@example.test', passwordHash]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database).useValue(database).overrideProvider(GeoapifyClient).useValue(provider).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await request('/auth/login', 'POST', { email: 'geocoding-operator@example.test', password });
    assert.equal(login.response.status, 201);
    const session = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session); cookie = session;
    const crewLogin = await request('/crew/auth/login', 'POST', { login: 'geocoding-crew@example.test', password }, '', config().CREW_FRONTEND_ORIGIN);
    assert.equal(crewLogin.response.status, 201);
    const participantSession = crewLogin.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(participantSession); crewCookie = participantSession;

    await context.test('anonymous, crew and invalid-origin requests cannot spend quota or accept points', async () => {
      const delivery = await insert(1);
      await expectStatus(path(delivery), 401, 'GET', undefined, '');
      await expectStatus(path(delivery), 401, 'POST', input(delivery), '');
      await expectStatus(path(delivery), 401, 'POST', input(delivery), crewCookie);
      await expectStatus(path(delivery), 403, 'POST', input(delivery), cookie, config().CREW_FRONTEND_ORIGIN);
      await expectStatus(`${path(delivery)}/accept`, 401, 'POST', { ...input(delivery), recordVersion: 1 }, '');
      await expectStatus(`${path(delivery)}/accept`, 403, 'POST', { ...input(delivery), recordVersion: 1 }, cookie, 'https://untrusted.example.test');
      await expectStatus(path(delivery), 400, 'POST', { ...input(delivery), address: 'Untrusted supplied address' });
      await expectStatus(path(delivery), 409, 'POST', { ...input(delivery), deliveryVersion: 99 });
      await expectStatus(`/deliveries/${randomUUID()}/geocoding`, 404);
      assert.equal(calls, 0);
    });

    await context.test('GET, refresh and placeholder addresses never call a provider or change delivery data', async () => {
      const delivery = await insert(2);
      const placeholder = await insert(3, 'Street example 3');
      const before = await snapshots();
      for (let repeat = 0; repeat < 3; repeat++) assert.equal((await read(delivery)).status, 'not_requested');
      assert.equal((await locate(placeholder)).status, 'invalid_address');
      assert.equal(calls, 0);
      assert.deepEqual(await snapshots(), before);
    });

    await context.test('an accepted exact-address cache survives repeats and shares only within its source instance', async () => {
      const delivery = await insert(4);
      const sibling = await insert(5, delivery.source.customer.address ?? undefined);
      const otherSource = await insert(6, delivery.source.customer.address ?? undefined, `${schema}_other`);
      const before = await snapshots();
      assert.equal((await locate(delivery)).status, 'accepted');
      assert.equal(calls, 1);
      assert.equal((await read(sibling)).status, 'accepted');
      assert.equal((await locate(sibling)).status, 'accepted');
      assert.equal((await locate(delivery)).status, 'accepted');
      assert.equal(calls, 1);
      assert.equal((await read(otherSource)).status, 'not_requested');
      await allowNextRequest();
      assert.equal((await locate(otherSource)).status, 'accepted');
      assert.equal(calls, 2);
      const records = await rows(database.source.manager, z.object({ count: z.number() }), 'SELECT count(*)::integer AS count FROM address_geocoding');
      assert.equal(records[0]?.count, 2);
      assert.deepEqual(await snapshots(), before, 'A geocoding cache must not rewrite the source snapshot or operational delivery JSON');
    });

    await context.test('approximate candidates require an explicit current operator acceptance', async () => {
      const delivery = await insert(7);
      const before = await snapshots();
      lookup = () => Promise.resolve({ ...accepted(), status: 'review_required', reason: 'approximate_result' });
      await allowNextRequest();
      const candidate = await locate(delivery);
      assert.equal(candidate.status, 'review_required');
      assert.equal(candidate.acceptance, null);
      assert.ok(candidate.recordVersion);
      const beforeCalls = calls;
      assert.equal((await locate(delivery)).status, 'review_required');
      assert.equal(calls, beforeCalls);
      await expectStatus(`${path(delivery)}/accept`, 409, 'POST', { ...input(delivery), recordVersion: candidate.recordVersion + 1 });
      await expectStatus(`${path(delivery)}/accept`, 409, 'POST', { ...input(delivery), addressKey: '0'.repeat(64), recordVersion: candidate.recordVersion });
      const saved = GeocodingResponseSchema.parse(await expectStatus(`${path(delivery)}/accept`, 200, 'POST', { ...input(delivery), recordVersion: candidate.recordVersion }));
      assert.equal(saved.status, 'accepted');
      assert.equal(saved.acceptance, 'operator');
      assert.deepEqual(saved.candidate, candidate.candidate);
      const retry = GeocodingResponseSchema.parse(await expectStatus(`${path(delivery)}/accept`, 200, 'POST', { ...input(delivery), recordVersion: candidate.recordVersion }));
      assert.deepEqual(retry, saved, 'A repeated acceptance cannot create another version or audit event');
      const audit = await rows(database.source.manager, z.object({ count: z.number() }),
        "SELECT count(*)::integer AS count FROM audit WHERE delivery_id=$1 AND action='address_geocoding.accepted'", [delivery.id]);
      assert.equal(audit[0]?.count, 1);
      assert.equal(calls, beforeCalls);
      assert.deepEqual(await snapshots(), before);
      lookup = () => Promise.resolve(accepted());
    });

    await context.test('provider pacing and daily quota are persisted, with a fresh UTC-day allowance', async () => {
      const delivery = await insert(8);
      const beforeCalls = calls;
      await database.source.query("UPDATE geocoding_budget SET next_request_at=now()+interval '10 seconds'");
      assert.equal((await locate(delivery)).status, 'rate_limited');
      assert.equal(calls, beforeCalls);
      dailyLimit = 2;
      await database.source.query("UPDATE geocoding_budget SET used=2,next_request_at=now()-interval '2 seconds'");
      const exhausted = await locate(delivery);
      assert.equal(exhausted.status, 'quota_exceeded');
      assert.ok(exhausted.retryAt);
      assert.equal(calls, beforeCalls);
      await database.source.query("UPDATE geocoding_budget SET budget_day=(now() AT TIME ZONE 'UTC')::date-1,used=2900");
      assert.equal((await locate(delivery)).status, 'accepted');
      assert.equal(calls, beforeCalls + 1);
      const budget = await rows(database.source.manager, z.object({ used: z.number(), today: z.boolean() }),
        "SELECT used,budget_day=(now() AT TIME ZONE 'UTC')::date AS today FROM geocoding_budget");
      assert.deepEqual(budget, [{ used: 1, today: true }]);
      dailyLimit = 100;
    });

    await context.test('concurrent duplicate requests share one pending lookup without holding a database lock during HTTP', async () => {
      const delivery = await insert(9);
      const gate = deferredLookup(); lookup = gate.lookup;
      await allowNextRequest();
      const beforeCalls = calls;
      const first = locate(delivery);
      try {
        await gate.entered();
        assert.equal((await read(delivery)).status, 'pending');
        assert.equal((await locate(delivery)).status, 'pending');
        assert.equal(calls, beforeCalls + 1);
      } finally { gate.resolve(accepted()); }
      assert.equal((await first).status, 'accepted');
      assert.equal(calls, beforeCalls + 1);
      lookup = () => Promise.resolve(accepted());
    });

    await context.test('CAP or province changes during lookup reject the old result and cannot contaminate the new address', async () => {
      for (const [index, change] of [{ postalCode: '98122' }, { province: 'CT' }].entries()) {
        const delivery = await insert(10 + index);
        const gate = deferredLookup(); lookup = gate.lookup;
        await allowNextRequest();
        const pending = request(path(delivery), 'POST', input(delivery));
        const changed = structuredClone(delivery);
        changed.version++;
        changed.source.customer = { ...changed.source.customer, ...change };
        try {
          await gate.entered();
          await database.source.transaction(async (manager) => {
            await manager.query('SELECT pg_advisory_xact_lock(7041001)');
            await store.save(manager, changed);
          });
        } finally { gate.resolve(accepted()); }
        assert.equal((await pending).response.status, 409);
        assert.notEqual(input(changed).addressKey, input(delivery).addressKey);
        assert.equal((await read(changed)).status, 'not_requested');
        const previous = await rows(database.source.manager, z.object({ status: z.string(), reason: z.string(), candidate: z.null() }),
          'SELECT status,reason,candidate FROM address_geocoding WHERE source_instance=$1 AND address_key=$2', [schema, input(delivery).addressKey]);
        assert.deepEqual(previous, [{ status: 'failed', reason: 'address_changed', candidate: null }]);
        assert.deepEqual(await store.get(changed.id), changed);
      }
      lookup = () => Promise.resolve(accepted());
    });
  } finally {
    try {
      if (app) await app.close();
      if (database.source.isInitialized) await database.source.destroy();
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      if (control.isInitialized) await control.destroy();
    }
  }
});
