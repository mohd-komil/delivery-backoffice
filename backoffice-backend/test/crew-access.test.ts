import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { seedMvpPilot } from '../scripts/demo-pilot';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { CrewVisitListSchema } from '../src/crew/contracts';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { AppointmentSchema, createDelivery as createUnplannedDelivery, DeliverySchema, IdSchema, InstantSchema, InstructionsSchema, LineServiceStatusSchema, ServiceTypeSchema, TaskTemplateSchema, type Appointment, type Delivery, type SourceSnapshot, type VisitResult } from '../src/domain/model';
import { instantiateTask, lineServiceStatuses } from '../src/domain/rules';
import { Files } from '../src/evidence/files';
import { hashPassword } from '../src/identity/identity';
import { AuditSchema, CrewSchema, FileSchema, ParticipantSchema, VehicleSchema, type Participant } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';
import { AddressSuggestionResponseSchema } from '../src/routing/address-suggestion';
import { EntranceResponseSchema } from '../src/routing/entrances';
import { GoogleGeocoder } from '../src/routing/google-geocoder';
import { GoogleRoads } from '../src/routing/google-maps';
import { RouteJobsSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { DeliveryListSchema } from '../src/operations/delivery-list';

class CrewTestDatabase extends Database {
  override readonly source: DataSource;

  constructor(schema: string) {
    super();
    this.source = new DataSource({
      type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema },
    });
  }
}

class CrewTestFiles extends Files {
  override readonly directory: string;

  constructor(store: DeliveryStore, directory: string) {
    super(store);
    this.directory = directory;
  }
}

// Independent strict response contracts catch accidental disclosure even if the production decoder strips unknown keys.
const CrewIdentity = z.object({ id: IdSchema, name: z.string(), role: z.literal('crew') }).strict();
const CrewVisitSummary = z.object({
  id: IdSchema, pickingName: z.string(), startsAt: InstantSchema, endsAt: InstantSchema,
  status: z.enum(['booked', 'in_progress', 'completed', 'failed']),
  confirmationStatus: z.enum(['awaiting_customer_confirmation', 'customer_confirmed']).nullable(),
  destination: z.object({ address: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable() }).strict(),
  crews: z.array(z.object({ id: IdSchema, name: z.string() }).strict()),
  vehicles: z.array(z.object({ id: IdSchema, name: z.string(), plate: z.string() }).strict()),
  route: CrewVisitListSchema.shape.visits.element.shape.route,
  routeStartBlocker: CrewVisitListSchema.shape.visits.element.shape.routeStartBlocker,
}).strict();
const CrewVisitDetail = CrewVisitSummary.extend({
  version: z.number().int().positive(),
  responsibleParticipant: z.object({ id: IdSchema, name: z.string() }).strict().nullable(),
  canFinish: z.boolean(),
  canStart: z.boolean(),
  scopeReviewReason: z.enum(['missing_scope', 'source_review', 'source_changed', 'work_changed', 'stock_pending', 'damage_hold']).nullable(),
  workScope: z.object({ revision: z.number().int().positive(), confirmedAt: InstantSchema,
    lines: z.array(z.object({ sourceLineId: z.number().int().positive(), deliveryMilli: z.number().int().nonnegative(),
      installationMilli: z.number().int().nonnegative(), collectionMilli: z.number().int().nonnegative(),
      customerStockConfirmed: z.boolean().optional(), service: ServiceTypeSchema }).strict()),
  }).strict().nullable(),
  failedAttempt: z.object({
    reason: z.string(), at: InstantSchema, actor: z.object({ id: IdSchema, name: z.string() }).strict(),
  }).strict().optional(),
  actualStartedAt: InstantSchema.nullable(),
  unfinishedChecklistCount: z.number().int().nonnegative(),
  customer: z.object({ name: z.string(), contact: z.string().nullable(), phones: z.array(z.string()) }).strict(),
  instructions: InstructionsSchema,
  documents: z.array(z.object({ id: IdSchema, name: z.string(), mime: z.string(), itemId: z.number().int().positive().nullable(), createdAt: z.string(),
    documentPurpose: z.enum(['general', 'instruction', 'drawing']).nullable(), documentVersion: z.number().int().positive().nullable(),
    documentSource: z.literal('local_upload').nullable(), supersedesFileId: IdSchema.nullable(), uploadedBy: z.object({ id: IdSchema, name: z.string() }).nullable(),
  }).strict()).optional(),
  issues: z.array(z.object({ id: IdSchema, type: z.enum(['damage', 'missing_parts', 'access', 'other']), description: z.string(),
    itemIds: z.array(z.number().int().positive()), appointmentId: IdSchema.optional(), status: z.enum(['open', 'resolved']),
  }).strict()).optional(),
  items: z.array(z.object({
    sourceLineId: z.number().int().positive(), name: z.string(), quantity: z.number().nonnegative(),
    uom: z.string(), configuration: z.string().nullable(), notes: z.string().nullable(), remainingMilli: z.number().int().nonnegative(),
    orderName: z.string().optional(),
    serviceWork: z.object({ service: ServiceTypeSchema.nullable(), remainingDeliveryMilli: z.number(), remainingInstallationMilli: z.number(),
      remainingCollectionMilli: z.number(), availableInstallationMilli: z.number(),
      plannedDeliveryMilli: z.number().int().nonnegative(), plannedInstallationMilli: z.number().int().nonnegative(),
      plannedCollectionMilli: z.number().int().nonnegative() }).strict().optional(),
  }).strict()),
  tasks: z.array(z.object({
    id: IdSchema, title: z.string(),
    checklist: z.array(z.object({ id: IdSchema, label: z.string(), done: z.boolean(), waived: z.boolean() }).strict()),
  }).strict()),
}).strict();
const BackofficeDetail = z.object({
  delivery: DeliverySchema, files: z.array(FileSchema), history: z.array(AuditSchema),
  deliveredQuantities: z.array(z.object({ sourceLineId: z.number().int().positive(), deliveredMilli: z.number().int().nonnegative() })),
  lineServices: z.array(LineServiceStatusSchema),
  closureBlockers: z.array(z.string()),
});
const HttpError = z.object({ code: z.string(), message: z.string() }).strict();
const ErrorCode = HttpError.pick({ code: true }).strip();
const LoginCookie = /^[0-9a-f]{64}$/;

type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH'; cookie?: string; body?: unknown; origin?: string };
type HttpReply = { status: number; data: unknown; headers: Headers };

function cookieFrom(reply: HttpReply, name: string): string {
  const cookie = reply.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, `Expected a ${name} cookie`);
  assert.ok(cookie.startsWith(`${name}=`), `Expected a ${name} cookie`);
  assert.ok(LoginCookie.test(cookie.slice(name.length + 1)), 'Expected an opaque session token');
  return cookie;
}

function assertNoStore(reply: HttpReply): void {
  const directives = reply.headers.get('cache-control')?.toLowerCase().split(',').map((value) => value.trim()) ?? [];
  assert.ok(directives.includes('private'), 'Sensitive responses must be private');
  assert.ok(directives.includes('no-store'), 'Sensitive responses must not be cached');
}

function appointment(delivery: Delivery, id: string) {
  const found = delivery.appointments.find((visit) => visit.id === id);
  assert.ok(found, 'Expected the specified appointment in the backoffice response');
  return found;
}

function drawnSignatures(signerName: string, offset = 0) {
  return {
    customerSignature: { signerName, strokes: [[{ x: 120 + offset, y: 260 }, { x: 200 + offset, y: 180 }, { x: 290 + offset, y: 265 }]] },
    crewSignature: { strokes: [[{ x: 410, y: 145 + offset }, { x: 460, y: 220 + offset }, { x: 540, y: 160 + offset }]] },
  };
}

function createDelivery(source: SourceSnapshot, id: string): Delivery {
  return { ...createUnplannedDelivery(source, id), servicePlan: { defaultService: 'delivery_only', overrides: [] } };
}

/** Fixture planning confirms the synthetic customer's installation-only stock explicitly. */
function demoRemainingWork(delivery: Delivery) {
  return lineServiceStatuses(delivery).filter((line) => line.availableDeliveryMilli + line.availableInstallationMilli + line.availableCollectionMilli > 0)
    .map((line) => ({ sourceLineId: line.sourceLineId, deliveryMilli: line.availableDeliveryMilli,
      installationMilli: line.availableInstallationMilli, collectionMilli: line.availableCollectionMilli,
      ...(line.service === 'installation_only' ? { customerStockConfirmed: true } : {}),
    }));
}

function assertCapturedSignatures(result: VisitResult, submitted: ReturnType<typeof drawnSignatures>, responsibleName: string): void {
  assert.deepEqual(result.customerSignature, { status: 'signed', capture: 'drawn', ...submitted.customerSignature, at: result.actualEnd });
  assert.deepEqual(result.crewSignature, { status: 'signed', capture: 'drawn', signerName: responsibleName, ...submitted.crewSignature, at: result.actualEnd });
}

void test('crew access and visit work through Nest HTTP use isolated credentials, actual staffing and private evidence', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `crew_access_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^crew_access_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new CrewTestDatabase(schema);
  let schemaCreated = false;
  let app: NestExpressApplication | undefined;
  const { FRONTEND_ORIGIN: backofficeOrigin, CREW_FRONTEND_ORIGIN: crewOrigin } = config();
  const adminEmail = 'crew-access-admin@example.test';
  const adminPassword = randomBytes(24).toString('base64url');
  const crewPassword = randomBytes(24).toString('base64url');
  const filesDirectory = await mkdtemp(join(tmpdir(), 'backoffice-crew-http-'));
  const roadCalls: number[][] = [];
  try {
    await control.initialize();
    const target = await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    assert.equal(target.length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), adminEmail, 'DEMO backoffice administrator', 'admin', await hashPassword(adminPassword)]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database).useValue(database)
      .overrideProvider(Files).useFactory({ factory: (store: DeliveryStore) => new CrewTestFiles(store, filesDirectory), inject: [DeliveryStore] })
      .overrideProvider(GoogleGeocoder).useValue(new GoogleGeocoder({ settings: undefined }))
      .overrideProvider(GoogleRoads).useValue(new GoogleRoads({
        settings: { browserKey: 'test-browser-key', routesKey: 'test-server-key' },
        compute: (key, points) => {
          assert.equal(key, 'test-server-key');
          const latitudes = points.map(({ latitude }) => latitude);
          roadCalls.push(latitudes);
          return Promise.resolve(latitudes[1] === 45.4642
            ? { legSeconds: [720, 960, 1200], encodedPolyline: 'first_path' }
            : { legSeconds: [1800, 360, 1500], encodedPolyline: 'second_path' });
        },
      }))
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    async function request(path: string, options: RequestOptions = {}): Promise<HttpReply> {
      const { method = 'GET', cookie, body, origin = path.startsWith('/crew/') ? crewOrigin : backofficeOrigin } = options;
      const headers: Record<string, string> = { Origin: origin };
      if (cookie) headers['Cookie'] = cookie;
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const reply = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data: unknown = await reply.json();
      return { status: reply.status, data, headers: reply.headers };
    }

    async function expectStatus(path: string, status: number, options?: RequestOptions): Promise<HttpReply> {
      const reply = await request(path, options);
      // Keep failed-response diagnostics free of returned credentials and private fixture values.
      const error = HttpError.safeParse(reply.data);
      assert.equal(reply.status, status, `${options?.method ?? 'GET'} ${path}${error.success ? ` (${error.data.code})` : ''}`);
      return reply;
    }

    const admin = await expectStatus('/auth/login', 201, { method: 'POST', body: { email: adminEmail, password: adminPassword } });
    const adminCookie = cookieFrom(admin, 'backoffice_session');

    async function backoffice(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST', cookie = adminCookie): Promise<unknown> {
      return (await expectStatus(path, method === 'POST' ? 201 : 200, { method, body, cookie })).data;
    }

    async function persistFixture(snapshot: Delivery): Promise<void> {
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [snapshot.id, schema, snapshot.source.pickingId, snapshot.version, JSON.stringify(snapshot)]);
    }

    async function createParticipant(name: string, login?: string): Promise<Participant> {
      return ParticipantSchema.parse(await backoffice('/participants', {
        firstName: 'DEMO', lastName: name, preferredName: name,
        phoneNumber: '+390000000321', address: 'DEMO private participant address',
        ...(login ? { login, password: crewPassword } : {}),
      }));
    }

    async function updateParticipant(person: Participant, change: { enabled?: boolean; password?: string }): Promise<Participant> {
      const { version, firstName, lastName, preferredName, phoneNumber, address, login, external, enabled } = person;
      return ParticipantSchema.parse(await backoffice(`/participants/${person.id}`, {
        version, firstName, lastName, preferredName, phoneNumber, address, login, external, enabled, ...change,
      }, 'PATCH'));
    }

    async function crewLogin(login: string, password = crewPassword) {
      const reply = await expectStatus('/crew/auth/login', 201, { method: 'POST', body: { login, password } });
      assertNoStore(reply);
      assert.equal(reply.headers.get('access-control-allow-origin'), null);
      assert.equal(reply.headers.get('access-control-allow-credentials'), null);
      const attributes = reply.headers.get('set-cookie')?.split(';').slice(1).map((value) => value.trim().toLowerCase()) ?? [];
      assert.ok(attributes.includes('httponly'));
      assert.ok(attributes.includes('samesite=strict'));
      assert.ok(attributes.includes('path=/api/crew'));
      assert.ok(attributes.includes('max-age=28800'));
      assert.equal(attributes.some((value) => value.startsWith('domain=')), false, 'Crew cookies are host-only');
      return { cookie: cookieFrom(reply, 'crew_session'), identity: CrewIdentity.parse(reply.data) };
    }

    async function crewVisits(cookie: string) {
      const reply = await expectStatus('/crew/visits', 200, { cookie });
      assertNoStore(reply);
      return CrewVisitListSchema.parse(reply.data).visits;
    }

    async function crewDetail(cookie: string, visitId: string) {
      const reply = await expectStatus(`/crew/visits/${visitId}`, 200, { cookie });
      assertNoStore(reply);
      return CrewVisitDetail.parse(reply.data);
    }

    async function crewWrite(path: string, body: unknown, status: number, cookie: string, method: 'POST' | 'PATCH' = 'POST') {
      const reply = await expectStatus(path, status, { method, body, cookie });
      assertNoStore(reply);
      return reply.data;
    }

    async function withRejectedCrewReceipt(operation: () => Promise<void>) {
      await database.source.query(`CREATE FUNCTION reject_crew_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'DEMO intentional crew receipt failure'; END; $$;
        CREATE TRIGGER crew_test_receipt_failure BEFORE INSERT ON command_receipt
        FOR EACH ROW EXECUTE FUNCTION reject_crew_test_receipt()`);
      try {
        await operation();
      } finally {
        await database.source.query('DROP TRIGGER crew_test_receipt_failure ON command_receipt; DROP FUNCTION reject_crew_test_receipt()');
      }
    }

    let participant = await createParticipant('Flexible crew member', 'crew-flex@example.test');
    const rosterOnly = await createParticipant('Default roster member', 'crew-roster@example.test');
    const otherMember = await createParticipant('Other crew member', 'crew-other@example.test');
    const memberSession = await crewLogin('CREW-FLEX@EXAMPLE.TEST');
    const rosterSession = await crewLogin('crew-roster@example.test');

    await context.test('separate crew credentials and cookies cannot cross into backoffice routes', async () => {
      assert.deepEqual(memberSession.identity, { id: participant.id, name: participant.name, role: 'crew' });
      const me = await expectStatus('/crew/auth/me', 200, { cookie: memberSession.cookie });
      assertNoStore(me);
      assert.deepEqual(CrewIdentity.parse(me.data), memberSession.identity);
      const wrongPassword = await expectStatus('/crew/auth/login', 401, { method: 'POST', body: { login: 'crew-flex@example.test', password: 'incorrect password' } });
      const adminCredentials = await expectStatus('/crew/auth/login', 401, { method: 'POST', body: { login: adminEmail, password: adminPassword } });
      assert.deepEqual(HttpError.parse(adminCredentials.data), HttpError.parse(wrongPassword.data));
      assertNoStore(wrongPassword);
      assert.equal(wrongPassword.headers.has('set-cookie'), false);
      await expectStatus('/crew/auth/login', 400, { method: 'POST', body: { login: 'crew-flex@example.test', password: crewPassword, role: 'admin' } });
      const wrongOrigin = await expectStatus('/crew/auth/login', 403, { method: 'POST', origin: backofficeOrigin, body: { login: 'crew-flex@example.test', password: crewPassword } });
      assertNoStore(wrongOrigin);
      assert.equal(wrongOrigin.headers.get('access-control-allow-origin'), null);
      const foreignRead = await expectStatus('/crew/visits', 403, { origin: backofficeOrigin, cookie: memberSession.cookie });
      assertNoStore(foreignRead);
      assert.equal(foreignRead.headers.get('access-control-allow-origin'), null);
      const anonymous = await expectStatus('/crew/visits', 401);
      assertNoStore(anonymous);
      await expectStatus('/crew/visits', 401, { cookie: adminCookie });
      await expectStatus('/crew/auth/me', 401, { cookie: adminCookie });
      await expectStatus('/auth/me', 401, { cookie: memberSession.cookie });
      await expectStatus('/deliveries', 401, { cookie: memberSession.cookie });
      await expectStatus('/auth/login', 401, { method: 'POST', body: { email: 'crew-flex@example.test', password: crewPassword } });
    });

    async function createCrew(name: string, participantIds: string[]) {
      return CrewSchema.parse(await backoffice('/crews', { name, participantIds, classification: 'indoor', area: 'DEMO crew area', enabled: true }));
    }

    async function createTask(title: string, checklist = ['Check fictional package']) {
      return TaskTemplateSchema.parse(await backoffice('/templates', { title, severity: 'low', order: 1, checklist, enabled: true }));
    }

    const homeCrew = await createCrew('DEMO flexible member default crew', [participant.id]);
    const assignedCrew = await createCrew('DEMO actual visit crew', [rosterOnly.id]);
    const otherCrew = await createCrew('DEMO other crew on the same visit', [otherMember.id]);
    const visibleTask = await createTask('DEMO actual assignment task');
    const privateTask = await createTask('DEMO other crew task');
    let delivery = createDelivery({
      pickingId: 1, pickingName: 'DEMO/CREW-ACCESS/1', saleOrderId: 41, saleOrderName: 'DEMO/SO/41',
      sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
      customer: { id: 1, name: 'DEMO customer', address: 'DEMO delivery address', city: 'Messina', country: 'IT', phones: ['+390000000123'], email: 'private-customer@example.test', contact: 'DEMO site contact' },
      items: [{ sourceLineId: 11, productId: 3, name: 'DEMO box', description: 'DEMO internal product description', quantity: 1.5, uom: 'unit', configuration: 'DEMO oak', ambient: 'DEMO room', notes: 'DEMO handling note', photoUrl: null }],
      serviceType: null, estimatedMinutes: null, notes: 'DEMO source-only notes',
    }, randomUUID());
    await persistFixture(delivery);
    const deliveryPath = `/deliveries/${delivery.id}`;

    async function book(startsAt: string, endsAt: string, deliveryMilli = 100): Promise<string> {
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments`, {
        version: delivery.version, requestId: randomUUID(), startsAt, endsAt,
        workLines: [{ sourceLineId: 11, deliveryMilli, installationMilli: 0, collectionMilli: 0 }],
      })).delivery;
      const created = delivery.appointments.at(-1);
      assert.ok(created);
      return created.id;
    }

    async function assign(visitId: string, crewId: string, taskId: string, participantIds?: string[]): Promise<void> {
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${visitId}/assign`, {
        version: delivery.version, requestId: randomUUID(), crewIds: [crewId], templateIds: [taskId],
        ...(participantIds ? { staffing: [{ crewId, participantIds }] } : {}),
      })).delivery;
    }

    async function confirm(visitId: string): Promise<void> {
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${visitId}/confirm-customer`, { version: delivery.version })).delivery;
    }

    async function readBackoffice(path = deliveryPath) {
      return BackofficeDetail.parse((await expectStatus(path, 200, { cookie: adminCookie })).data);
    }

    const ownedVisit = await book('2031-05-07T08:00:00Z', '2031-05-07T09:00:00Z');
    await assign(ownedVisit, assignedCrew.id, visibleTask.id, [participant.id]);
    await assign(ownedVisit, otherCrew.id, privateTask.id);
    const foreignVisit = await book('2031-05-07T11:00:00Z', '2031-05-07T12:00:00Z');
    await assign(foreignVisit, assignedCrew.id, privateTask.id);
    await confirm(foreignVisit);
    const unassignedVisit = await book('2031-05-07T14:00:00Z', '2031-05-07T15:00:00Z');
    const vehicle = VehicleSchema.parse(await backoffice('/vehicles', {
      ownership: 'external', name: 'DEMO visit van', plate: 'DEMO CREW-1', providerName: 'DEMO private provider',
      providerContact: '+390000000987', operationalStatus: 'available', enabled: true, notes: 'DEMO internal vehicle note',
    }));
    delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${ownedVisit}/transport`, {
      version: delivery.version, requestId: randomUUID(), vehicleId: vehicle.id,
      reserveFrom: '2031-05-07T07:30:00Z', reserveTo: '2031-05-07T09:30:00Z',
      driver: { kind: 'external', name: 'DEMO private driver', phone: '+390000000654' },
    })).delivery;

    await context.test('actual visit staffing authorizes only the selected person and exposes only their own crew/tasks', async () => {
      assert.ok(homeCrew.people.some((person) => person.id === participant.id));
      assert.equal(assignedCrew.people.some((person) => person.id === participant.id), false);
      const visible = await crewVisits(memberSession.cookie);
      assert.deepEqual(visible.map((visit) => visit.id), [ownedVisit]);
      assert.equal(visible[0]?.confirmationStatus, 'awaiting_customer_confirmation');
      assert.ok(visible.every(({ route }) => route === null), 'Standalone visits must not imply a published route');
      assert.deepEqual((await crewVisits(rosterSession.cookie)).map((visit) => visit.id), [foreignVisit]);
      const missing = await expectStatus(`/crew/visits/${randomUUID()}`, 404, { cookie: memberSession.cookie });
      assertNoStore(missing);
      for (const visitId of [foreignVisit, unassignedVisit]) {
        const denied = await expectStatus(`/crew/visits/${visitId}`, 404, { cookie: memberSession.cookie });
        assertNoStore(denied);
        assert.deepEqual(HttpError.parse(denied.data), HttpError.parse(missing.data));
      }
      await expectStatus(`/crew/visits/${ownedVisit}`, 404, { cookie: rosterSession.cookie });
      await expectStatus('/crew/visits/not-a-visit', 400, { cookie: memberSession.cookie });

      const detail = await crewDetail(memberSession.cookie, ownedVisit);
      assert.equal(detail.route, null);
      assert.equal(detail.routeStartBlocker, null, 'Standalone visits have no route departure or stop-order blocker');
      assert.equal(detail.id, ownedVisit);
      assert.equal(detail.pickingName, delivery.source.pickingName);
      assert.deepEqual(detail.crews, [{ id: assignedCrew.id, name: assignedCrew.name }]);
      assert.deepEqual(detail.vehicles, [{ id: vehicle.id, name: vehicle.name, plate: vehicle.plate }]);
      assert.deepEqual(detail.destination, { address: 'DEMO delivery address', city: 'Messina', country: 'IT' });
      assert.deepEqual(detail.customer, { name: 'DEMO customer', contact: 'DEMO site contact', phones: ['+390000000123'] });
      assert.deepEqual(detail.items, [{ sourceLineId: 11, name: 'DEMO box', quantity: 1.5, uom: 'unit', configuration: 'DEMO oak', notes: 'DEMO handling note', remainingMilli: 1500, orderName: 'DEMO/SO/41',
        serviceWork: { service: 'delivery_only', remainingDeliveryMilli: 1500, remainingInstallationMilli: 0, remainingCollectionMilli: 0,
          availableInstallationMilli: 0, plannedDeliveryMilli: 100, plannedInstallationMilli: 0, plannedCollectionMilli: 0 } }]);
      assert.deepEqual(detail.tasks.map((task) => task.title), [visibleTask.title]);
      assert.deepEqual(detail.tasks.flatMap((task) => task.checklist.map(({ label, done, waived }) => ({ label, done, waived }))),
        [{ label: 'Check fictional package', done: false, waived: false }]);
    });

    await context.test('customer confirmation is a backoffice command and remains a separate crew read status', async () => {
      const route = `${deliveryPath}/appointments/${ownedVisit}/confirm-customer`;
      await expectStatus(route, 401, { method: 'POST', body: { version: delivery.version }, cookie: memberSession.cookie });
      assert.equal((await crewDetail(memberSession.cookie, ownedVisit)).confirmationStatus, 'awaiting_customer_confirmation');
      await confirm(ownedVisit);
      assert.equal((await crewDetail(memberSession.cookie, ownedVisit)).confirmationStatus, 'customer_confirmed');
      assert.equal((await crewVisits(memberSession.cookie))[0]?.confirmationStatus, 'customer_confirmed');
      assert.equal((await crewDetail(memberSession.cookie, ownedVisit)).status, 'booked');
      const activeAllocation = appointment(delivery, ownedVisit).transportAllocations?.find((entry) => entry.status === 'active');
      assert.ok(activeAllocation);
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${ownedVisit}/transport/${activeAllocation.id}/cancel`, {
        version: delivery.version, requestId: randomUUID(), reason: 'DEMO free old travel window for rescheduling',
      })).delivery;
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${ownedVisit}`, {
        version: delivery.version, startsAt: '2031-05-07T08:15:00Z', endsAt: '2031-05-07T09:15:00Z',
      }, 'PATCH')).delivery;
      const moved = await crewDetail(memberSession.cookie, ownedVisit);
      assert.equal(Date.parse(moved.startsAt), Date.parse('2031-05-07T08:15:00Z'));
      assert.equal(moved.confirmationStatus, 'awaiting_customer_confirmation');
      assert.deepEqual(moved.vehicles, []);
      await confirm(ownedVisit);
    });

    await context.test('removing an actual participant immediately removes access and cancellation hides the visit', async () => {
      const original = appointment(delivery, ownedVisit);
      const assignments = original.assignments.map((entry) => ({
        assignmentId: entry.id,
        participantIds: entry.crewId === assignedCrew.id ? [rosterOnly.id] : entry.people.map((person) => person.id),
      }));
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${ownedVisit}/participants`, {
        version: delivery.version, assignments, reason: 'DEMO replace the actual flexible participant',
      }, 'PATCH')).delivery;
      assert.deepEqual(await crewVisits(memberSession.cookie), []);
      await expectStatus(`/crew/visits/${ownedVisit}`, 404, { cookie: memberSession.cookie });
      await expectStatus('/crew/auth/me', 200, { cookie: memberSession.cookie });
      assert.equal((await crewDetail(rosterSession.cookie, ownedVisit)).confirmationStatus, 'customer_confirmed');
      await crewWrite(`/crew/visits/${ownedVisit}/start`, { version: delivery.version, requestId: randomUUID() }, 404, memberSession.cookie);
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${ownedVisit}/cancel`, {
        version: delivery.version, reason: 'DEMO cancelled visit stays in backoffice history',
      })).delivery;
      assert.deepEqual((await crewVisits(rosterSession.cookie)).map((visit) => visit.id), [foreignVisit]);
      await expectStatus(`/crew/visits/${ownedVisit}`, 404, { cookie: rosterSession.cookie });
      assert.equal(appointment(delivery, ownedVisit).status, 'cancelled');
    });

    await context.test('confirmed crew work starts once, updates own checklist and stores issue photos atomically', async () => {
      const workTask = await createTask('DEMO execution task', ['Check the delivered package', 'Operator-waived step']);
      const workVisit = await book('2031-05-08T08:00:00Z', '2031-05-08T09:00:00Z');
      await assign(workVisit, assignedCrew.id, workTask.id, [participant.id]);
      await assign(workVisit, otherCrew.id, privateTask.id);
      delivery=BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${workVisit}/responsible`,{
        version:delivery.version,participantId:participant.id,
      },'PATCH')).delivery;
      const work = appointment(delivery, workVisit);
      const ownTask = work.assignments.find((entry) => entry.crewId === assignedCrew.id)?.tasks[0];
      const ownCheck = ownTask?.checklist[0]; const waivedCheck = ownTask?.checklist[1];
      const foreignCheck = work.assignments.find((entry) => entry.crewId === otherCrew.id)?.tasks[0]?.checklist[0];
      assert.ok(ownCheck && waivedCheck && foreignCheck);
      const route = `/crew/visits/${workVisit}`;
      const ownChecklist = `${route}/checklist/${ownCheck.id}`;
      const cookie = memberSession.cookie;
      const initial = await crewDetail(cookie, workVisit);
      const start = { version: initial.version, requestId: randomUUID() };
      const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#224466' } }).png().toBuffer();
      const report = {
        version: initial.version, requestId: randomUUID(), type: 'damage', description: 'DEMO damaged carton photographed at the visit',
        itemIds: [11], photo: { name: 'DEMO damaged carton.png', base64: image.toString('base64') },
      };

      const beforeStart = await readBackoffice();
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/start`, start, 409, cookie)).code, 'CUSTOMER_CONFIRMATION_REQUIRED');
      await crewWrite(`${route}/start`, start, 404, rosterSession.cookie);
      await crewWrite(`/crew/visits/${foreignVisit}/start`, start, 404, cookie);
      assert.equal(ErrorCode.parse(await crewWrite(ownChecklist, { ...start, done: true }, 409, cookie, 'PATCH')).code, 'VISIT_NOT_IN_PROGRESS');
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/issues`, report, 409, cookie)).code, 'VISIT_NOT_IN_PROGRESS');
      assert.deepEqual(await readBackoffice(), beforeStart);
      assert.deepEqual(await readdir(filesDirectory), []);

      await confirm(workVisit);
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${workVisit}/checklist/${waivedCheck.id}/waive`, {
        version: delivery.version, reason: 'DEMO operator waiver reason is not crew-visible',
      })).delivery;
      const confirmed = await crewDetail(cookie, workVisit);
      assert.equal(confirmed.status, 'booked');
      const started = CrewVisitDetail.parse(await crewWrite(`${route}/start`, { ...start, version: confirmed.version }, 201, cookie));
      assert.equal(started.status, 'in_progress');
      assert.equal(started.version, confirmed.version + 1);
      const row = await rows(database.source.manager, z.object({ status: z.literal('in_progress') }), 'SELECT status FROM appointment WHERE id=$1 AND delivery_id=$2', [workVisit, delivery.id]);
      assert.equal(row.length, 1, 'The PostgreSQL appointment row reflects the start command');

      const afterStart = await readBackoffice();
      assert.equal(appointment(afterStart.delivery, workVisit).status, 'in_progress');
      const startAudit = afterStart.history.find((entry) => entry.action === 'execution.started');
      assert.equal(startAudit?.actorId, participant.id);
      assert.equal(z.object({ appointmentId: IdSchema }).parse(startAudit?.details).appointmentId, workVisit);
      const markDone = { version: started.version, requestId: randomUUID(), done: true };
      await crewWrite(`${route}/checklist/${foreignCheck.id}`, markDone, 404, cookie, 'PATCH');
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/checklist/${waivedCheck.id}`, markDone, 409, cookie, 'PATCH')).code, 'CHECKLIST_WAIVED');
      assert.equal(ErrorCode.parse(await crewWrite(ownChecklist, { ...markDone, version: confirmed.version }, 409, cookie, 'PATCH')).code, 'HTTP_409');
      assert.deepEqual(await readBackoffice(), afterStart);

      const checked = CrewVisitDetail.parse(await crewWrite(ownChecklist, markDone, 200, cookie, 'PATCH'));
      assert.equal(checked.version, started.version + 1);
      assert.deepEqual(checked.tasks.flatMap((task) => task.checklist.map(({ id, done, waived }) => ({ id, done, waived }))), [
        { id: ownCheck.id, done: true, waived: false }, { id: waivedCheck.id, done: false, waived: true },
      ]);
      const afterChecklist = await readBackoffice();
      const allChecks = appointment(afterChecklist.delivery, workVisit).assignments.flatMap((entry) => entry.tasks.flatMap((task) => task.checklist));
      assert.equal(allChecks.find((entry) => entry.id === ownCheck.id)?.done, true);
      assert.equal(allChecks.find((entry) => entry.id === foreignCheck.id)?.done, false);
      assert.equal(afterChecklist.history.find((entry) => entry.action === 'checklist.crew_updated')?.actorId, participant.id);
      assert.deepEqual(CrewVisitDetail.parse(await crewWrite(`${route}/start`, start, 201, cookie)), checked);
      assert.deepEqual(CrewVisitDetail.parse(await crewWrite(ownChecklist, { ...markDone, version: checked.version }, 200, cookie, 'PATCH')), checked);
      await crewWrite(ownChecklist, { ...markDone, version: checked.version, done: false }, 409, cookie, 'PATCH');
      await crewWrite(`${route}/start`, start, 404, rosterSession.cookie);
      assert.deepEqual(await readBackoffice(), afterChecklist);

      const issueCommand = { ...report, version: checked.version };
      // A signature/dimensions/IEND fixture passes superficial PNG checks but cannot be decoded.
      const malformed = Buffer.alloc(45);
      image.copy(malformed, 0, 0, 8);
      malformed.writeUInt32BE(2, 16); malformed.writeUInt32BE(2, 20); malformed.write('IEND', 37, 'ascii');
      await crewWrite(`${route}/issues`, { ...issueCommand, photo: { ...report.photo, base64: malformed.toString('base64') } }, 400, cookie);
      await crewWrite(`${route}/issues`, { ...issueCommand, itemIds: [9999] }, 400, cookie);
      await crewWrite(`${route}/issues`, issueCommand, 404, rosterSession.cookie);
      assert.deepEqual(await readBackoffice(), afterChecklist);
      assert.deepEqual(await readdir(filesDirectory), []);

      // Fail the last write inside the test schema after the issue/photo work has begun.
      await withRejectedCrewReceipt(async () => {
        assert.equal(ErrorCode.parse(await crewWrite(`${route}/issues`, issueCommand, 500, cookie)).code, 'INTERNAL_ERROR');
      });
      assert.deepEqual(await readBackoffice(), afterChecklist, 'A receipt failure rolls back the issue, metadata, revision and audit');
      assert.deepEqual(await readdir(filesDirectory), [], 'A rolled-back issue leaves no staged or published photo');

      const reported = CrewVisitDetail.parse(await crewWrite(`${route}/issues`, issueCommand, 201, cookie));
      assert.equal(reported.version, checked.version + 1);
      assert.equal(reported.scopeReviewReason,null,'Damage discovered during this visit must not block its result form.');
      assert.equal(reported.canFinish,true,'The designated actual participant can finish the already-started visit.');
      assert.equal((await crewDetail(cookie,workVisit)).canFinish,true,'Refreshing the visit must retain the same finish permission.');
      const heldBooked=await crewDetail(rosterSession.cookie,foreignVisit);
      assert.equal(heldBooked.scopeReviewReason,'damage_hold');
      assert.equal(heldBooked.canStart,false,'A later booked visit remains blocked by the damaged product.');
      assert.equal(ErrorCode.parse(await crewWrite(`/crew/visits/${foreignVisit}/start`,{
        version:heldBooked.version,requestId:randomUUID(),
      },409,rosterSession.cookie)).code,'VISIT_WORK_SCOPE_REVIEW_REQUIRED');
      assert.equal(reported.scopeReviewReason, null, 'Damage discovered during active work must not block submitting that visit report');
      const observed = await readBackoffice();
      const issue = observed.delivery.issues[0];
      assert.ok(issue && observed.delivery.issues.length === 1);
      assert.equal(issue.type, 'damage'); assert.equal(issue.description, report.description);
      assert.equal(issue.source, 'crew'); assert.equal(issue.authorId, participant.id); assert.equal(issue.authorName, participant.name);
      assert.deepEqual(issue.itemIds, [11]);
      const photo = observed.files[0];
      assert.ok(photo && observed.files.length === 1);
      assert.deepEqual(issue.photoIds, [photo.id]);
      assert.deepEqual({ kind: photo.kind, status: photo.status, mime: photo.mime, name: photo.name, appointmentId: photo.appointmentId, issueId: photo.issueId, itemId: photo.itemId, size: photo.size }, {
        kind: 'evidence', status: 'ready', mime: 'image/png', name: report.photo.name, appointmentId: workVisit, issueId: issue.id, itemId: 11, size: image.length,
      });
      const issueAudit = observed.history.find((entry) => entry.action === 'issue.crew_reported');
      assert.equal(issueAudit?.actorId, participant.id);
      assert.deepEqual(z.object({ appointmentId: IdSchema, issueId: IdSchema, photoId: IdSchema }).parse(issueAudit?.details), {
        appointmentId: workVisit, issueId: issue.id, photoId: photo.id,
      });

      const downloadPath = `${deliveryPath}/files/${photo.id}`;
      await expectStatus(downloadPath, 401);
      await expectStatus(downloadPath, 401, { cookie });
      const download = await fetch(`${base}/api${downloadPath}`, { headers: { Cookie: adminCookie, Origin: backofficeOrigin } });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-type') ?? '', /^image\/png\b/u);
      assert.equal(download.headers.get('cache-control'), 'no-store');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), image);

      assert.deepEqual(CrewVisitDetail.parse(await crewWrite(`${route}/issues`, { ...issueCommand, version: reported.version }, 201, cookie)), reported);
      await crewWrite(`${route}/issues`, { ...issueCommand, version: reported.version, description: 'DEMO different issue' }, 409, cookie);
      assert.deepEqual(await readBackoffice(), observed, 'Retry neither duplicates nor rewrites the issue, photo, or audit');
      assert.deepEqual(await readdir(filesDirectory), [photo.id]);
    });

    const finishPhotoFiles = [
      { name: 'DEMO finished assembly.png', mime: 'image/png', bytes: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#446622' } }).png().toBuffer() },
      { name: 'DEMO room after delivery.jpg', mime: 'image/jpeg', bytes: await sharp({ create: { width: 3, height: 2, channels: 3, background: '#664422' } }).jpeg().toBuffer() },
    ];
    const finishPhotos = finishPhotoFiles.map(({ name, bytes }) => ({ name, base64: bytes.toString('base64') }));

    await context.test('the designated participant submits the shared visit report and private photos exactly once', async () => {
      delivery = (await readBackoffice()).delivery;
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/work-readiness/11`, {
        version: delivery.version, note: 'DEMO damaged carton checked and goods approved before another booking.',
      }, 'PATCH')).delivery;
      const operatorId = randomUUID();
      const operatorEmail = 'crew-access-operator@example.test';
      await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
        [operatorId, operatorEmail, 'DEMO scheduling operator', 'operator', await hashPassword(adminPassword)]);
      const operatorLogin = await expectStatus('/auth/login', 201, { method: 'POST', body: { email: operatorEmail, password: adminPassword } });
      const operatorCookie = cookieFrom(operatorLogin, 'backoffice_session');

      const reportTask = await createTask('DEMO report task', ['Finish delivery check', 'Assembly remains']);
      const reportVisit = await book('2031-05-09T08:00:00Z', '2031-05-09T09:00:00Z', 1000);
      await assign(reportVisit, assignedCrew.id, reportTask.id, [participant.id]);
      await assign(reportVisit, otherCrew.id, privateTask.id);
      const responsiblePath = `${deliveryPath}/appointments/${reportVisit}/responsible`;
      const route = `/crew/visits/${reportVisit}`;
      const requestId = randomUUID();
      const report = {
        requestId, summary: 'DEMO partial delivery and assembly report', quantities: [{ sourceLineId: 11, deliveredMilli: 1000 }],
        photos: finishPhotos, ...drawnSignatures('DEMO visit recipient'),
      };

      async function selectResponsible(participantId: string, cookie = adminCookie) {
        delivery = BackofficeDetail.parse(await backoffice(responsiblePath, { version: delivery.version, participantId }, 'PATCH', cookie)).delivery;
      }

      const beforeSelection = await readBackoffice();
      await expectStatus(responsiblePath, 401, { method: 'PATCH', cookie: memberSession.cookie, body: { version: delivery.version, participantId: participant.id } });
      const rosterDenied = await expectStatus(responsiblePath, 400, { method: 'PATCH', cookie: operatorCookie, body: { version: delivery.version, participantId: rosterOnly.id } });
      assert.equal(ErrorCode.parse(rosterDenied.data).code, 'RESPONSIBLE_NOT_ASSIGNED');
      const disabled = await updateParticipant(otherMember, { enabled: false });
      const disabledDenied = await expectStatus(responsiblePath, 409, { method: 'PATCH', cookie: operatorCookie, body: { version: delivery.version, participantId: otherMember.id } });
      assert.equal(ErrorCode.parse(disabledDenied.data).code, 'RESPONSIBLE_PARTICIPANT_DISABLED');
      await updateParticipant(disabled, { enabled: true });
      const otherSession = await crewLogin('crew-other@example.test');
      assert.deepEqual(await readBackoffice(), beforeSelection);

      await selectResponsible(participant.id, operatorCookie);
      const selected = await crewDetail(memberSession.cookie, reportVisit);
      assert.deepEqual(selected.responsibleParticipant, { id: participant.id, name: participant.name });
      assert.equal(selected.canFinish, false);
      const selectedAudit = (await readBackoffice()).history.find((entry) => entry.action === 'appointment.responsible_selected');
      assert.equal(selectedAudit?.actorId, operatorId);
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, { version: selected.version, ...report }, 409, memberSession.cookie)).code, 'VISIT_NOT_IN_PROGRESS');

      const staffing = appointment(delivery, reportVisit).assignments.map((entry) => ({
        assignmentId: entry.id,
        participantIds: entry.crewId === assignedCrew.id ? [rosterOnly.id] : entry.people.map((person) => person.id),
      }));
      delivery = BackofficeDetail.parse(await backoffice(`${deliveryPath}/appointments/${reportVisit}/participants`, {
        version: delivery.version, assignments: staffing, reason: 'DEMO replacement removes the designated person',
      }, 'PATCH')).delivery;
      assert.equal(Object.hasOwn(appointment(delivery, reportVisit), 'responsibleParticipant'), false);
      assert.ok((await readBackoffice()).history.some((entry) => entry.action === 'appointment.responsible_cleared'));
      await crewWrite(`${route}/finish`, { version: delivery.version, ...report }, 404, memberSession.cookie);
      assert.equal((await crewDetail(rosterSession.cookie, reportVisit)).responsibleParticipant, null);

      await confirm(reportVisit);
      const started = CrewVisitDetail.parse(await crewWrite(`${route}/start`, { version: delivery.version, requestId: randomUUID() }, 201, otherSession.cookie));
      assert.equal(started.status, 'in_progress');
      assert.ok(started.actualStartedAt);
      assert.equal(started.canFinish, false);
      assert.equal(started.unfinishedChecklistCount, 3);
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, { version: started.version, ...report }, 409, rosterSession.cookie)).code, 'VISIT_RESPONSIBLE_REQUIRED');
      delivery = (await readBackoffice()).delivery;
      await selectResponsible(otherMember.id);
      assert.equal((await crewDetail(otherSession.cookie, reportVisit)).canFinish, true);
      await selectResponsible(rosterOnly.id);
      const ready = await crewDetail(rosterSession.cookie, reportVisit);
      assert.deepEqual(ready.responsibleParticipant, { id: rosterOnly.id, name: rosterOnly.name });
      assert.equal(ready.canFinish, true);
      assert.equal((await crewDetail(otherSession.cookie, reportVisit)).canFinish, false);

      const ownCheck = ready.tasks[0]?.checklist[0];
      const pendingCheck = ready.tasks[0]?.checklist[1];
      const otherCheck = started.tasks[0]?.checklist[0];
      assert.ok(ownCheck && pendingCheck && otherCheck);
      const checkedOther = CrewVisitDetail.parse(await crewWrite(`${route}/checklist/${otherCheck.id}`, {
        version: ready.version, requestId: randomUUID(), done: true,
      }, 200, otherSession.cookie, 'PATCH'));
      assert.equal(checkedOther.unfinishedChecklistCount, 2);
      const prepared = CrewVisitDetail.parse(await crewWrite(`${route}/checklist/${ownCheck.id}`, {
        version: checkedOther.version, requestId: randomUUID(), done: true,
      }, 200, rosterSession.cookie, 'PATCH'));
      assert.equal(prepared.unfinishedChecklistCount, 1);
      assert.equal(prepared.items[0]?.remainingMilli, 1500);
      const body = { version: prepared.version, ...report };
      const revoked = await crewLogin('crew-roster@example.test');
      await expectStatus('/crew/auth/logout', 201, { method: 'POST', body: {}, cookie: revoked.cookie });
      const beforeFinish = await readBackoffice();
      const filesBeforeFinish = (await readdir(filesDirectory)).sort();
      await crewWrite(`${route}/finish`, body, 401, revoked.cookie);
      await crewWrite(`${route}/finish`, body, 401, adminCookie);
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, body, 403, otherSession.cookie)).code, 'NOT_VISIT_RESPONSIBLE');
      const { photos, ...withoutPhotos } = body;
      const malformedPhoto = { name: 'DEMO invalid photo.png', base64: Buffer.from('invalid image').toString('base64') };
      const invalidPhotoSets = [
        withoutPhotos,
        { ...body, photos: [] },
        { ...body, photos: [...photos, malformedPhoto] },
      ];
      for (const invalid of invalidPhotoSets) {
        await crewWrite(`${route}/finish`, invalid, 400, rosterSession.cookie);
      }
      const excessPhotoCount = await crewWrite(`${route}/finish`, { ...body, photos: Array.from({ length: 51 }, () => photos).flat() }, 400, rosterSession.cookie);
      assert.equal(ErrorCode.parse(excessPhotoCount).code, 'INVALID_INPUT');
      const oversized = { name: 'DEMO photo at byte limit.png', base64: Buffer.alloc(5 * 1024 * 1024).toString('base64') };
      const excessPhotoBytes = await crewWrite(`${route}/finish`, { ...body, photos: [...photos, ...Array.from({ length: 4 }, () => oversized)] }, 400, rosterSession.cookie);
      assert.equal(ErrorCode.parse(excessPhotoBytes).code, 'INVALID_INPUT');
      const { customerSignature, crewSignature, ...unsigned } = body;
      const invalidSignatures = [
        { ...unsigned, customerSignature },
        { ...unsigned, crewSignature },
        { ...body, customerSignature: { ...customerSignature, signerName: '   ' } },
        { ...body, crewSignature: { strokes: [[{ x: 100, y: 100 }, { x: 101, y: 102 }]] } },
        { ...body, customerSignature: { ...customerSignature, strokes: [[{ x: 1001, y: 0 }, { x: 100, y: 100 }]] } },
        { ...body, responsiblePersonId: otherMember.id },
        { ...body, crewSignature: { ...crewSignature, signerName: otherMember.name } },
      ];
      for (const invalid of invalidSignatures) {
        assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, invalid, 400, rosterSession.cookie)).code, 'INVALID_INPUT');
      }
      const copiedDrawing = customerSignature.strokes.map((stroke) => stroke.flatMap((point) => [point, point]));
      const copied = await crewWrite(`${route}/finish`, { ...body, crewSignature: { strokes: copiedDrawing } }, 400, rosterSession.cookie);
      assert.equal(ErrorCode.parse(copied).code, 'SIGNATURES_NOT_DISTINCT');
      assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, { ...body, version: checkedOther.version }, 409, rosterSession.cookie)).code, 'HTTP_409');
      const excess = await crewWrite(`${route}/finish`, { ...body, quantities: [{ sourceLineId: 11, deliveredMilli: 1501 }] }, 409, rosterSession.cookie);
      assert.equal(ErrorCode.parse(excess).code, 'EXCESS_VISIT_WORK');
      assert.deepEqual(await readBackoffice(), beforeFinish);
      assert.deepEqual((await readdir(filesDirectory)).sort(), filesBeforeFinish);

      await withRejectedCrewReceipt(async () => {
        assert.equal(ErrorCode.parse(await crewWrite(`${route}/finish`, body, 500, rosterSession.cookie)).code, 'INTERNAL_ERROR');
      });
      assert.deepEqual(await readBackoffice(), beforeFinish, 'A receipt failure rolls back the result, files, revision and audit');
      assert.deepEqual((await readdir(filesDirectory)).sort(), filesBeforeFinish, 'A failed finish leaves no new private file on disk');
      const rolledBackRows = await rows(database.source.manager, z.object({ status: z.literal('in_progress') }), 'SELECT status FROM appointment WHERE id=$1 AND delivery_id=$2', [reportVisit, delivery.id]);
      assert.equal(rolledBackRows.length, 1, 'A failed finish leaves the relational visit in progress');

      const replies = await Promise.all([body, body].map((command) => crewWrite(`${route}/finish`, command, 201, rosterSession.cookie)));
      const [finished, concurrentReplay] = replies.map((reply) => CrewVisitDetail.parse(reply));
      assert.ok(finished && concurrentReplay);
      assert.deepEqual(concurrentReplay, finished);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.canFinish, false);
      assert.equal(finished.version, prepared.version + 1);
      assert.equal(finished.unfinishedChecklistCount, 1);
      assert.equal(finished.items[0]?.remainingMilli, 500);
      const completedRows = await rows(database.source.manager, z.object({ status: z.literal('completed') }), 'SELECT status FROM appointment WHERE id=$1 AND delivery_id=$2', [reportVisit, delivery.id]);
      assert.equal(completedRows.length, 1);

      const observed = await readBackoffice();
      const visit = appointment(observed.delivery, reportVisit);
      const [result] = visit.results;
      assert.equal(visit.results.length, 1);
      assert.ok(result);
      assert.equal(z.object({ source: z.literal('crew_frontoffice') }).parse(result).source, 'crew_frontoffice');
      assert.equal(result.responsiblePersonId, rosterOnly.id);
      assert.deepEqual(result.actor, { kind: 'crew', id: rosterOnly.id, name: rosterOnly.name });
      assert.equal(result.summary, report.summary);
      assert.deepEqual(result.quantities, report.quantities);
      assert.deepEqual(observed.deliveredQuantities, report.quantities);
      assert.deepEqual(new Set(result.completedChecklistIds), new Set([ownCheck.id, otherCheck.id]));
      assert.equal(result.assignmentsSnapshot.flatMap((entry) => entry.tasks.flatMap((task) => task.checklist)).find((item) => item.id === pendingCheck.id)?.done, false);
      assert.deepEqual(result.assignmentsSnapshot, appointment(beforeFinish.delivery, reportVisit).assignments);
      assert.deepEqual(result.sourceSnapshot, beforeFinish.delivery.source);
      assert.deepEqual(result.instructionsSnapshot, beforeFinish.delivery.instructions);
      assert.equal(result.actualStart, started.actualStartedAt);
      assert.ok(Date.parse(result.actualEnd) > Date.parse(result.actualStart));
      assertCapturedSignatures(result, report, rosterOnly.name);
      assert.equal(observed.delivery.completedAt, null);
      assert.equal(observed.closureBlockers.some((blocker) => blocker.includes(reportVisit) && blocker.includes('signature')), false);
      const completionFiles = observed.files.filter((file) => file.appointmentId === reportVisit);
      assert.deepEqual(observed.files.filter((file) => file.appointmentId !== reportVisit), beforeFinish.files);
      assert.equal(completionFiles.length, finishPhotoFiles.length);
      const expectedEvidence = finishPhotoFiles.map(({ name, mime, bytes }) => {
        const file = completionFiles.find((entry) => entry.name === name);
        assert.ok(file);
        assert.deepEqual({ kind: file.kind, status: file.status, mime: file.mime, size: file.size, issueId: file.issueId, itemId: file.itemId }, {
          kind: 'evidence', status: 'ready', mime, size: bytes.length, issueId: null, itemId: null,
        });
        return { id: file.id, type: 'photo', itemIds: [] };
      });
      assert.deepEqual(result.evidence, expectedEvidence);
      for (const [index, file] of expectedEvidence.entries()) {
        const original = finishPhotoFiles[index];
        assert.ok(original);
        const downloadPath = `${deliveryPath}/files/${file.id}`;
        await expectStatus(downloadPath, 401);
        await expectStatus(downloadPath, 401, { cookie: rosterSession.cookie });
        const download = await fetch(`${base}/api${downloadPath}`, { headers: { Cookie: operatorCookie, Origin: backofficeOrigin } });
        assert.equal(download.status, 200);
        assert.match(download.headers.get('content-type') ?? '', new RegExp(`^${original.mime}\\b`, 'u'));
        assert.equal(download.headers.get('cache-control'), 'no-store');
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), original.bytes);
      }
      const reportAudits = observed.history.filter((entry) => entry.action === 'execution.crew_reported');
      assert.equal(reportAudits.length, 1);
      assert.equal(reportAudits[0]?.actorId, rosterOnly.id);
      assert.deepEqual(z.object({ appointmentId: IdSchema, resultId: IdSchema }).parse(reportAudits[0]?.details), { appointmentId: reportVisit, resultId: result.id });

      const changedVersion = { ...body, version: finished.version };
      assert.deepEqual(CrewVisitDetail.parse(await crewWrite(`${route}/finish`, changedVersion, 201, rosterSession.cookie)), finished);
      await crewWrite(`${route}/finish`, { ...changedVersion, summary: 'DEMO mismatched retry' }, 409, rosterSession.cookie);
      await crewWrite(`${route}/finish`, { ...changedVersion, crewSignature: drawnSignatures(customerSignature.signerName, 25).crewSignature }, 409, rosterSession.cookie);
      await crewWrite(`${route}/finish`, { ...changedVersion, photos: photos.slice(0, 1) }, 409, rosterSession.cookie);
      await crewWrite(`${route}/finish`, changedVersion, 403, otherSession.cookie);
      await crewWrite(`${route}/finish`, { ...changedVersion, requestId: randomUUID() }, 409, rosterSession.cookie);
      for (const visitId of [reportVisit, ownedVisit]) {
        const locked = await expectStatus(`${deliveryPath}/appointments/${visitId}/responsible`, 409, {
          method: 'PATCH', cookie: adminCookie, body: { version: finished.version, participantId: rosterOnly.id },
        });
        assert.equal(ErrorCode.parse(locked.data).code, 'VISIT_RESPONSIBLE_LOCKED');
      }
      assert.deepEqual(await readBackoffice(), observed);
      assert.deepEqual((await readdir(filesDirectory)).sort(), [...filesBeforeFinish, ...expectedEvidence.map(({ id }) => id)].sort());
    });

    await context.test('each visit needs its own signatures and authenticated backoffice can close the fully delivered picking', async () => {
      let signedDelivery = createDelivery({ ...delivery.source, pickingId: 2, pickingName: 'DEMO/CREW-SIGNATURES/2' }, randomUUID());
      await persistFixture(signedDelivery);
      const path = `/deliveries/${signedDelivery.id}`;
      const cookie = rosterSession.cookie;

      async function save(suffix: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') {
        signedDelivery = BackofficeDetail.parse(await backoffice(`${path}${suffix}`, { ...body, version: signedDelivery.version }, method)).delivery;
      }

      async function prepare(startsAt: string, endsAt: string) {
        await save('/appointments', { requestId: randomUUID(), startsAt, endsAt, workLines: demoRemainingWork(signedDelivery) });
        const visit = signedDelivery.appointments.at(-1);
        assert.ok(visit);
        const visitPath = `/appointments/${visit.id}`;
        await save(`${visitPath}/assign`, { requestId: randomUUID(), crewIds: [assignedCrew.id], templateIds: [visibleTask.id] });
        await save(`${visitPath}/confirm-customer`, {});
        await save(`${visitPath}/responsible`, { participantId: rosterOnly.id }, 'PATCH');
        const crewPath = `/crew/visits/${visit.id}`;
        const started = CrewVisitDetail.parse(await crewWrite(`${crewPath}/start`, { version: signedDelivery.version, requestId: randomUUID() }, 201, cookie));
        const check = started.tasks[0]?.checklist[0];
        assert.ok(check);
        const checked = CrewVisitDetail.parse(await crewWrite(`${crewPath}/checklist/${check.id}`, {
          version: started.version, requestId: randomUUID(), done: true,
        }, 200, cookie, 'PATCH'));
        assert.equal(checked.unfinishedChecklistCount, 0);
        return { id: visit.id, finishPath: `${crewPath}/finish`, version: checked.version };
      }

      const first = await prepare('2031-05-10T08:00:00Z', '2031-05-10T09:00:00Z');
      const firstSignatures = drawnSignatures('DEMO first visit recipient', 50);
      const firstReport = {
        version: first.version, requestId: randomUUID(), summary: 'DEMO first partial delivery',
        quantities: [{ sourceLineId: 11, deliveredMilli: 500 }], photos: finishPhotos.slice(0, 1), ...firstSignatures,
        incompleteWork: [{ sourceLineId: 11, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'Remaining item was not loaded.' }],
      };
      const firstFinished = CrewVisitDetail.parse(await crewWrite(first.finishPath, firstReport, 201, cookie));
      assert.equal(firstFinished.items[0]?.remainingMilli, 1000);
      const firstSaved = await readBackoffice(path);
      const firstResult = appointment(firstSaved.delivery, first.id).results[0];
      assert.ok(firstResult);
      assertCapturedSignatures(firstResult, firstSignatures, rosterOnly.name);
      assert.equal(firstSaved.delivery.completedAt, null);
      const blocked = await expectStatus(`${path}/complete`, 409, { method: 'POST', cookie: adminCookie, body: { version: firstSaved.delivery.version } });
      assert.equal(ErrorCode.parse(blocked.data).code, 'CLOSURE_BLOCKED');
      assert.ok(firstSaved.closureBlockers.some((blocker) => blocker.startsWith('Remaining quantity:')));
      assert.deepEqual(await readBackoffice(path), firstSaved);

      signedDelivery = firstSaved.delivery;
      const second = await prepare('2031-05-10T11:00:00Z', '2031-05-10T12:00:00Z');
      const secondSignatures = drawnSignatures('DEMO second visit recipient', 100);
      const secondBase = {
        version: second.version, requestId: randomUUID(), summary: 'DEMO remaining delivery',
        quantities: [{ sourceLineId: 11, deliveredMilli: 1000 }], photos: finishPhotos.slice(1),
      };
      await crewWrite(second.finishPath, { ...firstReport, version: second.version }, 409, cookie);
      await crewWrite(second.finishPath, { ...secondBase, crewSignature: secondSignatures.crewSignature }, 400, cookie);
      assert.equal((await crewDetail(cookie, second.id)).status, 'in_progress');
      const secondFinished = CrewVisitDetail.parse(await crewWrite(second.finishPath, { ...secondBase, ...secondSignatures }, 201, cookie));
      assert.equal(secondFinished.items[0]?.remainingMilli, 0);
      const detail = await expectStatus(path, 200, { cookie: adminCookie });
      assertNoStore(detail);
      const beforeClose = BackofficeDetail.parse(detail.data);
      assert.deepEqual(beforeClose.closureBlockers, []);
      assert.equal(beforeClose.files.length, 2);
      const secondResult = appointment(beforeClose.delivery, second.id).results[0];
      assert.ok(secondResult);
      assertCapturedSignatures(secondResult, secondSignatures, rosterOnly.name);
      assert.notEqual(secondResult.id, firstResult.id);
      for (const [result, visitId] of [[firstResult, first.id], [secondResult, second.id]] as const) {
        const file = beforeClose.files.find((entry) => entry.appointmentId === visitId);
        assert.ok(file);
        assert.deepEqual(result.evidence, [{ id: file.id, type: 'photo', itemIds: [] }]);
      }
      assert.deepEqual(appointment(beforeClose.delivery, first.id).results, [firstResult]);
      assert.equal((await expectStatus(path, 401, { cookie })).headers.has('set-cookie'), false);

      const list = DeliveryListSchema.parse((await expectStatus('/deliveries', 200, { cookie: adminCookie })).data);
      const overview = list.items.find((item) => item.id === signedDelivery.id);
      assert.ok(overview);
      const range = new URLSearchParams({ from: '2031-05-10T00:00:00Z', to: '2031-05-11T00:00:00Z' });
      const calendar = z.array(z.object({ deliveryId: IdSchema, appointment: AppointmentSchema })).parse(
        (await expectStatus(`/calendar?${range}`, 200, { cookie: adminCookie })).data,
      );
      const calendarVisits = calendar.filter((entry) => entry.deliveryId === signedDelivery.id).map((entry) => entry.appointment);
      for (const visits of [overview.appointments, calendarVisits]) {
        assert.deepEqual(new Set(visits.map((visit) => visit.id)), new Set([first.id, second.id]));
        const results = visits.flatMap((visit) => visit.results);
        assert.deepEqual(new Set(results.map((result) => result.id)), new Set([firstResult.id, secondResult.id]));
        assert.ok(results.every((result) => result.customerSignature === null && result.crewSignature === null));
      }

      const closedReply = await expectStatus(`${path}/complete`, 201, {
        method: 'POST', cookie: adminCookie, body: { version: beforeClose.delivery.version },
      });
      assertNoStore(closedReply);
      const closed = BackofficeDetail.parse(closedReply.data);
      assert.ok(closed.delivery.completedAt);
      assert.deepEqual(new Set(closed.delivery.completions[0]?.resultIds), new Set([firstResult.id, secondResult.id]));
      assert.deepEqual(closed.delivery.appointments, beforeClose.delivery.appointments, 'Closure preserves both signed results');
    });

    await context.test('otherwise complete legacy work with unsigned results still fails closure', async () => {
      const legacy = createDelivery({ ...delivery.source, pickingId: 3, pickingName: 'DEMO/CREW-UNSIGNED/3' }, randomUUID());
      const actor = { kind: 'crew' as const, id: rosterOnly.id, name: rosterOnly.name };
      const task = instantiateTask(visibleTask);
      const visit: Appointment = {
        id: randomUUID(), startsAt: '2026-11-01T08:00:00Z', endsAt: '2026-11-01T09:00:00Z', status: 'in_progress',
        cancellationReason: null, returnRequestId: null, results: [],
        responsibleParticipant: { id: actor.id, name: actor.name },
        assignments: [{ id: randomUUID(), crewId: assignedCrew.id, crewName: assignedCrew.name, people: [{ id: actor.id, name: actor.name, external: false }], tasks: [task] }],
      };
      legacy.appointments.push(visit);
      // This is a stored pre-scope historical result, not a newly permitted Crew command.
      for (const item of task.checklist) item.done = true;
      visit.status = 'completed';
      visit.results.push({
        id: randomUUID(), appointmentId: visit.id, supersedesResultId: null, correctionReason: null,
        actualStart: visit.startsAt, actualEnd: visit.endsAt, summary: 'DEMO report saved before drawn signatures', responsiblePersonId: actor.id,
        quantities: [{ sourceLineId: 11, deliveredMilli: 1500 }], completedChecklistIds: task.checklist.map((item) => item.id),
        evidence: [], customerSignature: null, crewSignature: null,
        actor, receivedAt: '2026-11-01T09:05:00Z', source: 'crew_frontoffice',
        sourceSnapshot: structuredClone(legacy.source), instructionsSnapshot: structuredClone(legacy.instructions),
        assignmentsSnapshot: structuredClone(visit.assignments),
      });
      const unsigned = DeliverySchema.parse(legacy);
      await persistFixture(unsigned);
      await database.source.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',
        [visit.id, unsigned.id, visit.startsAt, visit.endsAt, 'completed']);
      const path = `/deliveries/${unsigned.id}`;
      const original = await readBackoffice(path);
      assert.deepEqual(original.closureBlockers, [
        `Visit ${visit.id} requires the customer signature`,
        `Visit ${visit.id} requires the responsible crew signature`,
      ]);
      const blocked = await expectStatus(`${path}/complete`, 409, {
        method: 'POST', cookie: adminCookie, body: { version: unsigned.version },
      });
      assert.equal(ErrorCode.parse(blocked.data).code, 'CLOSURE_BLOCKED');
      assert.deepEqual(await readBackoffice(path), original);
      assert.equal(appointment(original.delivery, visit.id).results[0]?.customerSignature, null);
      assert.equal(appointment(original.delivery, visit.id).results[0]?.crewSignature, null);
    });

    await context.test('an absent customer leaves all goods available for a signed retry', async () => {
      const fixture = createDelivery({ ...delivery.source, pickingId: 4, pickingName: 'DEMO/CREW-ABSENT/4' }, randomUUID());
      await persistFixture(fixture);
      const path = `/deliveries/${fixture.id}`;
      let current = fixture;
      const { cookie } = memberSession;

      async function prepareVisit(startsAt: string, endsAt: string) {
        current = BackofficeDetail.parse(await backoffice(`${path}/appointments`, {
          version: current.version, requestId: randomUUID(), startsAt, endsAt,
          workLines: demoRemainingWork(current),
        })).delivery;
        const visit = current.appointments.at(-1);
        assert.ok(visit);
        const appointmentPath = `${path}/appointments/${visit.id}`;
        current = BackofficeDetail.parse(await backoffice(`${appointmentPath}/assign`, {
          version: current.version, requestId: randomUUID(), crewIds: [homeCrew.id, otherCrew.id], templateIds: [visibleTask.id],
        })).delivery;
        current = BackofficeDetail.parse(await backoffice(`${appointmentPath}/responsible`, {
          version: current.version, participantId: participant.id,
        }, 'PATCH')).delivery;
        current = BackofficeDetail.parse(await backoffice(`${appointmentPath}/confirm-customer`, { version: current.version })).delivery;
        return { id: visit.id, route: `/crew/visits/${visit.id}` };
      }

      const first = await prepareVisit('2031-05-11T08:00:00Z', '2031-05-11T09:00:00Z');
      const failurePath = `${first.route}/attempt-failure`;
      const reason = 'DEMO customer did not answer the door or phone';
      const command = { version: current.version, requestId: randomUUID(), reason };
      assert.equal(ErrorCode.parse(await crewWrite(failurePath, command, 409, cookie)).code, 'VISIT_NOT_IN_PROGRESS');
      const started = CrewVisitDetail.parse(await crewWrite(`${first.route}/start`, { version: current.version, requestId: randomUUID() }, 201, cookie));
      command.version = started.version;
      const otherSession = await crewLogin('crew-other@example.test');
      await expectStatus(failurePath, 401, { method: 'POST', body: command });
      await crewWrite(failurePath, command, 404, rosterSession.cookie);
      assert.equal(ErrorCode.parse(await crewWrite(failurePath, command, 403, otherSession.cookie)).code, 'NOT_VISIT_RESPONSIBLE');
      await crewWrite(failurePath, { ...command, reason: '   ' }, 400, cookie);
      await crewWrite(failurePath, { ...command, quantities: [{ sourceLineId: 11, deliveredMilli: 500 }] }, 400, cookie);
      const beforeFailure = await readBackoffice(path);
      await withRejectedCrewReceipt(async () => { await crewWrite(failurePath, command, 500, cookie); });
      assert.deepEqual(await readBackoffice(path), beforeFailure);
      assert.equal((await crewDetail(cookie, first.id)).status, 'in_progress');

      const failures = await Promise.all([command, { ...command, reason: ` ${reason} ` }].map(async (body) =>
        CrewVisitDetail.parse(await crewWrite(failurePath, body, 201, cookie))));
      const failed = failures[0];
      assert.ok(failed?.failedAttempt);
      assert.deepEqual(failures[1], failed);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.canFinish, false);
      assert.equal(failed.version, started.version + 1);
      assert.equal(failed.items[0]?.remainingMilli, 1500);
      assert.equal(failed.failedAttempt.reason, reason);
      assert.deepEqual(failed.failedAttempt.actor, { id: participant.id, name: participant.name });
      await crewWrite(failurePath, { ...command, version: failed.version, requestId: randomUUID() }, 409, cookie);

      const afterFailure = await readBackoffice(path);
      const failedVisit = appointment(afterFailure.delivery, first.id);
      assert.deepEqual(failedVisit.failedAttempt, failed.failedAttempt);
      assert.deepEqual(failedVisit.results, []);
      assert.deepEqual(afterFailure.files, []);
      assert.deepEqual(afterFailure.deliveredQuantities, [{ sourceLineId: 11, deliveredMilli: 0 }]);
      const audit = afterFailure.history.filter((entry) => entry.action === 'execution.customer_absent');
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.actorId, participant.id);
      assert.deepEqual(audit[0]?.details, { appointmentId: first.id, reason, version: failed.version });
      assert.ok(afterFailure.closureBlockers.some((blocker) => blocker.startsWith('Remaining quantity:')));
      assert.ok(!afterFailure.closureBlockers.some((blocker) => /signature|checklist/.test(blocker)));
      const inbox = DeliveryListSchema.parse((await expectStatus('/deliveries?view=inbox&search=DEMO%2FCREW-ABSENT%2F4', 200, { cookie: adminCookie })).data);
      assert.deepEqual(inbox.items.map((item) => item.id), [fixture.id]);

      current = afterFailure.delivery;
      const second = await prepareVisit('2031-05-11T08:00:00Z', '2031-05-11T09:00:00Z');
      const retry = CrewVisitDetail.parse(await crewWrite(`${second.route}/start`, { version: current.version, requestId: randomUUID() }, 201, cookie));
      const visits = await crewVisits(cookie);
      assert.ok(visits.findIndex((entry) => entry.id === second.id) < visits.findIndex((entry) => entry.id === first.id && entry.status === 'failed'));
      for (const assignment of appointment(current, second.id).assignments) {
        const assignmentCookie = assignment.crewId === homeCrew.id ? cookie : otherSession.cookie;
        const [item] = assignment.tasks[0]?.checklist ?? [];
        assert.ok(item);
        const { version } = await crewDetail(assignmentCookie, second.id);
        await crewWrite(`${second.route}/checklist/${item.id}`, { version, requestId: randomUUID(), done: true }, 200, assignmentCookie, 'PATCH');
      }
      assert.equal(retry.items[0]?.remainingMilli, 1500);
      const { version } = await crewDetail(cookie, second.id);
      const finished = CrewVisitDetail.parse(await crewWrite(`${second.route}/finish`, {
        version, requestId: randomUUID(), summary: 'DEMO full delivery on the second visit',
        quantities: [{ sourceLineId: 11, deliveredMilli: 1500 }], photos: finishPhotos.slice(0, 1), ...drawnSignatures('DEMO retry recipient'),
      }, 201, cookie));
      assert.equal(finished.items[0]?.remainingMilli, 0);
      assert.deepEqual((await readBackoffice(path)).closureBlockers, []);
      const closed = BackofficeDetail.parse(await backoffice(`${path}/complete`, { version: finished.version }));
      assert.ok(closed.delivery.completedAt);
      assert.deepEqual(appointment(closed.delivery, first.id), failedVisit);
    });

    await context.test('MVP pilot accounts for independent line work and scopes Crew documents to the assigned address', async (pilot) => {
      assert.equal(await seedMvpPilot(database.source), 3);
      const firstAddress = '/deliveries/91000000-0000-4000-8000-000000000001';
      const collectionAddress = '/deliveries/91000000-0000-4000-8000-000000000002';
      const otherPicking = '/deliveries/91000000-0000-4000-8000-000000000003';
      const { cookie } = memberSession;

      async function uploadDocument(path: string, name: string, itemId: number | null, text: string) {
        const updated = BackofficeDetail.parse(await backoffice(`${path}/files`, {
          name, itemId, kind: 'document', appointmentId: null, issueId: null, base64: Buffer.from(text).toString('base64'),
        }));
        const file = updated.files.find((entry) => entry.name === name);
        assert.ok(file);
        return file;
      }

      async function prepare(path: string, hour: number) {
        let { delivery: current } = await readBackoffice(path);
        current = BackofficeDetail.parse(await backoffice(`${path}/appointments`, {
          version: current.version, requestId: randomUUID(), startsAt: `2031-05-12T${hour}:00:00Z`, endsAt: `2031-05-12T${hour}:30:00Z`,
          workLines: demoRemainingWork(current),
        })).delivery;
        const visit = current.appointments.at(-1);
        assert.ok(visit);
        const appointmentPath = `${path}/appointments/${visit.id}`;
        current = BackofficeDetail.parse(await backoffice(`${appointmentPath}/assign`, {
          version: current.version, requestId: randomUUID(), crewIds: [homeCrew.id], templateIds: [visibleTask.id],
        })).delivery;
        current = BackofficeDetail.parse(await backoffice(`${appointmentPath}/responsible`, {
          version: current.version, participantId: participant.id,
        }, 'PATCH')).delivery;
        await backoffice(`${appointmentPath}/confirm-customer`, { version: current.version });
        return { id: visit.id, route: `/crew/visits/${visit.id}` };
      }

      async function startWithChecklist(visit: { id: string; route: string }) {
        const { version } = await crewDetail(cookie, visit.id);
        const started = CrewVisitDetail.parse(await crewWrite(`${visit.route}/start`, { version, requestId: randomUUID() }, 201, cookie));
        const checklistId = started.tasks[0]?.checklist[0]?.id;
        assert.ok(checklistId);
        return CrewVisitDetail.parse(await crewWrite(`${visit.route}/checklist/${checklistId}`, {
          version: started.version, requestId: randomUUID(), done: true,
        }, 200, cookie, 'PATCH'));
      }

      function report(version: number, quantities: VisitResult['quantities']) {
        return { version, requestId: randomUUID(), summary: 'DEMO MVP work report', quantities,
          photos: finishPhotos.slice(0, 1), ...drawnSignatures('DEMO MVP recipient') };
      }

      const header = await uploadDocument(firstAddress, 'DEMO access instructions.txt', null, 'Use the demo entrance.');
      const line = await uploadDocument(firstAddress, 'DEMO bookcase instructions.txt', 910022, 'DEMO assembly guide.');
      const otherAddressDoc = await uploadDocument(collectionAddress, 'DEMO collection instructions.txt', 910031, 'Collection at a different address.');
      const deliveryVisit = await prepare(firstAddress, 10);
      const active = await startWithChecklist(deliveryVisit);
      assert.deepEqual(active.items.slice(0, 2).map(({ orderName }) => orderName), ['DEMO/MVP/SO/9101', 'DEMO/MVP/SO/9102']);
      assert.deepEqual(active.documents?.map(({ id, itemId }) => ({ id, itemId })).sort((a, b) => a.id.localeCompare(b.id)),
        [{ id: header.id, itemId: null }, { id: line.id, itemId: 910022 }].sort((a, b) => a.id.localeCompare(b.id)));
      const documentRoute = `${deliveryVisit.route}/documents/${line.id}`;
      await expectStatus(documentRoute, 401);
      await expectStatus(documentRoute, 404, { cookie: rosterSession.cookie });
      await expectStatus(`${deliveryVisit.route}/documents/${otherAddressDoc.id}`, 404, { cookie });
      const document = await fetch(`${base}/api${documentRoute}`, { headers: { Origin: crewOrigin, Cookie: cookie } });
      assert.equal(document.status, 200);
      assert.equal(document.headers.get('cache-control'), 'no-store');
      assert.match(document.headers.get('content-disposition') ?? '', /^attachment/u);
      assert.equal(await document.text(), 'DEMO assembly guide.');

      const planPath = `${firstAddress}/services`;
      await expectStatus(planPath, 401, { method: 'PATCH', body: { version: active.version, defaultService: 'collection_only' } });
      await expectStatus(planPath, 409, { method: 'PATCH', cookie: adminCookie, body: { version: active.version, sourceLineId: 910011, service: 'collection_only' } });
      const earlyInstall = await crewWrite(`${deliveryVisit.route}/finish`, report(active.version, [
        { sourceLineId: 910011, deliveredMilli: 1000, installedMilli: 2000 },
      ]), 409, cookie);
      assert.equal(ErrorCode.parse(earlyInstall).code, 'INSTALLATION_REQUIRES_DELIVERY');
      const finishPath = `${deliveryVisit.route}/finish`;
      const itemChecks = [
        { sourceLineId: 910011, status: 'ok', note: 'First order: chair inspected.' },
        { sourceLineId: 910021, status: 'problem', note: 'Second order: packaging torn.' },
      ];
      const linePhotos = finishPhotos.map((photo, index) => ({ ...photo, sourceLineId: index === 0 ? 910011 : 910021 }));
      const incompleteWork = [
        { sourceLineId: 910011, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'First order: second chair was not loaded.' },
        { sourceLineId: 910011, operation: 'installation', reason: 'time_shortage', note: 'First order: assembly deferred.' },
        { sourceLineId: 910021, operation: 'delivery', reason: 'damage', note: 'Second order: chair damaged inside the packaging.' },
        { sourceLineId: 910022, operation: 'installation', reason: 'access', note: 'Bookcase room is blocked.' },
      ];
      const partialReport = { ...report(active.version, [{ sourceLineId: 910011, deliveredMilli: 1000 }]), itemChecks, incompleteWork, photos: linePhotos };
      const beforeChecks = await readBackoffice(firstAddress);
      const filesBeforeReasons = (await readdir(filesDirectory)).sort();
      assert.equal(ErrorCode.parse(await crewWrite(finishPath, { ...partialReport, incompleteWork: [] }, 400, cookie)).code,
        'INCOMPLETE_WORK_REASON_REQUIRED');
      await crewWrite(finishPath, { ...partialReport, incompleteWork: [incompleteWork[0], ...incompleteWork] }, 400, cookie);
      await crewWrite(finishPath, { ...partialReport, incompleteWork: incompleteWork.map((entry) => ({ ...entry, reason: 'other', note: ' ' })) }, 400, cookie);
      assert.equal(ErrorCode.parse(await crewWrite(finishPath, { ...partialReport, incompleteWork: [...incompleteWork,
        { sourceLineId: 910031, operation: 'collection', reason: 'access', note: null },
      ] }, 400, cookie)).code, 'UNEXPECTED_INCOMPLETE_WORK_REASON');
      await expectStatus(finishPath, 401, { method: 'POST', body: partialReport });
      await expectStatus(finishPath, 403, { method: 'POST', cookie, origin: 'https://untrusted.example.test', body: partialReport });
      await crewWrite(finishPath, partialReport, 404, rosterSession.cookie);
      assert.deepEqual((await readdir(filesDirectory)).sort(), filesBeforeReasons, 'Invalid reasons do not publish files');
      assert.deepEqual(await readBackoffice(firstAddress), beforeChecks, 'Invalid reasons do not alter results, audit, quantities or metadata');
      await crewWrite(finishPath, { ...partialReport, itemChecks: [itemChecks[0], itemChecks[0]] }, 400, cookie);
      assert.equal(ErrorCode.parse(await crewWrite(finishPath, {
        ...partialReport, itemChecks: [{ sourceLineId: 910031, status: 'problem', note: null }],
      }, 400, cookie)).code, 'UNKNOWN_CHECKED_PRODUCT');
      assert.equal(ErrorCode.parse(await crewWrite(finishPath, {
        ...partialReport, itemChecks: [{ sourceLineId: 910021, status: 'problem', note: null, linkedIssueId: randomUUID() }],
      }, 400, cookie)).code, 'INVALID_REPORT_ISSUE');
      assert.equal(ErrorCode.parse(await crewWrite(finishPath, {
        ...partialReport, photos: linePhotos.map((photo) => ({ ...photo, sourceLineId: 910031 })),
      }, 400, cookie)).code, 'UNKNOWN_EVIDENCE_ITEM');
      assert.deepEqual(await readBackoffice(firstAddress), beforeChecks);
      const partial = CrewVisitDetail.parse(await crewWrite(finishPath, partialReport, 201, cookie));
      assert.deepEqual(CrewVisitDetail.parse(await crewWrite(finishPath, partialReport, 201, cookie)), partial);
      await crewWrite(finishPath, { ...partialReport, incompleteWork: incompleteWork.map((entry) => ({ ...entry, note: 'Changed reason details' })) }, 409, cookie);
      await crewWrite(finishPath, {
        ...partialReport, photos: linePhotos.map((photo) => ({ ...photo, sourceLineId: 910011 })),
      }, 409, cookie);
      let afterChecks = await readBackoffice(firstAddress);
      const results = appointment(afterChecks.delivery, deliveryVisit.id).results;
      assert.equal(results.length, 1);
      const [checkedResult] = results;
      assert.ok(checkedResult);
      assert.deepEqual(checkedResult.itemChecks, itemChecks);
      assert.deepEqual(checkedResult.incompleteWork, incompleteWork);
      assert.equal(afterChecks.delivery.issues.length, 1, 'Retry links one product issue; other incomplete reasons do not become issues');
      const linkedIssue = afterChecks.delivery.issues[0]; assert.ok(linkedIssue);
      assert.deepEqual(linkedIssue.itemIds, [910021]);
      assert.equal(linkedIssue.appointmentId, deliveryVisit.id); assert.equal(linkedIssue.originResultId, checkedResult.id);
      assert.deepEqual(checkedResult.issueLinks, [{ sourceLineId: 910021, issueId: linkedIssue.id }]);
      assert.equal(afterChecks.delivery.workHolds?.length, 1);
      assert.equal(afterChecks.lineServices.find(({ sourceLineId }) => sourceLineId === 910021)?.planningBlockedReason, 'damage_hold');
      const savedPhotos = afterChecks.files.filter(({ appointmentId }) => appointmentId === deliveryVisit.id);
      assert.equal(savedPhotos.length, 2);
      assert.deepEqual(checkedResult.evidence.map(({ id, itemIds }) => ({ id, itemIds })), linePhotos.map(({ name, sourceLineId }) => {
        const file = savedPhotos.find((entry) => entry.name === name);
        assert.ok(file);
        assert.equal(file.itemId, sourceLineId);
        assert.equal(file.issueId, sourceLineId === 910021 ? linkedIssue.id : null);
        if (sourceLineId === 910021) assert.deepEqual(linkedIssue.photoIds, [file.id]);
        return { id: file.id, itemIds: [sourceLineId] };
      }));
      assert.deepEqual(partial.items.map(({ sourceLineId, serviceWork }) => [sourceLineId, serviceWork?.remainingDeliveryMilli, serviceWork?.remainingInstallationMilli]),
        [[910011, 1000, 2000], [910021, 1000, 0], [910022, 0, 1000]]);
      assert.equal(partial.items[0]?.serviceWork?.availableInstallationMilli, 1000);

      const readinessPath = `${firstAddress}/work-readiness/910021`;
      await expectStatus(readinessPath, 401, { method: 'PATCH', body: { version: afterChecks.delivery.version, note: 'Not authorized' } });
      await expectStatus(readinessPath, 401, { method: 'PATCH', cookie, body: { version: afterChecks.delivery.version, note: 'Crew cannot release readiness' } });
      await expectStatus(readinessPath, 400, { method: 'PATCH', cookie: adminCookie, body: { version: afterChecks.delivery.version, note: ' ' } });
      await expectStatus(`${firstAddress}/appointments`, 409, { method: 'POST', cookie: adminCookie, body: {
        version: afterChecks.delivery.version, requestId: randomUUID(), startsAt: '2031-05-13T10:00:00Z', endsAt: '2031-05-13T11:00:00Z',
        workLines: [{ sourceLineId: 910021, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }],
      } });
      const resolved = BackofficeDetail.parse(await backoffice(`${firstAddress}/issues/${linkedIssue.id}/resolve`, {
        version: afterChecks.delivery.version, resolution: 'Supplier claim processed; replacement readiness is a separate decision.',
      }));
      assert.equal(resolved.lineServices.find(({ sourceLineId }) => sourceLineId === 910021)?.planningBlockedReason, 'damage_hold');
      afterChecks = BackofficeDetail.parse(await backoffice(readinessPath, { version: resolved.delivery.version, note: 'Replacement inspected and ready for the demo repeat visit.' }, 'PATCH'));
      assert.equal(afterChecks.lineServices.find(({ sourceLineId }) => sourceLineId === 910021)?.planningBlockedReason, null);
      assert.deepEqual(appointment(afterChecks.delivery, deliveryVisit.id).results[0], checkedResult, 'Readiness cannot rewrite the signed report');
      assert.ok(afterChecks.history.some(({ action }) => action === 'work.readiness_confirmed'));

      await pilot.test('a route draft estimates a cross-Picking run over remaining work and rejects stale edits', async () => {
        const addressA = afterChecks.delivery.id;
        const addressB = '91000000-0000-4000-8000-000000000002';
        const addressC = '91000000-0000-4000-8000-000000000003';
        const jobsSchema = z.object({ anchorHasCoordinates: z.boolean().nullable(), jobs: z.array(z.object({
          deliveryId: IdSchema, pickingName: z.string(), addressKey: z.string(), distanceKm: z.number().nullable(),
          remaining: z.array(z.object({ sourceLineId: z.number(), deliveryMilli: z.number(), installationMilli: z.number(), collectionMilli: z.number() })),
        })) });
        const timelineSchema = z.object({
          stops: z.array(z.object({ deliveryId: IdSchema, eta: InstantSchema, travelMinutes: z.number(), travelSource: z.literal('demo') })),
          returnAt: InstantSchema, returnTravelMinutes: z.number(), returnTravelSource: z.literal('demo'),
          totalMinutes: z.number(), travelMinutes: z.number(), workMinutes: z.number(), waitingMinutes: z.number(),
        });
        const routeSchema = z.object({ id: IdSchema, version: z.number().int().positive(), timeline: timelineSchema });
        const listSchema = z.object({ drafts: z.array(z.object({ id: IdSchema, version: z.number(), stopCount: z.number() })),
          points: z.array(z.object({ id: z.string() })) });
        await expectStatus('/routes', 401, { cookie });
        const catalogueReply = await expectStatus('/routes', 200, { cookie: adminCookie });
        const catalogue = listSchema.parse(catalogueReply.data);
        assert.equal(JSON.stringify(catalogueReply.data).includes('test-server-key'), false);
        assert.deepEqual(z.object({ googleMaps: z.object({ key: z.string() }), roadRoutingEnabled: z.boolean() }).parse(catalogueReply.data),
          { googleMaps: { key: 'test-browser-key' }, roadRoutingEnabled: true });
        assert.equal(catalogue.drafts.length, 0);
        assert.deepEqual(catalogue.points.map(({ id }) => id).sort(),
          ['demo-start-catania', 'demo-start-messina', 'warehouse-milano', 'warehouse-monza']);
        const allJobs = jobsSchema.parse((await expectStatus('/routes/jobs', 200, { cookie: adminCookie })).data);
        const jobA = allJobs.jobs.find(({ deliveryId }) => deliveryId === addressA);
        assert.ok(jobA);
        assert.deepEqual(jobA.remaining.find(({ sourceLineId }) => sourceLineId === 910011), {
          sourceLineId: 910011, deliveryMilli: 1000, installationMilli: 2000, collectionMilli: 0,
        });
        async function nearby(radiusKm: number) {
          return jobsSchema.parse((await expectStatus(`/routes/jobs?anchorId=${addressA}&radiusKm=${radiusKm}`, 200, { cookie: adminCookie })).data);
        }
        const local = await nearby(10);
        assert.equal(local.anchorHasCoordinates, true);
        const jobB = local.jobs.find(({ deliveryId }) => deliveryId === addressB);
        assert.ok(jobB && jobB.distanceKm !== null && jobB.distanceKm > 8 && jobB.distanceKm < 9);
        assert.deepEqual(jobB.remaining, [{ sourceLineId: 910031, deliveryMilli: 0, installationMilli: 0, collectionMilli: 1000 }]);
        assert.ok(!local.jobs.some(({ deliveryId }) => deliveryId === addressC));
        const jobC = (await nearby(20)).jobs.find(({ deliveryId }) => deliveryId === addressC);
        assert.ok(jobC && jobC.distanceKm !== null && jobC.distanceKm > 14 && jobC.distanceKm < 16);
        assert.notEqual(jobA.pickingName, jobC.pickingName);

        const input = {
          name: 'DEMO mixed Picking route', departAt: '2031-05-14T07:00:00.000Z', crewId: homeCrew.id, vehicleId: vehicle.id,
          startPointId: 'warehouse-milano', endPointId: 'warehouse-milano', manualEstimates: [],
          stops: [{ deliveryId: addressA, workMinutes: 40 }, { deliveryId: addressC, workMinutes: 35 }],
        };
        const preview = z.object({ timeline: timelineSchema }).parse((await expectStatus('/routes/preview', 200, {
          method: 'POST', cookie: adminCookie, body: input,
        })).data);
        assert.deepEqual(preview.timeline.stops.map(({ deliveryId, eta, travelMinutes }) => [deliveryId, eta, travelMinutes]), [
          [addressA, '2031-05-14T07:30:00.000Z', 30], [addressC, '2031-05-14T08:30:00.000Z', 20],
        ]);
        assert.equal(preview.timeline.totalMinutes, 150);
        assert.equal(preview.timeline.returnAt, '2031-05-14T09:30:00.000Z');
        const create = { ...input, requestId: randomUUID() };
        const saved = routeSchema.parse(await backoffice('/routes', create));
        assert.equal(saved.version, 1);
        assert.deepEqual(saved.timeline, preview.timeline);
        assert.deepEqual(routeSchema.parse(await backoffice('/routes', create)), saved);

        const path = `/routes/${saved.id}`;
        const reverse = { ...input, stops: [...input.stops].reverse() };
        async function roadPreview(draft: unknown) {
          return RoutePreviewSchema.parse((await expectStatus('/routes/preview', 200, {
            method: 'POST', cookie: adminCookie, body: draft,
          })).data);
        }
        assert.deepEqual(roadCalls, []);
        const forwardRoad = await roadPreview({ ...input, useGoogleRoads: true });
        assert.deepEqual(forwardRoad.road, { status: 'ready', encodedPolyline: 'first_path' });
        assert.deepEqual(forwardRoad.timeline.stops.map(({ eta, travelSource }) => [eta, travelSource]), [
          ['2031-05-14T07:12:00.000Z', 'google'], ['2031-05-14T08:08:00.000Z', 'google'],
        ]);
        assert.equal(forwardRoad.timeline.returnAt, '2031-05-14T09:03:00.000Z');
        const reverseRoad = await roadPreview({ ...reverse, useGoogleRoads: true });
        assert.deepEqual(reverseRoad.road, { status: 'ready', encodedPolyline: 'second_path' });
        assert.equal(reverseRoad.timeline.stops[1]?.eta, '2031-05-14T08:11:00.000Z');
        assert.equal(reverseRoad.timeline.returnAt, '2031-05-14T09:16:00.000Z');
        assert.deepEqual(roadCalls, [[45.492, 45.4642, 45.5845, 45.492], [45.492, 45.5845, 45.4642, 45.492]]);
        const manual = await roadPreview({ ...input, useGoogleRoads: true, manualEstimates: [
          { fromPointId: 'warehouse-milano', toPointId: addressA, minutes: 5 },
        ] });
        assert.equal(manual.timeline.stops[0]?.travelSource, 'manual');
        assert.equal(manual.timeline.returnAt, '2031-05-14T08:56:00.000Z');
        const pin = { latitude: 45.5, longitude: 9.2, addressKey: jobA.addressKey };
        const pinned = { ...input, stops: [{ deliveryId: addressA, workMinutes: 40, pin }, input.stops[1]] };
        await roadPreview({ ...pinned, useGoogleRoads: true });
        assert.equal(roadCalls.at(-1)?.[1], pin.latitude);
        await roadPreview({ ...pinned, useGoogleRoads: true, stops: [
          { deliveryId: addressA, workMinutes: 40, pin: { ...pin, addressKey: '0'.repeat(64) } },
          input.stops[1],
        ] });
        assert.equal(roadCalls.at(-1)?.[1], 45.4642, 'Ignore pins with an outdated address identity');
        const reordered = routeSchema.parse(await backoffice(path, { ...reverse, version: saved.version }, 'PATCH'));
        assert.equal(reordered.version, 2);
        assert.equal(reordered.timeline.totalMinutes, 167);
        assert.equal(reordered.timeline.returnAt, '2031-05-14T09:47:00.000Z');
        const extended = { ...reverse, stops: [{ deliveryId: addressC, workMinutes: 45 }, { deliveryId: addressA, workMinutes: 40 }] };
        const updated = routeSchema.parse(await backoffice(path, { ...extended, version: reordered.version }, 'PATCH'));
        assert.equal(updated.version, 3);
        assert.equal(updated.timeline.totalMinutes, 177);
        assert.equal(updated.timeline.stops[1]?.eta, '2031-05-14T08:55:00.000Z');
        assert.equal(updated.timeline.returnAt, '2031-05-14T09:57:00.000Z');
        await expectStatus(path, 409, { method: 'PATCH', cookie: adminCookie, body: { ...input, version: reordered.version } });
        assert.deepEqual(routeSchema.parse((await expectStatus(path, 200, { cookie: adminCookie })).data), updated);
        const persisted = listSchema.parse((await expectStatus('/routes', 200, { cookie: adminCookie })).data);
        assert.deepEqual(persisted.drafts, [{ id: saved.id, version: 3, stopCount: 2 }]);
        assert.deepEqual((await readBackoffice(firstAddress)).delivery, afterChecks.delivery);
        assert.equal(roadCalls.length, 5, 'Saving and reopening drafts must not fetch a provider estimate');
      });

      await pilot.test('an operator confirms an independent entrance for matching future visits', async () => {
        const operatorId = randomUUID();
        const email = 'entrance-operator@example.test';
        const password = randomBytes(24).toString('base64url');
        await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
          [operatorId, email, 'DEMO Francesca', 'operator', await hashPassword(password)]);
        const login = await expectStatus('/auth/login', 201, { method: 'POST', body: { email, password } });
        const operatorCookie = cookieFrom(login, 'backoffice_session');
        const source = afterChecks.delivery.source;
        const initial = createDelivery({ ...source, pickingId: 911001, pickingName: 'DEMO ENTRANCE A' }, randomUUID());
        initial.routePoint = { latitude: 45.4642, longitude: 9.19 };
        await persistFixture(initial);
        const path = `/deliveries/${initial.id}/entrance`;
        const suggestionPath = `${path}/suggestion`;
        await expectStatus(path, 401);
        await expectStatus(path, 401, { cookie });
        await expectStatus(`/deliveries/${randomUUID()}/entrance`, 404, { cookie: operatorCookie });
        async function getEntrance(deliveryId: string) {
          const reply = await expectStatus(`/deliveries/${deliveryId}/entrance`, 200, { cookie: operatorCookie });
          assertNoStore(reply);
          return EntranceResponseSchema.parse(reply.data);
        }
        const view = await getEntrance(initial.id);
        assert.equal(view.entrance, null);
        assert.equal(view.stale, false);
        assert.deepEqual(view.referencePoint, initial.routePoint);
        assert.deepEqual(view.mapConfig, { key: 'test-browser-key' });
        const suggestionRequest = { method: 'POST' as const, body: { addressKey: view.addressKey } };
        await expectStatus(suggestionPath, 401, suggestionRequest);
        await expectStatus(suggestionPath, 403, { ...suggestionRequest, cookie: operatorCookie, origin: 'https://other.example' });
        await expectStatus(suggestionPath, 400, { ...suggestionRequest, cookie: operatorCookie, body: { addressKey: view.addressKey, address: 'Not accepted' } });
        await expectStatus(suggestionPath, 409, { ...suggestionRequest, cookie: operatorCookie, body: { addressKey: '0'.repeat(64) } });
        const suggestion = await expectStatus(suggestionPath, 200, { ...suggestionRequest, cookie: operatorCookie });
        assertNoStore(suggestion);
        assert.deepEqual(AddressSuggestionResponseSchema.parse(suggestion.data), {
          addressKey: view.addressKey, status: 'approximate', point: initial.routePoint, source: 'source',
        });
        assert.equal((await getEntrance(initial.id)).entrance, null, 'A reference is never saved as an entrance');

        const point = { latitude: 45.4647, longitude: 9.1882 };
        const command = { addressKey: view.addressKey, deliveryVersion: view.deliveryVersion, point, version: null, confirmed: true };
        await expectStatus(path, 401, { method: 'PATCH', body: command, cookie });
        await expectStatus(path, 400, { method: 'PATCH', cookie: operatorCookie, body: { ...command, confirmed: false } });
        await expectStatus(path, 400, { method: 'PATCH', cookie: operatorCookie, body: { ...command, point: { latitude: 91, longitude: 0 } } });
        const incomplete = createDelivery({
          ...initial.source, pickingId: 911005, customer: { ...source.customer, city: null },
        }, randomUUID());
        await persistFixture(incomplete);
        const incompleteView = await getEntrance(incomplete.id);
        const incompleteReply = await expectStatus(`/deliveries/${incomplete.id}/entrance`, 409, {
          method: 'PATCH', cookie: operatorCookie, body: { ...command, addressKey: incompleteView.addressKey },
        });
        assert.equal(ErrorCode.parse(incompleteReply.data).code, 'ENTRANCE_ADDRESS_REQUIRED');
        const confirmed = EntranceResponseSchema.parse(await backoffice(path, command, 'PATCH', operatorCookie));
        assert.deepEqual(confirmed.entrance?.point, point);
        assert.equal(confirmed.entrance?.version, 1);
        assert.deepEqual(confirmed.entrance?.confirmedBy, { id: operatorId, name: 'DEMO Francesca' });
        assert.equal(confirmed.deliveryVersion, initial.version);
        const audit = (await readBackoffice(`/deliveries/${initial.id}`)).history.find((entry) => entry.action === 'destination_entrance.confirmed');
        assert.ok(audit);
        assert.equal(audit.actorId, operatorId);

        const future = createDelivery({ ...initial.source, pickingId: 911002, pickingName: 'DEMO ENTRANCE FUTURE' }, randomUUID());
        await persistFixture(future);
        assert.deepEqual((await getEntrance(future.id)).entrance, confirmed.entrance);
        const differentAddress = createDelivery({
          ...initial.source, pickingId: 911003, customer: { ...source.customer, address: 'Different DEMO address' },
        }, randomUUID());
        await persistFixture(differentAddress);
        assert.equal((await getEntrance(differentAddress.id)).entrance, null);
        const differentCustomer = createDelivery({
          ...initial.source, pickingId: 911004, customer: { ...source.customer, id: 9911 },
        }, randomUUID());
        await persistFixture(differentCustomer);
        assert.equal((await getEntrance(differentCustomer.id)).entrance, null);
        const unrelatedSource = createDelivery(initial.source, randomUUID());
        await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
          [unrelatedSource.id, `${schema}_other`, unrelatedSource.source.pickingId, unrelatedSource.version, JSON.stringify(unrelatedSource)]);
        assert.equal((await getEntrance(unrelatedSource.id)).entrance, null);

        const revised = { ...point, latitude: 45.4651 };
        const update = { ...command, version: 1, point: revised };
        const attempts = await Promise.all([
          request(path, { method: 'PATCH', cookie: operatorCookie, body: update }),
          request(`/deliveries/${future.id}/entrance`, { method: 'PATCH', cookie: operatorCookie, body: update }),
        ]);
        assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 409]);
        assert.equal((await getEntrance(initial.id)).entrance?.version, 2);
        const job = RouteJobsSchema.parse((await expectStatus('/routes/jobs?search=DEMO%20ENTRANCE%20FUTURE', 200, { cookie: operatorCookie })).data).jobs[0];
        assert.equal(job?.deliveryId, future.id);
        assert.equal(job?.entranceConfirmed, true);
        assert.deepEqual(job?.point, revised);
        const routes = RoutePreviewSchema.parse((await expectStatus('/routes/preview', 200, { method: 'POST', cookie: operatorCookie, body: {
          name: 'DEMO shared entrance', departAt: '2031-05-14T07:00:00.000Z', crewId: null, vehicleId: null,
          startPointId: 'warehouse-milano', endPointId: 'warehouse-milano', manualEstimates: [], useGoogleRoads: true,
          stops: [
            { deliveryId: future.id, workMinutes: 10, pin: { latitude: 1, longitude: 2, addressKey: view.addressKey } },
            { deliveryId: afterChecks.delivery.id, workMinutes: 10 },
          ],
        } })).data);
        assert.equal(routes.road?.status, 'ready');
        assert.equal(roadCalls.at(-1)?.[1], revised.latitude, 'The confirmed entrance takes precedence over an older route pin');

        const changed = createDelivery({ ...initial.source, customer: { ...source.customer, address: 'New DEMO destination' } }, initial.id);
        changed.version = initial.version + 1;
        await database.source.query('UPDATE delivery SET version=$2,data=$3::jsonb WHERE id=$1', [changed.id, changed.version, JSON.stringify(changed)]);
        const current = await getEntrance(initial.id);
        assert.notEqual(current.addressKey, view.addressKey);
        assert.equal(current.entrance, null);
        assert.equal(current.stale, true);
        assert.equal((await getEntrance(future.id)).entrance?.version, 2);
        await expectStatus(path, 409, { method: 'PATCH', cookie: operatorCookie, body: { ...command, deliveryVersion: changed.version } });
        const newSuggestion = await expectStatus(suggestionPath, 200, { ...suggestionRequest, cookie: operatorCookie, body: { addressKey: current.addressKey } });
        assert.deepEqual(AddressSuggestionResponseSchema.parse(newSuggestion.data), {
          addressKey: current.addressKey, status: 'unconfigured', point: null, source: null,
        });
      });

      await expectStatus(documentRoute, 404, { cookie });
      await expectStatus(planPath, 409, { method: 'PATCH', cookie: adminCookie, body: { version: partial.version, sourceLineId: 910011, service: 'collection_only' } });
      const changed = BackofficeDetail.parse(await backoffice(planPath, { version: afterChecks.delivery.version, defaultService: 'collection_only' }, 'PATCH'));
      assert.deepEqual(changed.lineServices.map(({ sourceLineId, service }) => [sourceLineId, service]),
        [[910011, 'delivery_installation'], [910021, 'delivery_only'], [910022, 'installation_only']]);
      assert.equal(appointment(changed.delivery, deliveryVisit.id).results[0]?.servicePlanSnapshot?.defaultService, 'delivery_installation');

      const assemblyVisit = await prepare(firstAddress, 11);
      const assembly = await startWithChecklist(assemblyVisit);
      await crewWrite(`${assemblyVisit.route}/finish`, { ...report(assembly.version, [
        { sourceLineId: 910011, deliveredMilli: 0, installedMilli: 1000 },
        { sourceLineId: 910022, deliveredMilli: 0, installedMilli: 1000 },
      ]), incompleteWork: [
        { sourceLineId: 910011, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'Replacement chair is still unavailable.' },
        { sourceLineId: 910011, operation: 'installation', reason: 'missing_goods_or_parts', note: 'Second chair is not at the customer yet.' },
        { sourceLineId: 910021, operation: 'delivery', reason: 'damage', note: 'Awaiting replacement.' },
      ] }, 201, cookie);
      const installed = (await readBackoffice(firstAddress)).lineServices;
      assert.deepEqual(installed.map(({ deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli }) =>
        [deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli]), [[1000, 1000, 1000, 1000], [0, 0, 1000, 0], [0, 1000, 0, 0]]);

      const pickupVisit = await prepare(collectionAddress, 12);
      const pickup = await startWithChecklist(pickupVisit);
      const finished = CrewVisitDetail.parse(await crewWrite(`${pickupVisit.route}/finish`, report(pickup.version, [
        { sourceLineId: 910031, deliveredMilli: 0, collectedMilli: 1000 },
      ]), 201, cookie));
      const collected = await readBackoffice(collectionAddress);
      assert.equal(collected.lineServices[0]?.collectedMilli, 1000);
      assert.equal(collected.lineServices[0]?.deliveredMilli, 0);
      assert.deepEqual(collected.closureBlockers, []);
      await backoffice(`${collectionAddress}/complete`, { version: finished.version });
      const independent = await readBackoffice(otherPicking);
      assert.equal(independent.lineServices[0]?.remainingDeliveryMilli, 1000);
      const inherited = BackofficeDetail.parse(await backoffice(`${otherPicking}/services`, {
        version: independent.delivery.version, defaultService: 'installation_only',
      }, 'PATCH'));
      assert.equal(inherited.lineServices[0]?.remainingInstallationMilli, 1000);
      assert.equal(inherited.lineServices[0]?.remainingDeliveryMilli, 0);
    });

    await context.test('disable, password changes and logout revoke crew sessions without affecting backoffice', async () => {
      participant = await updateParticipant(participant, { enabled: false });
      const disabled = await expectStatus('/crew/visits', 401, { cookie: memberSession.cookie });
      assertNoStore(disabled);
      await expectStatus('/crew/auth/login', 401, { method: 'POST', body: { login: 'crew-flex@example.test', password: crewPassword } });
      participant = await updateParticipant(participant, { enabled: true });
      await expectStatus('/crew/auth/me', 401, { cookie: memberSession.cookie });
      const reenabled = await crewLogin('crew-flex@example.test');
      const newPassword = randomBytes(24).toString('base64url');
      participant = await updateParticipant(participant, { password: newPassword });
      await expectStatus('/crew/auth/me', 401, { cookie: reenabled.cookie });
      await expectStatus('/crew/auth/login', 401, { method: 'POST', body: { login: 'crew-flex@example.test', password: crewPassword } });
      const fresh = await crewLogin('crew-flex@example.test', newPassword);
      assert.equal(fresh.identity.id, participant.id);
      const logout = await expectStatus('/crew/auth/logout', 201, { method: 'POST', body: {}, cookie: fresh.cookie });
      assertNoStore(logout);
      assert.deepEqual(logout.data, { ok: true });
      await expectStatus('/crew/auth/me', 401, { cookie: fresh.cookie });
      assert.equal((await crewVisits(rosterSession.cookie))[0]?.id, foreignVisit);
      await expectStatus('/auth/me', 200, { cookie: adminCookie });
    });
  } finally {
    try {
      try {
        if (app) await app.close();
        else if (database.source.isInitialized) await database.source.destroy();
      } finally {
        if (control.isInitialized) {
          try {
            if (schemaCreated) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await control.destroy();
          }
        }
      }
    } finally {
      for (const filename of await readdir(filesDirectory)) await unlink(join(filesDirectory, filename));
      await rmdir(filesDirectory);
    }
  }
});
