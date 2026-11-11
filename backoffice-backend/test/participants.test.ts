import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, QueryFailedError } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { InitialSchema1793700000000 } from '../src/database/migration';
import { RelationalParticipants1793700100000 } from '../src/database/participants-migration';
import { createDelivery, DeliverySchema, TaskTemplateSchema, type Appointment, type Delivery, type SourceSnapshot, type TaskTemplate } from '../src/domain/model';
import { completeDelivery, instantiateTask, planVisitWork, recordExecution } from '../src/domain/rules';
import { Execution } from '../src/execution/execution';
import { Identity, hashPassword, verifyPassword } from '../src/identity/identity';
import { CrewIdentity } from '../src/identity/crew-identity';
import { AvailabilitySchema, AuditSchema, CrewSchema, DirectoryDeletionSchema, FileSchema, ParticipantSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';

function sourceFixture(index: number): SourceSnapshot {
  return { pickingId: index, pickingName: `PARTICIPANT/DEMO/${index}`, saleOrderId: index, saleOrderName: `PARTICIPANT/SO/${index}`,
    sourceState: 'assigned', salesTeam: 'MOHD MESSINA', customer: { id: index, name: 'DEMO staffing customer', address: 'Synthetic Road 1', city: 'Messina', country: 'IT', phones: ['+390000000001'], email: null, contact: null },
    items: [{ sourceLineId: index * 10, productId: 1, name: 'DEMO staffing item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: 'delivery_only', estimatedMinutes: null, notes: null };
}

function schemaSource(schema: string, legacyOnly = false): DataSource {
  return new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
    migrations: legacyOnly ? [InitialSchema1793700000000] : applicationMigrations,
    synchronize: false, logging: false, extra: { options: `-c search_path=${schema}` } });
}

class StaffingDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) { super(); this.source = schemaSource(schema); }
}

const Detail = z.object({ delivery: DeliverySchema, views: z.array(z.string()), progress: z.string(),
  coverage: z.object({ assigned: z.number(), total: z.number() }), closureBlockers: z.array(z.string()), files: z.array(FileSchema), history: z.array(AuditSchema) });
type DetailValue = z.infer<typeof Detail>;

void test('participant migration preserves legacy UUIDs, distinct same-name people, unknown profile fields and signed work', async () => {
  const schema = `participants_migration_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^participants_migration_[0-9a-f]{32}$/);
  const admin = makeDataSource(true);
  const legacy = schemaSource(schema, true);
  const updated = schemaSource(schema);
  // This historical test verifies the original lossless normalization, before the later exclusive-roster policy.
  updated.setOptions({ migrations: [InitialSchema1793700000000, RelationalParticipants1793700100000] });
  try {
    await admin.initialize();
    assert.equal((await rows(admin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await legacy.initialize();
    await legacy.runMigrations({ transaction: 'all' });
    const personId = randomUUID();
    const sameNameId = randomUUID();
    const historicalId = randomUUID();
    const crewOne = { id: randomUUID(), version: 7, name: 'Legacy DEMO One', classification: 'indoor', area: 'Messina', enabled: true,
      people: [{ id: personId, name: 'Legacy DEMO unknown profile', external: false }] };
    const crewTwo = { id: randomUUID(), version: 3, name: 'Legacy DEMO Two', classification: 'outdoor', area: 'Catania', enabled: false,
      people: [{ id: personId, name: 'Legacy DEMO unknown profile', external: false }, { id: sameNameId, name: 'Legacy DEMO unknown profile', external: true }] };
    for (const crew of [crewOne, crewTwo]) await legacy.query('INSERT INTO crew(id,version,data) VALUES($1,$2,$3::jsonb)', [crew.id, crew.version, JSON.stringify(crew)]);
    const template: TaskTemplate = { id: randomUUID(), version: 1, title: 'Legacy DEMO task', severity: 'low', order: 1, checklist: ['Inspect'], enabled: true };
    const actor = { kind: 'crew' as const, id: personId, name: 'Legacy DEMO unknown profile' };
    const delivery = createDelivery(sourceFixture(1), randomUUID());
    const appointment: Appointment = { id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
      assignments: [{ id: randomUUID(), crewId: crewOne.id, crewName: crewOne.name, people: [{ id: actor.id, name: actor.name, external: false },
        { id: historicalId, name: 'Legacy DEMO historical only', external: true }], tasks: [instantiateTask(template)] }], results: [] };
    appointment.status = 'in_progress';
    appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }],
      { id: randomUUID(), name: 'DEMO fixture planner', role: 'operator' }, appointment.startsAt);
    delivery.appointments.push(appointment);
    const worked = recordExecution(delivery, { id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
      actualStart: appointment.startsAt, actualEnd: appointment.endsAt, summary: 'Legacy DEMO signed work', responsiblePersonId: personId,
      quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))), evidence: [],
      customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO legacy customer', at: appointment.endsAt },
      crewSignature: { status: 'signed', signerName: actor.name, text: 'DEMO legacy crew', at: appointment.endsAt } }, actor, '2026-11-03T10:00:00Z');
    const closed = completeDelivery(worked, { id: randomUUID(), name: 'Legacy DEMO operator', role: 'operator' }, randomUUID(), '2026-11-03T10:00:00Z');
    // This migration fixture intentionally represents a stored result from before visit scopes existed.
    for (const visit of closed.appointments) { delete visit.workScope; for (const result of visit.results) delete result.workScopeSnapshot; }
    await legacy.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [closed.id, schema, 1, closed.version, JSON.stringify(closed)]);
    const before = (await rows(legacy.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [closed.id]))[0];
    assert.ok(before);
    await legacy.destroy();
    await updated.initialize();
    const applied = await updated.runMigrations({ transaction: 'all' });
    assert.equal(applied.length, 1);
    assert.deepEqual(await updated.runMigrations({ transaction: 'all' }), []);
    const profiles = await rows(updated.manager, z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable(),
      preferred_name: z.string().nullable(), phone_number: z.string().nullable(), address: z.string().nullable(), login: z.string().nullable(), password_hash: z.string().nullable(), legacy_name: z.string().nullable() }),
    'SELECT id,first_name,last_name,preferred_name,phone_number,address,login,password_hash,legacy_name FROM person ORDER BY id');
    assert.deepEqual(profiles.map((person) => person.id).sort(), [personId, sameNameId, historicalId].sort());
    for (const profile of profiles) {
      assert.equal(profile.first_name, null); assert.equal(profile.last_name, null); assert.equal(profile.preferred_name, null);
      assert.equal(profile.phone_number, null); assert.equal(profile.address, null); assert.equal(profile.login, null); assert.equal(profile.password_hash, null);
      assert.equal(profile.legacy_name, profile.id === historicalId ? 'Legacy DEMO historical only' : 'Legacy DEMO unknown profile');
    }
    const rosters = await rows(updated.manager, z.object({ crew_id: z.string().uuid(), person_id: z.string().uuid() }), 'SELECT crew_id,person_id FROM crew_member ORDER BY crew_id,position');
    assert.deepEqual(rosters.filter((entry) => entry.crew_id === crewOne.id).map((entry) => entry.person_id), [personId]);
    assert.deepEqual(rosters.filter((entry) => entry.crew_id === crewTwo.id).map((entry) => entry.person_id), [personId, sameNameId]);
    assert.equal(rosters.some((entry) => entry.person_id === historicalId), false, 'Historical membership must not become a current roster');
    const crews = await rows(updated.manager, z.object({ id: z.string().uuid(), version: z.number(), name: z.string(), enabled: z.boolean(), legacy_data: z.unknown() }), 'SELECT id,version,name,enabled,legacy_data FROM crew ORDER BY id');
    assert.equal(crews.find((crew) => crew.id === crewOne.id)?.version, 7);
    assert.equal(crews.find((crew) => crew.id === crewTwo.id)?.enabled, false);
    assert.deepEqual(crews.find((crew) => crew.id === crewOne.id)?.legacy_data, crewOne);
    assert.deepEqual((await rows(updated.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [closed.id]))[0]?.data, before.data);
  } finally {
    if (legacy.isInitialized) await legacy.destroy();
    if (updated.isInitialized) await updated.destroy();
    if (admin.isInitialized) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.destroy(); }
  }
});

void test('participant directory and visit staffing use real HTTP guards and isolated PostgreSQL constraints/transactions', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `staffing_http_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^staffing_http_[0-9a-f]{32}$/);
  const admin = makeDataSource(true);
  const database = new StaffingDatabase(schema);
  let app: NestExpressApplication | undefined;
  let base = '';
  let adminCookie = '';
  let operatorCookie = '';
  const password = randomBytes(24).toString('base64url');
  try {
    await admin.initialize();
    assert.equal((await rows(admin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize(); await database.source.runMigrations({ transaction: 'all' });
    const users = [{ id: randomUUID(), email: 'staffing-admin@example.test', name: 'DEMO staffing administrator', role: 'admin' },
      { id: randomUUID(), email: 'staffing-admin-two@example.test', name: 'DEMO second staffing administrator', role: 'admin' },
      { id: randomUUID(), email: 'staffing-operator@example.test', name: 'DEMO staffing operator', role: 'operator' }];
    const passwordHash = await hashPassword(password);
    for (const user of users) await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [user.id, user.email, user.name, user.role, passwordHash]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const store = module.get<DeliveryStore>(DeliveryStore);
    const gateway = module.get<Execution>(Execution);
    const identity = module.get<Identity>(Identity);
    async function request(route: string, method = 'GET', body?: unknown, cookie?: string) {
      const headers: Record<string, string> = { Origin: config().FRONTEND_ORIGIN };
      if (cookie) headers['Cookie'] = cookie;
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw: unknown = await response.json();
      return { status: response.status, raw };
    }
    async function success(route: string, method = 'GET', body?: unknown, cookie = operatorCookie) {
      const reply = await request(route, method, body, cookie);
      assert.ok(reply.status >= 200 && reply.status < 300, `${method} ${route}: ${reply.status} ${JSON.stringify(reply.raw)}`);
      return reply.raw;
    }
    async function failure(route: string, status: number, method = 'GET', body?: unknown, cookie?: string) {
      const reply = await request(route, method, body, cookie);
      assert.equal(reply.status, status, `${method} ${route}: ${JSON.stringify(reply.raw)}`);
      return reply.raw;
    }
    async function login(email: string): Promise<string> {
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 201);
      const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie;
    }
    adminCookie = await login('staffing-admin@example.test'); operatorCookie = await login('staffing-operator@example.test');
    const secondAdminCookie = await login('staffing-admin-two@example.test');
    async function participant(name: string, extra: Record<string, unknown> = {}) {
      return ParticipantSchema.parse(await success('/participants', 'POST', { firstName: 'DEMO', lastName: name, preferredName: name, ...extra }, adminCookie));
    }
    async function crew(name: string, participantIds: string[]) {
      return CrewSchema.parse(await success('/crews', 'POST', { name, classification: 'indoor', area: 'DEMO test area', enabled: true, participantIds }, adminCookie));
    }
    async function fixture(index: number) {
      const delivery = createDelivery(sourceFixture(index), randomUUID());
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [delivery.id, schema, index, 1, JSON.stringify(delivery)]);
      return delivery;
    }
    async function detail(id: string): Promise<DetailValue> { return Detail.parse(await success(`/deliveries/${id}`)); }
    async function book(delivery: Delivery, startsAt = '2026-11-10T08:00:00Z', endsAt = '2026-11-10T09:00:00Z') {
      const current = await detail(delivery.id);
      return Detail.parse(await success(`/deliveries/${delivery.id}/appointments`, 'POST', { version: current.delivery.version, requestId: randomUUID(), startsAt, endsAt,
        workLines: delivery.source.items.map((item) => ({ sourceLineId: item.sourceLineId, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 })) }));
    }
    function visit(detailValue: DetailValue): Appointment { const appointment = detailValue.delivery.appointments[0]; assert.ok(appointment); return appointment; }
    function updateBody(person: z.infer<typeof ParticipantSchema>, changes: Record<string, unknown> = {}) {
      return { version: person.version, firstName: person.firstName, lastName: person.lastName, preferredName: person.preferredName, phoneNumber: person.phoneNumber,
        address: person.address, login: person.login, external: person.external, enabled: person.enabled, ...changes };
    }

    await context.test('participant authentication, admin writes, strict fields, case-insensitive logins and password privacy/preservation', async () => {
      await failure('/participants', 401);
      await failure('/participants', 401, 'POST', { firstName: 'DEMO', lastName: 'Anonymous' });
      await failure('/participants', 403, 'POST', { firstName: 'DEMO', lastName: 'Forbidden' }, operatorCookie);
      await failure('/participants', 400, 'POST', { firstName: '', lastName: 'Invalid' }, adminCookie);
      await failure('/participants', 400, 'POST', { firstName: 'DEMO', lastName: 'Invalid', role: 'admin' }, adminCookie);
      await failure('/participants', 400, 'POST', { firstName: 'DEMO', lastName: 'Invalid', login: 'login-without-password' }, adminCookie);
      await failure('/participants', 400, 'POST', { firstName: 'DEMO', lastName: 'Short password', login: 'short-password', password: randomBytes(20).toString('base64url').slice(0, 14) }, adminCookie);
      const crewPassword = randomBytes(20).toString('base64url');
      const raw = await success('/participants', 'POST', { firstName: 'DEMO', lastName: 'Technician', preferredName: 'DEMO specialist', phoneNumber: '+390000000099',
        address: 'DEMO address', login: 'Technician@example.test', password: crewPassword, external: true }, adminCookie);
      let person = ParticipantSchema.parse(raw);
      const publicRecord = z.record(z.string(), z.unknown()).parse(raw);
      for (const secret of ['password', 'passwordHash', 'password_hash']) assert.equal(Object.hasOwn(publicRecord, secret), false);
      assert.equal(JSON.stringify(raw).includes(crewPassword), false); assert.equal(person.hasPassword, true);
      await failure('/participants', 409, 'POST', { firstName: 'DEMO', lastName: 'Other', login: 'tECHNICIAN@example.test', password: randomBytes(20).toString('base64url') }, adminCookie);
      await failure('/participants/' + person.id, 403, 'PATCH', updateBody(person), operatorCookie);
      const beforeHash = (await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [person.id]))[0]?.password_hash;
      assert.ok(beforeHash); assert.equal(await verifyPassword(crewPassword, beforeHash), true);
      const oldVersion = person.version;
      person = ParticipantSchema.parse(await success('/participants/' + person.id, 'PATCH', updateBody(person, { phoneNumber: '+390000000098' }), adminCookie));
      assert.equal(person.version, oldVersion + 1);
      assert.ok((await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [person.id]))[0]?.password_hash === beforeHash, 'Omitting a password must retain the stored hash');
      await failure('/participants/' + person.id, 400, 'PATCH', updateBody(person, { password: '' }), adminCookie);
      await failure('/participants/' + person.id, 400, 'PATCH', updateBody(person, { firstName: null, lastName: null }), adminCookie);
      assert.ok((await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [person.id]))[0]?.password_hash === beforeHash, 'Rejected blank password must not alter credentials');
      let databaseRejectedDuplicate = false;
      try {
        await database.source.query('INSERT INTO person(id,first_name,last_name,login,password_hash,external) VALUES($1,$2,$3,$4,$5,false)',
          [randomUUID(), 'DEMO', 'Database uniqueness fixture', 'tECHNICIAN@example.test', beforeHash]);
      } catch (error: unknown) {
        const driver: unknown = error instanceof QueryFailedError ? error.driverError : null;
        databaseRejectedDuplicate = z.object({ code: z.literal('23505'), constraint: z.literal('person_login_unique') }).safeParse(driver).success;
      }
      assert.equal(databaseRejectedDuplicate, true, 'PostgreSQL must enforce case-insensitive login uniqueness independently of HTTP validation');
      await failure('/participants/' + person.id, 409, 'PATCH', { ...updateBody(person), version: oldVersion }, adminCookie);
      const replacementPassword = randomBytes(20).toString('base64url').slice(0, 15);
      person = ParticipantSchema.parse(await success('/participants/' + person.id, 'PATCH', updateBody(person, { password: replacementPassword }), adminCookie));
      const newHash = (await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [person.id]))[0]?.password_hash;
      assert.ok(newHash); assert.ok(newHash !== beforeHash, 'An explicit new password must replace the hash');
      assert.equal(await verifyPassword(replacementPassword, newHash), true);
      assert.equal(await verifyPassword(crewPassword, newHash), false);
      const loginResult = await request('/auth/login', 'POST', { email: 'technician@example.test', password: replacementPassword });
      assert.equal(loginResult.status, 401, 'Crew credentials must never grant a backoffice session');
      const listed = z.array(ParticipantSchema).parse(await success('/participants'));
      assert.ok(listed.some((entry) => entry.id === person.id && entry.hasPassword));
      assert.equal(JSON.stringify(listed).includes(beforeHash), false);
      const sameNameOne = await participant('Same DEMO display'); const sameNameTwo = await participant('Same DEMO display');
      assert.equal(sameNameOne.name, sameNameTwo.name); assert.notEqual(sameNameOne.id, sameNameTwo.id);
    });

    const a = await participant('Person A'); const b = await participant('Person B'); const c = await participant('Person C');
    const d = await participant('Person D'); const e = await participant('Person E'); const f = await participant('Shared race');
    const disabled = await participant('Disabled person', { enabled: false });
    const firstCrew = await crew('DEMO staffing one', [a.id]); const secondCrew = await crew('DEMO staffing two', [b.id]);
    const emptyCrew = await crew('DEMO empty default roster', []);
    const template = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'DEMO staffing task', severity: 'low', order: 2, checklist: ['Check item', 'Clean area'], enabled: true }, adminCookie));
    const firstDelivery = await fixture(10); let first = await book(firstDelivery); const firstVisit = visit(first);
    const basePath = `/deliveries/${firstDelivery.id}/appointments/${firstVisit.id}/participants`;
    async function assign(delivery: Delivery, booked: DetailValue, crewIds: string[], staffing?: { crewId: string; participantIds: string[] }[]) {
      return request(`/deliveries/${delivery.id}/appointments/${visit(booked).id}/assign`, 'POST', { version: booked.delivery.version, requestId: randomUUID(), crewIds, templateIds: [template.id], ...(staffing ? { staffing } : {}) }, operatorCookie);
    }

    await context.test('exclusive default rosters use real admin rights, UUID identity, retained membership and clear bounded conflict names', async () => {
      const crewBody = { name: 'DEMO restricted roster', classification: 'indoor', area: 'DEMO area', enabled: true, participantIds: [] };
      await failure('/crews', 401, 'POST', crewBody);
      await failure('/crews', 403, 'POST', crewBody, operatorCookie);
      await failure('/crews/not-a-uuid', 400, 'PATCH', { ...crewBody, version: 1 }, adminCookie);
      await failure('/crews', 400, 'POST', { ...crewBody, name: 'x'.repeat(2001) }, adminCookie);
      await failure('/crews', 404, 'POST', { ...crewBody, participantIds: [randomUUID()] }, adminCookie);
      const personPrefix = 'DEMO "Person" <&> '; const crewPrefix = 'DEMO "Crew" <&> ';
      const boundedName = personPrefix + 'p'.repeat(2000 - personPrefix.length);
      const boundedCrewName = crewPrefix + 'c'.repeat(2000 - crewPrefix.length);
      const named = await participant('Boundary profile', { preferredName: boundedName });
      let original = await crew(boundedCrewName, [named.id.toUpperCase()]);
      const savedBody = { version: original.version, name: original.name, classification: original.classification, area: original.area, enabled: false, participantIds: [named.id.toUpperCase()] };
      await failure('/crews/' + original.id, 403, 'PATCH', savedBody, operatorCookie);
      await failure('/crews/' + original.id, 400, 'PATCH', { ...savedBody, participantIds: [named.id, named.id.toUpperCase()] }, adminCookie);
      original = CrewSchema.parse(await success('/crews/' + original.id.toUpperCase(), 'PATCH', savedBody, adminCookie));
      assert.deepEqual(original.people.map((person) => person.id), [named.id]);
      await failure('/crews/' + original.id, 409, 'PATCH', savedBody, adminCookie);
      const before = await rows(database.source.manager, z.object({ id: z.string().uuid(), version: z.number() }), 'SELECT id,version FROM crew ORDER BY id');
      const auditBefore = await rows(database.source.manager, z.object({ count: z.string() }), 'SELECT count(*)::text AS count FROM audit');
      const conflict = z.object({ message: z.string() }).parse(await failure('/crews', 409, 'POST', { ...crewBody, participantIds: [named.id.toUpperCase()] }, adminCookie));
      assert.ok(conflict.message.includes(boundedName)); assert.ok(conflict.message.includes(boundedCrewName));
      assert.deepEqual(await rows(database.source.manager, z.object({ id: z.string().uuid(), version: z.number() }), 'SELECT id,version FROM crew ORDER BY id'), before);
      assert.deepEqual(await rows(database.source.manager, z.object({ count: z.string() }), 'SELECT count(*)::text AS count FROM audit'), auditBefore);
      const equalName = await participant('Boundary profile', { preferredName: boundedName });
      assert.equal(equalName.name, named.name); assert.notEqual(equalName.id, named.id);
      const other = await crew(boundedCrewName, [equalName.id]);
      await failure('/crews/' + other.id, 409, 'PATCH', { version: other.version, name: other.name, classification: other.classification, area: other.area, enabled: true, participantIds: [named.id] }, adminCookie);
      const retained = z.array(CrewSchema).parse(await success('/crews')).find((entry) => entry.id === other.id);
      assert.deepEqual(retained, other, 'Rejected replacement must roll back roster, metadata and version');
      await success('/crews/' + original.id, 'PATCH', { ...savedBody, version: original.version, participantIds: [] }, adminCookie);
      const moved = CrewSchema.parse(await success('/crews/' + other.id, 'PATCH', { version: other.version, name: other.name, classification: other.classification, area: other.area, enabled: true, participantIds: [named.id] }, adminCookie));
      assert.deepEqual(moved.people.map((person) => person.id), [named.id]);
      let databaseRejectedDuplicate = false;
      try { await database.source.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0)', [original.id, named.id.toUpperCase()]); }
      catch (error: unknown) {
        const driver: unknown = error instanceof QueryFailedError ? error.driverError : null;
        databaseRejectedDuplicate = z.object({ code: z.literal('23505'), constraint: z.literal('crew_member_person_unique') }).safeParse(driver).success;
      }
      assert.equal(databaseRejectedDuplicate, true, 'PostgreSQL independently prevents assigning one UUID to two default rosters');
    });

    await context.test('two administrators cannot concurrently assign a free person to different default crews', async () => {
      const person = await participant('Default roster race');
      const one = await crew('DEMO default race one', []); const two = await crew('DEMO default race two', []);
      const body = (current: z.infer<typeof CrewSchema>) => ({ version: current.version, name: current.name, classification: current.classification, area: current.area, enabled: current.enabled, participantIds: [person.id] });
      const replies = await Promise.all([request('/crews/' + one.id, 'PATCH', body(one), adminCookie), request('/crews/' + two.id, 'PATCH', body(two), secondAdminCookie)]);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
      const rosters = await rows(database.source.manager, z.object({ crew_id: z.string().uuid() }), 'SELECT crew_id FROM crew_member WHERE person_id=$1', [person.id]);
      assert.equal(rosters.length, 1);
      const failedCrew = replies[0]?.status === 409 ? one : two;
      const after = z.array(CrewSchema).parse(await success('/crews')).find((entry) => entry.id === failedCrew.id);
      assert.deepEqual(after, failedCrew, 'The losing command leaves no partial version, metadata or roster changes');
      const audits = await rows(database.source.manager, z.object({ count: z.string() }), "SELECT count(*)::text AS count FROM audit WHERE action='crew.saved' AND details->>'id'=ANY($1::text[])", [[one.id, two.id]]);
      assert.equal(audits[0]?.count, '3', 'Only the two initial creates and one successful staffing command are audited');
    });

    await context.test('initial staffing overrides canonical rosters and rejects unknown/disabled/duplicate/empty people', async () => {
      await failure(basePath, 401);
      for (const [participantIds, status] of [[[randomUUID()], 404], [[disabled.id], 409], [[a.id, a.id], 400], [[], 400]] as const) {
        const reply = await assign(firstDelivery, first, [firstCrew.id], [{ crewId: firstCrew.id, participantIds: [...participantIds] }]);
        assert.equal(reply.status, status, JSON.stringify(reply.raw));
      }
      assert.equal((await assign(firstDelivery, first, [emptyCrew.id])).status, 400, 'An empty default roster requires an explicit nonempty staffing selection');
      const assigned = await assign(firstDelivery, first, [firstCrew.id, secondCrew.id], [{ crewId: firstCrew.id, participantIds: [c.id] }, { crewId: secondCrew.id, participantIds: [b.id] }]);
      assert.equal(assigned.status, 201, JSON.stringify(assigned.raw)); first = Detail.parse(assigned.raw);
      assert.deepEqual(visit(first).assignments.find((assignment) => assignment.crewId === firstCrew.id)?.people.map((person) => person.id), [c.id]);
      const canonical = z.array(CrewSchema).parse(await success('/crews')).find((entry) => entry.id === firstCrew.id);
      assert.deepEqual(canonical?.people.map((person) => person.id), [a.id]);
    });

    await context.test('availability excludes the current visit and treats adjacent intervals as non-overlapping', async () => {
      const current = AvailabilitySchema.parse(await success(basePath));
      assert.equal(current.people.find((person) => person.id === c.id)?.busy, false);
      assert.equal(current.people.find((person) => person.id === b.id)?.busy, false);
      const adjacentDelivery = await fixture(11); const adjacent = await book(adjacentDelivery, '2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z');
      const adjacentCrew = await crew('DEMO adjacent C', [c.id]);
      assert.equal((await assign(adjacentDelivery, adjacent, [adjacentCrew.id])).status, 201);
      const refreshed = AvailabilitySchema.parse(await success(basePath));
      assert.equal(refreshed.people.find((person) => person.id === c.id)?.busy, false);
      const busyDelivery = await fixture(12); const busy = await book(busyDelivery); const busyCrew = await crew('DEMO busy D', [d.id]);
      assert.equal((await assign(busyDelivery, busy, [busyCrew.id])).status, 201);
      const withConflict = AvailabilitySchema.parse(await success(basePath));
      const candidate = withConflict.people.find((person) => person.id === d.id);
      assert.equal(candidate?.busy, true); assert.equal(candidate?.conflicts[0]?.appointmentId, visit(busy).id);
    });

    await context.test('staffing patch preserves assignment/task IDs, audits reason, releases removed reservations and rolls back conflicts', async () => {
      const oldAssignments = structuredClone(visit(first).assignments);
      await success('/participants/' + b.id, 'PATCH', updateBody(b, { enabled: false }), adminCookie);
      assert.deepEqual(visit(await detail(firstDelivery.id)).assignments, oldAssignments, 'Disabling a person must not rewrite an existing booking');
      const firstAssignment = oldAssignments.find((assignment) => assignment.crewId === firstCrew.id);
      assert.ok(firstAssignment);
      const change = { version: first.delivery.version, reason: 'DEMO replace the unavailable participant', assignments: oldAssignments.map((assignment) => ({
        assignmentId: assignment.id, participantIds: assignment.id === firstAssignment.id ? [a.id] : assignment.people.map((person) => person.id),
      })) };
      first = Detail.parse(await success(basePath, 'PATCH', change));
      for (const previous of oldAssignments) {
        const current = visit(first).assignments.find((assignment) => assignment.id === previous.id);
        assert.ok(current); assert.deepEqual(current.tasks, previous.tasks);
      }
      assert.ok(first.history.some((event) => z.object({ reason: z.literal(change.reason) }).safeParse(event.details).success));
      const resources = await rows(database.source.manager, z.object({ resource: z.string() }), 'SELECT resource FROM reservation WHERE appointment_id=$1', [firstVisit.id]);
      assert.equal(resources.some((entry) => entry.resource === 'person:' + c.id), false);
      assert.equal(resources.some((entry) => entry.resource === 'person:' + a.id), true);
      const freedDelivery = await fixture(13); const freed = await book(freedDelivery); const freedCrew = await crew('DEMO released C', []);
      assert.equal((await assign(freedDelivery, freed, [freedCrew.id], [{ crewId: freedCrew.id, participantIds: [c.id] }])).status, 201);
      const version = first.delivery.version;
      const assignmentsBeforeConflict = structuredClone(visit(first).assignments);
      const resourcesBeforeConflict = [...resources].sort((left, right) => left.resource.localeCompare(right.resource));
      await failure(basePath, 409, 'PATCH', { version, reason: 'DEMO competing participant conflict', assignments: oldAssignments.map((assignment) => ({
        assignmentId: assignment.id, participantIds: assignment.id === firstAssignment.id ? [d.id] : [e.id],
      })) }, operatorCookie);
      const unchanged = await detail(firstDelivery.id);
      assert.equal(unchanged.delivery.version, version); assert.deepEqual(visit(unchanged).assignments, assignmentsBeforeConflict);
      assert.deepEqual((await rows(database.source.manager, z.object({ resource: z.string() }), 'SELECT resource FROM reservation WHERE appointment_id=$1', [firstVisit.id])).sort((left, right) => left.resource.localeCompare(right.resource)), resourcesBeforeConflict);
    });

    await context.test('staffing requires exact assignment coverage, distinct enabled people, a reason and a fresh version', async () => {
      const assignments = visit(first).assignments.map((assignment) => ({ assignmentId: assignment.id, participantIds: assignment.people.map((person) => person.id) }));
      const valid = { version: first.delivery.version, reason: 'DEMO valid staffing edit', assignments };
      const firstAssignment = assignments[0]; assert.ok(firstAssignment);
      const firstCrewAssignment = visit(first).assignments.find((assignment) => assignment.crewId === firstCrew.id); assert.ok(firstCrewAssignment);
      await failure(basePath, 409, 'PATCH', { ...valid, version: first.delivery.version - 1 }, operatorCookie);
      await failure(basePath, 400, 'PATCH', { ...valid, reason: '' }, operatorCookie);
      await failure(basePath, 400, 'PATCH', { ...valid, assignments: [] }, operatorCookie);
      await failure(basePath, 400, 'PATCH', { ...valid, assignments: assignments.map((assignment) => ({ ...assignment, participantIds: [e.id] })) }, operatorCookie);
      await failure(basePath, 400, 'PATCH', { ...valid, assignments: [...assignments, firstAssignment] }, operatorCookie);
      await failure(basePath, 400, 'PATCH', { ...valid, assignments: assignments.map((assignment, index) => index === 0 ? { ...assignment, assignmentId: randomUUID() } : assignment) }, operatorCookie);
      await failure(basePath, 404, 'PATCH', { ...valid, assignments: assignments.map((assignment) => ({ ...assignment, participantIds: [randomUUID()] })) }, operatorCookie);
      await failure(basePath, 409, 'PATCH', { ...valid, assignments: assignments.map((assignment) => assignment.assignmentId === firstCrewAssignment.id ? { ...assignment, participantIds: [disabled.id] } : assignment) }, operatorCookie);
      await failure(basePath, 409, 'PATCH', { ...valid, assignments: assignments.map((assignment) => ({ ...assignment,
        participantIds: assignment.assignmentId === firstCrewAssignment.id ? [b.id] : [e.id],
      })) }, operatorCookie);
      assert.equal((await detail(firstDelivery.id)).delivery.version, first.delivery.version);
    });

    await context.test('two competing assignment transactions cannot reserve the same participant', async () => {
      const one = await fixture(20); const two = await fixture(21); const firstBooked = await book(one); const secondBooked = await book(two);
      const crewOne = await crew('DEMO race one', [f.id]); const crewTwo = await crew('DEMO race two', []);
      const replies = await Promise.all([assign(one, firstBooked, [crewOne.id]), assign(two, secondBooked, [crewTwo.id], [{ crewId: crewTwo.id, participantIds: [f.id] }])]);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
      assert.equal((await rows(database.source.manager, z.object({ appointment_id: z.string().uuid() }), 'SELECT appointment_id FROM reservation WHERE resource=$1', ['person:' + f.id])).length, 1);
    });

    await context.test('profile and roster edits retain historical snapshots; in-progress and completed visits reject staffing changes', async () => {
      const workDelivery = await fixture(30);
      const startsAt = new Date(Date.now() - 3_600_000).toISOString(); const endsAt = new Date(Date.now() - 1_800_000).toISOString();
      let worked = await book(workDelivery, startsAt, endsAt); const workCrew = await crew('DEMO historical crew', [e.id]);
      const assigned = await assign(workDelivery, worked, [workCrew.id]); assert.equal(assigned.status, 201); worked = Detail.parse(assigned.raw);
      const appointment = visit(worked); const principal = await identity.authenticate({ headers: { cookie: operatorCookie } });
      worked = Detail.parse(await success(`/deliveries/${workDelivery.id}/appointments/${appointment.id}/confirm-customer`, 'POST', { version: worked.delivery.version }));
      const authorized = await gateway.authorizeLocalScenario(workDelivery.id, appointment.id, principal);
      worked = Detail.parse(await gateway.start(authorized, worked.delivery.version));
      const path = `/deliveries/${workDelivery.id}/appointments/${appointment.id}/participants`;
      const staffing = () => ({ version: worked.delivery.version, reason: 'DEMO forbidden after start', assignments: visit(worked).assignments.map((assignment) => ({ assignmentId: assignment.id, participantIds: [e.id] })) });
      await failure(path, 409, 'PATCH', staffing(), operatorCookie);
      const representative = gateway.representative(authorized);
      worked = Detail.parse(await gateway.receive(authorized, worked.delivery.version, { id: randomUUID(), appointmentId: appointment.id,
        supersedesResultId: null, correctionReason: null, actualStart: startsAt, actualEnd: endsAt, summary: 'DEMO staffing history', responsiblePersonId: representative.id,
        quantities: [{ sourceLineId: 300, deliveredMilli: 1000 }], completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))), evidence: [],
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer confirmation', at: endsAt },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew confirmation', at: endsAt } }));
      const before = structuredClone(worked.delivery.appointments);
      await success('/participants/' + e.id, 'PATCH', updateBody(e, { preferredName: 'DEMO renamed future person' }), adminCookie);
      await success('/crews/' + workCrew.id, 'PATCH', { version: workCrew.version, name: workCrew.name, classification: workCrew.classification, area: workCrew.area, enabled: false, participantIds: [] }, adminCookie);
      assert.deepEqual((await detail(workDelivery.id)).delivery.appointments, before);
      await failure(path, 409, 'PATCH', staffing(), operatorCookie);
      assert.equal(store.db.source.isInitialized, true);
    });

    await context.test('directory CRUD reads single records, protects deletion by role/origin/version and deletes unused records without exposing credentials', async () => {
      const loginPassword = randomBytes(24).toString('base64url');
      const skill = z.object({ id: z.string().uuid() }).parse(await success('/skills', 'POST', { name: 'DEMO deletion skill', enabled: true }, adminCookie));
      const removable = await participant('Removable', { login: 'crud-member@example.test', password: loginPassword, skillIds: [skill.id] });
      const removableCrew = await crew('DEMO removable crew', [removable.id]);
      const removableTemplate = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'DEMO removable task', severity: 'low', order: 0, checklist: ['Inspect'], enabled: true, requiredSkillIds: [] }, adminCookie));
      const crewLogin = await module.get<CrewIdentity>(CrewIdentity).login({ login: removable.login, password: loginPassword });
      const crewCookie = `crew_session=${crewLogin.token}`;
      await failure(`/participants/${removable.id}`, 409, 'DELETE', { version: removable.version }, adminCookie);
      for (const entry of [{ path: 'crews', record: removableCrew }, { path: 'participants', record: removable }, { path: 'templates', record: removableTemplate }]) {
        const route = `/${entry.path}/${entry.record.id}`;
        assert.deepEqual(await success(route), entry.record);
        await failure(route, 401);
        await failure(route, 401, 'GET', undefined, crewCookie);
        await failure(route, 401, 'DELETE', { version: entry.record.version });
        await failure(route, 401, 'DELETE', { version: entry.record.version }, crewCookie);
        await failure(route, 403, 'DELETE', { version: entry.record.version }, operatorCookie);
        await failure(route, 400, 'DELETE', { version: 0 }, adminCookie);
        await failure(route, 400, 'DELETE', { version: entry.record.version, force: true }, adminCookie);
        await failure(route, 409, 'DELETE', { version: entry.record.version + 1 }, adminCookie);
        await failure(`/${entry.path}/invalid`, 400, 'DELETE', { version: 1 }, adminCookie);
        await failure(`/${entry.path}/${randomUUID()}`, 404, 'DELETE', { version: 1 }, adminCookie);
        const crossOrigin = await fetch(`${base}/api${route}`, { method: 'DELETE', headers: { Origin: 'https://untrusted.example.test', Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: entry.record.version }) });
        assert.equal(crossOrigin.status, 403); await crossOrigin.arrayBuffer();
        const preflight = await fetch(`${base}/api${route}`, { method: 'OPTIONS', headers: { Origin: config().FRONTEND_ORIGIN, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'content-type' } });
        assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /DELETE/); await preflight.arrayBuffer();
        const deleted = DirectoryDeletionSchema.parse(await success(route, 'DELETE', { version: entry.record.version }, adminCookie));
        assert.deepEqual(deleted, { id: entry.record.id, deleted: true });
        await failure(route, 404, 'GET', undefined, adminCookie);
        await failure(route, 404, 'DELETE', { version: entry.record.version }, adminCookie);
        const listing = z.array(z.object({ id: z.string().uuid() })).parse(await success(`/${entry.path}`));
        assert.equal(listing.some(({ id }) => id === entry.record.id), false);
        if (entry.path === 'crews') assert.deepEqual(await success(`/participants/${removable.id}`), removable, 'Deleting an unused crew must preserve its people');
        const audits = await rows(database.source.manager, z.object({ details: z.unknown() }), "SELECT details FROM audit WHERE action LIKE '%.deleted' AND details->>'id'=$1", [entry.record.id]);
        assert.deepEqual(audits, [{ details: { id: entry.record.id, version: entry.record.version } }]);
      }
      assert.equal((await rows(database.source.manager, z.object({ person_id: z.string().uuid() }), 'SELECT person_id FROM participant_skill WHERE person_id=$1', [removable.id])).length, 0);
      assert.equal((await rows(database.source.manager, z.object({ person_id: z.string().uuid() }), 'SELECT person_id FROM crew_session WHERE person_id=$1', [removable.id])).length, 0);
      await assert.rejects(module.get<CrewIdentity>(CrewIdentity).authenticate({ headers: { cookie: crewCookie } }), /Crew session expired/);
    });

    await context.test('deletion rejects current, cancelled and historical assignment references without changing snapshots', async () => {
      const linkedPerson = await participant('History delete guard');
      const linkedCrew = await crew('DEMO historical delete guard', [linkedPerson.id]);
      const linkedTemplate = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'DEMO historical delete task', severity: 'low', order: 0, checklist: ['Inspect'], enabled: true, requiredSkillIds: [] }, adminCookie));
      const source = await fixture(80); const booked = await book(source);
      let linked = Detail.parse(await success(`/deliveries/${source.id}/appointments/${visit(booked).id}/assign`, 'POST', { version: booked.delivery.version, requestId: randomUUID(), crewIds: [linkedCrew.id], templateIds: [linkedTemplate.id] }));
      const detached = CrewSchema.parse(await success(`/crews/${linkedCrew.id}`, 'PATCH', { version: linkedCrew.version, name: linkedCrew.name, area: linkedCrew.area, classification: linkedCrew.classification, enabled: true, participantIds: [] }, adminCookie));
      const entries = [{ path: 'participants', record: linkedPerson }, { path: 'crews', record: detached }, { path: 'templates', record: linkedTemplate }];
      for (const status of ['booked', 'cancelled'] as const) {
        if (status === 'cancelled') linked = Detail.parse(await success(`/deliveries/${source.id}/appointments/${visit(linked).id}/cancel`, 'POST', { version: linked.delivery.version, reason: 'DEMO cancellation retains directory history' }));
        const before = structuredClone(linked.delivery);
        for (const entry of entries) {
          const response = await failure(`/${entry.path}/${entry.record.id}`, 409, 'DELETE', { version: entry.record.version }, adminCookie);
          assert.match(z.object({ message: z.string() }).parse(response).message, /Disable it instead/);
        }
        assert.deepEqual((await detail(source.id)).delivery, before);
      }
      const currentTemplate = TaskTemplateSchema.parse(await success(`/templates/${template.id}`));
      await failure(`/templates/${template.id}`, 409, 'DELETE', { version: currentTemplate.version }, adminCookie);
      const historical = ParticipantSchema.parse(await success(`/participants/${e.id}`));
      await failure(`/participants/${e.id}`, 409, 'DELETE', { version: historical.version }, adminCookie);
    });

    await context.test('directory deletion also protects nested driver/result UUIDs and saved route crew references', async () => {
      const protectedPerson = await participant('Nested history');
      const protectedDriver = await participant('Retired driver history');
      const protectedTemplate = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'DEMO result-only task', severity: 'low', order: 0, checklist: ['Inspect'], enabled: true, requiredSkillIds: [] }, adminCookie));
      const protectedCrew = await crew('DEMO route crew guard', []);
      const history = await fixture(81);
      const baseHistory = (await store.all()).find((delivery) => delivery.appointments.some((appointment) => appointment.results.length > 0));
      assert.ok(baseHistory);
      const historicalVisit = baseHistory.appointments.find((appointment) => appointment.results.length > 0); assert.ok(historicalVisit);
      const historicResult = historicalVisit.results[0]; assert.ok(historicResult);
      const snapshot = structuredClone(historicalVisit);
      snapshot.id = randomUUID();
      const oldResultId = randomUUID();
      const auditor = users[0]; assert.ok(auditor);
      const author = { id: auditor.id, name: auditor.name };
      snapshot.results = [{ ...structuredClone(historicResult), id: oldResultId, appointmentId: snapshot.id,
        assignmentsSnapshot: historicResult.assignmentsSnapshot.map((assignment) => ({ ...assignment,
          people: [{ id: protectedPerson.id.toUpperCase(), name: protectedPerson.name, external: false }],
          tasks: assignment.tasks.map((task) => ({ ...task, templateId: protectedTemplate.id })),
        })),
        transportSnapshot: [{ id: randomUUID(), vehicle: { id: randomUUID(), version: 1, ownership: 'company', name: 'DEMO historical vehicle', plate: 'DEMO-HISTORY', providerName: null, providerContact: null },
          driver: { kind: 'participant', person: { id: protectedDriver.id, name: protectedDriver.name, external: false } },
          reserveFrom: snapshot.startsAt, reserveTo: snapshot.endsAt, status: 'cancelled', createdAt: snapshot.startsAt, createdBy: author,
          replacesAllocationId: null, retiredAt: snapshot.endsAt, retiredBy: author, retirementReason: 'DEMO cancelled allocation retained with result' }],
      }, { ...structuredClone(historicResult), id: randomUUID(), appointmentId: snapshot.id, supersedesResultId: oldResultId, correctionReason: 'DEMO corrected report retains earlier snapshot' }];
      history.appointments = [snapshot];
      await store.save(database.source.manager, DeliverySchema.parse(history));
      const before = await store.get(history.id);
      await failure(`/participants/${protectedPerson.id}`, 409, 'DELETE', { version: protectedPerson.version }, adminCookie);
      await failure(`/participants/${protectedDriver.id}`, 409, 'DELETE', { version: protectedDriver.version }, adminCookie);
      await failure(`/templates/${protectedTemplate.id}`, 409, 'DELETE', { version: protectedTemplate.version }, adminCookie);
      assert.deepEqual(await store.get(history.id), before);
      const routeId = randomUUID();
      const routeJob = await fixture(83);
      const catalogue = z.object({ points: z.array(z.object({ id: z.string() })).min(1) }).parse(await success('/routes'));
      const depot = catalogue.points[0]; assert.ok(depot);
      await success('/routes', 'POST', { requestId: routeId, name: 'DEMO deletion guard route', departAt: '2026-12-01T08:00:00Z', crewId: protectedCrew.id, vehicleId: null,
        startPointId: depot.id, endPointId: depot.id, stops: [{ deliveryId: routeJob.id, workMinutes: 30 }], manualEstimates: [], useLocalEstimates: false });
      const routeBefore = await rows(database.source.manager, z.object({ data: z.unknown() }), 'SELECT data FROM route_draft WHERE id=$1', [routeId]);
      await failure(`/crews/${protectedCrew.id}`, 409, 'DELETE', { version: protectedCrew.version }, adminCookie);
      assert.deepEqual(await rows(database.source.manager, z.object({ data: z.unknown() }), 'SELECT data FROM route_draft WHERE id=$1', [routeId]), routeBefore);
    });

    await context.test('delete cannot race a concurrent update or assignment into a dangling reference', async () => {
      const concurrentPerson = await participant('Concurrent delete update');
      const updatePath = `/participants/${concurrentPerson.id}`;
      const [updated, deleted] = await Promise.all([
        request(updatePath, 'PATCH', updateBody(concurrentPerson, { preferredName: 'DEMO concurrent rename' }), adminCookie),
        request(updatePath, 'DELETE', { version: concurrentPerson.version }, adminCookie),
      ]);
      if (deleted.status === 200) { assert.equal(updated.status, 404); await failure(updatePath, 404, 'GET', undefined, adminCookie); }
      else { assert.equal(deleted.status, 409); assert.equal(updated.status, 200); assert.equal(ParticipantSchema.parse(await success(updatePath)).version, 2); }
      const racingPerson = await participant('Concurrent delete assignment');
      const racingCrew = await crew('DEMO concurrent deletion crew', []);
      const source = await fixture(82); const booked = await book(source);
      const [assigned, removed] = await Promise.all([
        assign(source, booked, [racingCrew.id], [{ crewId: racingCrew.id, participantIds: [racingPerson.id] }]),
        request(`/participants/${racingPerson.id}`, 'DELETE', { version: racingPerson.version }, adminCookie),
      ]);
      if (removed.status === 200) { assert.equal(assigned.status, 404); assert.equal(visit(await detail(source.id)).assignments.length, 0); }
      else { assert.equal(removed.status, 409); assert.equal(assigned.status, 201); assert.equal(ParticipantSchema.parse(await success(`/participants/${racingPerson.id}`)).id, racingPerson.id); }
    });
  } finally {
    if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy();
    if (admin.isInitialized) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.destroy(); }
  }
});
