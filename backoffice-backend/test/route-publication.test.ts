import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, DeliverySchema, IdSchema, InstantSchema, LineServiceStatusSchema, TaskTemplateSchema, VisitWorkScopeSchema, type Delivery } from '../src/domain/model';
import { hashPassword } from '../src/identity/identity';
import { AuditSchema, CrewSchema, ParticipantCalendarSchema, ParticipantSchema, SkillSchema, VehicleSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';
import { RouteDraftInputSchema, RouteTimelineSchema, type RouteDraftInput } from '../src/routing/contracts';
import { RouteFeasibilitySchema } from '../src/routing/feasibility';
import { GoogleRoads } from '../src/routing/google-maps';
import { RouteDetailSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { routeJob } from '../src/routing/service';

class PublicationDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

const Review = z.object({
  routeId: IdSchema, draftVersion: z.number().int().positive(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  publicationEnabled: z.boolean(), timeline: RouteTimelineSchema, feasibility: RouteFeasibilitySchema,
  stops: z.array(z.object({ deliveryId: IdSchema, mode: z.enum(['create', 'attach']), appointmentId: IdSchema,
    startsAt: InstantSchema, endsAt: InstantSchema, workScope: VisitWorkScopeSchema,
    responsibleParticipant: z.object({ id: IdSchema, name: z.string() }),
    customerConfirmationStatus: z.enum(['customer_confirmed', 'awaiting_customer_confirmation']),
  })),
});
const Published = z.object({ id: IdSchema, version: z.number().int().positive(), status: z.literal('published'),
  draftVersion: z.number().int().positive(), publishedAt: InstantSchema,
  stops: z.array(z.object({ deliveryId: IdSchema, appointmentId: IdSchema, source: z.enum(['created', 'attached']) })),
});
const Detail = z.object({ delivery: DeliverySchema, lineServices: z.array(LineServiceStatusSchema), history: z.array(AuditSchema) });
const ErrorReply = z.object({ code: z.string(), message: z.string() });
const workLines = [
  { sourceLineId: 31, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 },
  { sourceLineId: 32, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0 },
];
const departAt = '2032-05-12T07:00:00.000Z';

void test('route publication uses real authorization and atomic work/resource ownership on isolated PostgreSQL', async (context) => {
  const schema = `route_publication_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^route_publication_[a-f0-9]{32}$/);
  const control = makeDataSource(true);
  const db = new PublicationDatabase(schema);
  const previousFlag = process.env['ROUTE_PUBLICATION_ENABLED'];
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let adminCookie = '';
  let operatorCookie = '';
  let fixtureNumber = 0;
  let roadCalls = 0;
  const password = randomBytes(24).toString('base64url');

  async function request(path: string, method = 'GET', body?: unknown, cookie = operatorCookie, origin: string = config().FRONTEND_ORIGIN) {
    const response = await fetch(`${base}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json();
    return { response, data };
  }
  async function success(path: string, method = 'GET', body?: unknown, cookie = operatorCookie) {
    const result = await request(path, method, body, cookie);
    assert.ok(result.response.ok, `${method} ${path}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
  async function snapshot() {
    const tables = ['delivery', 'appointment', 'reservation', 'transport_reservation', 'route_publication', 'route_stop', 'route_reservation', 'command_receipt', 'audit', 'file_record'] as const;
    const result: Record<string, string[]> = {};
    for (const table of tables) {
      const data = await rows(db.source.manager, z.object({ value: z.string() }), `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`);
      result[table] = data.map(({ value }) => value);
    }
    return result;
  }
  async function fixture(count = 2) {
    fixtureNumber += 1;
    const label = fixtureNumber;
    const participant = ParticipantSchema.parse(await success('/participants', 'POST', {
      firstName: 'DEMO Luca', lastName: `Publication ${label}`, login: `route-member-${label}@example.test`, password,
    }, adminCookie));
    const crew = CrewSchema.parse(await success('/crews', 'POST', {
      name: `DEMO Publication ${label}`, area: 'Catania', classification: 'outdoor', enabled: true, participantIds: [participant.id],
    }, adminCookie));
    const vehicle = VehicleSchema.parse(await success('/vehicles', 'POST', {
      name: `DEMO Van ${label}`, plate: `DEMO PUB ${label}`, ownership: 'company', providerName: null, providerContact: null,
      operationalStatus: 'available', enabled: true, notes: null,
    }, adminCookie));
    const template = z.object({ id: IdSchema }).parse(await success('/templates', 'POST', {
      title: `DEMO Unload ${label}`, severity: 'low', order: 0, checklist: ['Check the exact order line'], enabled: true, requiredSkillIds: [],
    }, adminCookie));
    const deliveries: Delivery[] = [];
    for (let i = 0; i < count; i++) {
      const sourceId = label * 100 + i + 1;
      const orderId = sourceId * 10;
      const delivery = createDelivery({ pickingId: sourceId, pickingName: `DEMO/PUBLICATION/${sourceId}`, saleOrderId: orderId, saleOrderName: `SO/${orderId}`,
        salesOrders: [{ id: orderId, name: `SO/${orderId}` }, { id: orderId + 1, name: `SO/${orderId + 1}` }],
        sourceState: 'assigned', salesTeam: 'DEMO', customer: { id: sourceId, name: 'DEMO publication customer', address: `Piazza Test ${i + 1}`,
          city: 'Catania', country: 'IT', phones: ['+39000000001'], email: null, contact: null },
        items: [31, 32].map((sourceLineId, index) => ({ sourceLineId, saleOrderId: orderId + index, productId: 7, name: 'DEMO identical chair',
          quantity: 2, uom: 'unit', description: null, configuration: null, ambient: null, notes: null, photoUrl: null })),
        serviceType: 'delivery_only', estimatedMinutes: 60, notes: null }, randomUUID());
      delivery.routePoint = { latitude: 37.50 - i * 0.01, longitude: 15.084 };
      await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [delivery.id, schema, sourceId, delivery.version, JSON.stringify(delivery)]);
      deliveries.push(delivery);
    }
    const draft = RouteDraftInputSchema.parse({ name: `DEMO publication ${label}`, departAt, crewId: crew.id, vehicleId: vehicle.id,
      startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', useLocalEstimates: true,
      stops: deliveries.map((delivery) => ({ deliveryId: delivery.id, workMinutes: 30, workDurationSource: 'manual',
        workFingerprint: routeJob(delivery).workFingerprint, customerWindow: { kind: 'unrestricted' } })), manualEstimates: [],
      planning: { participantIds: [participant.id], participantAvailability: [{ participantId: participant.id,
        workingIntervals: [{ startsAt: '2032-05-12T06:00:00Z', endsAt: '2032-05-12T18:00:00Z' }], unavailableIntervals: [] }],
      vehicleAvailability: null, transferBufferMinutes: 5 },
    });
    return { participant, crew, vehicle, template, deliveries, draft };
  }
  async function saveDraft(draft: RouteDraftInput) {
    return RouteDetailSchema.parse(await success('/routes', 'POST', { ...draft, requestId: randomUUID() }));
  }
  function selections(f: Awaited<ReturnType<typeof fixture>>) {
    return f.deliveries.map((delivery) => ({ mode: 'create' as const, deliveryId: delivery.id, workLines,
      templateIds: [f.template.id], responsibleParticipantId: f.participant.id }));
  }
  async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
    const saved = await saveDraft(f.draft);
    const body = { version: saved.version, stops: selections(f) };
    const review = Review.parse(await success(`/routes/${saved.id}/publication-review`, 'POST', body));
    return { saved, body, review, publish: { ...body, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true } };
  }

  try {
    delete process.env['ROUTE_PUBLICATION_ENABLED'];
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.source.initialize();
    await db.source.runMigrations({ transaction: 'all' });
    for (const role of ['admin', 'operator']) await db.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), `${role}@publication.example.test`, `DEMO ${role}`, role, await hashPassword(password)]);
    await db.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(db)
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({
        settings: { browserKey: 'test-browser-key', routesKey: 'test-server-key' },
        compute: () => { roadCalls++; throw new Error('Publication must not call a road API'); },
      })).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const store = module.get(DeliveryStore);
    for (const role of ['admin', 'operator']) {
      const reply = await request('/auth/login', 'POST', { email: `${role}@publication.example.test`, password }, '');
      assert.equal(reply.response.status, 201);
      const cookie = reply.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
      if (role === 'admin') adminCookie = cookie; else operatorCookie = cookie;
    }

    await context.test('release gate defaults off; authorization, strict body and Origin protections remain real', async () => {
      const capability = z.object({ enabled: z.boolean(), reason: z.string().nullable() }).parse(await success('/routes/publication-capability'));
      assert.equal(capability.enabled, false);
      const f = await fixture();
      const prepared = await prepare(f);
      assert.equal(prepared.review.publicationEnabled, false);
      const absentPublication = await fetch(`${base}/api/routes/${prepared.saved.id}/publication`, {
        headers: { Cookie: operatorCookie, Origin: config().FRONTEND_ORIGIN },
      });
      assert.equal(absentPublication.status, 200);
      assert.match(absentPublication.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(await absentPublication.text(), 'null', 'An unpublished route must return JSON null, not an empty 200 body');
      const path = `/routes/${prepared.saved.id}/publish`;
      const before = await snapshot();
      const disabled = await request(path, 'POST', prepared.publish);
      assert.equal(disabled.response.status, 409);
      assert.equal(ErrorReply.parse(disabled.data).code, 'ROUTE_PUBLICATION_DISABLED');
      assert.deepEqual(await snapshot(), before);
      process.env['ROUTE_PUBLICATION_ENABLED'] = 'true';
      assert.equal(z.object({ enabled: z.boolean() }).parse(await success('/routes/publication-capability')).enabled, true);
      assert.equal((await request(path, 'POST', prepared.publish, '')).response.status, 401);
      assert.equal((await request(path, 'POST', prepared.publish, operatorCookie, 'https://untrusted.example.test')).response.status, 403);
      assert.equal((await request(path, 'POST', { ...prepared.publish, publishedBy: 'forged' })).response.status, 400);
      const member = await request('/crew/auth/login', 'POST', { login: f.participant.login, password }, '', config().CREW_FRONTEND_ORIGIN);
      assert.equal(member.response.status, 201);
      const memberCookie = member.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(memberCookie);
      assert.equal((await request(path, 'POST', prepared.publish, memberCookie)).response.status, 401);
      assert.deepEqual(await snapshot(), before);
    });

    await context.test('exact same-SKU order lines publish once, reserve the whole trip and remain customer-unconfirmed', async () => {
      const f = await fixture(); const prepared = await prepare(f);
      assert.equal(prepared.review.feasibility.status, 'feasible_estimate');
      const initial = await snapshot();
      const secondReview = Review.parse(await success(`/routes/${prepared.saved.id}/publication-review`, 'POST', prepared.body));
      assert.equal(secondReview.fingerprint, prepared.review.fingerprint);
      assert.deepEqual(await snapshot(), initial, 'Review must be read-only');
      const path = `/routes/${prepared.saved.id}/publish`;
      const [first, duplicate] = await Promise.all([success(path, 'POST', prepared.publish), success(path, 'POST', prepared.publish)]);
      const published = Published.parse(first);
      assert.deepEqual(Published.parse(duplicate), published);
      assert.equal(published.id, prepared.saved.id);
      assert.equal(published.stops.length, 2);
      assert.ok(published.stops.every(({ source }) => source === 'created'));
      const publishedDocument = await success(`/routes/${published.id}/publication`);
      assert.deepEqual(Published.parse(publishedDocument), published);
      assert.equal(z.object({ review: Review }).parse(publishedDocument).review.fingerprint, prepared.review.fingerprint,
        'Published detail includes the frozen exact review, not dynamically recomputed remaining work');
      for (const stop of published.stops) {
        const detail = Detail.parse(await success(`/deliveries/${stop.deliveryId}`));
        const visit = detail.delivery.appointments.find(({ id }) => id === stop.appointmentId); assert.ok(visit);
        assert.equal(detail.delivery.appointments.length, 1);
        assert.deepEqual(visit.workScope?.lines.map(({ sourceLineId, deliveryMilli }) => ({ sourceLineId, deliveryMilli })),
          [{ sourceLineId: 31, deliveryMilli: 1000 }, { sourceLineId: 32, deliveryMilli: 500 }]);
        assert.deepEqual(detail.lineServices.map(({ availableDeliveryMilli }) => availableDeliveryMilli), [1000, 1500]);
        assert.equal(visit.assignments.length, 1);
        assert.equal(visit.responsibleParticipant?.id, f.participant.id);
        assert.equal(visit.customerConfirmation, undefined);
      }
      const reservationRows = await rows(db.source.manager, z.object({ resource: z.string(), startsAt: z.date(), endsAt: z.date() }),
        'SELECT resource,starts_at AS "startsAt",ends_at AS "endsAt" FROM route_reservation WHERE route_id=$1 ORDER BY resource', [published.id]);
      assert.deepEqual(reservationRows.map(({ resource }) => resource).sort(), [`crew:${f.crew.id}`, `person:${f.participant.id}`, `vehicle:${f.vehicle.id}`].sort());
      assert.ok(reservationRows.every(({ startsAt, endsAt }) => startsAt.toISOString() === departAt && endsAt.toISOString() === prepared.review.timeline.returnAt));
      const committed = await snapshot();
      assert.deepEqual(Published.parse(await success(path, 'POST', prepared.publish)), published);
      assert.deepEqual(Published.parse(await success(path, 'POST', { ...prepared.publish,
        stops: prepared.publish.stops.map((stop) => ({ ...stop, workLines: [...stop.workLines].reverse() })),
      })), published, 'Reordering exact line selections is the same canonical request, unlike reordering route stops');
      assert.deepEqual(await snapshot(), committed);
      assert.equal((await request(path, 'POST', { ...prepared.publish, acknowledgeEstimates: false })).response.status, 409);
      assert.equal((await request(path, 'POST', { ...prepared.publish, requestId: randomUUID() })).response.status, 409);
      assert.deepEqual(await snapshot(), committed);
      assert.equal(roadCalls, 0);
    });

    await context.test('attaches the exact booked visit without duplicate assignments, changed confirmation or document metadata', async () => {
      const f = await fixture(); const first = f.deliveries[0]; assert.ok(first);
      const time = RoutePreviewSchema.parse(await success('/routes/preview', 'POST', f.draft)).timeline.stops[0];
      assert.ok(time?.workStartAt && time.workEndAt);
      let detail = Detail.parse(await success(`/deliveries/${first.id}/appointments`, 'POST', {
        version: first.version, requestId: randomUUID(), startsAt: '2032-05-13T08:00:00Z', endsAt: '2032-05-13T09:00:00Z',
        workLines: [{ sourceLineId: 31, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0 }],
      }));
      const unrelated = detail.delivery.appointments[0]; assert.ok(unrelated);
      detail = Detail.parse(await success(`/deliveries/${first.id}/appointments`, 'POST', {
        version: detail.delivery.version, requestId: randomUUID(), startsAt: time.workStartAt, endsAt: time.workEndAt, workLines,
      }));
      const appointment = detail.delivery.appointments.find(({ id }) => id !== unrelated.id); assert.ok(appointment);
      const visitPath = `/deliveries/${first.id}/appointments/${appointment.id}`;
      detail = Detail.parse(await success(`${visitPath}/assign`, 'POST', { version: detail.delivery.version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id] }));
      detail = Detail.parse(await success(`${visitPath}/responsible`, 'PATCH', { version: detail.delivery.version, participantId: f.participant.id }));
      detail = Detail.parse(await success(`${visitPath}/confirm-customer`, 'POST', { version: detail.delivery.version }));
      const preserved = detail.delivery.appointments.find(({ id }) => id === appointment.id); assert.ok(preserved);
      const historyBefore = detail.history;
      const documentId = randomUUID();
      await db.source.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,appointment_id,item_id,status,document_purpose,document_version,document_source)
        VALUES($1,$2,$3,'DEMO original drawing.pdf','application/pdf',10,'document',$4,31,'ready','drawing',1,'local_upload')`,
        [documentId, first.id, randomUUID(), appointment.id]);
      const documentBefore = await rows(db.source.manager, z.object({ json: z.string() }), 'SELECT row_to_json(f)::text AS json FROM file_record f WHERE id=$1', [documentId]);
      f.draft.stops = f.draft.stops.map((stop) => stop.deliveryId === first.id ? { ...stop, appointmentId: appointment.id, workFingerprint: routeJob(detail.delivery, undefined, appointment.id).workFingerprint } : stop);
      const saved = await saveDraft(f.draft);
      const body = { version: saved.version, stops: selections(f).map((stop) => stop.deliveryId === first.id
        ? { mode: 'attach' as const, deliveryId: first.id, appointmentId: appointment.id, responsibleParticipantId: f.participant.id } : stop) };
      const review = Review.parse(await success(`/routes/${saved.id}/publication-review`, 'POST', body));
      assert.equal(review.feasibility.status, 'feasible_estimate');
      const published = Published.parse(await success(`/routes/${saved.id}/publish`, 'POST', { ...body, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true }));
      assert.equal(published.stops[0]?.appointmentId, appointment.id);
      assert.equal(published.stops[0]?.source, 'attached');
      const after = Detail.parse(await success(`/deliveries/${first.id}`));
      assert.equal(after.delivery.appointments.length, 2);
      assert.deepEqual(after.delivery.appointments.find(({ id }) => id === unrelated.id), unrelated, 'The first booked visit is not selected implicitly');
      const attached = after.delivery.appointments.find(({ id }) => id === appointment.id); assert.ok(attached);
      assert.deepEqual({ id: attached.id, startsAt: attached.startsAt, endsAt: attached.endsAt, workScope: attached.workScope,
        assignments: attached.assignments, customerConfirmation: attached.customerConfirmation,
        responsibleParticipant: attached.responsibleParticipant, results: attached.results },
      { id: preserved.id, startsAt: preserved.startsAt, endsAt: preserved.endsAt, workScope: preserved.workScope,
        assignments: preserved.assignments, customerConfirmation: preserved.customerConfirmation,
        responsibleParticipant: preserved.responsibleParticipant, results: preserved.results });
      assert.ok(historyBefore.every((entry) => after.history.some((savedEntry) => savedEntry.id === entry.id && JSON.stringify(savedEntry.details) === JSON.stringify(entry.details))));
      assert.deepEqual(await rows(db.source.manager, z.object({ json: z.string() }), 'SELECT row_to_json(f)::text AS json FROM file_record f WHERE id=$1', [documentId]), documentBefore);
      const membership = await rows(db.source.manager, z.object({ source: z.string() }), 'SELECT source FROM route_stop WHERE appointment_id=$1 AND active', [appointment.id]);
      assert.deepEqual(membership, [{ source: 'attached' }]);
    });

    await context.test('a database failure late in publication rolls back visits, memberships, resources, audit and receipt', async () => {
      const f = await fixture(); const prepared = await prepare(f); const before = await snapshot();
      await db.source.query(`CREATE FUNCTION fail_publication_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'DEMO injected final reservation failure'; END $$;
        CREATE TRIGGER fail_publication_reservation BEFORE INSERT ON route_reservation FOR EACH ROW EXECUTE FUNCTION fail_publication_reservation();`);
      try {
        const failed = await request(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish);
        assert.equal(failed.response.status, 500);
        assert.ok(!JSON.stringify(failed.data).includes('DEMO injected'), 'Internal database error details stay private');
        assert.deepEqual(await snapshot(), before);
      } finally {
        await db.source.query('DROP TRIGGER fail_publication_reservation ON route_reservation; DROP FUNCTION fail_publication_reservation()');
      }
      const retried = Published.parse(await success(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish));
      assert.equal(retried.stops.length, 2, 'An unsuccessful transaction must not leave a success receipt');
    });

    await context.test('stale source, changed draft and missing estimate acknowledgement cannot publish any stop', async () => {
      const f = await fixture(); const prepared = await prepare(f); const first = f.deliveries[0]; assert.ok(first);
      const noAck = await request(`/routes/${prepared.saved.id}/publish`, 'POST', { ...prepared.publish, acknowledgeEstimates: false });
      assert.equal(noAck.response.status, 409);
      await db.source.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const current = await store.get(first.id, manager, true); current.version += 1;
        current.routePoint = { latitude: 37.49999, longitude: 15.084 };
        await store.save(manager, current);
      });
      const before = await snapshot();
      assert.equal((await request(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish)).response.status, 409);
      assert.deepEqual(await snapshot(), before);
      const fresh = await fixture(); const updated = await prepare(fresh);
      await success(`/routes/${updated.saved.id}`, 'PATCH', { ...fresh.draft, version: updated.saved.version, name: 'DEMO renamed after review' });
      const afterEdit = await snapshot();
      assert.equal((await request(`/routes/${updated.saved.id}/publish`, 'POST', updated.publish)).response.status, 409);
      assert.deepEqual(await snapshot(), afterEdit);
    });

    await context.test('publication waits for row-only evidence writers and preserves their committed issue photo linkage', async () => {
      const f = await fixture(1); const first = f.deliveries[0]; assert.ok(first);
      const withIssue = Detail.parse(await success(`/deliveries/${first.id}/issues`, 'POST', {
        version: first.version, type: 'other', description: 'DEMO packaging photo for dispatcher review', itemIds: [31],
      }));
      const issue = withIssue.delivery.issues[0]; assert.ok(issue);
      const photoId = randomUUID();
      await db.source.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,item_id,issue_id,status)
        VALUES($1,$2,$3,'DEMO packaging.jpg','image/jpeg',10,'photo',31,$4,'ready')`,
      [photoId, first.id, randomUUID(), issue.id]);
      const prepared = await prepare(f);
      const writer = db.source.createQueryRunner();
      await writer.connect(); await writer.startTransaction();
      let publication: ReturnType<typeof request> | undefined;
      let blocked = false;
      let expectedVersion = withIssue.delivery.version;
      try {
        // Mirrors upload finalization: a delivery row lock, without the scheduling advisory lock.
        const current = await store.get(first.id, writer.manager, true);
        const currentIssue = current.issues.find(({ id }) => id === issue.id); assert.ok(currentIssue);
        currentIssue.photoIds.push(photoId); current.version += 1; expectedVersion = current.version;
        await store.save(writer.manager, current);
        const [writerPid] = await rows(writer.manager, z.object({ pid: z.number().int() }), 'SELECT pg_backend_pid() AS pid');
        assert.ok(writerPid);
        publication = request(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [waiting] = await rows(control.manager, z.object({ blocked: z.boolean() }), `SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity a WHERE a.datname='delivery_backoffice_test'
              AND a.application_name=$1 AND $2::integer=ANY(pg_blocking_pids(a.pid))) AS blocked`, [schema, writerPid.pid]);
          if (waiting?.blocked) { blocked = true; break; }
          await setTimeout(20);
        }
      } finally {
        await writer.commitTransaction(); await writer.release();
      }
      assert.ok(publication); const result = await publication;
      assert.equal(blocked, true, 'The real HTTP publication must wait for the independent row writer');
      assert.equal(result.response.status, 409, 'The committed evidence change invalidates the prior review before any publication writes');
      assert.equal(ErrorReply.parse(result.data).code, 'ROUTE_PREVIEW_STALE');
      const retained = await store.get(first.id);
      assert.equal(retained.version, expectedVersion); assert.equal(retained.appointments.length, 0);
      assert.deepEqual(retained.issues.find(({ id }) => id === issue.id)?.photoIds, [photoId]);
      const [unpublished] = await rows(db.source.manager, z.object({ count: z.number() }),
        'SELECT count(*)::int AS count FROM route_publication WHERE id=$1', [prepared.saved.id]);
      assert.equal(unpublished?.count, 0);
      const fresh = Review.parse(await success(`/routes/${prepared.saved.id}/publication-review`, 'POST', prepared.body));
      await success(`/routes/${prepared.saved.id}/publish`, 'POST', { ...prepared.publish, fingerprint: fresh.fingerprint });
      const published = await store.get(first.id);
      assert.equal(published.version, expectedVersion + 1); assert.equal(published.appointments.length, 1);
      assert.deepEqual(published.issues.find(({ id }) => id === issue.id)?.photoIds, [photoId]);
    });

    await context.test('two publications with the same person and vehicle cannot both reserve overlapping trips', async () => {
      const f = await fixture(); const first = await prepare(f);
      const competing = await fixture();
      competing.participant = f.participant; competing.crew = f.crew; competing.vehicle = f.vehicle;
      competing.draft = { ...competing.draft, crewId: f.crew.id, vehicleId: f.vehicle.id, planning: f.draft.planning };
      const secondSaved = await saveDraft(competing.draft);
      const secondBody = { version: secondSaved.version, stops: selections(competing) };
      const secondReview = Review.parse(await success(`/routes/${secondSaved.id}/publication-review`, 'POST', secondBody));
      const replies = await Promise.all([
        request(`/routes/${first.saved.id}/publish`, 'POST', first.publish),
        request(`/routes/${secondSaved.id}/publish`, 'POST', { ...secondBody, requestId: randomUUID(), fingerprint: secondReview.fingerprint, acknowledgeEstimates: true }),
      ]);
      assert.deepEqual(replies.map(({ response }) => response.status).sort(), [200, 409]);
      const publicationCount = await rows(db.source.manager, z.object({ count: z.number() }),
        'SELECT count(*)::int AS count FROM route_publication WHERE id=ANY($1::uuid[])', [[first.saved.id, secondSaved.id]]);
      assert.equal(publicationCount[0]?.count, 1);
      const appointmentCounts = await Promise.all([...f.deliveries, ...competing.deliveries].map(async (delivery) => (await store.get(delivery.id)).appointments.length));
      assert.equal(appointmentCounts.reduce((sum, count) => sum + count, 0), 2, 'Different delivery work cannot disguise double booking the shared trip resources');
    });

    await context.test('a standalone quantity booking and publication serialize without allocating the same remaining work twice', async () => {
      const f = await fixture(); const prepared = await prepare(f); const first = f.deliveries[0]; assert.ok(first);
      const replies = await Promise.all([
        request(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish),
        request(`/deliveries/${first.id}/appointments`, 'POST', { version: first.version, requestId: randomUUID(),
          startsAt: '2032-05-13T08:00:00Z', endsAt: '2032-05-13T09:00:00Z',
          workLines: [{ sourceLineId: 31, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 }] }),
      ]);
      const publicationStatus = replies[0]?.response.status; const bookingStatus = replies[1]?.response.status;
      assert.ok(publicationStatus === 200 && bookingStatus === 409 || publicationStatus === 409 && bookingStatus === 201,
        `Expected exactly one winner, got Publish ${publicationStatus} / Book ${bookingStatus}`);
      const after = Detail.parse(await success(`/deliveries/${first.id}`));
      assert.equal(after.delivery.appointments.length, 1);
      assert.ok(after.lineServices.every(({ availableDeliveryMilli }) => availableDeliveryMilli >= 0));
      assert.ok(after.lineServices.every(({ reservedDeliveryMilli }) => reservedDeliveryMilli <= 2000));
    });

    await context.test('route-owned resources block standalone assignments even only on the return leg, and direct route-child edits are guarded', async () => {
      const f = await fixture(); const prepared = await prepare(f);
      const published = Published.parse(await success(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish));
      const stop = published.stops[0]; assert.ok(stop);
      let detail = Detail.parse(await success(`/deliveries/${stop.deliveryId}`));
      const visitPath = `/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}`;
      const before = await snapshot();
      for (const [path, method, body] of [
        [`${visitPath}/cancel`, 'POST', { version: detail.delivery.version, reason: 'Attempt standalone cancellation' }],
        [visitPath, 'PATCH', { version: detail.delivery.version, startsAt: '2032-05-14T08:00:00Z', endsAt: '2032-05-14T09:00:00Z' }],
        [`${visitPath}/work-scope`, 'PATCH', { version: detail.delivery.version, requestId: randomUUID(), reason: 'Attempt standalone scope edit', workLines }],
      ] as const) {
        assert.equal((await request(path, method, body)).response.status, 409);
      }
      assert.deepEqual(await snapshot(), before);
      const other = await fixture(1); const delivery = other.deliveries[0]; assert.ok(delivery);
      const from = prepared.review.timeline.returnDepartAt; const to = prepared.review.timeline.returnAt; assert.ok(from && to);
      detail = Detail.parse(await success(`/deliveries/${delivery.id}/appointments`, 'POST', {
        version: delivery.version, requestId: randomUUID(), startsAt: from, endsAt: to, workLines,
      }));
      const appointment = detail.delivery.appointments[0]; assert.ok(appointment);
      const otherPath = `/deliveries/${delivery.id}/appointments/${appointment.id}`;
      const staffing = z.object({ people: z.array(z.object({ id: IdSchema, busy: z.boolean() })) }).parse(await success(`${otherPath}/participants`));
      assert.equal(staffing.people.find(({ id }) => id === f.participant.id)?.busy, true);
      assert.equal((await request(`${otherPath}/assign`, 'POST', { version: detail.delivery.version, requestId: randomUUID(), crewIds: [f.crew.id], templateIds: [f.template.id] })).response.status, 409);
      const availability = z.object({ vehicles: z.array(z.object({ id: IdSchema, busy: z.boolean() })) }).parse(await success(`${otherPath}/transport/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
      assert.equal(availability.vehicles.find(({ id }) => id === f.vehicle.id)?.busy, true);
      assert.equal((await request(`${otherPath}/transport`, 'POST', { version: detail.delivery.version, requestId: randomUUID(),
        vehicleId: f.vehicle.id, reserveFrom: from, reserveTo: to, driver: { kind: 'participant', participantId: f.participant.id } })).response.status, 409);
    });
    await context.test('published routes retain required resources and skills, block early Start and appear in the participant calendar', async () => {
      const f = await fixture(1);
      const skill = SkillSchema.parse(await success('/skills', 'POST', { name: `DEMO publication skill ${fixtureNumber}`, description: null, enabled: true }, adminCookie));
      f.participant = ParticipantSchema.parse(await success(`/participants/${f.participant.id}/skills`, 'PATCH', {
        version: f.participant.version, skillIds: [skill.id],
      }, adminCookie));
      const template = TaskTemplateSchema.parse(await success(`/templates/${f.template.id}`));
      await success(`/templates/${template.id}`, 'PATCH', { ...template, requiredSkillIds: [skill.id] }, adminCookie);
      const prepared = await prepare(f);
      const published = Published.parse(await success(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish));
      const stop = published.stops[0]; assert.ok(stop);
      const detail = Detail.parse(await success(`/deliveries/${stop.deliveryId}`));
      const confirmed = Detail.parse(await success(`/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}/confirm-customer`, 'POST', { version: detail.delivery.version }));
      const member = await request('/crew/auth/login', 'POST', { login: f.participant.login, password }, '', config().CREW_FRONTEND_ORIGIN);
      assert.equal(member.response.status, 201);
      const cookie = member.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
      const crewVisit = await request(`/crew/visits/${stop.appointmentId}`, 'GET', undefined, cookie, config().CREW_FRONTEND_ORIGIN);
      assert.equal(crewVisit.response.status, 200);
      assert.equal(z.object({ canStart: z.boolean() }).parse(crewVisit.data).canStart, false);
      const start = await request(`/crew/visits/${stop.appointmentId}/start`, 'POST', { version: confirmed.delivery.version, requestId: randomUUID() }, cookie, config().CREW_FRONTEND_ORIGIN);
      assert.equal(start.response.status, 409);
      assert.equal((await store.get(stop.deliveryId)).appointments[0]?.status, 'booked');
      const calendar = ParticipantCalendarSchema.parse(await success(`/participants/${f.participant.id}/calendar?from=2032-05-12T06%3A00%3A00Z&to=2032-05-12T18%3A00%3A00Z`));
      assert.deepEqual(calendar.routeReservations?.map(({ routeId, startsAt, endsAt, bufferMinutes }) => ({ routeId, startsAt, endsAt, bufferMinutes })),
        [{ routeId: published.id, startsAt: departAt, endsAt: prepared.review.timeline.returnAt, bufferMinutes: 5 }]);
      const before = await snapshot();
      assert.equal((await request(`/skills/${skill.id}`, 'PATCH', { version: skill.version, name: skill.name, description: skill.description, enabled: false }, adminCookie)).response.status, 409);
      assert.equal((await request(`/participants/${f.participant.id}/skills`, 'PATCH', { version: f.participant.version, skillIds: [] }, adminCookie)).response.status, 409);
      assert.equal((await request(`/vehicles/${f.vehicle.id}`, 'PATCH', { version: f.vehicle.version, name: f.vehicle.name, plate: f.vehicle.plate,
        ownership: f.vehicle.ownership, providerName: null, providerContact: null, operationalStatus: 'maintenance', enabled: true, notes: null }, adminCookie)).response.status, 409);
      assert.equal((await request(`/crews/${f.crew.id}`, 'PATCH', { version: f.crew.version, name: f.crew.name, area: f.crew.area,
        classification: f.crew.classification, enabled: false, participantIds: [f.participant.id] }, adminCookie)).response.status, 409);
      assert.equal((await request(`/participants/${f.participant.id}`, 'PATCH', { version: f.participant.version, firstName: f.participant.firstName,
        lastName: f.participant.lastName, preferredName: null, phoneNumber: null, address: null, login: f.participant.login,
        external: false, enabled: false, skillIds: [skill.id] }, adminCookie)).response.status, 409);
      assert.equal((await request(`/participants/${f.participant.id.toUpperCase()}`, 'PATCH', { version: f.participant.version, firstName: f.participant.firstName,
        lastName: f.participant.lastName, preferredName: null, phoneNumber: null, address: null, login: f.participant.login,
        external: false, enabled: false, skillIds: [skill.id] }, adminCookie)).response.status, 409);
      assert.deepEqual(await snapshot(), before);
      const retainedPerson = ParticipantSchema.parse(await success(`/participants/${f.participant.id}`));
      assert.equal(retainedPerson.enabled, true); assert.deepEqual(retainedPerson.skillIds, [skill.id]);
      assert.equal(z.array(VehicleSchema).parse(await success('/vehicles')).find(({ id }) => id === f.vehicle.id)?.operationalStatus, 'available');
      assert.equal(CrewSchema.parse(await success(`/crews/${f.crew.id}`)).enabled, true);
    });

    await context.test('unknown customer windows cannot be waived by accepting estimates', async () => {
      const f = await fixture(1);
      f.draft.stops = f.draft.stops.map((stop) => ({ ...stop, customerWindow: { kind: 'unknown' } }));
      const prepared = await prepare(f);
      assert.equal(prepared.review.feasibility.status, 'insufficient_data');
      assert.ok(prepared.review.feasibility.findings.some(({ code }) => code === 'customer_window_unknown'));
      const before = await snapshot();
      assert.equal((await request(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish)).response.status, 409);
      assert.deepEqual(await snapshot(), before);
    });

    await context.test('publishes a legacy draft without the saved driver or any driver contact', async () => {
      const external = await fixture(1); assert.ok(external.draft.planning);
      const saved = RouteDetailSchema.parse(await success('/routes', 'POST', { ...external.draft, requestId: randomUUID(),
        planning: { ...external.draft.planning, driver: undefined } }));
      assert.deepEqual(saved.planning?.driver, { kind: 'none' });
      await db.source.query("UPDATE route_draft SET data=jsonb_set(data, '{planning,driver}', $2::jsonb) WHERE id=$1", [
        saved.id, JSON.stringify({ kind: 'external', name: 'DEMO legacy driver', availability: null }),
      ]);
      const input = { version: saved.version, stops: selections(external) };
      const complete = Review.parse(await success(`/routes/${saved.id}/publication-review`, 'POST', input));
      assert.equal(complete.feasibility.status, 'feasible_estimate');
      await success(`/routes/${saved.id}/publish`, 'POST', { ...input, requestId: randomUUID(), fingerprint: complete.fingerprint, acknowledgeEstimates: true });
      const live = RouteOperationsSchema.parse(await success(`/routes/${saved.id}/operations`));
      assert.equal(live.externalDriverPhone, null);
      assert.deepEqual(live.draft.planning?.driver, { kind: 'none' });
      assert.deepEqual(live.resources.driver, { kind: 'none' });
    });

    await context.test('route-to-route transfer uses the larger buffer exactly once', async () => {
      const first = await fixture(1); const prepared = await prepare(first);
      await success(`/routes/${prepared.saved.id}/publish`, 'POST', prepared.publish);
      const returned = prepared.review.timeline.returnAt; assert.ok(returned);
      const second = await fixture(1);
      second.crew = first.crew; second.participant = first.participant; second.vehicle = first.vehicle;
      second.draft = { ...second.draft, crewId: first.crew.id, vehicleId: first.vehicle.id,
        departAt: new Date(Date.parse(returned) + 5 * 60_000).toISOString(),
        planning: first.draft.planning };
      const adjacent = await prepare(second);
      assert.equal(adjacent.review.feasibility.status, 'feasible_estimate', 'A five-minute gap meets both five-minute buffers; they are not summed');
      const tooClose = await saveDraft({ ...second.draft, departAt: new Date(Date.parse(returned) + 4 * 60_000).toISOString() });
      const nearReview = Review.parse(await success(`/routes/${tooClose.id}/publication-review`, 'POST', { version: tooClose.version, stops: selections(second) }));
      assert.equal(nearReview.feasibility.status, 'conflict');
      assert.ok(nearReview.feasibility.findings.some(({ code }) => code === 'resource_busy'));
    });

    assert.equal(roadCalls, 0);
  } finally {
    if (previousFlag === undefined) delete process.env['ROUTE_PUBLICATION_ENABLED']; else process.env['ROUTE_PUBLICATION_ENABLED'] = previousFlag;
    if (app) await app.close(); else if (db.source.isInitialized) await db.source.destroy();
    if (control.isInitialized) {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.destroy();
    }
  }
});
