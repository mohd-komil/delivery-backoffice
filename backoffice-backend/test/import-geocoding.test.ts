import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, type Delivery, type OperatorActor } from '../src/domain/model';
import { IMPORT_GEOCODING_MAX_ADDRESSES, ImportGeocoding } from '../src/integration/import-geocoding';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { DeliveryStore } from '../src/operations/store';
import { GeoapifyCandidateSchema, type GeoapifyLookupResult } from '../src/routing/geoapify-client';
import { AddressGeocoding, type GeocodingResponse } from '../src/routing/geocoding';

class ImportGeocodingDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

void test('automatic import geocoding selects remaining addresses and respects cached outcomes and batch bounds', async (context) => {
  const schema = `auto_geocode_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^auto_geocode_[a-f0-9]{32}$/);
  const control = makeDataSource(true);
  const db = new ImportGeocodingDatabase(schema);
  const store = new DeliveryStore(db);
  const points = new DeliveryPoints(store);
  const actor: OperatorActor = { id: randomUUID(), name: 'Synthetic import operator', role: 'operator' };
  const candidate = GeoapifyCandidateSchema.parse({ point: { latitude: 38.188, longitude: 15.554 }, formattedAddress: 'Synthetic result',
    precision: 'building', confidence: 1, matchType: 'full_match', attribution: 'Powered by Geoapify · © OpenStreetMap contributors' });
  let providerCalls = 0;
  let outcome: GeoapifyLookupResult = { status: 'accepted', reason: null, candidate };
  const geocoding = new AddressGeocoding(store, { getSettings: () => Promise.resolve({ configured: true, dailyLimit: 100 }),
    lookup: () => { providerCalls++; return Promise.resolve(outcome); } });
  const automatic = new ImportGeocoding(store, points, geocoding);
  let created = false;
  let index = 0;

  async function fixture(sourceInstance: string, address?: string): Promise<Delivery> {
    index++;
    const delivery = createDelivery({ pickingId: index, pickingName: `AUTOGEO/${index}`, saleOrderId: index, saleOrderName: `SO/${index}`,
      sourceState: 'assigned', salesTeam: 'Synthetic fixture', customer: { id: index, name: 'Synthetic customer', address: address ?? `Via Test ${index}`,
        city: 'Messina', country: 'IT', postalCode: '98123', province: 'ME', phones: [], email: null, contact: null },
      items: [{ sourceLineId: index, productId: 7, name: 'Synthetic item', description: null, quantity: 1, uom: 'unit',
        configuration: null, ambient: null, notes: null, photoUrl: null }], serviceType: null, estimatedMinutes: null, notes: null }, randomUUID());
    await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, sourceInstance, index, delivery.version, JSON.stringify(delivery)]);
    return delivery;
  }
  async function cached(delivery: Delivery, sourceInstance: string, status: 'accepted' | 'review_required' | 'not_found' | 'failed' | 'pending') {
    await db.source.query(`INSERT INTO address_geocoding(source_instance,address_key,provider,status,version,candidate,acceptance,request_token,lease_until,retry_after)
      VALUES($1,$2,'geoapify',$3,1,$4::jsonb,$5,$6,$7,$8)`, [sourceInstance, destinationAddressKey(delivery.source.customer), status,
      status === 'accepted' || status === 'review_required' ? JSON.stringify(candidate) : null, status === 'accepted' ? 'automatic' : null,
      status === 'pending' ? randomUUID() : null, status === 'pending' ? new Date(Date.now() + 3600_000) : null,
      status === 'failed' || status === 'not_found' ? new Date(Date.now() + 3600_000) : null]);
  }
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await db.source.initialize(); await db.source.runMigrations({ transaction: 'all' });

    await context.test('skip existing points before address dedup; unknown service does not block locating another customer at that address', async () => {
      const reference = await fixture('selection'); reference.routePoint = { latitude: 38.1, longitude: 15.5 };
      await store.save(db.source.manager, reference);
      const entrance = await fixture('selection', 'Via Shared 12');
      await db.source.query(`INSERT INTO destination_entrance(source_instance,source_customer_id,address_key,latitude,longitude,version,confirmed_by_id,confirmed_by_name)
        VALUES($1,$2,$3,38.1,15.5,1,$4,$5)`, ['selection', entrance.source.customer.id, destinationAddressKey(entrance.source.customer), actor.id, actor.name]);
      const selected = await fixture('selection', entrance.source.customer.address ?? undefined);
      const duplicate = await fixture('selection', selected.source.customer.address ?? undefined);
      await fixture('selection', 'Street example 1');
      const review = await fixture('selection'); review.sourceReview = true; await store.save(db.source.manager, review);
      for (const state of ['not_found', 'review_required', 'failed', 'pending', 'accepted'] as const) await cached(await fixture('selection'), 'selection', state);
      const missing = await fixture('selection'); missing.source.customer.city = null; await store.save(db.source.manager, missing);
      const foreign = await fixture('another_source', selected.source.customer.address ?? undefined);
      const before = await rows(db.source.manager, z.object({ data: z.unknown() }), 'SELECT data FROM delivery ORDER BY id');
      const summary = await automatic.run('selection', actor);
      assert.deepEqual(summary, { deliveries: 12, alreadyMapped: 3, skippedInvalid: 2, skippedReview: 1, duplicateAddresses: 1,
        cached: 4, checkedAddresses: 1, accepted: 1, reviewRequired: 0, notFound: 0, failed: 0, deferred: 0, stopReason: 'complete' });
      assert.equal(providerCalls, 1);
      assert.equal((await points.effectiveFor([selected, duplicate])).size, 2);
      assert.equal((await points.effectiveFor([foreign])).size, 0);
      const repeat = await automatic.run('selection', actor);
      assert.equal(repeat.alreadyMapped, 5);
      assert.equal(repeat.checkedAddresses, 0);
      assert.equal(providerCalls, 1);
      assert.deepEqual(await rows(db.source.manager, z.object({ data: z.unknown() }), 'SELECT data FROM delivery ORDER BY id'), before);
    });

    await context.test('expired negative cache retries once; provider outage stops the batch and preserves the importable records', async () => {
      const failed = await fixture('outage');
      await cached(failed, 'outage', 'failed');
      await fixture('outage');
      await db.source.query("UPDATE address_geocoding SET retry_after=now()-interval '1 second' WHERE source_instance='outage'");
      await db.source.query("UPDATE geocoding_budget SET next_request_at=now()-interval '1 second'");
      outcome = { status: 'failed', reason: 'provider_unavailable', candidate: null };
      const beforeCalls = providerCalls;
      const result = await automatic.run('outage', actor);
      assert.equal(result.failed, 1); assert.equal(result.deferred, 1); assert.equal(result.stopReason, 'provider_unavailable');
      assert.equal(providerCalls, beforeCalls + 1);
      assert.deepEqual(await store.get(failed.id), failed);
    });

    await context.test('global pacing is awaited between consecutive eligible addresses, while quota stops without another provider call', async () => {
      await fixture('paced'); await fixture('paced');
      outcome = { status: 'accepted', reason: null, candidate };
      await db.source.query("UPDATE geocoding_budget SET next_request_at=now()-interval '1 second'");
      const beforeCalls = providerCalls;
      const started = Date.now();
      const result = await automatic.run('paced', actor);
      assert.equal(result.accepted, 2); assert.equal(providerCalls, beforeCalls + 2);
      assert.ok(Date.now() - started >= 900, 'The persisted one-second provider interval must remain effective');
      await fixture('quota'); await fixture('quota');
      await db.source.query('UPDATE geocoding_budget SET used=100');
      const limited = await automatic.run('quota', actor);
      assert.equal(limited.stopReason, 'quota_exceeded'); assert.equal(limited.deferred, 2);
      assert.equal(providerCalls, beforeCalls + 2);
    });

    await context.test('the bounded coordinator processes at most twenty eligible unique addresses', async () => {
      for (let i = 0; i < 22; i++) await fixture('bounded');
      let calls = 0;
      const snapshots = new Map<string, GeocodingResponse>();
      const stub: Pick<AddressGeocoding, 'getMany' | 'locate'> = {
        getMany(deliveries) {
          for (const delivery of deliveries) snapshots.set(delivery.id, { provider: 'geoapify', configured: true,
            addressKey: destinationAddressKey(delivery.source.customer), deliveryVersion: delivery.version, recordVersion: null,
            status: 'not_requested', reason: null, retryAt: null, candidate: null, acceptance: null });
          return Promise.resolve(snapshots);
        },
        locate(id) {
          calls++; const snapshot = snapshots.get(id); assert.ok(snapshot);
          return Promise.resolve({ ...snapshot, status: 'accepted', recordVersion: 2, candidate, acceptance: 'automatic' });
        },
      };
      const result = await new ImportGeocoding(store, points, stub).run('bounded', actor);
      assert.equal(calls, IMPORT_GEOCODING_MAX_ADDRESSES); assert.equal(result.accepted, 20);
      assert.equal(result.deferred, 2); assert.equal(result.stopReason, 'batch_limit');
    });

    await context.test('cached outcomes ahead of fresh work do not consume the twenty-address budget', async () => {
      for (let i = 0; i < 21; i++) await cached(await fixture('cached_tail'), 'cached_tail', 'review_required');
      await fixture('cached_tail');
      await db.source.query("UPDATE geocoding_budget SET used=0,next_request_at=now()-interval '1 second'");
      const beforeCalls = providerCalls;
      const result = await automatic.run('cached_tail', actor);
      assert.equal(result.cached, 21); assert.equal(result.accepted, 1); assert.equal(result.checkedAddresses, 1);
      assert.equal(result.deferred, 0); assert.equal(providerCalls, beforeCalls + 1);
    });

    await context.test('a destination changed after eligibility reading is deferred without submitting stale text', async () => {
      const delivery = await fixture('changed');
      const beforeCalls = providerCalls;
      const racing: Pick<AddressGeocoding, 'getMany' | 'locate'> = {
        async getMany(deliveries) {
          const states = await geocoding.getMany(deliveries);
          const current = structuredClone(delivery);
          current.source.customer.postalCode = '98124'; current.version++;
          await db.source.transaction(async (manager) => {
            await manager.query('SELECT pg_advisory_xact_lock(7041001)');
            await store.save(manager, current);
          });
          return states;
        },
        locate: (id, input, principal) => geocoding.locate(id, input, principal),
      };
      const result = await new ImportGeocoding(store, points, racing).run('changed', actor);
      assert.equal(result.deferred, 1); assert.equal(result.checkedAddresses, 0);
      assert.equal(providerCalls, beforeCalls);
      assert.equal((await store.get(delivery.id)).source.customer.postalCode, '98124');
    });

    await context.test('the coordinator stops before a new external call when its time budget has elapsed', async (testContext) => {
      await fixture('timed');
      let now = Date.now();
      testContext.mock.method(Date, 'now', () => now);
      const stub: Pick<AddressGeocoding, 'getMany' | 'locate'> = {
        getMany(deliveries) {
          now += 30_001;
          return Promise.resolve(new Map(deliveries.map((delivery) => [delivery.id, { provider: 'geoapify' as const, configured: true,
            addressKey: destinationAddressKey(delivery.source.customer), deliveryVersion: delivery.version, recordVersion: null,
            status: 'not_requested' as const, reason: null, retryAt: null, candidate: null, acceptance: null }])));
        },
        locate() { throw new Error('Time budget must be checked before a new lookup'); },
      };
      const result = await new ImportGeocoding(store, points, stub).run('timed', actor);
      assert.equal(result.stopReason, 'time_budget'); assert.equal(result.deferred, 1); assert.equal(result.checkedAddresses, 0);
    });
  } finally {
    if (db.source.isInitialized) await db.source.destroy();
    if (control.isInitialized) {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.destroy();
    }
  }
});
