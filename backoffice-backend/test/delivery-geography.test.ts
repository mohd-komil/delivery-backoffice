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
import { deliveryGeography } from '../src/domain/delivery-geography';
import { createDelivery, DeliverySchema, type Delivery } from '../src/domain/model';
import { hashPassword } from '../src/identity/identity';
import { DeliveryListSchema } from '../src/operations/delivery-list';

class GeographyDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

function fixture(index: number): Delivery {
  const city = index === 20 ? 'Palermo' : index === 21 ? 'Ragusa' : index <= 12 ? (index === 2 ? ' catania ' : 'Catania')
    : index <= 14 || index >= 18 ? 'Messina' : index === 15 ? null : index === 16 ? '__missing__' : 'Milano';
  const delivery = createDelivery({
    pickingId: index, pickingName: `GEOGRAPHY/JOB${index}`, saleOrderId: index, saleOrderName: `GEOGRAPHY/SO${index}`,
    sourceState: 'assigned', salesTeam: 'DEMO',
    customer: { id: index, name: `DEMO Geography ${index}`, address: `Via DEMO ${index}`, city, country: 'IT',
      phones: [], email: null, contact: null },
    items: [{ sourceLineId: index, productId: 1, name: 'DEMO Chair', description: null, quantity: 1, uom: 'unit',
      configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: null, estimatedMinutes: null, notes: null,
  }, randomUUID());
  if (index <= 14 || index === 17 || index >= 19) delivery.addressGeography = {
    addressKey: index === 19 ? '0'.repeat(64) : destinationAddressKey(delivery.source.customer), sourceCustomerId: index,
    province: index === 20 ? 'PA' : index === 21 ? 'RG' : index <= 12 ? 'CT' : index === 17 ? 'MI' : 'ME',
    postalCode: index >= 20 ? '00010' : index <= 6 ? '95121' : index <= 12 ? '95125' : index === 13 ? '09810' : index === 14 ? '98122' : '00100',
    source: 'synthetic_fixture',
  };
  if (index === 17) delivery.appointments.push({ id: randomUUID(), startsAt: '2031-05-01T08:00:00Z',
    endsAt: '2031-05-01T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
    assignments: [], results: [] });
  return delivery;
}

void test('resolved geography is address/customer-bound and never invents source values', () => {
  const delivery = fixture(1);
  assert.deepEqual(deliveryGeography(delivery), { city: 'Catania', province: 'CT', postalCode: '95121', source: 'synthetic_fixture' });
  const absent = { city: 'Catania', province: null, postalCode: null, source: null };
  assert.deepEqual(deliveryGeography({ ...delivery, addressGeography: undefined }), absent);
  assert.ok(delivery.addressGeography);
  assert.deepEqual(deliveryGeography({ ...delivery, addressGeography: { ...delivery.addressGeography, sourceCustomerId: 2 } }), absent);
  assert.deepEqual(deliveryGeography({ ...delivery, source: { ...delivery.source,
    customer: { ...delivery.source.customer, address: 'A changed address' } } }), absent);
  assert.equal(DeliverySchema.safeParse({ ...delivery, addressGeography: { ...delivery.addressGeography, postalCode: 95121 } }).success, false);
});

void test('geographic Inbox filters run before pagination with cascading facets and unchanged global counts', async (context) => {
  const schema = `geography_http_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^geography_http_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const db = new GeographyDatabase(schema);
  const password = randomBytes(24).toString('base64url');
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let cookie = '';
  const before = Array.from({ length: 21 }, (_, index) => fixture(index + 1));

  async function request(route: string, expected = 200, session = cookie) {
    const reply = await fetch(base + '/api' + route, { headers: { Origin: config().FRONTEND_ORIGIN, Cookie: session } });
    const raw: unknown = await reply.json();
    assert.equal(reply.status, expected, `${route}: ${JSON.stringify(raw)}`);
    return raw;
  }
  async function list(query = '') {
    return DeliveryListSchema.parse(await request('/deliveries?view=inbox' + query));
  }

  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }),
      'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.source.initialize();
    await db.source.runMigrations({ transaction: 'all' });
    for (const delivery of before) await db.source.query(
      'INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, schema, delivery.source.pickingId, delivery.version, JSON.stringify(delivery)]);
    await db.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'geography-operator@example.test', 'DEMO Geography Operator', 'operator', await hashPassword(password)]);
    await db.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(db).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: {
      Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ email: 'geography-operator@example.test', password }) });
    assert.equal(login.status, 201);
    const session = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session);
    cookie = session;

    const baseline = await list();
    await context.test('cities span the entire Inbox while unavailable cities produce empty child options', async () => {
      assert.equal(baseline.total, 20);
      assert.equal(baseline.items.length, 10);
      assert.deepEqual(baseline.geographyFacets.provinces, [
        { value: 'CT', count: 12 }, { value: 'ME', count: 2 }, { value: 'PA', count: 1 }, { value: 'RG', count: 1 }, { value: null, count: 4 },
      ]);
      assert.ok(baseline.geographyFacets.cities.some(({ value, count }) => value === 'Catania' && count === 12));
      assert.ok(!baseline.geographyFacets.cities.some(({ value }) => value === 'Milano'));
      assert.ok(baseline.geographyFacets.postalCodes.some(({ value }) => value === '09810'));
      assert.deepEqual((await list('&page=2')).geographyFacets, baseline.geographyFacets);
      const empty = await list('&city=Rome&search=absent');
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.items, []);
      assert.deepEqual(empty.geographyFacets, { cities: baseline.geographyFacets.cities, provinces: [], postalCodes: [] });
      assert.deepEqual(empty.counts, baseline.counts);
      assert.equal(baseline.counts.inbox, 20);
      assert.equal(baseline.counts.planned, 1);
    });

    await context.test('city narrows province and CAP options across every page while own and lower selections are ignored', async () => {
      const catania = await list('&city=catania');
      const expected = { cities: baseline.geographyFacets.cities, provinces: [{ value: 'CT', count: 12 }],
        postalCodes: [{ value: '95121', count: 6 }, { value: '95125', count: 6 }] };
      assert.deepEqual(catania.geographyFacets, expected);
      assert.deepEqual((await list('&city=CATANIA&page=2')).geographyFacets, expected);
      assert.deepEqual((await list('&city=Catania&province=ct&postalCode=95121')).geographyFacets, expected);
      const impossible = await list('&city=Catania&province=ME');
      assert.equal(impossible.total, 0);
      assert.deepEqual(impossible.geographyFacets, { ...expected, postalCodes: [] });
      const postalOnly = await list('&postalCode=95121');
      assert.equal(postalOnly.total, 6);
      assert.deepEqual(postalOnly.geographyFacets, baseline.geographyFacets);
    });

    await context.test('province narrows CAP with explicit missing options and search never changes cascading choices', async () => {
      const messina = await list('&city=Messina');
      assert.deepEqual(messina.geographyFacets, {
        cities: baseline.geographyFacets.cities,
        provinces: [{ value: 'ME', count: 2 }, { value: null, count: 2 }],
        postalCodes: [{ value: '09810', count: 1 }, { value: '98122', count: 1 }, { value: null, count: 2 }],
      });
      const known = await list('&city=messina&province=ME');
      assert.equal(known.total, 2);
      assert.deepEqual(known.geographyFacets.provinces, messina.geographyFacets.provinces);
      assert.deepEqual(known.geographyFacets.postalCodes, [{ value: '09810', count: 1 }, { value: '98122', count: 1 }]);
      const missing = await list('&city=Messina&provinceMissing=true');
      assert.equal(missing.total, 2);
      assert.deepEqual(missing.geographyFacets.provinces, messina.geographyFacets.provinces);
      assert.deepEqual(missing.geographyFacets.postalCodes, [{ value: null, count: 2 }]);
      assert.deepEqual((await list('&province=ME')).geographyFacets.provinces, baseline.geographyFacets.provinces);
      assert.deepEqual((await list('&province=ME')).geographyFacets.postalCodes, known.geographyFacets.postalCodes);
      const searched = await list('&city=Messina&search=JOB13');
      assert.equal(searched.total, 1);
      assert.deepEqual(searched.geographyFacets, messina.geographyFacets);
      const noSearchMatches = await list('&city=Messina&province=ME&search=no-matches');
      assert.equal(noSearchMatches.total, 0);
      assert.deepEqual(noSearchMatches.geographyFacets, known.geographyFacets);
    });

    await context.test('city, province and postal code combine exactly before pagination and retain leading zeros', async () => {
      const first = await list('&city=%20CATANIA%20');
      assert.equal(first.total, 12);
      assert.equal(first.items.length, 10);
      const second = await list('&city=catania&page=2');
      assert.equal(second.total, 12);
      assert.deepEqual(second.items.map(({ source }) => source.pickingId), [11, 12]);
      assert.deepEqual(second.counts, baseline.counts);
      const combined = await list('&city=messina&province=me&postalCode=09810');
      assert.equal(combined.total, 1);
      assert.equal(combined.items[0]?.source.pickingId, 13);
      assert.deepEqual(combined.items[0]?.geography, { city: 'Messina', province: 'ME', postalCode: '09810', source: 'synthetic_fixture' });
      assert.deepEqual(combined.geographyFacets.postalCodes, [{ value: '09810', count: 1 }, { value: '98122', count: 1 }]);
      assert.equal((await list('&postalCode=9810')).total, 0);
      assert.equal((await list('&city=Mess')).total, 0);
      assert.equal((await list('&city=Messina&province=CT')).total, 0);
      assert.equal((await list('&city=Messina&search=JOB13')).items[0]?.source.pickingId, 13);
    });

    await context.test('unknown filters are explicit, cannot collide with literal names and discard stale geography', async () => {
      const missingCity = await list('&cityMissing=true');
      assert.deepEqual(missingCity.items.map(({ source }) => source.pickingId), [15]);
      assert.deepEqual(missingCity.geographyFacets, { cities: baseline.geographyFacets.cities,
        provinces: [{ value: null, count: 1 }], postalCodes: [{ value: null, count: 1 }] });
      const missingProvince = await list('&provinceMissing=true');
      assert.deepEqual(missingProvince.items.map(({ source }) => source.pickingId), [15, 16, 18, 19]);
      assert.deepEqual(missingProvince.geographyFacets.postalCodes, [{ value: null, count: 4 }]);
      assert.deepEqual((await list('&postalCodeMissing=true')).items.map(({ source }) => source.pickingId), [15, 16, 18, 19]);
      assert.deepEqual((await list('&city=__missing__')).items.map(({ source }) => source.pickingId), [16]);
      const stale = (await list('&city=Messina&provinceMissing=true')).items.find(({ source }) => source.pickingId === 19);
      assert.deepEqual(stale?.geography, { city: 'Messina', province: null, postalCode: null, source: null });
    });

    await context.test('matching facets infer unique upstream fields over every page without changing cascading options', async () => {
      assert.deepEqual(baseline.matchingGeographyFacets, baseline.geographyFacets);
      const byProvince = await list('&province=ct');
      const provinceMatches = {
        cities: [{ value: 'Catania', count: 12 }], provinces: [{ value: 'CT', count: 12 }],
        postalCodes: [{ value: '95121', count: 6 }, { value: '95125', count: 6 }],
      };
      assert.equal(byProvince.items.length, 10);
      assert.deepEqual(byProvince.matchingGeographyFacets, provinceMatches);
      assert.deepEqual(byProvince.geographyFacets.cities, baseline.geographyFacets.cities);
      assert.deepEqual((await list('&province=CT&page=2')).matchingGeographyFacets, provinceMatches);
      assert.deepEqual((await list('&province=CT&search=no-matches')).matchingGeographyFacets, provinceMatches);
      assert.deepEqual((await list('&postalCode=95121')).matchingGeographyFacets, {
        cities: [{ value: 'Catania', count: 6 }], provinces: [{ value: 'CT', count: 6 }], postalCodes: [{ value: '95121', count: 6 }],
      });
      const planned = DeliveryListSchema.parse(await request('/deliveries?view=planned'));
      assert.deepEqual(planned.matchingGeographyFacets, {
        cities: [{ value: 'Milano', count: 1 }], provinces: [{ value: 'MI', count: 1 }], postalCodes: [{ value: '00100', count: 1 }],
      });
    });

    await context.test('matching facets preserve ambiguous CAP, missing values, leading zeros and impossible intersections', async () => {
      const ambiguous = {
        cities: [{ value: 'Palermo', count: 1 }, { value: 'Ragusa', count: 1 }],
        provinces: [{ value: 'PA', count: 1 }, { value: 'RG', count: 1 }], postalCodes: [{ value: '00010', count: 2 }],
      };
      assert.deepEqual((await list('&postalCode=00010')).matchingGeographyFacets, ambiguous);
      const narrowedSearch = await list('&postalCode=00010&search=JOB20');
      assert.equal(narrowedSearch.total, 1);
      assert.deepEqual(narrowedSearch.matchingGeographyFacets, ambiguous);
      assert.deepEqual((await list('&postalCode=09810')).matchingGeographyFacets, {
        cities: [{ value: 'Messina', count: 1 }], provinces: [{ value: 'ME', count: 1 }], postalCodes: [{ value: '09810', count: 1 }],
      });
      assert.deepEqual((await list('&cityMissing=true')).matchingGeographyFacets, {
        cities: [{ value: null, count: 1 }], provinces: [{ value: null, count: 1 }], postalCodes: [{ value: null, count: 1 }],
      });
      const missing = (await list('&provinceMissing=true')).matchingGeographyFacets;
      assert.equal(missing.cities.length, 3);
      assert.ok(missing.cities.some(({ value, count }) => value === 'Messina' && count === 2));
      assert.deepEqual(missing.provinces, [{ value: null, count: 4 }]);
      assert.deepEqual(missing.postalCodes, [{ value: null, count: 4 }]);
      for (const query of ['&city=Messina&province=CT', '&postalCode=9810', '&postalCode=00010&provinceMissing=true']) {
        const result = await list(query);
        assert.equal(result.total, 0);
        assert.deepEqual(result.matchingGeographyFacets, { cities: [], provinces: [], postalCodes: [] });
      }
    });

    await context.test('authentication, strict query validation and OpenAPI describe the same contract', async () => {
      await request('/deliveries?view=inbox', 401, '');
      for (const query of [
        'city=Catania&cityMissing=true', 'province=CT&provinceMissing=true', 'postalCode=95121&postalCodeMissing=true',
        'cityMissing=false', 'city=', 'city=Catania&city=Messina', 'postalCode=' + '1'.repeat(21),
        'province=' + 'a'.repeat(101), 'cityId=1',
      ]) await request('/deliveries?view=inbox&' + query, 400);
      const document = z.object({ paths: z.record(z.string(), z.object({ get: z.object({ parameters: z.array(z.object({ name: z.string() })) }).optional() })) })
        .parse(await request('/openapi.json'));
      const names = document.paths['/deliveries']?.get?.parameters.map(({ name }) => name);
      for (const name of ['city', 'province', 'postalCode', 'cityMissing', 'provinceMissing', 'postalCodeMissing']) assert.ok(names?.includes(name));
      const after = await rows(db.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery ORDER BY source_id');
      assert.deepEqual(after.map(({ data }) => data), before, 'Filtering never writes delivery/source/planning/history data');
    });
  } finally {
    try {
      if (app) await app.close();
      if (db.source.isInitialized) await db.source.destroy();
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      if (control.isInitialized) await control.destroy();
    }
  }
});
