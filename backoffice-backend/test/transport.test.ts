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
import { AppointmentSchema, createDelivery, DeliverySchema, SourceSchema, TaskTemplateSchema, VisitResultSchema, type Appointment, type Delivery, type TransportAllocation } from '../src/domain/model';
import { Execution } from '../src/execution/execution';
import { hashPassword, Identity } from '../src/identity/identity';
import { AuditSchema, CrewSchema, FileSchema, ParticipantSchema, TransportAvailabilitySchema, VehicleSchema, type TransportPlan, type Vehicle } from '../src/operations/contracts';

class TransportDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}
const Detail = z.object({ delivery: DeliverySchema, files: z.array(FileSchema), history: z.array(AuditSchema) });
type DetailValue = z.infer<typeof Detail>;

void test('transport planning uses real HTTP guards, isolated PostgreSQL and immutable operational history', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `transport_http_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^transport_http_[0-9a-f]{32}$/);
  const control = makeDataSource(true); const database = new TransportDatabase(schema);
  let app: NestExpressApplication | undefined; let base = ''; let adminCookie = ''; let operatorCookie = ''; let fixtureIndex = 0;
  const password = randomBytes(24).toString('base64url');
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize(); await database.source.runMigrations({ transaction: 'all' });
    const passwordHash = await hashPassword(password);
    for (const role of ['admin', 'operator'] as const) await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), `transport-${role}@example.test`, `DEMO transport ${role}`, role, passwordHash]);
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const identity = module.get<Identity>(Identity); const execution = module.get<Execution>(Execution);
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
    async function failure(route: string, expected: number, method = 'GET', body?: unknown, cookie?: string, origin?: string) {
      const reply = await request(route, method, body, cookie, origin);
      assert.equal(reply.status, expected, `${method} ${route}: ${JSON.stringify(reply.raw)}`);
      return z.object({ code: z.string(), message: z.string() }).parse(reply.raw);
    }
    async function login(role: 'admin' | 'operator') {
      const reply = await request('/auth/login', 'POST', { email: `transport-${role}@example.test`, password });
      assert.equal(reply.status, 201); z.object({ role: z.literal(role) }).parse(reply.raw); assert.ok(reply.cookie); return reply.cookie;
    }
    adminCookie = await login('admin'); operatorCookie = await login('operator');
    async function participant(name: string) { return ParticipantSchema.parse(await success('/participants', 'POST', { firstName: 'DEMO', lastName: name, preferredName: name }, adminCookie)); }
    async function crew(name: string, participantIds: string[]) { return CrewSchema.parse(await success('/crews', 'POST', { name, participantIds, classification: 'indoor', area: 'DEMO transport area', enabled: true }, adminCookie)); }
    async function template() { return TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'DEMO transport work', severity: 'low', order: 1, checklist: ['DEMO unloading checked'], enabled: true }, adminCookie)); }
    async function fixture(): Promise<Delivery> {
      fixtureIndex++;
      const primaryOrder = fixtureIndex * 10; const secondaryOrder = primaryOrder + 1;
      const source = SourceSchema.parse({ pickingId: fixtureIndex, pickingName: `TRANSPORT/DEMO/${fixtureIndex}`, saleOrderId: primaryOrder, saleOrderName: `TRANSPORT/SO/${primaryOrder}`,
        salesOrders: [{ id: primaryOrder, name: `TRANSPORT/SO/${primaryOrder}` }, { id: secondaryOrder, name: `TRANSPORT/SO/${secondaryOrder}` }],
        sourceState: 'assigned', salesTeam: 'MOHD MESSINA', customer: { id: fixtureIndex, name: 'DEMO transport customer', address: 'Synthetic transport road', city: 'Messina', country: 'IT', phones: ['+390000000123'], email: null, contact: null },
        items: [{ sourceLineId: fixtureIndex * 100, saleOrderId: primaryOrder, productId: 1, name: 'DEMO primary order item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null },
          { sourceLineId: fixtureIndex * 100 + 1, saleOrderId: secondaryOrder, productId: 2, name: 'DEMO secondary order item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
        serviceType: 'delivery_only', estimatedMinutes: null, notes: null });
      const delivery = createDelivery(source, randomUUID());
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [delivery.id, schema, fixtureIndex, delivery.version, JSON.stringify(delivery)]);
      return delivery;
    }
    async function detail(id: string): Promise<DetailValue> { return Detail.parse(await success('/deliveries/' + id)); }
    async function book(delivery: Delivery, startsAt: string, endsAt: string, allLines = false) {
      const current = await detail(delivery.id);
      const selected = allLines ? delivery.source.items : delivery.source.items.slice(current.delivery.appointments.length, current.delivery.appointments.length + 1);
      return Detail.parse(await success(`/deliveries/${delivery.id}/appointments`, 'POST', { version: current.delivery.version, requestId: randomUUID(), startsAt, endsAt,
        workLines: selected.map((item) => ({ sourceLineId: item.sourceLineId, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 })) }));
    }
    function visit(value: DetailValue): Appointment { const found = value.delivery.appointments.at(-1); assert.ok(found); return found; }
    async function assignPeople(value: DetailValue, crewId: string, templateId: string) {
      return Detail.parse(await success(`/deliveries/${value.delivery.id}/appointments/${visit(value).id}/assign`, 'POST', { version: value.delivery.version, requestId: randomUUID(), crewIds: [crewId], templateIds: [templateId] }));
    }
    let vehicleIndex = 0;
    function vehicleInput(name: string, plate: string, changes: Record<string, unknown> = {}) {
      return { ownership: 'company', name, plate, providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: null, ...changes };
    }
    async function vehicle(name: string, changes: Record<string, unknown> = {}): Promise<Vehicle> {
      vehicleIndex++; return VehicleSchema.parse(await success('/vehicles', 'POST', vehicleInput(name, `DEMO VAN ${vehicleIndex}`, changes), adminCookie));
    }
    function vehicleBody(value: Vehicle, changes: Record<string, unknown> = {}) {
      return { version: value.version, ownership: value.ownership, name: value.name, plate: value.plate, providerName: value.providerName,
        providerContact: value.providerContact, operationalStatus: value.operationalStatus, enabled: value.enabled, notes: value.notes, ...changes };
    }
    async function editVehicle(value: Vehicle, changes: Record<string, unknown>) { return VehicleSchema.parse(await success('/vehicles/' + value.id, 'PATCH', vehicleBody(value, changes), adminCookie)); }
    function transportPath(value: DetailValue) { return `/deliveries/${value.delivery.id}/appointments/${visit(value).id}/transport`; }
    function plan(value: Vehicle, reserveFrom: string, reserveTo: string, driver: TransportPlan['driver'] = { kind: 'none' }): TransportPlan { return { vehicleId: value.id, reserveFrom, reserveTo, driver }; }
    async function allocate(value: DetailValue, transport: TransportPlan, requestId = randomUUID()) {
      return Detail.parse(await success(transportPath(value), 'POST', { version: value.delivery.version, requestId, ...transport }));
    }
    function active(value: DetailValue): TransportAllocation { const allocation = visit(value).transportAllocations?.find((entry) => entry.status === 'active'); assert.ok(allocation); return allocation; }
    async function footprint(value: DetailValue) {
      const found = (await rows(database.source.manager, z.object({ transport: z.number(), crew: z.number(), receipts: z.number(), audits: z.number() }),
        'SELECT (SELECT count(*)::int FROM transport_reservation WHERE appointment_id=$1) AS transport,(SELECT count(*)::int FROM reservation WHERE appointment_id=$1) AS crew,(SELECT count(*)::int FROM command_receipt WHERE delivery_id=$2) AS receipts,(SELECT count(*)::int FROM audit WHERE delivery_id=$2) AS audits', [visit(value).id, value.delivery.id]))[0]; assert.ok(found); return found;
    }
    async function availability(value: DetailValue, from: string, to: string) { return TransportAvailabilitySchema.parse(await success(`${transportPath(value)}/availability?${new URLSearchParams({ from, to })}`)); }

    await context.test('vehicle catalogue persists normalized plates and validates ownership, admin access, origins and versions', async () => {
      await failure('/vehicles', 401); await failure('/vehicles', 401, 'POST', vehicleInput('Anonymous', 'DEMO ANON'));
      await failure('/vehicles', 403, 'POST', vehicleInput('Operator cannot edit', 'DEMO DENIED'), operatorCookie);
      await failure('/vehicles', 403, 'POST', vehicleInput('Wrong origin', 'DEMO ORIGIN'), adminCookie, 'https://untrusted.example');
      await failure('/vehicles', 400, 'POST', vehicleInput('', 'DEMO INVALID'), adminCookie);
      await failure('/vehicles', 400, 'POST', vehicleInput('Long name', 'DEMO INVALID', { name: 'A'.repeat(201) }), adminCookie);
      await failure('/vehicles', 400, 'POST', vehicleInput('Invalid plate', 'АБ123'), adminCookie);
      await failure('/vehicles', 400, 'POST', vehicleInput('Unknown fields', 'DEMO UNKNOWN', { administrator: true }), adminCookie);
      await failure('/vehicles', 400, 'POST', vehicleInput('Missing carrier', 'DEMO EXT', { ownership: 'external' }), adminCookie);
      await failure('/vehicles', 400, 'POST', vehicleInput('Company cannot have carrier', 'DEMO BAD COMPANY', { providerName: 'DEMO carrier' }), adminCookie);
      let value = await vehicle('DEMO company van', { plate: '  ab-123 cd  ' }); assert.equal(value.plate, 'AB-123 CD');
      await failure('/vehicles', 409, 'POST', vehicleInput('Same normalized plate', 'ab-123 cd'), adminCookie);
      const distinctSeparator = await vehicle('DEMO distinct plate', { plate: 'AB123CD' }); assert.notEqual(distinctSeparator.id, value.id);
      const external = await vehicle('DEMO hired van', { ownership: 'external', providerName: 'DEMO fictional carrier', providerContact: '+390000000567' }); assert.equal(external.providerName, 'DEMO fictional carrier');
      const stale = value.version;
      await failure('/vehicles/' + value.id, 403, 'PATCH', vehicleBody(value), operatorCookie);
      await failure('/vehicles/' + randomUUID(), 404, 'PATCH', vehicleBody(value), adminCookie);
      value = await editVehicle(value, { name: 'DEMO renamed van', notes: 'Synthetic vehicle record' }); assert.equal(value.version, stale + 1);
      await failure('/vehicles/' + value.id, 409, 'PATCH', vehicleBody(value, { version: stale }), adminCookie);
      const listed = z.array(VehicleSchema).parse(await success('/vehicles')); assert.deepEqual(listed.find((entry) => entry.id === value.id), value);
      assert.equal((await rows(database.source.manager, z.object({ id: z.string().uuid(), version: z.number() }), 'SELECT id,version FROM vehicle WHERE id=$1', [value.id]))[0]?.version, value.version);
      await assert.rejects(database.source.query('UPDATE vehicle SET plate=$2 WHERE id=$1', [distinctSeparator.id, value.plate]), (error: unknown) => {
        const driver: unknown = error instanceof QueryFailedError ? error.driverError : null; return z.object({ code: z.literal('23505') }).safeParse(driver).success;
      });
    });

    await context.test('transport commands validate cover windows, drivers and unavailable vehicles; committed receipts replay without policy churn', async () => {
      const delivery = await fixture(); let booked = await book(delivery, '2031-03-15T10:00:00Z', '2031-03-15T12:00:00Z');
      let van = await vehicle('DEMO cover-window van'); const valid = plan(van, '2031-03-15T09:00:00Z', '2031-03-15T13:00:00Z');
      const body = { version: booked.delivery.version, requestId: randomUUID(), ...valid }; const before = await footprint(booked);
      await failure(transportPath(booked), 401, 'POST', body);
      await failure(transportPath(booked), 403, 'POST', body, operatorCookie, 'https://untrusted.example');
      await failure(transportPath(booked), 400, 'POST', { ...body, injectedStatus: 'active' }, operatorCookie);
      await failure(transportPath(booked), 400, 'POST', { ...body, reserveFrom: '2031-03-15T10:30:00Z' }, operatorCookie);
      await failure(transportPath(booked), 400, 'POST', { ...body, reserveTo: '2031-03-15T11:30:00Z' }, operatorCookie);
      await failure(transportPath(booked), 400, 'POST', { ...body, reserveFrom: '2031-03-01T00:00:00Z', reserveTo: '2031-04-16T00:00:00Z' }, operatorCookie);
      await failure(transportPath(booked), 400, 'POST', { ...body, reserveFrom: valid.reserveTo, reserveTo: valid.reserveFrom }, operatorCookie);
      await failure(transportPath(booked), 404, 'POST', { ...body, vehicleId: randomUUID() }, operatorCookie);
      await failure(transportPath(booked), 404, 'POST', { ...body, driver: { kind: 'participant', participantId: randomUUID() } }, operatorCookie);
      await failure(transportPath(booked), 400, 'POST', { ...body, driver: { kind: 'external', name: 'DEMO driver', phone: '' } }, operatorCookie);
      for (const operationalStatus of ['maintenance', 'out_of_service'] as const) {
        van = await editVehicle(van, { operationalStatus });
        await failure(transportPath(booked), 409, 'POST', body, operatorCookie);
      }
      van = await editVehicle(van, { operationalStatus: 'available', enabled: false }); await failure(transportPath(booked), 409, 'POST', body, operatorCookie);
      van = await editVehicle(van, { enabled: true }); assert.deepEqual(await footprint(booked), before, 'Rejected plans leave allocation/reservation/receipt/audit state unchanged');
      booked = Detail.parse(await success(transportPath(booked), 'POST', body)); assert.equal(active(booked).vehicle.version, van.version);
      await failure(transportPath(booked), 409, 'POST', { ...body, requestId: randomUUID() }, operatorCookie);
      await failure(transportPath(booked), 409, 'POST', { ...body, version: booked.delivery.version, requestId: randomUUID() }, operatorCookie);
      await editVehicle(van, { enabled: false, operationalStatus: 'maintenance' });
      const snapshot = structuredClone(booked.delivery); const replayBefore = await footprint(booked);
      const replay = Detail.parse(await success(transportPath(booked), 'POST', body)); assert.deepEqual(replay.delivery, snapshot); assert.deepEqual(await footprint(booked), replayBefore);
      assert.match((await failure(transportPath(booked), 409, 'POST', { ...body, reserveTo: '2031-03-15T14:00:00Z' }, operatorCookie)).message, /Request ID reused/i);
      const secondVisit = await book(delivery, '2031-03-16T10:00:00Z', '2031-03-16T12:00:00Z');
      assert.match((await failure(transportPath(secondVisit), 409, 'POST', body, operatorCookie)).message, /Request ID reused/i, 'A receipt is bound to its appointment route, even within the same delivery');
    });

    await context.test('vehicle reservations cover travel windows across deliveries, exclude current visits and allow adjacent half-open windows', async () => {
      const van = await vehicle('DEMO travel-window van'); const one = await fixture(); const two = await fixture(); const three = await fixture();
      let first = await book(one, '2031-04-01T10:00:00Z', '2031-04-01T11:00:00Z'); const second = await book(two, '2031-04-01T11:00:00Z', '2031-04-01T12:00:00Z'); let third = await book(three, '2031-04-01T12:00:00Z', '2031-04-01T13:00:00Z');
      first = await allocate(first, plan(van, '2031-04-01T09:00:00Z', '2031-04-01T12:00:00Z'));
      const before = await footprint(second);
      await failure(transportPath(second), 409, 'POST', { version: second.delivery.version, requestId: randomUUID(), ...plan(van, '2031-04-01T10:30:00Z', '2031-04-01T12:30:00Z') }, operatorCookie);
      assert.deepEqual(await footprint(second), before); assert.deepEqual((await detail(two.id)).delivery, second.delivery);
      const otherAvailability = await availability(second, '2031-04-01T11:00:00Z', '2031-04-01T12:00:00Z');
      const busy = otherAvailability.vehicles.find((entry) => entry.id === van.id); assert.ok(busy); assert.equal(busy.busy, true); assert.equal(busy.conflicts[0]?.appointmentId, visit(first).id);
      assert.equal((await availability(first, '2031-04-01T09:00:00Z', '2031-04-01T12:00:00Z')).vehicles.find((entry) => entry.id === van.id)?.busy, false);
      third = await allocate(third, plan(van, '2031-04-01T12:00:00Z', '2031-04-01T14:00:00Z')); assert.equal(active(third).vehicle.id, van.id);
      const a = await fixture(); const b = await fixture(); const left = await book(a, '2031-04-02T10:00:00Z', '2031-04-02T11:00:00Z'); const right = await book(b, '2031-04-02T10:00:00Z', '2031-04-02T11:00:00Z');
      const replies = await Promise.all([left, right].map((value) => request(transportPath(value), 'POST', { version: value.delivery.version, requestId: randomUUID(), ...plan(van, '2031-04-02T09:00:00Z', '2031-04-02T12:00:00Z') }, operatorCookie)));
      assert.deepEqual(replies.map((entry) => entry.status).sort(), [201, 409]);
      for (let position = 0; position < replies.length; position++) { const reply = replies[position]; const value = [left, right][position]; assert.ok(reply && value); const current = await detail(value.delivery.id);
        assert.equal((visit(current).transportAllocations ?? []).filter((entry) => entry.status === 'active').length, reply.status === 201 ? 1 : 0);
        assert.equal((await footprint(current)).transport, reply.status === 201 ? 1 : 0);
      }
    });

    await context.test('driver conflicts use real people across crew roles and travel windows, while same-visit crew driving and independent drivers are allowed', async () => {
      const driver = await participant('DEMO crew and driver'); const replacement = await participant('DEMO replacement crew person'); const independent = await participant('DEMO independent driver');
      const team = await crew('DEMO driving team', [driver.id]); const otherTeam = await crew('DEMO independent driver team', [independent.id]); const task = await template();
      const van = await vehicle('DEMO crew driver van'); const secondVan = await vehicle('DEMO duplicate driver van'); const thirdVan = await vehicle('DEMO other driver van');
      const delivery = await fixture(); let planned = await book(delivery, '2031-05-01T10:00:00Z', '2031-05-01T11:00:00Z'); planned = await assignPeople(planned, team.id, task.id);
      planned = await allocate(planned, plan(van, '2031-05-01T09:00:00Z', '2031-05-01T12:00:00Z', { kind: 'participant', participantId: driver.id }));
      assert.equal(active(planned).driver.kind, 'participant', 'A crew participant may also drive this same visit');
      const duplicateBefore = await footprint(planned);
      await failure(transportPath(planned), 409, 'POST', { version: planned.delivery.version, requestId: randomUUID(), ...plan(secondVan, '2031-05-01T09:00:00Z', '2031-05-01T12:00:00Z', { kind: 'participant', participantId: driver.id }) }, operatorCookie);
      assert.deepEqual(await footprint(planned), duplicateBefore);
      const earlyDelivery = await fixture(); const early = await book(earlyDelivery, '2031-05-01T08:30:00Z', '2031-05-01T09:30:00Z');
      const earlyAssign = { version: early.delivery.version, requestId: randomUUID(), crewIds: [team.id], templateIds: [task.id] };
      await failure(`/deliveries/${early.delivery.id}/appointments/${visit(early).id}/assign`, 409, 'POST', earlyAssign, operatorCookie);
      const earlyAvailable = await availability(early, visit(early).startsAt, visit(early).endsAt);
      const personBusy = earlyAvailable.people.find((entry) => entry.id === driver.id); assert.ok(personBusy); assert.equal(personBusy.busy, true);
      assert.ok(personBusy.conflicts.some((entry) => entry.appointmentId === visit(planned).id && entry.startsAt === '2031-05-01T09:00:00.000Z' && entry.endsAt === '2031-05-01T12:00:00.000Z'), 'Availability explains the extended driver interval');

      const transportBefore = structuredClone(visit(planned).transportAllocations);
      const assignments = visit(planned).assignments.map((entry) => ({ assignmentId: entry.id, participantIds: [replacement.id] }));
      planned = Detail.parse(await success(`/deliveries/${planned.delivery.id}/appointments/${visit(planned).id}/participants`, 'PATCH', { version: planned.delivery.version, assignments, reason: 'DEMO crew swap keeps separate driver' }));
      assert.deepEqual(visit(planned).transportAllocations, transportBefore);
      assert.equal((await footprint(planned)).transport, 2, 'Staffing updates retain both vehicle and independent driver ledger rows');
      await failure(`/deliveries/${early.delivery.id}/appointments/${visit(early).id}/assign`, 409, 'POST', earlyAssign, operatorCookie);

      const adjacentDelivery = await fixture(); let adjacent = await book(adjacentDelivery, '2031-05-01T12:00:00Z', '2031-05-01T13:00:00Z'); adjacent = await assignPeople(adjacent, team.id, task.id);
      assert.equal(visit(adjacent).assignments[0]?.people[0]?.id, driver.id, 'The driver is free exactly at the transport interval end');
      const laterDelivery = await fixture(); const later = await book(laterDelivery, '2031-05-01T13:00:00Z', '2031-05-01T14:00:00Z'); await assignPeople(later, otherTeam.id, task.id);
      await failure(transportPath(planned), 409, 'POST', { version: planned.delivery.version, requestId: randomUUID(), ...plan(thirdVan, '2031-05-01T09:00:00Z', '2031-05-01T14:00:00Z', { kind: 'participant', participantId: independent.id }) }, operatorCookie);
      planned = await allocate(planned, plan(thirdVan, '2031-05-01T09:00:00Z', '2031-05-01T12:00:00Z', { kind: 'participant', participantId: independent.id }));
      assert.equal((visit(planned).transportAllocations ?? []).filter((entry) => entry.status === 'active').length, 2, 'An enabled person outside the current crew can be selected as an independent driver');
      const disabledProfile = ParticipantSchema.parse(await success('/participants/' + independent.id, 'PATCH', { version: independent.version, firstName: independent.firstName, lastName: independent.lastName, preferredName: independent.preferredName,
        phoneNumber: independent.phoneNumber, address: independent.address, login: independent.login, external: independent.external, enabled: false }, adminCookie));
      const disabledDelivery = await fixture(); const disabledVisit = await book(disabledDelivery, '2031-05-02T10:00:00Z', '2031-05-02T11:00:00Z');
      await failure(transportPath(disabledVisit), 409, 'POST', { version: disabledVisit.delivery.version, requestId: randomUUID(), ...plan(secondVan, '2031-05-02T09:00:00Z', '2031-05-02T12:00:00Z', { kind: 'participant', participantId: disabledProfile.id }) }, operatorCookie);
    });

    await context.test('replacement and cancellation retain snapshots/reasons, release retired resources and keep cancelled visits read-only', async () => {
      const driver = await participant('DEMO old driver snapshot'); let firstVan = await vehicle('DEMO original vehicle snapshot'); const replacementVan = await vehicle('DEMO replacement vehicle');
      const delivery = await fixture(); let booked = await book(delivery, '2031-06-01T10:00:00Z', '2031-06-01T11:00:00Z');
      booked = await allocate(booked, plan(firstVan, '2031-06-01T09:00:00Z', '2031-06-01T12:00:00Z', { kind: 'participant', participantId: driver.id }));
      const original = structuredClone(active(booked));
      firstVan = await editVehicle(firstVan, { name: 'DEMO future catalogue name', plate: 'DEMO RENAMED', operationalStatus: 'maintenance', enabled: false });
      assert.deepEqual(active(await detail(delivery.id)), original, 'Catalogue edits never rewrite an existing allocation snapshot');
      await failure(`${transportPath(booked)}/${original.id}/replace`, 400, 'POST', { version: booked.delivery.version, requestId: randomUUID(), ...plan(replacementVan, original.reserveFrom, original.reserveTo), reason: '' }, operatorCookie);
      const replaceCommand = { version: booked.delivery.version, requestId: randomUUID(), ...plan(replacementVan, original.reserveFrom, original.reserveTo, { kind: 'external', name: 'DEMO fictional carrier driver', phone: '+390000000789' }), reason: 'DEMO planned van replacement' };
      booked = Detail.parse(await success(`${transportPath(booked)}/${original.id}/replace`, 'POST', replaceCommand));
      const retired = visit(booked).transportAllocations?.find((entry) => entry.id === original.id); assert.ok(retired);
      assert.equal(retired.status, 'replaced'); assert.equal(retired.retirementReason, replaceCommand.reason); assert.ok(retired.retiredAt); assert.ok(retired.retiredBy); assert.deepEqual(retired.vehicle, original.vehicle); assert.deepEqual(retired.driver, original.driver);
      const current = active(booked); assert.equal(current.replacesAllocationId, original.id); assert.equal(current.vehicle.id, replacementVan.id); assert.equal(current.driver.kind, 'external');
      const replaceFootprint = await footprint(booked); assert.deepEqual(Detail.parse(await success(`${transportPath(booked)}/${original.id}/replace`, 'POST', replaceCommand)).delivery, booked.delivery); assert.deepEqual(await footprint(booked), replaceFootprint);
      firstVan = await editVehicle(firstVan, { operationalStatus: 'available', enabled: true });
      const otherDelivery = await fixture(); let other = await book(otherDelivery, '2031-06-01T10:00:00Z', '2031-06-01T11:00:00Z'); other = await allocate(other, plan(firstVan, original.reserveFrom, original.reserveTo, { kind: 'participant', participantId: driver.id })); assert.equal(active(other).vehicle.id, firstVan.id, 'Replacement frees the retired vehicle and participant driver');
      const cancelCommand = { version: booked.delivery.version, requestId: randomUUID(), reason: 'DEMO transport no longer needed' };
      booked = Detail.parse(await success(`${transportPath(booked)}/${current.id}/cancel`, 'POST', cancelCommand));
      assert.equal(visit(booked).transportAllocations?.find((entry) => entry.id === current.id)?.retirementReason, cancelCommand.reason); assert.equal((await footprint(booked)).transport, 0);
      assert.match((await failure(`${transportPath(booked)}/${original.id}/cancel`, 409, 'POST', cancelCommand, operatorCookie)).message, /Request ID reused/i, 'A cancel receipt cannot be replayed against another allocation route');
      const cancelledWorker = await participant('DEMO cancellation worker'); const cancelledDriver = await participant('DEMO cancellation independent driver');
      const cancelledCrew = await crew('DEMO cancellation crew', [cancelledWorker.id]); const cancelledTask = await template();
      const freedDelivery = await fixture(); let freed = await book(freedDelivery, '2031-06-01T10:00:00Z', '2031-06-01T11:00:00Z');
      freed = await assignPeople(freed, cancelledCrew.id, cancelledTask.id);
      freed = await allocate(freed, plan(replacementVan, original.reserveFrom, original.reserveTo, { kind: 'participant', participantId: cancelledDriver.id }));
      const retainedAssignments = structuredClone(visit(freed).assignments); const retainedTransport = structuredClone(active(freed));
      assert.equal((await footprint(freed)).crew, 2, 'The booked visit reserves its crew and actual worker');
      assert.equal((await footprint(freed)).transport, 2, 'The same visit independently reserves its vehicle and participant driver');
      const reusedDelivery = await fixture(); let reused = await book(reusedDelivery, '2031-06-01T10:00:00Z', '2031-06-01T11:00:00Z');
      const occupied = await availability(reused, original.reserveFrom, original.reserveTo);
      assert.equal(occupied.vehicles.find((entry) => entry.id === replacementVan.id)?.busy, true);
      assert.equal(occupied.people.find((entry) => entry.id === cancelledWorker.id)?.busy, true);
      assert.equal(occupied.people.find((entry) => entry.id === cancelledDriver.id)?.busy, true);
      const visitCancellationReason = 'DEMO visit cancelled; release crew, worker, car and independent driver';
      freed = Detail.parse(await success(`/deliveries/${freed.delivery.id}/appointments/${visit(freed).id}/cancel`, 'POST', { version: freed.delivery.version, reason: visitCancellationReason }));
      const cancelledAllocation = visit(freed).transportAllocations?.[0]; assert.ok(cancelledAllocation);
      assert.equal(visit(freed).status, 'cancelled'); assert.equal(visit(freed).cancellationReason, visitCancellationReason);
      assert.equal(cancelledAllocation.status, 'cancelled'); assert.equal(cancelledAllocation.retirementReason, visitCancellationReason);
      assert.equal((await footprint(freed)).crew, 0, 'Visit cancellation removes every derived crew/person service reservation');
      assert.equal((await footprint(freed)).transport, 0, 'Visit cancellation also removes every vehicle/driver transport reservation');
      assert.deepEqual(visit(freed).assignments, retainedAssignments, 'Cancellation preserves the original crew, participants, task IDs and checklist snapshots');
      assert.deepEqual(cancelledAllocation.vehicle, retainedTransport.vehicle); assert.deepEqual(cancelledAllocation.driver, retainedTransport.driver);
      assert.equal(cancelledAllocation.reserveFrom, retainedTransport.reserveFrom); assert.equal(cancelledAllocation.reserveTo, retainedTransport.reserveTo);
      const cancellationAudit = freed.history.find((entry) => entry.action === 'appointment.cancellation_reason'); assert.ok(cancellationAudit);
      assert.deepEqual(z.object({ reason: z.string() }).parse(cancellationAudit.details), { reason: visitCancellationReason });
      const released = await availability(reused, original.reserveFrom, original.reserveTo);
      assert.equal(released.vehicles.find((entry) => entry.id === replacementVan.id)?.busy, false);
      assert.equal(released.people.find((entry) => entry.id === cancelledWorker.id)?.busy, false);
      assert.equal(released.people.find((entry) => entry.id === cancelledDriver.id)?.busy, false);
      reused = await assignPeople(reused, cancelledCrew.id, cancelledTask.id);
      reused = await allocate(reused, plan(replacementVan, original.reserveFrom, original.reserveTo, { kind: 'participant', participantId: cancelledDriver.id }));
      assert.equal(visit(reused).assignments[0]?.crewId, cancelledCrew.id); assert.equal(visit(reused).assignments[0]?.people[0]?.id, cancelledWorker.id);
      assert.equal(active(reused).vehicle.id, replacementVan.id); assert.deepEqual(active(reused).driver, retainedTransport.driver);
      assert.equal((await footprint(reused)).crew, 2); assert.equal((await footprint(reused)).transport, 2);
      assert.deepEqual(visit(await detail(freed.delivery.id)).assignments, retainedAssignments, 'Overlapping reuse never erases the cancelled visit history');
      await failure(transportPath(freed), 409, 'POST', { version: freed.delivery.version, requestId: randomUUID(), ...plan(replacementVan, original.reserveFrom, original.reserveTo) }, operatorCookie);
      await failure(`${transportPath(freed)}/${cancelledAllocation.id}/cancel`, 409, 'POST', { version: freed.delivery.version, requestId: randomUUID(), reason: 'DEMO cancelled visit stays readonly' }, operatorCookie);
      const cancelReplay = Detail.parse(await success(`${transportPath(booked)}/${current.id}/cancel`, 'POST', cancelCommand)); assert.deepEqual(cancelReplay.delivery, booked.delivery);
    });

    await context.test('combined crew and transport assignment commits once or rolls back every crew/task/reservation change', async () => {
      const worker = await participant('DEMO atomic driver'); const team = await crew('DEMO atomic transport crew', [worker.id]); const task = await template();
      let van = await vehicle('DEMO atomic transport van', { operationalStatus: 'maintenance' });
      const delivery = await fixture(); let booked = await book(delivery, '2031-07-01T10:00:00Z', '2031-07-01T11:00:00Z');
      const command = { version: booked.delivery.version, requestId: randomUUID(), crewIds: [team.id], templateIds: [task.id], transport: [plan(van, '2031-07-01T09:00:00Z', '2031-07-01T12:00:00Z', { kind: 'participant', participantId: worker.id })] };
      const before = await footprint(booked);
      const path = `/deliveries/${delivery.id}/appointments/${visit(booked).id}/assign`;
      await failure(path, 409, 'POST', command, operatorCookie); assert.deepEqual((await detail(delivery.id)).delivery, booked.delivery); assert.deepEqual(await footprint(booked), before);
      van = await editVehicle(van, { operationalStatus: 'available' });
      booked = Detail.parse(await success(path, 'POST', command));
      assert.equal(booked.delivery.version, command.version + 1); assert.equal(visit(booked).assignments.length, 1); assert.equal(active(booked).vehicle.version, van.version);
      assert.equal((await footprint(booked)).crew, 2); assert.equal((await footprint(booked)).transport, 2);
      const allocations = structuredClone(visit(booked).transportAllocations); const replayBefore = await footprint(booked);
      await editVehicle(van, { enabled: false });
      assert.deepEqual(Detail.parse(await success(path, 'POST', command)).delivery, booked.delivery); assert.deepEqual(await footprint(booked), replayBefore); assert.deepEqual(visit(await detail(delivery.id)).transportAllocations, allocations);
      await failure(`/deliveries/${delivery.id}/appointments/${visit(booked).id}`, 409, 'PATCH', { version: booked.delivery.version, startsAt: '2031-07-01T11:00:00Z', endsAt: '2031-07-01T12:00:00Z' }, operatorCookie);

      const scopedDelivery = await fixture(); const firstScoped = await book(scopedDelivery, '2031-08-01T10:00:00Z', '2031-08-01T11:00:00Z');
      const scopedCommand = { version: firstScoped.delivery.version, requestId: randomUUID(), crewIds: [team.id], templateIds: [task.id], transport: [] };
      await success(`/deliveries/${scopedDelivery.id}/appointments/${visit(firstScoped).id}/assign`, 'POST', scopedCommand);
      const secondScoped = await book(scopedDelivery, '2031-08-02T10:00:00Z', '2031-08-02T11:00:00Z'); const secondBefore = await footprint(secondScoped);
      const wrongTarget = await failure(`/deliveries/${scopedDelivery.id}/appointments/${visit(secondScoped).id}/assign`, 409, 'POST', scopedCommand, operatorCookie);
      assert.match(wrongTarget.message, /Request ID reused/i, 'Explicit empty transport still binds the combined command receipt to its appointment');
      assert.deepEqual((await detail(scopedDelivery.id)).delivery, secondScoped.delivery); assert.deepEqual(await footprint(secondScoped), secondBefore);
    });

    await context.test('completion keeps the return reservation, freezes transport in signed results and preserves legacy snapshot absence', async () => {
      const worker = await participant('DEMO historical transport worker'); const team = await crew('DEMO historical transport crew', [worker.id]); const task = await template();
      let van = await vehicle('DEMO historical hired vehicle', { ownership: 'external', providerName: 'DEMO historical carrier', providerContact: '+390000000890' });
      const now = Date.now(); const startsAt = new Date(now - 7_200_000).toISOString(); const endsAt = new Date(now - 3_600_000).toISOString();
      const reserveFrom = new Date(now - 10_800_000).toISOString(); const reserveTo = new Date(now + 7_200_000).toISOString();
      const delivery = await fixture(); let worked = await book(delivery, startsAt, endsAt, true); worked = await assignPeople(worked, team.id, task.id);
      const command = { version: worked.delivery.version, requestId: randomUUID(), ...plan(van, reserveFrom, reserveTo, { kind: 'participant', participantId: worker.id }) };
      worked = Detail.parse(await success(transportPath(worked), 'POST', command)); const original = structuredClone(active(worked));
      van = await editVehicle(van, { name: 'DEMO future vehicle name', enabled: false, operationalStatus: 'out_of_service' });
      await success('/participants/' + worker.id, 'PATCH', { version: worker.version, firstName: worker.firstName, lastName: worker.lastName, preferredName: 'DEMO future driver name', phoneNumber: worker.phoneNumber,
        address: worker.address, login: worker.login, external: worker.external, enabled: worker.enabled }, adminCookie);
      const principal = await identity.authenticate({ headers: { cookie: operatorCookie } }); const authorized = await execution.authorizeLocalScenario(delivery.id, visit(worked).id, principal);
      worked = Detail.parse(await success(`/deliveries/${delivery.id}/appointments/${visit(worked).id}/confirm-customer`, 'POST', { version: worked.delivery.version }));
      worked = Detail.parse(await execution.start(authorized, worked.delivery.version)); const representative = execution.representative(authorized); const appointment = visit(worked);
      worked = Detail.parse(await execution.receive(authorized, worked.delivery.version, { id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
        actualStart: startsAt, actualEnd: endsAt, summary: 'DEMO signed transport work', responsiblePersonId: representative.id,
        quantities: delivery.source.items.map((item) => ({ sourceLineId: item.sourceLineId, deliveredMilli: 1000 })), completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((entry) => entry.checklist.map((item) => item.id))), evidence: [],
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer transport confirmation', at: endsAt }, crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew transport confirmation', at: endsAt } }));
      const completed = visit(worked); assert.equal(completed.status, 'completed'); const result = completed.results[0]; assert.ok(result);
      assert.deepEqual(result.transportSnapshot, [original]); assert.deepEqual(completed.transportAllocations, [original]); assert.equal(result.sourceSnapshot.salesOrders?.length, 2);
      assert.equal((await footprint(worked)).transport, 2, 'Completing the visit keeps vehicle+driver reservations through the planned return time');
      const signedBefore = structuredClone(completed.results);
      await failure(transportPath(worked), 409, 'POST', { version: worked.delivery.version, requestId: randomUUID(), ...plan(van, reserveFrom, reserveTo) }, operatorCookie);
      await failure(`${transportPath(worked)}/${original.id}/replace`, 409, 'POST', { version: worked.delivery.version, requestId: randomUUID(), ...plan(van, reserveFrom, reserveTo), reason: 'DEMO cannot revise signed transport' }, operatorCookie);
      await failure(`${transportPath(worked)}/${original.id}/cancel`, 409, 'POST', { version: worked.delivery.version, requestId: randomUUID(), reason: 'DEMO completed visit stays readonly' }, operatorCookie);
      assert.deepEqual(Detail.parse(await success(transportPath(worked), 'POST', command)).delivery, worked.delivery, 'Exact prior receipt replay remains valid after execution and catalogue changes');
      van = await editVehicle(van, { enabled: true, operationalStatus: 'available' });
      const returnDelivery = await fixture(); const returnVisit = await book(returnDelivery, new Date(now + 3_600_000).toISOString(), new Date(now + 5_400_000).toISOString());
      const futureFrom = new Date(now + 1_800_000).toISOString(); const futureTo = new Date(now + 6_300_000).toISOString();
      await failure(transportPath(returnVisit), 409, 'POST', { version: returnVisit.delivery.version, requestId: randomUUID(), ...plan(van, futureFrom, futureTo) }, operatorCookie);
      const otherVan = await vehicle('DEMO other vehicle for occupied driver');
      await failure(transportPath(returnVisit), 409, 'POST', { version: returnVisit.delivery.version, requestId: randomUUID(), ...plan(otherVan, futureFrom, futureTo, { kind: 'participant', participantId: worker.id }) }, operatorCookie);
      const busy = await availability(returnVisit, futureFrom, futureTo); assert.equal(busy.vehicles.find((entry) => entry.id === van.id)?.busy, true); assert.equal(busy.people.find((entry) => entry.id === worker.id)?.busy, true);
      const afterReturnDelivery = await fixture(); let afterReturn = await book(afterReturnDelivery, reserveTo, new Date(Date.parse(reserveTo) + 1_800_000).toISOString());
      afterReturn = await allocate(afterReturn, plan(van, reserveTo, new Date(Date.parse(reserveTo) + 3_600_000).toISOString(), { kind: 'participant', participantId: worker.id })); assert.equal(active(afterReturn).vehicle.id, van.id);
      assert.deepEqual(visit(await detail(delivery.id)).results, signedBefore, 'Future catalogue edits and reservations do not rewrite earlier signed results');
      const legacyResult = structuredClone(result); delete legacyResult.transportSnapshot; assert.equal(Object.hasOwn(VisitResultSchema.parse(legacyResult), 'transportSnapshot'), false);
      const legacyVisit = structuredClone(completed); delete legacyVisit.transportAllocations; legacyVisit.results = [legacyResult];
      const decoded = AppointmentSchema.parse(legacyVisit); assert.equal(Object.hasOwn(decoded, 'transportAllocations'), false); assert.equal(Object.hasOwn(decoded.results[0] ?? {}, 'transportSnapshot'), false);
    });
  } finally {
    if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy();
    if (control.isInitialized) { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.destroy(); }
  }
});
