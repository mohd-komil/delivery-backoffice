import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../../src/app';
import { applicationUrl, config } from '../../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../../src/database/database';
import { createDelivery, DeliverySchema, IdSchema, LineServiceStatusSchema, type Delivery, type QuantityResultSchema, type WorkLineInput } from '../../src/domain/model';
import { Files } from '../../src/evidence/files';
import { hashPassword } from '../../src/identity/identity';
import { AuditSchema, CrewSchema, ParticipantSchema, VehicleSchema } from '../../src/operations/contracts';
import { DeliveryStore } from '../../src/operations/store';
import { RouteDraftInputSchema } from '../../src/routing/contracts';
import { RouteDetailSchema, RoutePreviewSchema } from '../../src/routing/http-contracts';
import { PublicationReviewSchema, PublicationSummarySchema } from '../../src/routing/publication-contracts';
import { GoogleRoads } from '../../src/routing/google-maps';
import { routeJob } from '../../src/routing/service';
import { CrewVisitDetailSchema } from '../../src/crew/contracts';

class LifecycleDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

class LifecycleFiles extends Files {
  override readonly directory: string;
  constructor(store: DeliveryStore, directory: string) { super(store); this.directory = directory; }
}

export const DeliveryDetail = z.object({ delivery: DeliverySchema, lineServices: z.array(LineServiceStatusSchema), history: z.array(AuditSchema) });
export const ErrorCode = z.object({ code: z.string() });
type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; cookie?: string; origin?: string };
type Quantity = z.infer<typeof QuantityResultSchema>;

export async function lifecycleFixture() {
  const schema = `route_lifecycle_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^route_lifecycle_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new LifecycleDatabase(schema);
  const directory = await mkdtemp(join(tmpdir(), 'backoffice-route-lifecycle-'));
  const previousGate = process.env['ROUTE_PUBLICATION_ENABLED'];
  process.env['ROUTE_PUBLICATION_ENABLED'] = 'true';
  const password = randomBytes(24).toString('base64url');
  let app: NestExpressApplication | undefined;
  let created = false;
  let base = '';
  let operatorCookie = '';
  let adminCookie = '';
  let ordinal = 0;

  async function close() {
    if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy();
    if (control.isInitialized) {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.destroy();
    }
    for (const file of await readdir(directory, { withFileTypes: true })) {
      assert.ok(file.isFile(), 'Only owned flat evidence files may be cleaned');
      await unlink(join(directory, file.name));
    }
    await rmdir(directory);
    if (previousGate === undefined) delete process.env['ROUTE_PUBLICATION_ENABLED']; else process.env['ROUTE_PUBLICATION_ENABLED'] = previousGate;
  }
  async function request(path: string, options: RequestOptions = {}) {
    const { method = 'GET', body, cookie = operatorCookie, origin = path.startsWith('/crew/') ? config().CREW_FRONTEND_ORIGIN : config().FRONTEND_ORIGIN } = options;
    const response = await fetch(`${base}/api${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function ok(path: string, options: RequestOptions = {}) {
    const reply = await request(path, options);
    const error = ErrorCode.safeParse(reply.data);
    assert.ok(reply.status >= 200 && reply.status < 300,
      `${options.method ?? 'GET'} ${path}: ${reply.status}${error.success ? ` ${error.data.code}` : ''}`);
    return reply.data;
  }
  async function login(loginName: string) {
    const result = await request('/crew/auth/login', { method: 'POST', body: { login: loginName, password }, cookie: '' });
    assert.equal(result.status, 201);
    const cookie = result.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    return cookie;
  }
  async function person(label: string) {
    ordinal++;
    return ParticipantSchema.parse(await ok('/participants', { method: 'POST', cookie: adminCookie,
      body: { firstName: 'DEMO', lastName: label, login: `lifecycle-${ordinal}@example.test`, password } }));
  }
  async function fixture(options: { count?: number; buffer?: number; service?: 'delivery_only' | 'delivery_installation' | 'collection_only'; departAt?: string } = {}) {
    const participant = await person('Marco Rossi');
    const colleague = await person('Luca Bianchi');
    const label = ordinal;
    const crew = CrewSchema.parse(await ok('/crews', { method: 'POST', cookie: adminCookie,
      body: { name: `DEMO Lifecycle ${label}`, area: 'Catania', classification: 'outdoor', enabled: true, participantIds: [participant.id, colleague.id] } }));
    const vehicle = VehicleSchema.parse(await ok('/vehicles', { method: 'POST', cookie: adminCookie,
      body: { name: `DEMO Lifecycle van ${label}`, plate: `DEMO LC ${label}`, ownership: 'company', providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: null } }));
    const template = z.object({ id: IdSchema }).parse(await ok('/templates', { method: 'POST', cookie: adminCookie,
      body: { title: `DEMO Inspect ${label}`, severity: 'low', order: 0, checklist: ['Check the source order line'], enabled: true, requiredSkillIds: [] } }));
    const deliveries: Delivery[] = [];
    const service = options.service ?? 'delivery_only';
    for (let index = 0; index < (options.count ?? 2); index++) {
      const sourceId = label * 100 + index + 1;
      const orderId = sourceId * 10;
      const delivery = createDelivery({ pickingId: sourceId, pickingName: `DEMO/LIFECYCLE/${sourceId}`, saleOrderId: orderId, saleOrderName: `SO/${orderId}`,
        salesOrders: [{ id: orderId, name: `SO/${orderId}` }, { id: orderId + 1, name: `SO/${orderId + 1}` }], sourceState: 'assigned', salesTeam: 'DEMO',
        customer: { id: sourceId, name: 'DEMO client', address: `Piazza Test ${index + 1}`, city: 'Catania', country: 'IT', phones: ['+39000000001'], email: null, contact: null },
        items: [31, 32].map((sourceLineId, offset) => ({ sourceLineId, saleOrderId: orderId + offset, productId: 7, name: 'DEMO identical chair',
          quantity: 2, uom: 'unit', description: null, configuration: null, ambient: null, notes: null, photoUrl: null })),
        serviceType: service, estimatedMinutes: 60, notes: null }, randomUUID());
      delivery.routePoint = { latitude: 37.50 - index * 0.01, longitude: 15.084 };
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [delivery.id, schema, sourceId, delivery.version, JSON.stringify(delivery)]);
      deliveries.push(delivery);
    }
    const departAt = options.departAt ?? new Date(Date.now() - 10 * 60_000).toISOString();
    const dayStart = new Date(Date.parse(departAt) - 24 * 60 * 60_000).toISOString();
    const dayEnd = new Date(Date.parse(departAt) + 24 * 60 * 60_000).toISOString();
    const workLines: WorkLineInput[] = [31, 32].map((sourceLineId) => ({ sourceLineId,
      deliveryMilli: service === 'collection_only' ? 0 : 1000, installationMilli: service === 'delivery_installation' ? 1000 : 0, collectionMilli: service === 'collection_only' ? 1000 : 0 }));
    const draft = RouteDraftInputSchema.parse({ name: `DEMO lifecycle ${label}`, departAt, crewId: crew.id, vehicleId: vehicle.id,
      startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', useLocalEstimates: true, manualEstimates: [],
      stops: deliveries.map((delivery) => ({ deliveryId: delivery.id, workMinutes: 30, workDurationSource: 'manual', workFingerprint: routeJob(delivery).workFingerprint,
        customerWindow: { kind: 'unrestricted' } })),
      planning: { participantIds: [participant.id, colleague.id], participantAvailability: [participant, colleague].map(({ id }) => ({ participantId: id,
        workingIntervals: [{ startsAt: dayStart, endsAt: dayEnd }], unavailableIntervals: [] })),
        vehicleAvailability: null, driver: { kind: 'participant', participantId: participant.id }, transferBufferMinutes: options.buffer ?? 0 } });
    return { participant, colleague, crew, vehicle, template, deliveries, draft, workLines, cookie: await login(participant.login ?? ''), colleagueCookie: await login(colleague.login ?? '') };
  }
  async function detail(deliveryId: string) { return DeliveryDetail.parse(await ok(`/deliveries/${deliveryId}`)); }
  async function confirm(deliveryId: string, appointmentId: string) {
    const current = await detail(deliveryId);
    if (current.delivery.appointments.find(({ id }) => id === appointmentId)?.customerConfirmation) return current;
    return DeliveryDetail.parse(await ok(`/deliveries/${deliveryId}/appointments/${appointmentId}/confirm-customer`, { method: 'POST', body: { version: current.delivery.version } }));
  }
  async function publish(f: Awaited<ReturnType<typeof fixture>>, attachFirst = false, withAttachedTransport = false) {
    if (attachFirst) {
      const first = f.deliveries[0]; const stop = f.draft.stops[0]; assert.ok(first && stop);
      const timing = RoutePreviewSchema.parse(await ok('/routes/preview', { method: 'POST', body: f.draft })).timeline.stops[0];
      assert.ok(timing?.workStartAt && timing.workEndAt);
      let current = DeliveryDetail.parse(await ok(`/deliveries/${first.id}/appointments`, { method: 'POST', body: {
        version: first.version, requestId: randomUUID(), startsAt: timing.workStartAt, endsAt: timing.workEndAt, workLines: f.workLines } }));
      const visit = current.delivery.appointments[0]; assert.ok(visit);
      const endpoint = `/deliveries/${first.id}/appointments/${visit.id}`;
      current = DeliveryDetail.parse(await ok(`${endpoint}/assign`, { method: 'POST', body: { version: current.delivery.version, requestId: randomUUID(),
        crewIds: [f.crew.id], templateIds: [f.template.id], staffing: [{ crewId: f.crew.id, participantIds: [f.participant.id, f.colleague.id] }] } }));
      await ok(`${endpoint}/responsible`, { method: 'PATCH', body: { version: current.delivery.version, participantId: f.participant.id } });
      current = await confirm(first.id, visit.id);
      if (withAttachedTransport) current = DeliveryDetail.parse(await ok(`${endpoint}/transport`, { method: 'POST', body: {
        version: current.delivery.version, requestId: randomUUID(), vehicleId: f.vehicle.id, reserveFrom: timing.workStartAt, reserveTo: timing.workEndAt,
        driver: { kind: 'participant', participantId: f.participant.id },
      } }));
      stop.appointmentId = visit.id; stop.workFingerprint = routeJob(current.delivery, undefined, visit.id).workFingerprint;
    }
    const saved = RouteDetailSchema.parse(await ok('/routes', { method: 'POST', body: { ...f.draft, requestId: randomUUID() } }));
    const input = { version: saved.version, stops: f.deliveries.map((delivery, index) => attachFirst && index === 0
      ? { mode: 'attach', deliveryId: delivery.id, appointmentId: f.draft.stops[index]?.appointmentId, responsibleParticipantId: f.participant.id }
      : { mode: 'create', deliveryId: delivery.id, responsibleParticipantId: f.participant.id, workLines: f.workLines, templateIds: [f.template.id] }) };
    const review = PublicationReviewSchema.parse(await ok(`/routes/${saved.id}/publication-review`, { method: 'POST', body: input }));
    assert.equal(review.feasibility.status, 'feasible_estimate');
    const command = { ...input, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true };
    const published = PublicationSummarySchema.parse(await ok(`/routes/${saved.id}/publish`, { method: 'POST', body: command }));
    return { ...published, draft: f.draft, review, command };
  }
  async function start(appointmentId: string, cookie: string) {
    const current = CrewVisitDetailSchema.parse(await ok(`/crew/visits/${appointmentId}`, { cookie }));
    return CrewVisitDetailSchema.parse(await ok(`/crew/visits/${appointmentId}/start`, { method: 'POST', cookie, body: { version: current.version, requestId: randomUUID() } }));
  }
  async function finish(appointmentId: string, cookie: string, quantities: Quantity[], incompleteWork: unknown[] = []) {
    let visit = CrewVisitDetailSchema.parse(await ok(`/crew/visits/${appointmentId}`, { cookie }));
    for (const item of visit.tasks.flatMap(({ checklist }) => checklist)) {
      visit = CrewVisitDetailSchema.parse(await ok(`/crew/visits/${appointmentId}/checklist/${item.id}`, { method: 'PATCH', cookie,
        body: { version: visit.version, requestId: randomUUID(), done: true } }));
    }
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 170, b: 120 } } }).png().toBuffer();
    return CrewVisitDetailSchema.parse(await ok(`/crew/visits/${appointmentId}/finish`, { method: 'POST', cookie, body: {
      version: visit.version, requestId: randomUUID(), summary: 'DEMO exact line work result', quantities, incompleteWork,
      itemChecks: quantities.map(({ sourceLineId }) => ({ sourceLineId, status: 'ok', note: null })),
      customerSignature: { signerName: 'DEMO customer', strokes: [[{ x: 100, y: 150 }, { x: 180, y: 240 }, { x: 280, y: 130 }]] },
      crewSignature: { strokes: [[{ x: 150, y: 170 }, { x: 220, y: 100 }, { x: 310, y: 210 }]] },
      photos: [{ name: 'demo-lifecycle.png', base64: bytes.toString('base64'), sourceLineId: 31 }],
    } }));
  }
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await database.source.initialize(); await database.source.runMigrations({ transaction: 'all' });
    for (const role of ['admin', 'operator']) await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), `${role}@lifecycle.example.test`, `DEMO ${role}`, role, await hashPassword(password)]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database)
      .overrideProvider(Files).useFactory({ factory: (store: DeliveryStore) => new LifecycleFiles(store, directory), inject: [DeliveryStore] })
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({ settings: undefined, compute: () => { throw new Error('No road provider is permitted'); } })).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    for (const role of ['admin', 'operator']) {
      const reply = await request('/auth/login', { method: 'POST', cookie: '', body: { email: `${role}@lifecycle.example.test`, password } });
      assert.equal(reply.status, 201); const cookie = reply.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
      if (role === 'admin') adminCookie = cookie; else operatorCookie = cookie;
    }
    return { schema, database, request, ok, person, fixture, publish, confirm, detail, start, finish, login, close, adminCookie, operatorCookie };
  } catch (error: unknown) { await close(); throw error; }
}

export type LifecycleFixture = Awaited<ReturnType<typeof lifecycleFixture>>;
export type LifecycleRoute = Awaited<ReturnType<LifecycleFixture['publish']>>;
