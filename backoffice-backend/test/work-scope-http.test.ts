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
import { createDelivery, DeliverySchema, LineServiceStatusSchema, ScopeReviewReasonSchema, type Appointment } from '../src/domain/model';
import { appointmentScopeReviewReason, lineServiceStatuses } from '../src/domain/rules';
import { hashPassword } from '../src/identity/identity';
import { AuditSchema, CrewSchema, ParticipantSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';

class ScopeDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

const Detail = z.object({ delivery: DeliverySchema, lineServices: z.array(LineServiceStatusSchema), history: z.array(AuditSchema),
  appointmentPlanning: z.array(z.object({ appointmentId: z.string().uuid(), reviewReason: ScopeReviewReasonSchema, canEdit: z.boolean() })) });
const workLines = [{ sourceLineId: 11, deliveryMilli: 600, installationMilli: 0, collectionMilli: 0 }];
const startsAt = '2031-01-01T08:00:00Z';
const endsAt = '2031-01-01T09:00:00Z';

void test('work scope HTTP contracts, atomic reservations and source races on owned PostgreSQL', async (context) => {
  const schema = `work_scope_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^work_scope_[a-f0-9]{32}$/);
  const control = makeDataSource(true);
  const db = new ScopeDatabase(schema);
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let operatorCookie = '';
  let adminCookie = '';
  const password = randomBytes(24).toString('base64url');
  let index = 0;
  async function request(path: string, method = 'GET', body?: unknown, cookie = operatorCookie, origin: string | undefined = config().FRONTEND_ORIGIN) {
    const response = await fetch(`${base}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json();
    return { response, data };
  }
  async function success(path: string, method: string, body?: unknown, cookie = operatorCookie) {
    const result = await request(path, method, body, cookie);
    assert.ok(result.response.ok, `${result.response.status}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  async function fixture() {
    index += 1;
    const delivery = createDelivery({ pickingId: index, pickingName: `WORK-SCOPE/DEMO/${index}`, saleOrderId: index, saleOrderName: `SO/${index}`,
      sourceState: 'assigned', salesTeam: 'DEMO', customer: { id: index, name: 'DEMO Scope Customer', address: 'DEMO Street 1', city: 'Catania', country: 'IT', phones: ['+39000000001'], email: null, contact: null },
      items: [{ sourceLineId: 11, productId: 5, name: 'DEMO Table', description: null, quantity: 2, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: 60, notes: null }, randomUUID());
    await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, schema, index, delivery.version, JSON.stringify(delivery)]);
    return delivery;
  }
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.source.initialize();
    await db.source.runMigrations({ transaction: 'all' });
    for (const role of ['admin', 'operator']) await db.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), `${role}@scope.example.test`, `DEMO ${role}`, role, await hashPassword(password)]);
    await db.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(db).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const store = module.get(DeliveryStore);
    for (const role of ['admin', 'operator']) {
      const login = await request('/auth/login', 'POST', { email: `${role}@scope.example.test`, password }, '');
      assert.equal(login.response.status, 201);
      const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      if (role === 'admin') adminCookie = cookie;
      else operatorCookie = cookie;
    }

    await context.test('booking an older unworked row stores its exact known source default without overwriting later local decisions', async () => {
      const delivery = await fixture();
      delete delivery.servicePlan;
      delivery.source.serviceType = 'delivery_and_assembly';
      await store.save(db.source.manager, delivery);
      const detail = Detail.parse(await success(`/deliveries/${delivery.id}/appointments`, 'POST', { version: 1, requestId: randomUUID(), startsAt, endsAt, workLines }));
      assert.deepEqual(detail.delivery.servicePlan, { defaultService: 'delivery_installation', overrides: [] });
      assert.equal(detail.delivery.appointments[0]?.workScope?.lines[0]?.service, 'delivery_installation');
      assert.equal(detail.lineServices[0]?.remainingInstallationMilli, 2000);
    });

    await context.test('strict authenticated booking, replay and concurrent requests protect remaining quantities', async () => {
      const delivery = await fixture();
      const path = `/deliveries/${delivery.id}/appointments`;
      const input = { version: 1, requestId: randomUUID(), startsAt, endsAt, workLines };
      assert.equal((await request(path, 'POST', input, '')).response.status, 401);
      assert.equal((await request(path, 'POST', input, operatorCookie, 'http://untrusted.example.test')).response.status, 403);
      assert.equal((await request(path, 'POST', { version: 1, requestId: randomUUID(), startsAt, endsAt })).response.status, 400);
      assert.equal((await request(path, 'POST', { ...input, workLines: [workLines[0], workLines[0]] })).response.status, 400);
      const first = Detail.parse(await success(path, 'POST', input));
      assert.equal(first.delivery.appointments.length, 1);
      assert.equal(first.lineServices[0]?.availableDeliveryMilli, 1400);
      assert.deepEqual(Detail.parse(await success(path, 'POST', input)).delivery, first.delivery);
      assert.equal((await request(path, 'POST', { ...input, workLines: [{ ...workLines[0], deliveryMilli: 700 }] })).response.status, 409);
      assert.equal((await request(path, 'POST', { ...input, requestId: randomUUID() })).response.status, 409);
      const parallel = await Promise.all([1, 2].map(() => request(path, 'POST', { ...input, version: first.delivery.version,
        requestId: randomUUID(), workLines: [{ sourceLineId: 11, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }] })));
      assert.deepEqual(parallel.map((result) => result.response.status).sort(), [201, 409]);
      const after = Detail.parse(await success(`/deliveries/${delivery.id}`, 'GET'));
      assert.equal(after.delivery.appointments.length, 2);
      assert.equal(after.lineServices[0]?.reservedDeliveryMilli, 1600);
      assert.equal(after.lineServices[0]?.availableDeliveryMilli, 400);
      assert.equal((await request(path, 'POST', { ...input, version: after.delivery.version, requestId: randomUUID() })).response.status, 409);
    });

    await context.test('rescope records reason and both scopes, resets confirmation, replays once and cancellation frees work', async () => {
      const delivery = await fixture();
      const path = `/deliveries/${delivery.id}`;
      let detail = Detail.parse(await success(`${path}/appointments`, 'POST', { version: 1, requestId: randomUUID(), startsAt, endsAt, workLines }));
      const appointment = detail.delivery.appointments[0];
      assert.ok(appointment);
      const person = ParticipantSchema.parse(await success('/participants', 'POST', { firstName: 'DEMO', lastName: 'Scope Member' }, adminCookie));
      const crew = CrewSchema.parse(await success('/crews', 'POST', { name: 'DEMO Scope Crew', area: 'DEMO', classification: 'indoor', enabled: true, participantIds: [person.id] }, adminCookie));
      const template = z.object({ id: z.string().uuid() }).parse(await success('/templates', 'POST', { title: 'DEMO Scope Task', severity: 'low', order: 1, checklist: ['Check'], enabled: true }, adminCookie));
      const visitPath = `${path}/appointments/${appointment.id}`;
      detail = Detail.parse(await success(`${visitPath}/assign`, 'POST', { version: detail.delivery.version, requestId: randomUUID(), crewIds: [crew.id], templateIds: [template.id] }));
      detail = Detail.parse(await success(`${visitPath}/confirm-customer`, 'POST', { version: detail.delivery.version }));
      const update = { version: detail.delivery.version, requestId: randomUUID(), reason: 'DEMO customer changed the quantity for this visit',
        workLines: [{ sourceLineId: 11, deliveryMilli: 900, installationMilli: 0, collectionMilli: 0 }] };
      assert.equal((await request(`${visitPath}/work-scope`, 'PATCH', { ...update, reason: '' })).response.status, 400);
      detail = Detail.parse(await success(`${visitPath}/work-scope`, 'PATCH', update));
      assert.equal(detail.delivery.appointments[0]?.workScope?.revision, 2);
      assert.equal(detail.delivery.appointments[0]?.customerConfirmation, undefined);
      const audit = detail.history.find((entry) => entry.action === 'appointment.work_scope_updated');
      assert.ok(audit);
      const evidence = z.object({ reason: z.string(), previousScope: z.object({ revision: z.number() }), workScope: z.object({ revision: z.number() }), previousCustomerConfirmation: z.object({ confirmedAt: z.string() }) }).parse(audit.details);
      assert.equal(evidence.previousScope.revision, 1);
      assert.equal(evidence.workScope.revision, 2);
      assert.equal(evidence.reason, update.reason);
      assert.deepEqual(Detail.parse(await success(`${visitPath}/work-scope`, 'PATCH', update)).delivery, detail.delivery);
      detail = Detail.parse(await success(`${visitPath}/cancel`, 'POST', { version: detail.delivery.version, reason: 'DEMO released appointment' }));
      assert.equal(detail.lineServices[0]?.availableDeliveryMilli, 2000);
      assert.equal(detail.lineServices[0]?.deliveredMilli, 0);
      assert.equal(detail.delivery.appointments[0]?.workScope?.revision, 2, 'Cancelled scope remains in history');
      assert.equal((await request(`${visitPath}/work-scope`, 'PATCH', { ...update, version: detail.delivery.version, requestId: randomUUID() })).response.status, 409);
    });

    await context.test('the same scheduling lock serializes source refresh with booking, and stale scopes require explicit review', async () => {
      const delivery = await fixture();
      const mutation = db.source.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const current = await store.get(delivery.id, manager, true);
        current.source.customer.address = 'DEMO New Address';
        current.version += 1;
        await store.save(manager, current);
      });
      const booking = request(`/deliveries/${delivery.id}/appointments`, 'POST', { version: 1, requestId: randomUUID(), startsAt, endsAt, workLines });
      const [, result] = await Promise.all([mutation, booking]);
      assert.ok(result.response.status === 201 || result.response.status === 409);
      const current = await store.get(delivery.id);
      const visit = current.appointments[0];
      if (visit) assert.equal(appointmentScopeReviewReason(current, visit), 'source_changed');
      else assert.equal(current.version, 2);
      assert.equal(lineServiceStatuses(current)[0]?.deliveredMilli, 0);
    });

    await context.test('a started legacy visit can be explicitly reviewed once without fabricating result history', async () => {
      const delivery = await fixture();
      const appointment: Appointment = { id: randomUUID(), startsAt, endsAt, actualStartedAt: startsAt, status: 'in_progress',
        cancellationReason: null, returnRequestId: null, assignments: [], results: [] };
      delivery.appointments.push(appointment);
      await db.source.transaction(async (manager) => {
        await store.save(manager, delivery);
        await manager.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)', [appointment.id, delivery.id, startsAt, endsAt, appointment.status]);
      });
      const path = `/deliveries/${delivery.id}/appointments/${appointment.id}/work-scope`;
      const input = { version: 1, requestId: randomUUID(), reason: 'DEMO dispatcher reviewed the already started legacy visit', workLines };
      const reviewed = Detail.parse(await success(path, 'PATCH', input));
      assert.equal(reviewed.delivery.appointments[0]?.status, 'in_progress');
      assert.equal(reviewed.delivery.appointments[0]?.actualStartedAt, startsAt);
      assert.deepEqual(reviewed.delivery.appointments[0]?.results, []);
      assert.equal(reviewed.appointmentPlanning[0]?.canEdit, false);
      assert.equal((await request(path, 'PATCH', { ...input, version: reviewed.delivery.version, requestId: randomUUID() })).response.status, 409);
      assert.equal((await request(`/deliveries/${delivery.id}/appointments/${randomUUID()}/work-scope`, 'PATCH', { ...input, version: reviewed.delivery.version, requestId: randomUUID() })).response.status, 404);
    });
  } finally {
    if (app) await app.close();
    else if (db.source.isInitialized) await db.source.destroy();
    if (control.isInitialized) {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.destroy();
    }
  }
});
