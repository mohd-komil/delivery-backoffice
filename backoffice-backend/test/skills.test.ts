import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, QueryFailedError } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, DeliverySchema, TaskTemplateSchema, type Appointment, type Delivery, type SourceSnapshot } from '../src/domain/model';
import { Execution } from '../src/execution/execution';
import { hashPassword, Identity } from '../src/identity/identity';
import { AuditSchema, AvailabilitySchema, CrewSchema, FileSchema, ParticipantSchema, SkillSchema } from '../src/operations/contracts';

class SkillsDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

const Detail = z.object({ delivery: DeliverySchema, files: z.array(FileSchema), history: z.array(AuditSchema) });
const ProfileFields = ParticipantSchema.omit({ version: true, skillIds: true }).strip();
type DetailValue = z.infer<typeof Detail>;
type Skill = z.infer<typeof SkillSchema>;
type Participant = z.infer<typeof ParticipantSchema>;
type Crew = z.infer<typeof CrewSchema>;
type Template = z.infer<typeof TaskTemplateSchema>;

function source(index: number): SourceSnapshot {
  return { pickingId: index, pickingName: `SKILLS/DEMO/${index}`, saleOrderId: index, saleOrderName: `SKILLS/SO/${index}`,
    sourceState: 'assigned', salesTeam: 'MOHD MESSINA', customer: { id: index, name: 'DEMO skills customer', address: 'Synthetic skills road', city: 'Messina', country: 'IT', phones: ['+390000000123'], email: null, contact: null },
    items: [{ sourceLineId: index * 10, productId: 1, name: 'DEMO skills item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: 'delivery_only', estimatedMinutes: null, notes: null };
}

function profileBody(person: Participant, changes: Record<string, unknown> = {}) {
  return { version: person.version, firstName: person.firstName, lastName: person.lastName, preferredName: person.preferredName,
    phoneNumber: person.phoneNumber, address: person.address, login: person.login, external: person.external, enabled: person.enabled, ...changes };
}

function templateBody(template: Template, changes: Record<string, unknown> = {}) {
  return { version: template.version, title: template.title, severity: template.severity, order: template.order,
    checklist: template.checklist, enabled: template.enabled, ...changes };
}

void test('participant skills use real HTTP guards, isolated PostgreSQL and immutable visit snapshots', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `skills_http_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^skills_http_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const database = new SkillsDatabase(schema);
  let app: NestExpressApplication | undefined;
  let base = '';
  let adminCookie = '';
  let operatorCookie = '';
  const password = randomBytes(24).toString('base64url');
  let index = 0;
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    const passwordHash = await hashPassword(password);
    for (const role of ['admin', 'operator'] as const) await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), `skills-${role}@example.test`, `DEMO skills ${role}`, role, passwordHash]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const gateway = module.get<Execution>(Execution);
    const identity = module.get<Identity>(Identity);

    async function request(route: string, method = 'GET', body?: unknown, cookie?: string, origin: string = config().FRONTEND_ORIGIN) {
      const headers: Record<string, string> = { Origin: origin };
      if (cookie) headers['Cookie'] = cookie;
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw: unknown = await response.json();
      return { status: response.status, raw, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function success(route: string, method = 'GET', body?: unknown, cookie = operatorCookie) {
      const reply = await request(route, method, body, cookie);
      assert.ok(reply.status >= 200 && reply.status < 300, `${method} ${route}: ${reply.status} ${JSON.stringify(reply.raw)}`);
      return reply.raw;
    }
    async function failure(route: string, status: number, method = 'GET', body?: unknown, cookie?: string, origin?: string) {
      const reply = await request(route, method, body, cookie, origin);
      assert.equal(reply.status, status, `${method} ${route}: ${JSON.stringify(reply.raw)}`);
      return z.object({ code: z.string(), message: z.string() }).parse(reply.raw);
    }
    async function login(role: 'admin' | 'operator') {
      const reply = await request('/auth/login', 'POST', { email: `skills-${role}@example.test`, password });
      assert.equal(reply.status, 201); z.object({ role: z.literal(role) }).parse(reply.raw);
      assert.ok(reply.cookie); return reply.cookie;
    }
    adminCookie = await login('admin'); operatorCookie = await login('operator');
    async function skill(name: string, extra: Record<string, unknown> = {}): Promise<Skill> {
      return SkillSchema.parse(await success('/skills', 'POST', { name, ...extra }, adminCookie));
    }
    async function editSkill(value: Skill, changes: Record<string, unknown>) {
      return SkillSchema.parse(await success('/skills/' + value.id, 'PATCH', { version: value.version, name: value.name, enabled: value.enabled, ...changes }, adminCookie));
    }
    async function person(name: string, skillIds: string[] = [], extra: Record<string, unknown> = {}): Promise<Participant> {
      return ParticipantSchema.parse(await success('/participants', 'POST', { firstName: 'DEMO', lastName: name, preferredName: name, skillIds, ...extra }, adminCookie));
    }
    async function personSkills(value: Participant, skillIds: string[]) {
      return ParticipantSchema.parse(await success(`/participants/${value.id}/skills`, 'PATCH', { version: value.version, skillIds }, adminCookie));
    }
    async function crew(name: string, participantIds: string[]): Promise<Crew> {
      const raw = await success('/crews', 'POST', { name, participantIds, classification: 'indoor', area: 'DEMO skills area', enabled: true }, adminCookie);
      assert.equal(Object.hasOwn(z.record(z.string(), z.unknown()).parse(raw), 'skillIds'), false, 'Skills belong to people, never to crews');
      return CrewSchema.parse(raw);
    }
    async function template(title: string, requiredSkillIds?: string[]): Promise<Template> {
      return TaskTemplateSchema.parse(await success('/templates', 'POST', { title, severity: 'low', order: 1, checklist: ['DEMO inspected'], enabled: true,
        ...(requiredSkillIds === undefined ? {} : { requiredSkillIds }) }, adminCookie));
    }
    async function fixture(): Promise<Delivery> {
      index++; const delivery = createDelivery(source(index), randomUUID());
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [delivery.id, schema, index, delivery.version, JSON.stringify(delivery)]);
      return delivery;
    }
    async function detail(id: string): Promise<DetailValue> { return Detail.parse(await success('/deliveries/' + id)); }
    async function book(delivery: Delivery, startsAt?: string, endsAt?: string) {
      const start = startsAt ?? new Date(Date.UTC(2030, 0, 1) + index * 7_200_000).toISOString();
      const end = endsAt ?? new Date(Date.parse(start) + 3_600_000).toISOString();
      const current = await detail(delivery.id);
      return Detail.parse(await success(`/deliveries/${delivery.id}/appointments`, 'POST', { version: current.delivery.version, requestId: randomUUID(), startsAt: start, endsAt: end,
        workLines: delivery.source.items.map((item) => ({ sourceLineId: item.sourceLineId, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 })) }));
    }
    function visit(value: DetailValue): Appointment { const found = value.delivery.appointments[0]; assert.ok(found); return found; }
    function assignPath(value: DetailValue) { return `/deliveries/${value.delivery.id}/appointments/${visit(value).id}/assign`; }
    function staffingPath(value: DetailValue) { return `/deliveries/${value.delivery.id}/appointments/${visit(value).id}/participants`; }
    async function footprint(id: string) {
      return (await rows(database.source.manager, z.object({ reservations: z.number(), receipts: z.number(), audits: z.number() }),
        'SELECT (SELECT count(*)::int FROM reservation r JOIN appointment a ON a.id=r.appointment_id WHERE a.delivery_id=$1) AS reservations,(SELECT count(*)::int FROM command_receipt WHERE delivery_id=$1) AS receipts,(SELECT count(*)::int FROM audit WHERE delivery_id=$1) AS audits', [id]))[0];
    }

    await context.test('catalog permits both Backoffice roles while enforcing authentication/origin/strict inputs and case-insensitive full-length names', async () => {
      await failure('/skills', 401); await failure('/skills', 401, 'POST', { name: 'Anonymous' });
      const operatorSkill=SkillSchema.parse(await success('/skills','POST',{name:'Operator created'},operatorCookie));
      await failure('/skills', 403, 'POST', { name: 'Bad origin' }, adminCookie, 'https://untrusted.example');
      await failure('/skills', 400, 'POST', { name: '' }, adminCookie);
      await failure('/skills', 400, 'POST', { name: 'A'.repeat(201) }, adminCookie);
      await failure('/skills', 400, 'POST', { name: 'Long description', description: 'A'.repeat(2001) }, adminCookie);
      await failure('/skills', 400, 'POST', { name: 'Mass assignment', role: 'admin' }, adminCookie);
      let value = await skill('  Cabinet assembly  ', { description: 'DEMO assembly qualification' });
      assert.equal(value.name, 'Cabinet assembly'); assert.equal(value.version, 1); assert.equal(value.enabled, true);
      await failure('/skills', 409, 'POST', { name: 'cABINET ASSEMBLY' }, adminCookie);
      const longName = 'L'.repeat(199) + 'X'; await skill(longName); await skill('L'.repeat(199) + 'Y');
      await failure('/skills', 409, 'POST', { name: longName.toLowerCase() }, adminCookie);
      const operatorChanged=SkillSchema.parse(await success('/skills/'+operatorSkill.id,'PATCH',{version:operatorSkill.version,name:'Operator updated',enabled:false},operatorCookie));
      assert.equal(operatorChanged.enabled,false); assert.equal(operatorChanged.version,2);
      await failure('/skills/' + randomUUID(), 404, 'PATCH', { version: 1, name: 'Missing', enabled: true }, adminCookie);
      await failure('/skills/not-a-uuid', 400, 'PATCH', { version: 1, name: 'Invalid', enabled: true }, adminCookie);
      const oldVersion = value.version; value = await editSkill(value, { name: 'Cabinet fitting' });
      assert.equal(value.description, 'DEMO assembly qualification', 'An omitted description preserves the stored value');
      await failure('/skills/' + value.id, 409, 'PATCH', { version: oldVersion, name: value.name, enabled: true }, adminCookie);
      const listed = z.array(SkillSchema).parse(await success('/skills')); assert.ok(listed.some((entry) => entry.id === value.id));
      await assert.rejects(database.source.query('INSERT INTO skill(id,version,name,description,enabled) VALUES($1,1,$2,NULL,true)', [randomUUID(), value.name.toUpperCase()]), (error: unknown) => {
        const driver: unknown = error instanceof QueryFailedError ? error.driverError : null;
        return z.object({ code: z.literal('23505') }).safeParse(driver).success;
      });
    });

    await context.test('participant skill writes preserve profiles/passwords/rosters, distinguish omission from clear and reject invalid IDs atomically', async () => {
      const a = await skill('Participant A'); const b = await skill('Participant B'); const disabled = await skill('Disabled participant grant', { enabled: false });
      let value = await person('DEMO skill technician', [], { phoneNumber: '+390000000456', address: 'Synthetic qualification street', login: 'skills-person@example.test', password });
      const memberCrew = await crew('DEMO skill technician crew', [value.id]);
      const hash = (await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [value.id]))[0]?.password_hash; assert.ok(hash);
      const originalProfile = ProfileFields.parse(value);
      await failure(`/participants/${value.id}/skills`, 401, 'PATCH', { version: value.version, skillIds: [a.id] });
      await failure(`/participants/${value.id}/skills`, 403, 'PATCH', { version: value.version, skillIds: [a.id] }, operatorCookie,'https://untrusted.example');
      await failure(`/participants/${value.id}/skills`, 403, 'PATCH', { version: value.version, skillIds: [a.id] }, adminCookie, 'https://untrusted.example');
      for (const skillIds of [[a.id, a.id], [a.id, a.id.toUpperCase()]]) await failure(`/participants/${value.id}/skills`, 400, 'PATCH', { version: value.version, skillIds }, adminCookie);
      await failure(`/participants/${value.id}/skills`, 404, 'PATCH', { version: value.version, skillIds: [randomUUID()] }, adminCookie);
      await failure(`/participants/${randomUUID()}/skills`, 404, 'PATCH', { version: 1, skillIds: [a.id] }, adminCookie);
      await failure(`/participants/${value.id}/skills`, 400, 'PATCH', { version: value.version, skillIds: [a.id], name: 'Injected profile' }, adminCookie);
      await failure(`/participants/${value.id}/skills`, 409, 'PATCH', { version: value.version, skillIds: [disabled.id] }, adminCookie);
      const oldVersion = value.version; value = ParticipantSchema.parse(await success(`/participants/${value.id}/skills`,'PATCH',{version:value.version,skillIds:[a.id,b.id]},operatorCookie));
      assert.deepEqual([...value.skillIds].sort(), [a.id, b.id].sort()); assert.deepEqual(ProfileFields.parse(value), originalProfile);
      await failure(`/participants/${value.id}/skills`, 409, 'PATCH', { version: oldVersion, skillIds: [] }, adminCookie);
      assert.equal((await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [value.id]))[0]?.password_hash, hash);
      assert.deepEqual(CrewSchema.parse((z.array(CrewSchema).parse(await success('/crews'))).find((entry) => entry.id === memberCrew.id)).people.map((entry) => entry.id), [value.id]);
      value = ParticipantSchema.parse(await success('/participants/' + value.id, 'PATCH', profileBody(value, { phoneNumber: '+390000000457' }), adminCookie));
      assert.deepEqual([...value.skillIds].sort(), [a.id, b.id].sort(), 'Full profile PATCH omission preserves skill links');
      const beforeInvalid = structuredClone(value);
      await failure('/participants/' + value.id, 404, 'PATCH', profileBody(value, { phoneNumber: 'Must roll back', skillIds: [randomUUID()] }), adminCookie);
      assert.deepEqual(z.array(ParticipantSchema).parse(await success('/participants')).find((entry) => entry.id === value.id), beforeInvalid);
      value = ParticipantSchema.parse(await success('/participants/' + value.id, 'PATCH', profileBody(value, { skillIds: [] }), adminCookie)); assert.deepEqual(value.skillIds, []);
      value = await personSkills(value, [a.id]); await editSkill(a, { enabled: false });
      value = await personSkills(value, [a.id]); assert.deepEqual(value.skillIds, [a.id], 'An existing disabled grant may be retained');
      const newcomer = await person('DEMO new grant'); await failure(`/participants/${newcomer.id}/skills`, 409, 'PATCH', { version: newcomer.version, skillIds: [a.id] }, adminCookie);
      value = await personSkills(value, []); assert.deepEqual(value.skillIds, []);
      assert.deepEqual((await rows(database.source.manager, z.object({ crew_id: z.string().uuid() }), 'SELECT crew_id FROM crew_member WHERE person_id=$1', [value.id])).map((entry) => entry.crew_id), [memberCrew.id]);
    });

    await context.test('task template requirements preserve omission, allow explicit clearing and keep legacy JSON absent on reads', async () => {
      const a = await skill('Template assembly'); const b = await skill('Template wiring');
      let value = await template('DEMO combined qualification', [a.id, b.id]);
      await failure('/templates', 400, 'POST', { title: 'Incomplete operator input' }, operatorCookie);
      await failure('/templates', 400, 'POST', { title: 'Duplicate requirements', severity: 'low', order: 1, checklist: ['Check'], enabled: true, requiredSkillIds: [a.id, a.id] }, adminCookie);
      await failure('/templates', 404, 'POST', { title: 'Missing requirement', severity: 'low', order: 1, checklist: ['Check'], enabled: true, requiredSkillIds: [randomUUID()] }, adminCookie);
      value = TaskTemplateSchema.parse(await success('/templates/' + value.id, 'PATCH', templateBody(value, { title: 'DEMO renamed task' }), operatorCookie));
      assert.deepEqual([...(value.requiredSkillIds ?? [])].sort(), [a.id, b.id].sort());
      value = TaskTemplateSchema.parse(await success('/templates/' + value.id, 'PATCH', templateBody(value, { id: value.id.toUpperCase(), title: 'DEMO matching readonly identifier' }), adminCookie));
      const beforeRejected = structuredClone(value);
      await failure('/templates/' + value.id, 400, 'PATCH', templateBody(value, { id: randomUUID(), title: 'Must not replace another template' }), adminCookie);
      await failure('/templates/' + value.id, 400, 'PATCH', templateBody(value, { arbitraryUnknownField: 'Must not be accepted' }), adminCookie);
      const afterRejected = (await rows(database.source.manager, z.object({ version: z.number(), data: TaskTemplateSchema }), 'SELECT version,data FROM task_template WHERE id=$1', [value.id]))[0]; assert.ok(afterRejected);
      assert.equal(afterRejected.version, beforeRejected.version); assert.deepEqual(afterRejected.data, beforeRejected, 'Rejected foreign identifiers and unknown fields must not change the stored row or version');
      const previous = value.version;
      await failure('/templates/' + value.id, 409, 'PATCH', templateBody(value, { version: previous - 1, requiredSkillIds: [] }), adminCookie);
      value = TaskTemplateSchema.parse(await success('/templates/' + value.id, 'PATCH', templateBody(value, { requiredSkillIds: [] }), adminCookie)); assert.deepEqual(value.requiredSkillIds, []);
      const legacy = { id: randomUUID(), version: 1, title: 'DEMO legacy requirement absent', severity: 'low', order: 1, checklist: ['Legacy check'], enabled: true };
      await database.source.query('INSERT INTO task_template(id,version,data) VALUES($1,1,$2::jsonb)', [legacy.id, JSON.stringify(legacy)]);
      const read = z.array(TaskTemplateSchema).parse(await success('/templates')).find((entry) => entry.id === legacy.id); assert.ok(read); assert.deepEqual(read.requiredSkillIds, []);
      const stored = (await rows(database.source.manager, z.object({ data: z.record(z.string(), z.unknown()) }), 'SELECT data FROM task_template WHERE id=$1', [legacy.id]))[0]; assert.ok(stored);
      assert.equal(Object.hasOwn(stored.data, 'requiredSkillIds'), false, 'Reading a legacy template must not rewrite its saved representation');
      let retained = await template('DEMO disabled retained requirement', [a.id]); await editSkill(a, { enabled: false });
      retained = TaskTemplateSchema.parse(await success('/templates/' + retained.id, 'PATCH', templateBody(retained, { title: 'DEMO retained disabled requirement' }), adminCookie)); assert.deepEqual(retained.requiredSkillIds, [a.id]);
      await failure('/templates', 409, 'POST', { title: 'New disabled requirement', severity: 'low', order: 1, checklist: ['Check'], enabled: true, requiredSkillIds: [a.id] }, adminCookie);
    });

    await context.test('every actual person independently covers all task requirements; failed multi-crew assignments roll back and qualified overrides work', async () => {
      const a = await skill('Every person assembly'); const b = await skill('Every person electrical');
      const onlyA = await person('DEMO only assembly', [a.id]); const onlyB = await person('DEMO only electrical', [b.id]);
      const fullOne = await person('DEMO fully qualified one', [a.id, b.id]); const fullTwo = await person('DEMO fully qualified two', [a.id, b.id]);
      let fullThree = await person('DEMO fully qualified replacement', [a.id, b.id]);
      const mixed = await crew('DEMO mixed skills cannot pool', [onlyA.id, onlyB.id]);
      const good = await crew('DEMO qualified default', [fullOne.id]); await crew('DEMO other default crew', [fullTwo.id]);
      let taskA = await template('DEMO assembly requirement', [a.id]); let taskB = await template('DEMO electrical requirement', [b.id]);
      const futureTask = await template('DEMO future assembly requirement', [a.id]);
      const delivery = await fixture(); let booked = await book(delivery); const before = await footprint(delivery.id);
      const body = { version: booked.delivery.version, requestId: randomUUID(), crewIds: [mixed.id], templateIds: [taskA.id, taskB.id] };
      await failure(assignPath(booked), 409, 'POST', body, operatorCookie);
      assert.deepEqual((await detail(delivery.id)).delivery, booked.delivery, 'Two complementary partial profiles cannot jointly cover each-person requirements');
      assert.deepEqual(await footprint(delivery.id), before);
      await failure(assignPath(booked), 409, 'POST', { ...body, requestId: randomUUID(), staffing: [{ crewId: mixed.id, participantIds: [fullOne.id, onlyA.id] }] }, operatorCookie);
      assert.deepEqual(await footprint(delivery.id), before, 'One unqualified actual person rolls back the whole override even alongside a fully qualified person');
      await failure(assignPath(booked), 409, 'POST', { ...body, requestId: randomUUID(), crewIds: [good.id, mixed.id] }, operatorCookie);
      assert.deepEqual(await footprint(delivery.id), before, 'Failure in one selected crew cannot reserve or commit another qualified crew');
      assert.deepEqual(visit(await detail(delivery.id)).assignments, []);
      const command = { ...body, requestId: randomUUID(), crewIds: [mixed.id, good.id], staffing: [{ crewId: mixed.id, participantIds: [fullTwo.id] }, { crewId: good.id, participantIds: [fullOne.id] }] };
      booked = Detail.parse(await success(assignPath(booked), 'POST', command));
      const snapshot = visit(booked);
      assert.equal(snapshot.assignments.length, 2);
      for (const assignment of snapshot.assignments) {
        assert.equal(assignment.people.length, 1);
        assert.deepEqual(assignment.people[0]?.skillsSnapshot?.map((entry) => entry.id).sort(), [a.id, b.id].sort());
        assert.deepEqual(assignment.tasks.find((entry) => entry.templateId === taskA.id)?.requiredSkillsSnapshot, [{ id: a.id, name: a.name }]);
        assert.deepEqual(assignment.tasks.find((entry) => entry.templateId === taskB.id)?.requiredSkillsSnapshot, [{ id: b.id, name: b.name }]);
      }
      assert.deepEqual(z.array(CrewSchema).parse(await success('/crews')).find((entry) => entry.id === mixed.id)?.people.map((entry) => entry.id), [onlyA.id, onlyB.id], 'A visit override does not modify default rosters');
      const available = AvailabilitySchema.parse(await success(staffingPath(booked)));
      assert.deepEqual([...(available.people.find((entry) => entry.id === fullOne.id)?.skillIds ?? [])].sort(), [a.id, b.id].sort());
      const calendar = z.object({ participant: z.record(z.string(), z.unknown()) }).parse(await success(`/participants/${fullOne.id}/calendar?${new URLSearchParams({ from: snapshot.startsAt, to: snapshot.endsAt })}`));
      assert.equal(Object.hasOwn(calendar.participant, 'skillIds'), false, 'Detached participant calendars do not disclose the editable capability catalogue');

      taskA = TaskTemplateSchema.parse(await success('/templates/' + taskA.id, 'PATCH', templateBody(taskA, { requiredSkillIds: [] }), adminCookie));
      taskB = TaskTemplateSchema.parse(await success('/templates/' + taskB.id, 'PATCH', templateBody(taskB, { requiredSkillIds: [] }), adminCookie));
      assert.deepEqual(taskA.requiredSkillIds, []); assert.deepEqual(taskB.requiredSkillIds, []);
      const assignmentForGood = snapshot.assignments.find((entry) => entry.crewId === good.id); assert.ok(assignmentForGood);
      const allRows = snapshot.assignments.map((assignment) => ({ assignmentId: assignment.id, participantIds: assignment.people.map((entry) => entry.id) }));
      const wrongRows = allRows.map((entry) => entry.assignmentId === assignmentForGood.id ? { ...entry, participantIds: [onlyA.id] } : entry);
      const beforeStaffing = await footprint(delivery.id);
      await failure(staffingPath(booked), 409, 'PATCH', { version: booked.delivery.version, assignments: wrongRows, reason: 'DEMO cannot evade saved requirements' }, operatorCookie);
      assert.deepEqual(await footprint(delivery.id), beforeStaffing);
      const replacementRows = allRows.map((entry) => entry.assignmentId === assignmentForGood.id ? { ...entry, participantIds: [fullThree.id] } : entry);
      booked = Detail.parse(await success(staffingPath(booked), 'PATCH', { version: booked.delivery.version, assignments: replacementRows, reason: 'DEMO fully qualified replacement' }));
      const savedTasks = structuredClone(visit(booked).assignments.map((entry) => ({ id: entry.id, tasks: entry.tasks })));
      assert.deepEqual((await rows(database.source.manager, z.object({ resource: z.string() }), 'SELECT resource FROM reservation WHERE appointment_id=$1 AND resource=$2', [snapshot.id, 'person:' + fullOne.id])), []);
      fullThree = await personSkills(fullThree, [a.id]);
      await failure(staffingPath(booked), 409, 'PATCH', { version: booked.delivery.version, assignments: replacementRows, reason: 'DEMO retained person no longer qualified' }, operatorCookie);
      fullThree = await personSkills(fullThree, [a.id, b.id]);
      await editSkill(a, { enabled: false });
      await failure(staffingPath(booked), 409, 'PATCH', { version: booked.delivery.version, assignments: replacementRows, reason: 'DEMO disabled saved requirement' }, operatorCookie);
      const future = await fixture(); const futureBooked = await book(future);
      await failure(assignPath(futureBooked), 409, 'POST', { version: futureBooked.delivery.version, requestId: randomUUID(), crewIds: [good.id], templateIds: [futureTask.id] }, operatorCookie);
      assert.equal((await footprint(future.id))?.reservations, 0);
      const beforeReplay = await detail(delivery.id); const replayFootprint = await footprint(delivery.id);
      const replay = Detail.parse(await success(assignPath(beforeReplay), 'POST', command));
      assert.deepEqual(replay.delivery, beforeReplay.delivery, 'Exact committed receipt replay precedes disabled-skill and stale-version revalidation');
      assert.deepEqual(await footprint(delivery.id), replayFootprint);
      assert.match((await failure(assignPath(beforeReplay), 409, 'POST', { ...command, templateIds: [taskA.id] }, operatorCookie)).message, /Request ID reused/i);
      const moved = Detail.parse(await success(`/deliveries/${delivery.id}/appointments/${snapshot.id}`, 'PATCH', { version: beforeReplay.delivery.version,
        startsAt: new Date(Date.parse(snapshot.startsAt) + 43_200_000).toISOString(), endsAt: new Date(Date.parse(snapshot.endsAt) + 43_200_000).toISOString() }));
      assert.deepEqual(visit(moved).assignments.map((entry) => ({ id: entry.id, tasks: entry.tasks })), savedTasks, 'Moving an already planned visit does not retroactively qualify or rewrite saved tasks');
    });

    await context.test('renaming/disabling qualifications does not revalidate execution or rewrite signed task/person snapshots', async () => {
      let qualification = await skill('Historical assembly qualification'); let worker = await person('DEMO historical skilled worker', [qualification.id]);
      const workCrew = await crew('DEMO historical qualified crew', [worker.id]); let workTemplate = await template('DEMO historical skilled task', [qualification.id]);
      const delivery = await fixture();
      const startsAt = new Date(Date.now() - 3_600_000).toISOString(); const endsAt = new Date(Date.now() - 1_800_000).toISOString();
      let worked = await book(delivery, startsAt, endsAt);
      worked = Detail.parse(await success(assignPath(worked), 'POST', { version: worked.delivery.version, requestId: randomUUID(), crewIds: [workCrew.id], templateIds: [workTemplate.id] }));
      const assigned = structuredClone(visit(worked));
      qualification = await editSkill(qualification, { name: 'Renamed future qualification', enabled: false }); worker = await personSkills(worker, []);
      const principal = await identity.authenticate({ headers: { cookie: operatorCookie } });
      const authorized = await gateway.authorizeLocalScenario(delivery.id, assigned.id, principal);
      worked = Detail.parse(await success(`/deliveries/${delivery.id}/appointments/${assigned.id}/confirm-customer`, 'POST', { version: worked.delivery.version }));
      worked = Detail.parse(await gateway.start(authorized, worked.delivery.version));
      const representative = gateway.representative(authorized);
      const sourceItem = delivery.source.items[0]; assert.ok(sourceItem);
      worked = Detail.parse(await gateway.receive(authorized, worked.delivery.version, { id: randomUUID(), appointmentId: assigned.id,
        supersedesResultId: null, correctionReason: null, actualStart: startsAt, actualEnd: endsAt, summary: 'DEMO signed qualified work', responsiblePersonId: representative.id,
        quantities: [{ sourceLineId: sourceItem.sourceLineId, deliveredMilli: 1000 }], completedChecklistIds: assigned.assignments.flatMap((entry) => entry.tasks.flatMap((task) => task.checklist.map((item) => item.id))), evidence: [],
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer confirmation', at: endsAt },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew confirmation', at: endsAt } }));
      const result = visit(worked).results[0]; assert.ok(result);
      assert.deepEqual(result.assignmentsSnapshot[0]?.tasks[0]?.requiredSkillsSnapshot, [{ id: qualification.id, name: 'Historical assembly qualification' }]);
      assert.deepEqual(result.assignmentsSnapshot[0]?.people[0]?.skillsSnapshot, [{ id: qualification.id, name: 'Historical assembly qualification' }]);
      const signedBefore = structuredClone(worked.delivery.appointments);
      qualification = await editSkill(qualification, { description: 'Future-only catalogue note' });
      workTemplate = TaskTemplateSchema.parse(await success('/templates/' + workTemplate.id, 'PATCH', templateBody(workTemplate, { title: 'DEMO future task title', requiredSkillIds: [] }), adminCookie));
      assert.equal(workTemplate.title, 'DEMO future task title'); assert.deepEqual(worker.skillIds, []);
      assert.deepEqual((await detail(delivery.id)).delivery.appointments, signedBefore, 'Directory and requirement edits leave complete signed history unchanged');
    });

    await context.test('catalog writes and assignment share the actual PostgreSQL scheduling lock and serialize without partial commits', async () => {
      const qualification = await skill('Concurrent skill qualification'); const worker = await person('DEMO concurrent skilled worker', [qualification.id]);
      const workCrew = await crew('DEMO concurrent crew', [worker.id]); const task = await template('DEMO concurrent task', [qualification.id]);
      const delivery = await fixture(); const booked = await book(delivery); const before = await footprint(delivery.id);
      const blocker = database.source.createQueryRunner(); await blocker.connect(); await blocker.startTransaction(); await blocker.query('SELECT pg_advisory_xact_lock(7041001)');
      const disable = request('/skills/' + qualification.id, 'PATCH', { version: qualification.version, name: qualification.name, enabled: false }, adminCookie);
      const assign = request(assignPath(booked), 'POST', { version: booked.delivery.version, requestId: randomUUID(), crewIds: [workCrew.id], templateIds: [task.id] }, operatorCookie);
      let blocked = 0;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          blocked = (await rows(control.manager, z.object({ count: z.number() }), `SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.locktype='advisory' AND l.objid=7041001 AND NOT l.granted AND a.datname='delivery_backoffice_test' AND a.application_name=$1`, [schema]))[0]?.count ?? 0;
          if (blocked >= 2) break;
          await setTimeout(20);
        }
      } finally { await blocker.commitTransaction(); await blocker.release(); }
      const [disabled, assigned] = await Promise.all([disable, assign]);
      assert.equal(blocked, 2, 'Both real HTTP commands must wait for the same PostgreSQL advisory lock');
      assert.equal(disabled.status, 200); assert.ok([201, 409].includes(assigned.status));
      const after = await detail(delivery.id);
      if (assigned.status === 409) {
        assert.deepEqual(after.delivery, booked.delivery); assert.deepEqual(await footprint(delivery.id), before);
      } else {
        assert.equal(after.delivery.version, booked.delivery.version + 1); assert.equal(visit(after).assignments.length, 1);
        assert.deepEqual(visit(after).assignments[0]?.tasks[0]?.requiredSkillsSnapshot, [{ id: qualification.id, name: qualification.name }]);
        assert.equal((await footprint(delivery.id))?.reservations, 2);
      }
    });
  } finally {
    if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy();
    if (control.isInitialized) { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.destroy(); }
  }
});
