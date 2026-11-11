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
import { createDelivery, DeliverySchema, type Delivery } from '../src/domain/model';
import { hashPassword } from '../src/identity/identity';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { DeliveryMapSchema } from '../src/routing/delivery-map';
import { GoogleRoads } from '../src/routing/google-maps';

class MapDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

function fixture(index: number): Delivery {
  const delivery = createDelivery({
    pickingId: index, pickingName: `MAP/DEMO/${index}`, saleOrderId: index, saleOrderName: `MAP/SO/${index}`,
    sourceState: 'assigned', salesTeam: 'DEMO',
    customer: { id: index, name: `DEMO Map ${index}`, address: index === 15 ? null : `Via DEMO ${index}`,
      city: index <= 13 ? 'Catania' : 'Messina', country: 'IT', phones: ['+3900000000'], email: null, contact: null },
    items: [{ sourceLineId: index, productId: 1, name: 'DEMO Chair', description: null, quantity: 1, uom: 'unit',
      configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: null, estimatedMinutes: null, notes: 'Private operational details do not belong in map markers',
  }, randomUUID());
  delivery.addressGeography = {
    addressKey: destinationAddressKey(delivery.source.customer), sourceCustomerId: index,
    province: index <= 13 ? 'CT' : 'ME', postalCode: index <= 13 ? '95121' : '09810', source: 'synthetic_fixture',
  };
  if (index !== 13 && index !== 14) delivery.routePoint = index <= 2
    ? { latitude: 37.5079, longitude: 15.083 }
    : { latitude: 37.508 + index * 0.001, longitude: 15.083 };
  if (index === 17) delivery.appointments.push({ id: randomUUID(), startsAt: '2031-05-01T08:00:00Z',
    endsAt: '2031-05-01T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
    assignments: [], results: [] });
  return delivery;
}

void test('Inbox map returns every filtered job with scoped entrance coordinates and real HTTP authorization', async (context) => {
  const schema = `delivery_map_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^delivery_map_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new MapDatabase(schema);
  const password = randomBytes(24).toString('base64url');
  const deliveries = Array.from({ length: 17 }, (_, index) => fixture(index + 1));
  const confirmedPoint = { latitude: 38.2, longitude: 15.6 };
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let cookie = '';
  let googleCalls = 0;

  async function request(route: string, status = 200, session = cookie) {
    const response = await fetch(`${base}/api${route}`, { headers: { Origin: config().FRONTEND_ORIGIN, Cookie: session } });
    const raw: unknown = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(raw)}`);
    if (status === 200) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    return raw;
  }
  async function map(query = '') { return DeliveryMapSchema.parse(await request('/deliveries/map' + query)); }

  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }),
      'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    for (const delivery of deliveries) await database.source.query(
      'INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, schema, delivery.source.pickingId, delivery.version, JSON.stringify(delivery)]);
    for (const index of [13, 14, 16]) {
      const delivery = deliveries[index - 1];
      assert.ok(delivery);
      await database.source.query(`INSERT INTO destination_entrance
        (source_instance,source_customer_id,address_key,latitude,longitude,version,confirmed_by_id,confirmed_by_name)
        VALUES($1,$2,$3,$4,$5,1,$6,$7)`, [
        index === 14 ? 'unrelated_source' : schema, delivery.source.customer.id,
        index === 13 ? '0'.repeat(64) : destinationAddressKey(delivery.source.customer),
        confirmedPoint.latitude, confirmedPoint.longitude, randomUUID(), 'DEMO confirmation',
      ]);
    }
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'map-operator@example.test', 'DEMO Map Operator', 'operator', await hashPassword(password)]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database).useValue(database)
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({
        settings: { browserKey: 'test-browser-key', routesKey: 'test-server-key' },
        compute: () => { googleCalls++; throw new Error('Map markers must not call Google'); },
      })).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: {
      Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ email: 'map-operator@example.test', password }) });
    assert.equal(login.status, 201);
    const session = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session);
    cookie = session;

    await context.test('all Inbox matches span list pages and overlapping points keep separate identities', async () => {
      const result = await map();
      assert.deepEqual([result.total, result.mappedCount, result.missingCount], [16, 13, 3]);
      assert.equal(result.markers.length + result.missingCoordinates.length, result.total);
      const first = result.markers.find(({ pickingName }) => pickingName === 'MAP/DEMO/1');
      const second = result.markers.find(({ pickingName }) => pickingName === 'MAP/DEMO/2');
      assert.ok(first && second);
      assert.notEqual(first.deliveryId, second.deliveryId);
      assert.deepEqual(first.point, second.point);
      assert.equal(first.pointSource, 'reference');
      assert.ok(result.markers.some(({ pickingName }) => pickingName === 'MAP/DEMO/12'));
      assert.ok(!result.markers.some(({ pickingName }) => pickingName === 'MAP/DEMO/17'));
      assert.equal(JSON.stringify(result).includes('Private operational details'), false);
      assert.equal(JSON.stringify(result).includes('test-server-key'), false);
    });

    await context.test('current confirmed entrances override references and old or foreign entrances are ignored', async () => {
      const result = await map();
      const confirmed = result.markers.find(({ pickingName }) => pickingName === 'MAP/DEMO/16');
      assert.deepEqual(confirmed?.point, confirmedPoint);
      assert.equal(confirmed?.pointSource, 'confirmed_entrance');
      assert.deepEqual(result.missingCoordinates.map(({ pickingName }) => pickingName), ['MAP/DEMO/13', 'MAP/DEMO/14', 'MAP/DEMO/15']);
      assert.equal(result.missingCoordinates.at(-1)?.address, null);
      assert.deepEqual(result.missingCoordinates[0]?.geography,
        { city: 'Catania', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' });
    });

    await context.test('map and paged list share exact geographic, missing and text filters', async () => {
      for (const query of ['', '&city=catania', '&province=CT&postalCode=95121', '&postalCode=09810',
        '&city=Messina&province=CT', '&cityMissing=true', '&search=DEMO%2F12']) {
        const result = await map('?view=inbox' + query);
        const first = DeliveryListSchema.parse(await request('/deliveries?view=inbox' + query));
        const second = DeliveryListSchema.parse(await request('/deliveries?view=inbox&page=2' + query));
        assert.equal(result.total, first.total);
        const expected = [...first.items, ...second.items].map(({ id }) => id).sort();
        const actual = [...result.markers, ...result.missingCoordinates].map(({ deliveryId }) => deliveryId).sort();
        assert.deepEqual(actual, expected);
      }
      assert.equal((await map('?city=catania')).total, 13);
      assert.equal((await map('?postalCode=9810')).total, 0);
    });

    await context.test('area filtering precedes pagination and shares current effective points, facets and missing counts', async () => {
      const world = '&north=90&south=-90&east=180&west=-180';
      const global = await map('?view=inbox' + world);
      assert.deepEqual([global.total, global.mappedCount, global.missingCount], [13, 13, 0]);
      assert.equal(global.area?.excludedMissingCoordinates, 3);
      const area = '&north=37.6&south=37&east=15.2&west=15';
      const local = await map('?view=inbox' + area);
      assert.equal(local.total, 12);
      assert.ok(!local.markers.some(({ pickingName }) => pickingName === 'MAP/DEMO/16'), 'Confirmed entrance overrides reference inside the area');
      const first = DeliveryListSchema.parse(await request('/deliveries?view=inbox' + area));
      const second = DeliveryListSchema.parse(await request('/deliveries?view=inbox&page=2' + area));
      assert.deepEqual([first.total, first.items.length, second.items.length], [12, 10, 2]);
      assert.deepEqual(first.area, local.area);
      assert.deepEqual([...first.items, ...second.items].map(({ id }) => id).sort(), local.markers.map(({ deliveryId }) => deliveryId).sort());
      assert.deepEqual(first.geographyFacets.cities, [{ value: 'Catania', count: 12 }]);
      assert.deepEqual(first.matchingGeographyFacets, first.geographyFacets);
      assert.deepEqual(first.counts, DeliveryListSchema.parse(await request('/deliveries?view=inbox')).counts);
      const city = await map('?city=Catania' + area);
      assert.equal(city.total, 12);
      assert.equal(city.area?.excludedMissingCoordinates, 1);
      const missingOnly = await map('?city=Catania&search=DEMO%2F13' + area);
      assert.equal(missingOnly.total, 0);
      assert.equal(missingOnly.area?.excludedMissingCoordinates, 1);
      const confirmed = await map('?north=38.3&south=38.1&east=15.7&west=15.5');
      assert.deepEqual(confirmed.markers.map(({ pickingName }) => pickingName), ['MAP/DEMO/16']);
      const boundary = await map('?north=37.508&south=37.5079&east=15.083&west=15.08');
      assert.deepEqual(boundary.markers.map(({ pickingName }) => pickingName), ['MAP/DEMO/1', 'MAP/DEMO/2']);
      assert.equal((await map()).area, null);
    });

    await context.test('authentication and query bounds apply without writes or external calls', async () => {
      await request('/deliveries/map', 401, '');
      await request('/deliveries/map', 401, 'crew_session=not-a-backoffice-session');
      for (const query of ['view=planned', 'page=1', 'unknown=1', 'city=Catania&cityMissing=true',
        'postalCodeMissing=false', 'province=' + 'a'.repeat(101)]) await request('/deliveries/map?' + query, 400);
      for (const query of ['north=50', 'north=&south=37&east=16&west=15', 'north=NaN&south=37&east=16&west=15',
        'north=91&south=37&east=16&west=15', 'north=40&south=40&east=16&west=15',
        'north=40&south=37&east=-170&west=170', 'north=40&south=37&east=181&west=15']) {
        await request('/deliveries/map?' + query, 400);
        await request('/deliveries?view=inbox&' + query, 400);
      }
      await request('/deliveries?view=planned&north=40&south=37&east=16&west=15', 400);
      await request('/deliveries?north=40&south=37&east=16&west=15', 400);
      assert.equal(googleCalls, 0);
      const after = await rows(database.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery ORDER BY source_id');
      assert.deepEqual(after.map(({ data }) => data), deliveries);
      const [audit] = await rows(database.source.manager, z.object({ count: z.number() }), 'SELECT count(*)::integer AS count FROM audit');
      assert.equal(audit?.count, 0);
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
