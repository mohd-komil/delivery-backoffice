import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { seedMvpPilot } from '../scripts/demo-pilot';
import { routeFeasibilityFixtures, seedRouteFeasibility } from '../scripts/demo-route-feasibility';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { AppointmentSchema, DeliverySchema } from '../src/domain/model';
import { planVisitWork } from '../src/domain/rules';
import { hashPassword } from '../src/identity/identity';
import { demoRouteAddressIds } from '../src/routing/demo-estimates';
import { GoogleRoads } from '../src/routing/google-maps';
import { RouteDetailSchema, RouteDraftListSchema, RouteJobsSchema, RoutePreviewSchema, RouteSuggestionSchema } from '../src/routing/http-contracts';
import { routeJob } from '../src/routing/service';

class NearbyDatabase extends Database {
  override readonly source: DataSource;

  constructor(schema: string) {
    super();
    this.source = new DataSource({
      type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema },
    });
  }
}

function assertSameDraft(actual: z.infer<typeof RouteDetailSchema>, expected: z.infer<typeof RouteDetailSchema>) {
  assert.deepEqual({ ...actual, feasibility: { ...actual.feasibility, checkedAt: expected.feasibility.checkedAt } }, expected);
}

void test('Inbox nearby jobs and one-click drafts use isolated PostgreSQL, real guards and no road API', async (context) => {
  const schema = `route_nearby_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^route_nearby_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new NearbyDatabase(schema);
  const password = randomBytes(24).toString('base64url');
  let app: NestExpressApplication | undefined;
  let created = false;
  let base = '';
  let cookie = '';
  let roadCalls = 0;
  const { milano, sesto, monza } = demoRouteAddressIds;

  async function request(route: string, method = 'GET', body?: unknown, session = cookie, origin: string = config().FRONTEND_ORIGIN) {
    const headers: Record<string, string> = { Origin: origin };
    if (session) headers['Cookie'] = session;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}/api${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw: unknown = await response.json();
    return { response, raw };
  }

  async function expectStatus(route: string, status: number, method = 'GET', body?: unknown, session = cookie, origin: string = config().FRONTEND_ORIGIN) {
    const result = await request(route, method, body, session, origin);
    assert.equal(result.response.status, status, `${method} ${route}: ${JSON.stringify(result.raw)}`);
    return result.raw;
  }

  const deliverySnapshot = () => rows(database.source.manager, z.object({ data: DeliverySchema }),
    'SELECT data FROM delivery ORDER BY id');

  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }),
      'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    await seedMvpPilot(database.source);
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'nearby-operator@example.test', 'DEMO Nearby Operator', 'operator', await hashPassword(password)]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database).useValue(database)
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({
        settings: { browserKey: 'test-browser-key', routesKey: 'test-server-key' },
        compute: () => { roadCalls++; throw new Error('Nearby work must not call a road provider'); },
      })).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await request('/auth/login', 'POST', { email: 'nearby-operator@example.test', password });
    assert.equal(login.response.status, 201);
    const session = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session);
    cookie = session;

    await context.test('returns the selected anchor and remaining mixed-service jobs by radius', async () => {
      const catalogue = RouteJobsSchema.parse(await expectStatus('/routes/jobs', 200));
      assert.equal(catalogue.anchorJob, null);
      assert.equal(catalogue.anchorHasCoordinates, null);
      assert.equal(catalogue.jobs.length, 3);
      const near = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=10`, 200));
      assert.equal(near.anchorJob?.deliveryId, milano);
      assert.equal(near.anchorJob?.suggestedWorkMinutes, 45);
      assert.equal(near.anchorHasCoordinates, true);
      assert.deepEqual(near.jobs.map(({ deliveryId }) => deliveryId), [sesto]);
      assert.deepEqual(near.jobs[0]?.remaining.map(({ deliveryMilli, installationMilli, collectionMilli }) =>
        [deliveryMilli, installationMilli, collectionMilli]), [[0, 0, 1000]]);
      assert.ok(near.jobs[0]?.distanceKm !== null && near.jobs[0]?.distanceKm !== undefined);
      assert.ok(near.jobs[0].distanceKm > 8 && near.jobs[0].distanceKm < 9);
      assert.ok(near.anchorJob?.remaining.some(({ installationMilli }) => installationMilli > 0));
      const wider = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=20`, 200));
      assert.deepEqual(wider.jobs.map(({ deliveryId }) => deliveryId), [sesto, monza]);
      assert.notEqual(wider.anchorJob?.pickingName, wider.jobs[1]?.pickingName);
      const empty = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=1`, 200));
      assert.deepEqual(empty.jobs, []);
      assert.equal(empty.anchorJob?.deliveryId, milano);
      const searched = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=20&search=Monza`, 200));
      assert.deepEqual(searched.jobs.map(({ deliveryId }) => deliveryId), [monza]);
      assert.equal(searched.anchorJob?.deliveryId, milano, 'Searching candidates does not discard the selected anchor');
    });

    const draft = {
      requestId: randomUUID(), name: 'DEMO nearby from Inbox', departAt: new Date().toISOString(),
      crewId: null, vehicleId: null, startPointId: 'warehouse-milano', endPointId: 'warehouse-milano',
      stops: [{ deliveryId: milano, workMinutes: 45 }, { deliveryId: sesto, workMinutes: 25 }], manualEstimates: [],
    };

    await context.test('guards and bounded validation stay active for the Inbox flow', async () => {
      await expectStatus(`/routes/jobs?anchorId=${milano}`, 401, 'GET', undefined, '');
      await expectStatus('/routes', 401, 'POST', draft, '');
      await expectStatus('/routes', 403, 'POST', draft, cookie, 'http://127.0.0.1:3002');
      for (const radius of ['0', '51', '-1', 'invalid']) {
        await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=${radius}`, 400);
      }
      await expectStatus('/routes/jobs?radiusKm=10', 400);
      await expectStatus(`/routes/jobs?anchorId=${randomUUID()}`, 404);
      await expectStatus('/routes', 400, 'POST', { ...draft, stops: [draft.stops[0], draft.stops[0]] });
    });

    await context.test('one request saves the anchor and selection without booking, including concurrent retries', async () => {
      const before = await deliverySnapshot();
      const [first, retry] = await Promise.all([
        expectStatus('/routes', 201, 'POST', draft), expectStatus('/routes', 201, 'POST', draft),
      ]);
      const saved = RouteDetailSchema.parse(first);
      const retried = RouteDetailSchema.parse(retry);
      assert.deepEqual({ ...retried, feasibility: { ...retried.feasibility, checkedAt: saved.feasibility.checkedAt } }, saved);
      assert.equal(saved.id, draft.requestId);
      assert.equal(saved.version, 1);
      assert.equal(saved.crewId, null);
      assert.equal(saved.vehicleId, null);
      assert.deepEqual(saved.stops, draft.stops);
      assert.deepEqual(await deliverySnapshot(), before, 'A draft must not book visits or change remaining work');
      const reopened = RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200));
      assert.deepEqual({ ...reopened, feasibility: { ...reopened.feasibility, checkedAt: saved.feasibility.checkedAt } }, saved);
      const list = RouteDraftListSchema.parse(await expectStatus('/routes', 200));
      assert.deepEqual(list.drafts.map(({ id, stopCount }) => ({ id, stopCount })), [{ id: saved.id, stopCount: 2 }]);
      await expectStatus('/routes', 409, 'POST', { ...draft, name: 'Changed repeated request' });
      assert.equal(roadCalls, 0);
    });

    await context.test('full-trip feasibility reads real reservations and bounded order suggestions preserve domain state', async () => {
      const before = await deliverySnapshot();
      const personId = randomUUID(); const crewId = randomUUID(); const vehicleId = randomUUID();
      const actor = { id: randomUUID(), name: 'DEMO route operator', role: 'operator' as const };
      const appointments: string[] = [];
      await database.source.query('INSERT INTO person(id,first_name,last_name,external,enabled) VALUES($1,$2,$3,false,true)', [personId, 'DEMO Luca', 'Bianchi']);
      await database.source.query('INSERT INTO crew(id,version,name,classification,area,enabled) VALUES($1,1,$2,$3,$4,true)', [crewId, 'DEMO route crew', 'outdoor', 'Milano']);
      await database.source.query('INSERT INTO vehicle(id,version,ownership,name,plate,operational_status,enabled) VALUES($1,1,$2,$3,$4,$5,true)', [vehicleId, 'company', 'DEMO route van', 'DEMO ROUTE', 'available']);
      try {
        const stops = [];
        for (const [index, deliveryId] of [monza, milano].entries()) {
          const delivery = before.find(({ data }) => data.id === deliveryId)?.data; assert.ok(delivery);
          const item = delivery.source.items[0]; assert.ok(item);
          const appointment = AppointmentSchema.parse({ id: randomUUID(), startsAt: `2026-11-12T${index === 0 ? '08:42' : '09:40'}:00Z`, endsAt: `2026-11-12T${index === 0 ? '09:12' : '10:10'}:00Z`,
            status: 'booked', cancellationReason: null, returnRequestId: null, results: [],
            workScope: planVisitWork(delivery, [{ sourceLineId: item.sourceLineId, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], actor, '2026-11-11T08:00:00Z'),
            assignments: [{ id: randomUUID(), crewId, crewName: 'DEMO route crew', people: [{ id: personId, name: 'DEMO Luca Bianchi', external: false, skillsSnapshot: [] }],
              tasks: [{ id: randomUUID(), templateId: randomUUID(), title: 'Unload', severity: 'high', order: 0, requiredSkillsSnapshot: [], checklist: [{ id: randomUUID(), label: 'Check', done: false, waiver: null }] }] }],
          });
          appointments.push(appointment.id);
          const updated = { ...delivery, appointments: [...delivery.appointments, appointment] };
          await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [deliveryId, JSON.stringify(updated)]);
          await database.source.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)', [appointment.id, deliveryId, appointment.startsAt, appointment.endsAt, 'booked']);
          for (const resource of [`person:${personId}`, `crew:${crewId}`]) await database.source.query('INSERT INTO reservation(appointment_id,resource) VALUES($1,$2)', [appointment.id, resource]);
          const job = routeJob(updated, undefined, appointment.id);
          stops.push({ deliveryId, appointmentId: appointment.id, workMinutes: 30, workDurationSource: 'manual', workFingerprint: job.workFingerprint, customerWindow: { kind: 'unrestricted' } });
        }
        const input = { name: 'DEMO real feasibility', departAt: '2026-11-12T08:00:00Z', crewId, vehicleId, startPointId: 'warehouse-milano', endPointId: 'warehouse-milano', stops, manualEstimates: [],
          planning: { participantIds: [personId], participantAvailability: [{ participantId: personId, workingIntervals: [{ startsAt: '2026-11-12T07:00:00Z', endsAt: '2026-11-12T18:00:00Z' }], unavailableIntervals: [] }],
            vehicleAvailability: null, driver: { kind: 'participant', participantId: personId }, transferBufferMinutes: 0 } };
        const state = await deliverySnapshot();
        const preview = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', input));
        assert.equal(preview.feasibility.status, 'feasible_estimate');
        const repeated = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', input));
        assert.equal(repeated.feasibility.fingerprint, preview.feasibility.fingerprint, 'checkedAt is not part of the freshness fingerprint');
        const suggestionInput = { ...input, objective: 'travel_minutes' };
        await expectStatus('/routes/suggest-order', 401, 'POST', suggestionInput, '');
        await expectStatus('/routes/suggest-order', 403, 'POST', suggestionInput, cookie, 'http://127.0.0.1:3002');
        await expectStatus('/routes/suggest-order', 400, 'POST', { ...suggestionInput, objective: 'unknown' });
        await expectStatus('/routes/suggest-order', 400, 'POST', { ...suggestionInput, useGoogleRoads: true });
        const suggestion = RouteSuggestionSchema.parse(await expectStatus('/routes/suggest-order', 200, 'POST', suggestionInput));
        assert.equal(suggestion.status, 'suggested'); assert.deepEqual(suggestion.deliveryIds, [milano, monza]);
        assert.equal(suggestion.travelMinutesSaved, 17);
        assert.deepEqual(await deliverySnapshot(), state, 'Preview and suggestions never assign, book or change work');
        assert.equal(suggestion.current.feasibility.fingerprint, preview.feasibility.fingerprint);
        const changedSource = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', { ...input, stops: input.stops.map((stop) => ({ ...stop, workDurationSource: 'remaining_estimate', workMinutes: 999 })) }));
        assert.ok(changedSource.timeline.stops.every((stop) => stop.workMinutes !== 999), 'Server recomputes estimates for selected quantities');
        const busyId = randomUUID(); appointments.push(busyId);
        assert.ok(preview.timeline.returnDepartAt && preview.timeline.returnAt);
        await database.source.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)', [busyId, sesto, preview.timeline.returnDepartAt, preview.timeline.returnAt, 'booked']);
        await database.source.query('INSERT INTO transport_reservation(allocation_id,appointment_id,resource,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), busyId, `vehicle:${vehicleId}`, preview.timeline.returnDepartAt, preview.timeline.returnAt]);
        const blocked = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', input));
        assert.equal(blocked.feasibility.status, 'conflict');
        assert.ok(blocked.feasibility.findings.some(({ code, resourceId }) => code === 'resource_busy' && resourceId === `vehicle:${vehicleId}`));
        assert.notEqual(blocked.feasibility.fingerprint, preview.feasibility.fingerprint);
        await database.source.query("UPDATE appointment SET status='completed' WHERE id=$1", [busyId]);
        const returning = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', input));
        assert.ok(returning.feasibility.findings.some(({ code, resourceId }) => code === 'resource_busy' && resourceId === `vehicle:${vehicleId}`), 'A completed visit can still reserve its vehicle during the return journey');
        await database.source.query("UPDATE vehicle SET operational_status='maintenance' WHERE id=$1", [vehicleId]);
        const maintenance = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', input));
        assert.ok(maintenance.feasibility.findings.some(({ code }) => code === 'vehicle_unavailable'));
        assert.equal(roadCalls, 0);
      } finally {
        await database.source.query('DELETE FROM transport_reservation WHERE appointment_id=ANY($1::uuid[])', [appointments]);
        await database.source.query('DELETE FROM reservation WHERE appointment_id=ANY($1::uuid[])', [appointments]);
        await database.source.query('DELETE FROM appointment WHERE id=ANY($1::uuid[])', [appointments]);
        for (const { data } of before) await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [data.id, JSON.stringify(data)]);
        await database.source.query('DELETE FROM person WHERE id=$1', [personId]);
        await database.source.query('DELETE FROM crew WHERE id=$1', [crewId]);
        await database.source.query('DELETE FROM vehicle WHERE id=$1', [vehicleId]);
      }
    });

    await context.test('missing points and unavailable work stay distinct and stale selection is rejected atomically', async () => {
      const [selected] = await rows(database.source.manager, z.object({ data: DeliverySchema }),
        'SELECT data FROM delivery WHERE id=$1', [sesto]);
      assert.ok(selected);
      const missingPoint = { ...selected.data };
      delete missingPoint.routePoint;
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [sesto, JSON.stringify(missingPoint)]);
      const unlocated = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${sesto}&radiusKm=10`, 200));
      assert.equal(unlocated.anchorJob?.deliveryId, sesto);
      assert.equal(unlocated.anchorHasCoordinates, false);
      assert.deepEqual(unlocated.jobs, []);
      const candidates = RouteJobsSchema.parse(await expectStatus(`/routes/jobs?anchorId=${milano}&radiusKm=20`, 200));
      assert.deepEqual(candidates.jobs.map(({ deliveryId }) => deliveryId), [monza]);

      const blocked = { ...selected.data, sourceReview: true };
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [sesto, JSON.stringify(blocked)]);
      await expectStatus(`/routes/jobs?anchorId=${sesto}`, 404);
      await expectStatus('/routes', 409, 'POST', { ...draft, requestId: randomUUID() });
      const list = RouteDraftListSchema.parse(await expectStatus('/routes', 200));
      assert.equal(list.drafts.length, 1, 'An invalid selected stop cannot leave a partially saved draft');
      assert.equal(roadCalls, 0, 'Lookup, save, retry and detail never request road estimates');
    });

    await context.test('new Sicily address timing persists, reorders and invalidates stale manual references without Google', async () => {
      const references = [
        { id: milano, address: "Piazza San Francesco d'Assisi 3", point: { latitude: 37.5025956, longitude: 15.0843868 } },
        { id: monza, address: 'Piazza Federico II di Svevia', point: { latitude: 37.4989686, longitude: 15.084386 } },
      ];
      for (const reference of references) {
        const [stored] = await rows(database.source.manager, z.object({ data: DeliverySchema }),
          'SELECT data FROM delivery WHERE id=$1', [reference.id]);
        assert.ok(stored);
        const delivery = { ...stored.data, routePoint: reference.point,
          source: { ...stored.data.source, customer: { ...stored.data.source.customer, address: reference.address, city: 'Catania' } } };
        await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [reference.id, JSON.stringify(delivery)]);
      }
      const current = await deliverySnapshot();
      const sicily = {
        name: 'Sicily public reference timing', departAt: '2026-11-10T09:00:00+01:00', crewId: null, vehicleId: null,
        startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', useLocalEstimates: true,
        stops: [{ deliveryId: milano, workMinutes: 40 }, { deliveryId: monza, workMinutes: 35 }], manualEstimates: [],
      };
      await expectStatus('/routes/preview', 401, 'POST', sicily, '');
      await expectStatus('/routes/preview', 400, 'POST', { ...sicily, useLocalEstimates: 'yes' });
      const preview = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', sicily));
      assert.equal(preview.timeline.stops[0]?.eta, '2026-11-10T08:04:00.000Z');
      assert.equal(preview.timeline.stops[1]?.eta, '2026-11-10T08:46:00.000Z');
      assert.equal(preview.timeline.returnAt, '2026-11-10T09:26:00.000Z');
      assert.equal(preview.timeline.stops[0]?.travelSource, 'local_demo');
      assert.deepEqual(preview.warnings, []);
      const saved = RouteDetailSchema.parse(await expectStatus('/routes', 201, 'POST', { ...sicily, requestId: randomUUID() }));
      assert.equal(saved.useLocalEstimates, true);
      assertSameDraft(RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200)), saved);
      const reversed = RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200, 'PATCH', {
        ...sicily, version: saved.version, stops: [...sicily.stops].reverse(),
      }));
      assert.equal(reversed.timeline.stops[0]?.eta, '2026-11-10T08:05:00.000Z');
      assert.equal(reversed.timeline.stops[1]?.eta, '2026-11-10T08:42:00.000Z');
      assert.equal(reversed.timeline.returnTravelMinutes, 4);
      assertSameDraft(RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200)), reversed);

      const contextFor = (pointId: string) => {
        const found = preview.pointContexts.find((entry) => entry.pointId === pointId);
        assert.ok(found);
        return { point: found.point, addressKey: found.addressKey };
      };
      const manualEstimates = [
        { fromPointId: sicily.startPointId, toPointId: milano, minutes: 30 },
        { fromPointId: milano, toPointId: monza, minutes: 20 },
        { fromPointId: monza, toPointId: sicily.endPointId, minutes: 25 },
        { fromPointId: sicily.startPointId, toPointId: monza, minutes: 42 },
        { fromPointId: monza, toPointId: milano, minutes: 28 },
        { fromPointId: milano, toPointId: sicily.endPointId, minutes: 22 },
      ].map((estimate) => ({ ...estimate, context: { from: contextFor(estimate.fromPointId), to: contextFor(estimate.toPointId) } }));
      const manual = { ...sicily, manualEstimates };
      const manualForward = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', manual));
      assert.equal(manualForward.timeline.returnAt, '2026-11-10T10:30:00.000Z');
      assert.deepEqual(manualForward.warnings, []);
      const manualReverse = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', { ...manual, stops: [...sicily.stops].reverse() }));
      assert.equal(manualReverse.timeline.returnAt, '2026-11-10T10:47:00.000Z');
      const longer = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', {
        ...manual, stops: [...sicily.stops].reverse().map((stop, index) => index === 0 ? { ...stop, workMinutes: stop.workMinutes + 10 } : stop),
      }));
      assert.equal(longer.timeline.returnAt, '2026-11-10T10:57:00.000Z');
      const persisted = RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200, 'PATCH', { ...manual, version: reversed.version }));
      assert.deepEqual(persisted.manualEstimates, manualEstimates);
      assertSameDraft(RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200)), persisted);
      assert.deepEqual(await deliverySnapshot(), current, 'Timing and draft changes cannot mutate deliveries or book resources');

      const firstManual = manualEstimates[0];
      assert.ok(firstManual);
      const unverified = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', {
        ...sicily, manualEstimates: [{ fromPointId: firstManual.fromPointId, toPointId: firstManual.toPointId, minutes: 0 }],
      }));
      assert.equal(unverified.timeline.stops[0]?.travelMinutes, 0);
      assert.equal(unverified.warnings[0]?.code, 'manual_estimate_unverified');
      await expectStatus('/routes/preview', 400, 'POST', { ...sicily, manualEstimates: [{ ...firstManual, context: { from: firstManual.context.from } }] });
      const changedAddress = current.find(({ data }) => data.id === milano)?.data;
      assert.ok(changedAddress);
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [milano, JSON.stringify({ ...changedAddress,
        source: { ...changedAddress.source, customer: { ...changedAddress.source.customer, address: 'Via Etnea 397' } } })]);
      const staleAddress = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', manual));
      assert.equal(staleAddress.warnings.length, 2);
      assert.ok(staleAddress.warnings.every(({ code }) => code === 'manual_estimate_stale'));
      assert.equal(staleAddress.timeline.stops[0]?.travelSource, 'local_demo');
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [milano, JSON.stringify({ ...changedAddress,
        routePoint: { latitude: 37.5154798, longitude: 15.0834923 } })]);
      const staleCoordinate = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', manual));
      assert.equal(staleCoordinate.warnings.length, 2);
      assert.equal(staleCoordinate.timeline.stops[0]?.travelMinutes, 0);
      const unknown = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', { ...manual, useLocalEstimates: false }));
      assert.equal(unknown.timeline.stops[0]?.eta, null);
      assert.equal(unknown.timeline.returnAt, null);

      const confirmedVisit = AppointmentSchema.parse({
        id: randomUUID(), status: 'booked', startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T10:00:00Z',
        cancellationReason: null, returnRequestId: null, assignments: [], results: [],
        customerConfirmation: { confirmedAt: '2026-11-09T08:00:00Z', confirmedBy: { id: randomUUID(), name: 'DEMO operator' } },
        workScope: planVisitWork(changedAddress, [{ sourceLineId: 910011, deliveryMilli: 1000, installationMilli: 1000, collectionMilli: 0 }],
          { id: randomUUID(), name: 'DEMO operator', role: 'operator' }, '2026-11-09T08:00:00Z'),
      });
      const withFirstVisit = { ...changedAddress, appointments: [...changedAddress.appointments, confirmedVisit] };
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [milano, JSON.stringify({
        ...withFirstVisit,
      })]);
      const unbound = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', sicily));
      assert.equal(unbound.timeline.stops[0]?.windowStatus, 'none', 'Even a single visit must be selected explicitly');
      assert.equal(unbound.jobs[0]?.remaining.find((line) => line.sourceLineId === 910011)?.deliveryMilli, 1000);
      const unspecified = { ...sicily, stops: sicily.stops.map((stop) => stop.deliveryId === milano ? { ...stop, appointmentId: confirmedVisit.id } : stop) };
      const unspecifiedWindow = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', unspecified));
      assert.equal(unspecifiedWindow.timeline.stops[0]?.windowKind, 'unknown', 'A confirmed appointment does not define whether its end means arrival or completion');
      const bound = { ...sicily, stops: sicily.stops.map((stop) => stop.deliveryId === milano ? { ...stop, appointmentId: confirmedVisit.id,
        customerWindow: { kind: 'work_end', startsAt: confirmedVisit.startsAt, endsAt: confirmedVisit.endsAt } } : stop) };
      const window = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', bound));
      assert.equal(window.timeline.stops[0]?.windowStatus, 'confirmed');
      assert.equal(window.timeline.stops[0]?.windowStart, confirmedVisit.startsAt);
      assert.equal(window.timeline.stops[0]?.waitMinutes, 56);
      assert.equal(window.timeline.stops[0]?.workStartAt, '2026-11-10T09:00:00.000Z');
      assert.deepEqual(window.jobs[0]?.remaining.map(({ sourceLineId, deliveryMilli, installationMilli }) =>
        ({ sourceLineId, deliveryMilli, installationMilli })), [{ sourceLineId: 910011, deliveryMilli: 1000, installationMilli: 1000 }]);
      const secondVisit = AppointmentSchema.parse({ ...confirmedVisit, id: randomUUID(), startsAt: '2026-11-10T12:00:00Z', endsAt: '2026-11-10T13:00:00Z',
        workScope: planVisitWork(withFirstVisit, [{ sourceLineId: 910021, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }],
          { id: randomUUID(), name: 'DEMO operator', role: 'operator' }, '2026-11-09T08:00:00Z') });
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [milano, JSON.stringify({
        ...changedAddress, appointments: [...changedAddress.appointments, confirmedVisit, secondVisit],
      })]);
      const ambiguous = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', sicily));
      assert.equal(ambiguous.timeline.stops[0]?.windowStatus, 'none');
      assert.equal(ambiguous.timeline.stops[0]?.windowStart, null);
      assert.equal(ambiguous.timeline.stops[0]?.late, null);
      assert.equal(ambiguous.timeline.stops[0]?.waitMinutes, 0, 'An ambiguous appointment is never chosen arbitrarily');
      assert.equal(ambiguous.jobs[0]?.appointmentOptions.length, 2);
      const chosen = { ...sicily, stops: sicily.stops.map((stop) => stop.deliveryId === milano ? { ...stop, appointmentId: secondVisit.id,
        customerWindow: { kind: 'arrival', startsAt: secondVisit.startsAt, endsAt: secondVisit.endsAt } } : stop) };
      const secondWindow = RoutePreviewSchema.parse(await expectStatus('/routes/preview', 200, 'POST', chosen));
      assert.equal(secondWindow.timeline.stops[0]?.windowStart, secondVisit.startsAt);
      assert.deepEqual(secondWindow.jobs[0]?.remaining.map(({ sourceLineId }) => sourceLineId), [910021], 'Identical chair SKU in another order remains separate');
      const boundSaved = RouteDetailSchema.parse(await expectStatus('/routes', 201, 'POST', { ...chosen, requestId: randomUUID() }));
      assert.equal(boundSaved.stops[0]?.appointmentId, secondVisit.id);
      assert.equal(RouteDetailSchema.parse(await expectStatus(`/routes/${boundSaved.id}`, 200)).stops[0]?.appointmentId, secondVisit.id);
      await expectStatus('/routes/preview', 409, 'POST', { ...chosen, stops: chosen.stops.map((stop) => ({ ...stop, appointmentId: randomUUID() })) });
      await database.source.query('UPDATE delivery SET data=$2::jsonb WHERE id=$1', [milano, JSON.stringify({
        ...changedAddress, appointments: [...changedAddress.appointments, { ...confirmedVisit, workScope: undefined }],
      })]);
      await expectStatus('/routes/preview', 409, 'POST', sicily);
      const legacyDraft = RouteDetailSchema.parse(await expectStatus(`/routes/${saved.id}`, 200));
      assert.equal(legacyDraft.jobs.find(({ deliveryId }) => deliveryId === milano)?.workReviewReason, 'legacy_scope_review');
      assert.equal(roadCalls, 0, 'Local estimates, manual preview, save and reopen must not call the configured Google provider');
    });
    await context.test('route presentation seeds insert only dedicated fixtures and preserve later edits', async () => {
      const catalog: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
      assert.equal(await seedRouteFeasibility(database.source, catalog, true), 3);
      assert.equal(await seedRouteFeasibility(database.source, catalog, true), 0);
      const fixture = routeFeasibilityFixtures(catalog)[0]; assert.ok(fixture);
      const [record] = await rows(database.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [fixture.delivery.id]);
      assert.ok(record);
      const changed = { ...record.data, version: 2, source: { ...record.data.source, notes: 'DEMO later operator state must survive the seed' } };
      await database.source.query('UPDATE delivery SET version=2,data=$2::jsonb WHERE id=$1', [changed.id, JSON.stringify(changed)]);
      assert.equal(await seedRouteFeasibility(database.source, catalog, true), 0);
      const [preserved] = await rows(database.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [changed.id]);
      assert.deepEqual(preserved?.data, changed);
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
