import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, type Delivery } from '../src/domain/model';
import { DeliveryPoints } from '../src/operations/delivery-points';
import { Participants } from '../src/operations/participants';
import { DeliveryStore } from '../src/operations/store';
import { Vehicles } from '../src/operations/vehicles';
import { RouteDraftInputSchema } from '../src/routing/contracts';
import { DeliveryMap } from '../src/routing/delivery-map';
import { DestinationEntrances } from '../src/routing/entrances';
import { GeoapifyCandidateSchema } from '../src/routing/geocoding-contracts';
import { GoogleRoads } from '../src/routing/google-maps';
import { RouteDrafts } from '../src/routing/service';
import { PlanningLocations } from '../src/planning/locations';
import { PlanningCalendar } from '../src/planning/calendar';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { lifecycleFixture } from './support/route-lifecycle-fixture';

class PointDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

void test('saved geocodes propagate to map, nearby and Routes without confirming an entrance or rewriting history', async (context) => {
  const schema = `geocode_points_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^geocode_points_[a-f0-9]{32}$/);
  const control = makeDataSource(true);
  const db = new PointDatabase(schema);
  const store = new DeliveryStore(db);
  const points = new DeliveryPoints(store);
  const entrances = new DestinationEntrances(store, points);
  const participants = new Participants(store);
  const roads = new GoogleRoads({ settings: null, compute: () => { throw new Error('Geocoding must not activate road APIs'); } });
  const routes = new RouteDrafts(store, participants, new Vehicles(store, participants), roads, entrances, new PlanningLocations(store), new PlanningCalendar(store));
  const map = new DeliveryMap(store, points);
  let index = 0;
  let created = false;
  async function fixture(address: string, sourceInstance = schema): Promise<Delivery> {
    index++;
    const delivery = createDelivery({ pickingId: index, pickingName: `GEO/TEST/${index}`, saleOrderId: index, saleOrderName: `SO/${index}`,
      sourceState: 'assigned', salesTeam: 'DEMO', customer: { id: index, name: 'Synthetic geocoding fixture', address,
        city: 'Messina', country: 'IT', postalCode: '98123', province: 'ME', phones: [], email: null, contact: null },
      items: [{ sourceLineId: index, productId: 99, name: 'Same physical SKU', sku: 'SAME-SKU', description: null, quantity: 1,
        uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: 30, notes: null }, randomUUID());
    await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, sourceInstance, index, delivery.version, JSON.stringify(delivery)]);
    return delivery;
  }
  const candidate = GeoapifyCandidateSchema.parse({ point: { latitude: 38.18686, longitude: 15.55061 },
    formattedAddress: 'Synthetic test result, Via Roma 19, Messina', precision: 'building', confidence: 1,
    matchType: 'full_match', attribution: 'Powered by Geoapify | © OpenStreetMap contributors' });
  async function cache(delivery: Delivery, status: 'accepted' | 'review_required' = 'accepted') {
    await db.source.query(`INSERT INTO address_geocoding(source_instance,address_key,provider,status,version,candidate,acceptance)
      VALUES($1,$2,'geoapify',$3,1,$4::jsonb,$5)`, [schema, destinationAddressKey(delivery.source.customer), status,
      JSON.stringify(candidate), status === 'accepted' ? 'automatic' : null]);
  }
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.source.initialize();
    await db.source.runMigrations({ transaction: 'all' });
    const first = await fixture('Via Roma 19');
    const second = await fixture('Via Roma 19');
    const foreign = await fixture('Via Roma 19', `${schema}_other_source`);
    const approximate = await fixture('Via Roma 20');
    const unknownWork = await fixture('Via Roma 19');
    unknownWork.source.serviceType = null;
    unknownWork.servicePlan = { defaultService: null, overrides: [] };
    await store.save(db.source.manager, unknownWork);
    first.routePoint = { latitude: 37.5, longitude: 15.1 };
    await store.save(db.source.manager, first);
    await cache(first);
    await cache(approximate, 'review_required');

    await context.test('accepted coordinates override references, share only matching source/address, and show unknown-work deliveries', async () => {
      const result = await map.get({});
      assert.equal(result.mappedCount, 3);
      assert.equal(result.missingCount, 2);
      for (const delivery of [first, second, unknownWork]) {
        const marker = result.markers.find(({ deliveryId }) => deliveryId === delivery.id);
        assert.deepEqual(marker?.point, candidate.point);
        assert.equal(marker?.pointSource, 'geocoded');
        assert.equal(marker?.geocoding?.precision, 'building');
        assert.equal(marker?.geocoding?.acceptance, 'automatic');
        assert.match(marker?.geocoding?.attribution ?? '', /OpenStreetMap/);
      }
      assert.ok(result.missingCoordinates.some(({ deliveryId }) => deliveryId === foreign.id));
      assert.ok(result.missingCoordinates.some(({ deliveryId }) => deliveryId === approximate.id));
      const review = await entrances.get(first.id);
      assert.equal(review.entrance, null);
      assert.deepEqual(review.referencePoint, candidate.point);
      assert.equal(review.referenceGeocoding?.provider, 'geoapify');
      assert.equal(review.referenceGeocoding?.acceptance, 'automatic');
      const nearby = await routes.jobs({ anchorId: first.id, radiusKm: '10' });
      assert.equal(nearby.anchorHasCoordinates, true);
      assert.equal(nearby.anchorJob?.entranceConfirmed, false);
      assert.equal(nearby.anchorJob?.geocoding?.provider, 'geoapify');
      assert.deepEqual(nearby.jobs.map(({ deliveryId }) => deliveryId), [second.id]);
      assert.equal(nearby.jobs[0]?.distanceKm, 0);
    });

    await context.test('route contexts use accepted coordinates, entrance changes invalidate prior manual travel assumptions', async () => {
      const input = RouteDraftInputSchema.parse({ name: 'Synthetic route', departAt: '2031-01-01T08:00:00Z', crewId: null, vehicleId: null,
        startPointId: 'warehouse-milano', endPointId: 'warehouse-milano', stops: [{ deliveryId: first.id, workMinutes: 30 }], manualEstimates: [] });
      const preview = await routes.preview(input);
      assert.deepEqual(preview.jobs[0]?.point, candidate.point);
      assert.equal(preview.jobs[0]?.entranceConfirmed, false);
      const from = preview.pointContexts.find(({ pointId }) => pointId === input.startPointId);
      const to = preview.pointContexts.find(({ pointId }) => pointId === first.id);
      assert.ok(from && to);
      input.manualEstimates = [{ fromPointId: input.startPointId, toPointId: first.id, minutes: 10,
        context: { from: { point: from.point, addressKey: from.addressKey }, to: { point: to.point, addressKey: to.addressKey } } }];
      const before = await routes.preview(input);
      assert.equal(before.timeline.stops[0]?.travelSource, 'manual');
      const unloadingPoint = { latitude: 38.187, longitude: 15.551 };
      await entrances.confirm(first.id, { deliveryVersion: 1, addressKey: destinationAddressKey(first.source.customer),
        version: null, confirmed: true, point: unloadingPoint }, { id: randomUUID(), name: 'Synthetic operator', role: 'operator' });
      const after = await routes.preview(input);
      assert.deepEqual(after.jobs[0]?.point, unloadingPoint);
      assert.equal(after.jobs[0]?.entranceConfirmed, true);
      assert.equal(after.jobs[0]?.geocoding, undefined);
      assert.ok(after.warnings.some(({ code }) => code === 'manual_estimate_stale'));
      assert.equal(after.timeline.stops[0]?.travelMinutes, null);
      assert.deepEqual(before.jobs[0]?.point, candidate.point, 'Previously captured planning evidence remains unchanged');
      assert.equal((await points.effectiveFor([first])).get(first.id)?.pointSource, 'confirmed_entrance');
      assert.equal((await points.effectiveFor([second])).get(second.id)?.pointSource, 'geocoded', 'Entrance confirmation is customer scoped');
      assert.deepEqual(await store.get(first.id), first, 'Geocoding and entrance records do not mutate source or delivery versions');
    });

    await context.test('changed CAP, source-review and stale in-memory delivery versions cannot reuse accepted coordinates', async () => {
      second.source.customer.postalCode = '98124';
      second.version++;
      await store.save(db.source.manager, second);
      assert.equal((await points.effectiveFor([second])).has(second.id), false);
      unknownWork.sourceReview = true;
      await store.save(db.source.manager, unknownWork);
      assert.equal((await points.effectiveFor([unknownWork])).has(unknownWork.id), false);
      const stale = structuredClone(second);
      stale.version--;
      stale.source.customer.postalCode = '98123';
      assert.equal((await points.effectiveFor([stale])).has(stale.id), false);
    });
  } finally {
    if (db.source.isInitialized) await db.source.destroy();
    if (control.isInitialized) {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.destroy();
    }
  }
});

void test('published Crew navigation can use an accepted address point without changing publication evidence', async () => {
  const h = await lifecycleFixture();
  try {
    const fixture = await h.fixture({ count: 1 });
    const delivery = fixture.deliveries[0];
    assert.ok(delivery);
    const point = { latitude: 37.50, longitude: 15.084 };
    delete delivery.routePoint;
    await new DeliveryStore(h.database).save(h.database.source.manager, delivery);
    const candidate = GeoapifyCandidateSchema.parse({ point, formattedAddress: 'Synthetic test address', precision: 'building',
      confidence: 1, matchType: 'full_match', attribution: 'Powered by Geoapify | © OpenStreetMap contributors' });
    await h.database.source.query(`INSERT INTO address_geocoding(source_instance,address_key,provider,status,version,candidate,acceptance)
      VALUES($1,$2,'geoapify','accepted',1,$3::jsonb,'automatic')`,
    [h.schema, destinationAddressKey(delivery.source.customer), JSON.stringify(candidate)]);
    const published = await h.publish(fixture);
    const before = await h.ok(`/routes/${published.id}/revisions/1`);
    const live = RouteOperationsSchema.parse(await h.ok(`/crew/routes/${published.id}`, { cookie: fixture.cookie }));
    assert.deepEqual(live.stops[0]?.entrance, { ...point, addressKey: destinationAddressKey(delivery.source.customer) });
    assert.equal(live.stops[0]?.geocoding?.provider, 'geoapify');
    assert.deepEqual(await h.ok(`/routes/${published.id}/revisions/1`), before);
  } finally {
    await h.close();
  }
});
