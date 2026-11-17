import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { config } from '../src/config';
import { Database, rows } from '../src/database/database';
import { createDelivery, CustomerConfirmationSchema, DeliverySchema, TaskTemplateSchema, ViewSchema, type Appointment, type Delivery, type SourceSnapshot } from '../src/domain/model';
import { MAX_FILE_BYTES } from '../src/evidence/files';
import { Execution } from '../src/execution/execution';
import { Identity } from '../src/identity/identity';
import { quantityToMilli } from '../src/domain/rules';
import { AuditSchema, CrewSchema, FileSchema, ImportSchema, ParticipantCalendarSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';
import { DeliveryListSchema } from '../src/operations/delivery-list';

const DetailSchema = z.object({
  delivery: DeliverySchema, views: z.array(ViewSchema), progress: z.string(),
  coverage: z.object({ assigned: z.number(), total: z.number() }),
  closureBlockers: z.array(z.string()), files: z.array(FileSchema), history: z.array(AuditSchema),
});
const ErrorSchema = z.object({ code: z.string(), message: z.string(), details: z.array(z.string()).optional() });
const AccountSchema = z.object({ email: z.string().email(), password: z.string().min(16) });
type Detail = z.infer<typeof DetailSchema>;

void test('Nest HTTP with real guards, isolated PostgreSQL fixtures, planning, rights, and private files', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const accountData: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
  const accounts = z.object({ admin: AccountSchema, operator: AccountSchema }).parse(accountData);
  const testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = testingModule.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApplication(app);
  const db = testingModule.get(Database);
  const store = testingModule.get(DeliveryStore);
  const ownedDeliveries: string[] = [];
  const ownedCrews: string[] = [];
  const ownedTemplates: string[] = [];
  const ownedParticipants: string[] = [];
  const participantAliases = new Map<string, { id: string; name: string }>();
  const ownedFiles = new Set<string>();
  const sourceInstance = `http_test_${randomUUID()}`;
  const cookies: string[] = [];
  let base = '';
  let adminCookie = '';
  let operatorCookie = '';

  async function request(route: string, method = 'GET', body?: unknown, cookie?: string, origin: string = config().FRONTEND_ORIGIN) {
    const headers: Record<string, string> = { Origin: origin };
    if (cookie) headers['Cookie'] = cookie;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const response = await fetch(base + '/api' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw: unknown = await response.json();
    return { response, raw };
  }
  async function success(route: string, method = 'GET', body?: unknown, cookie = operatorCookie) {
    const result = await request(route, method, body, cookie);
    assert.ok(result.response.ok, `${method} ${route}: expected success, received ${result.response.status}; ${JSON.stringify(result.raw)}`);
    return result.raw;
  }
  async function failure(route: string, status: number, method = 'GET', body?: unknown, cookie?: string, origin: string = config().FRONTEND_ORIGIN) {
    const result = await request(route, method, body, cookie, origin);
    assert.equal(result.response.status, status, `${method} ${route}: ${JSON.stringify(result.raw)}`);
    return ErrorSchema.parse(result.raw);
  }
  async function detail(id: string): Promise<Detail> { return DetailSchema.parse(await success('/deliveries/' + id)); }
  async function login(role: 'admin' | 'operator'): Promise<string> {
    const result = await request('/auth/login', 'POST', accounts[role]);
    assert.equal(result.response.status, 201);
    const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    assert.match(result.response.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(result.response.headers.get('set-cookie') ?? '', /SameSite=Strict/i);
    cookies.push(cookie);
    return cookie;
  }
  async function fixture(index: number, overrides: Partial<SourceSnapshot> = {}): Promise<Delivery> {
    const imported = (await store.all()).find((delivery) => delivery.source.pickingId === 1 && delivery.source.pickingName === 'DEMO/OUT/0001');
    assert.ok(imported);
    const source = { ...structuredClone(imported.source), pickingId: 100000 + index, pickingName: `HTTP DEMO ${sourceInstance} ${index}`, serviceType: 'delivery_only', ...overrides };
    const delivery = createDelivery(source, randomUUID());
    await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, sourceInstance, source.pickingId, delivery.version, JSON.stringify(delivery)]);
    ownedDeliveries.push(delivery.id);
    return delivery;
  }
  async function book(deliveryId: string, startsAt: string, endsAt: string, allWork = false): Promise<Detail> {
    const current = await detail(deliveryId);
    const items = allWork ? current.delivery.source.items : current.delivery.source.items.slice(0, 1);
    return DetailSchema.parse(await success(`/deliveries/${deliveryId}/appointments`, 'POST', { version: current.delivery.version, requestId: randomUUID(), startsAt, endsAt,
      workLines: items.map((item) => ({ sourceLineId: item.sourceLineId, deliveryMilli: allWork ? quantityToMilli(item.quantity) : 100, installationMilli: 0, collectionMilli: 0 })) }));
  }
  function latestAppointment(result: Detail): Appointment {
    const appointment = result.delivery.appointments.at(-1);
    assert.ok(appointment);
    return appointment;
  }
  async function ensureParticipant(person: { id: string; name: string; external: boolean }) {
    const existing = participantAliases.get(person.id);
    if (existing) { person.id = existing.id; person.name = existing.name; return existing; }
    const profile = z.object({ id: z.string().uuid(), name: z.string() }).parse(await success('/participants', 'POST', {
      firstName: 'HTTP', lastName: 'Fixture', preferredName: person.name, external: person.external,
    }, adminCookie));
    participantAliases.set(person.id, profile); participantAliases.set(profile.id, profile);
    person.id = profile.id; person.name = profile.name; ownedParticipants.push(profile.id);
    return profile;
  }
  async function createCrew(name: string, people: { id: string; name: string; external: boolean }[]) {
    const participantIds: string[] = [];
    for (const person of people) participantIds.push((await ensureParticipant(person)).id);
    const crew = CrewSchema.parse(await success('/crews', 'POST', { name, classification: 'indoor', area: 'DEMO Test zone', enabled: true, participantIds }, adminCookie));
    ownedCrews.push(crew.id);
    return crew;
  }

  try {
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const target = await rows(db.source.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name');
    assert.equal(target.length, 1);

    await context.test('login, authentication, admin authorization, origins, and strict inputs use actual guards', async () => {
      assert.equal(z.object({ status: z.literal('ok') }).parse(await success('/health', 'GET', undefined, '')).status, 'ok');
      await failure('/deliveries', 401);
      await failure('/auth/login', 403, 'POST', accounts.operator, undefined, 'https://untrusted.example');
      await failure('/auth/login', 401, 'POST', { email: accounts.operator.email, password: 'DEMO invalid password' });
      adminCookie = await login('admin');
      operatorCookie = await login('operator');
      assert.equal(z.object({ role: z.literal('operator') }).parse(await success('/auth/me')).role, 'operator');
      await failure('/crews', 400, 'POST', { name: 'Incomplete operator input' }, operatorCookie);
      await failure('/imports', 403, 'POST', {}, operatorCookie, 'https://untrusted.example');
      await failure('/auth/login', 400, 'POST', { ...accounts.operator, role: 'admin' });
      await failure('/deliveries?unexpected=admin', 400, 'GET', undefined, operatorCookie);
    });

    await context.test('HTTP JSON parser rejects malformed and oversized bodies without exposing submitted text', async () => {
      const secretMarker = 'DEMO parser body must never be reflected';
      const malformed = await fetch(base + '/api/auth/login', { method: 'POST',
        headers: { Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json' },
        body: '{' + secretMarker });
      assert.equal(malformed.status, 400);
      const malformedBody: unknown = await malformed.json();
      const malformedError = ErrorSchema.parse(malformedBody);
      assert.equal(malformedError.message.includes(secretMarker), false);
      const oversized = await fetch(base + '/api/auth/login', { method: 'POST',
        headers: { Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(8 * 1024 * 1024) }) });
      assert.equal(oversized.status, 413);
      const oversizedBody: unknown = await oversized.json();
      assert.equal(ErrorSchema.parse(oversizedBody).message.includes('xxxxx'), false);
    });

    await context.test('source import reaches HTTP API and repeat import preserves identities', async () => {
      const first = ImportSchema.parse(await success('/imports', 'POST', {}));
      assert.equal(first.status, 'succeeded');
      assert.equal(first.processed, 20);
      const ids = (await store.all()).filter((delivery) => delivery.source.pickingId <= 20).map((delivery) => delivery.id);
      assert.equal(ids.length, 20);
      assert.equal(ImportSchema.parse(await success('/imports', 'POST', {})).status, 'succeeded');
      assert.deepEqual((await store.all()).filter((delivery) => delivery.source.pickingId <= 20).map((delivery) => delivery.id), ids);
      const list = DeliveryListSchema.parse(await success('/deliveries?page=1'));
      assert.equal(list.items.length, 10);
      assert.ok(list.total >= 20);
      assert.equal(Object.keys(list.counts).length, 8);
      assert.ok(z.array(ImportSchema).parse(await success('/imports')).length >= 2);
      await failure('/deliveries/not-a-uuid', 400, 'GET', undefined, operatorCookie);
      await failure('/deliveries/' + randomUUID(), 404, 'GET', undefined, operatorCookie);
    });

    const primary = await fixture(1);
    const parallel = await fixture(2);
    const sharedConflict = await fixture(3);
    const raceA = await fixture(4);
    const raceB = await fixture(5);
    const missing = await fixture(6, { customer: { ...primary.source.customer, address: null } });
    const review = await fixture(7);
    await db.source.query('UPDATE delivery SET data=jsonb_set(data,\'{sourceReview}\',\'true\') WHERE id=$1', [review.id]);
    const personA = { id: randomUUID(), name: 'HTTP DEMO Person A', external: false };
    const personB = { id: randomUUID(), name: 'HTTP DEMO Person B', external: false };
    const external = { id: randomUUID(), name: 'HTTP DEMO Electrician', external: true };
    let crewA = await createCrew('HTTP DEMO Crew A ' + sourceInstance, [personA, external]);
    const crewB = await createCrew('HTTP DEMO Crew B ' + sourceInstance, [personB]);
    const crewShared = await createCrew('HTTP DEMO Shared Crew ' + sourceInstance, []);
    const crewExternal = await createCrew('HTTP DEMO External Shared Crew ' + sourceInstance, []);
    let template = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'HTTP DEMO assembly', severity: 'low', order: 9, checklist: ['Check fixture', 'Assemble fixture'], enabled: true }, adminCookie));
    ownedTemplates.push(template.id);

    await context.test('planning has validation, independent visits, replay protection, versions, and real calendar', async () => {
      const workLines = [{ sourceLineId: 11, deliveryMilli: 100, installationMilli: 0, collectionMilli: 0 }];
      await failure(`/deliveries/${missing.id}/appointments`, 409, 'POST', { version: 1, requestId: randomUUID(), startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T09:00:00Z', workLines }, operatorCookie);
      await failure(`/deliveries/${review.id}/appointments`, 409, 'POST', { version: 1, requestId: randomUUID(), startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T09:00:00Z', workLines }, operatorCookie);
      await failure(`/deliveries/${primary.id}/appointments`, 400, 'POST', { version: 1, requestId: randomUUID(), startsAt: '2026-11-10T10:00:00Z', endsAt: '2026-11-10T09:00:00Z' }, operatorCookie);
      const command = { version: 1, requestId: randomUUID(), startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T09:00:00Z', workLines };
      const booked = DetailSchema.parse(await success(`/deliveries/${primary.id}/appointments`, 'POST', command));
      assert.equal(booked.delivery.appointments.length, 1);
      const replay = DetailSchema.parse(await success(`/deliveries/${primary.id}/appointments`, 'POST', command));
      assert.deepEqual(replay.delivery, booked.delivery);
      await failure(`/deliveries/${primary.id}/appointments`, 409, 'POST', { ...command, endsAt: '2026-11-10T09:30:00Z' }, operatorCookie);
      await failure(`/deliveries/${primary.id}/appointments`, 409, 'POST', { ...command, requestId: randomUUID() }, operatorCookie);
      await failure(`/deliveries/${primary.id}/instructions`, 400, 'PATCH', { version: booked.delivery.version, ...booked.delivery.instructions, sourceReview: false }, operatorCookie);
      const second = await book(primary.id, '2026-11-11T08:00:00Z', '2026-11-11T09:00:00Z');
      assert.equal(second.delivery.appointments.length, 2);
      assert.deepEqual(second.coverage, { assigned: 0, total: 2 });
      const calendar = z.array(z.object({ deliveryId: z.string().uuid(), appointment: z.object({ id: z.string().uuid() }) })).parse(await success('/calendar?from=2026-11-10T00%3A00%3A00Z&to=2026-11-12T00%3A00%3A00Z'));
      assert.equal(calendar.filter((entry) => entry.deliveryId === primary.id).length, 2);
      await failure('/calendar?from=2026-01-01T00%3A00%3A00Z&to=2026-12-01T00%3A00%3A00Z', 400, 'GET', undefined, operatorCookie);
    });

    await context.test('multiple crews snapshot tasks; other crews can overlap while crew/shared/external conflicts reject', async () => {
      let current = await detail(primary.id);
      const appointment = current.delivery.appointments[0];
      assert.ok(appointment);
      current = DetailSchema.parse(await success(`/deliveries/${primary.id}/appointments/${appointment.id}/assign`, 'POST', { version: current.delivery.version, requestId: randomUUID(), crewIds: [crewA.id, crewB.id], templateIds: [template.id] }));
      assert.equal(current.delivery.appointments[0]?.assignments.length, 2);
      assert.deepEqual(current.coverage, { assigned: 1, total: 2 });
      assert.equal(current.delivery.appointments[0]?.assignments[0]?.tasks[0]?.severity, 'low');
      const otherBooked = await book(parallel.id, '2026-11-10T08:30:00Z', '2026-11-10T09:30:00Z');
      const otherAppointment = latestAppointment(otherBooked);
      for (const crewId of [crewA.id, crewShared.id, crewExternal.id]) {
        const staffing = crewId === crewShared.id ? [{ crewId, participantIds: [personA.id] }] : crewId === crewExternal.id ? [{ crewId, participantIds: [external.id] }] : undefined;
        await failure(`/deliveries/${parallel.id}/appointments/${otherAppointment.id}/assign`, 409, 'POST', { version: otherBooked.delivery.version, requestId: randomUUID(), crewIds: [crewId], templateIds: [template.id], ...(staffing ? { staffing } : {}) }, operatorCookie);
      }
      const freeCrew = await createCrew('HTTP DEMO Independent ' + sourceInstance, [{ id: randomUUID(), name: 'HTTP DEMO Independent Person', external: false }]);
      const independent = DetailSchema.parse(await success(`/deliveries/${parallel.id}/appointments/${otherAppointment.id}/assign`, 'POST', { version: otherBooked.delivery.version, requestId: randomUUID(), crewIds: [freeCrew.id], templateIds: [template.id] }));
      assert.equal(independent.coverage.assigned, 1);
      const adjacent = await book(sharedConflict.id, '2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z');
      assert.ok(DetailSchema.parse(await success(`/deliveries/${sharedConflict.id}/appointments/${latestAppointment(adjacent).id}/assign`, 'POST', { version: adjacent.delivery.version, requestId: randomUUID(), crewIds: [crewA.id], templateIds: [template.id] })).delivery);
    });

    await context.test('parallel competing transactions cannot double-book one person and stale edits return 409', async () => {
      const a = await book(raceA.id, '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z');
      const b = await book(raceB.id, '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z');
      const replies = await Promise.all([
        request(`/deliveries/${raceA.id}/appointments/${latestAppointment(a).id}/assign`, 'POST', { version: a.delivery.version, requestId: randomUUID(), crewIds: [crewA.id], templateIds: [template.id] }, operatorCookie),
        request(`/deliveries/${raceB.id}/appointments/${latestAppointment(b).id}/assign`, 'POST', { version: b.delivery.version, requestId: randomUUID(), crewIds: [crewShared.id], templateIds: [template.id], staffing: [{ crewId: crewShared.id, participantIds: [personA.id] }] }, operatorCookie),
      ]);
      assert.deepEqual(replies.map((reply) => reply.response.status).sort(), [201,409]);
      const fresh = await detail(raceA.id);
      const input = { version: fresh.delivery.version, ...fresh.delivery.instructions };
      const edits = await Promise.all([
        request(`/deliveries/${raceA.id}/instructions`, 'PATCH', { ...input, notes: 'HTTP DEMO first editor' }, operatorCookie),
        request(`/deliveries/${raceA.id}/instructions`, 'PATCH', { ...input, notes: 'HTTP DEMO second editor' }, operatorCookie),
      ]);
      assert.deepEqual(edits.map((reply) => reply.response.status).sort(), [200,409]);
    });

    await context.test('customer confirmation uses authenticated authorship, versions and the agreed visit window', async () => {
      const delivery = await fixture(8);
      const startsAt = '2026-11-18T08:00:00Z';
      const endsAt = '2026-11-18T10:00:00Z';
      let current = await book(delivery.id, startsAt, endsAt);
      const appointmentId = latestAppointment(current).id;
      const visitPath = `/deliveries/${delivery.id}/appointments/${appointmentId}`;
      const confirmPath = `${visitPath}/confirm-customer`;
      const unassigned = { version: current.delivery.version };
      await failure(confirmPath, 401, 'POST', unassigned);
      await failure(confirmPath, 403, 'POST', unassigned, operatorCookie, 'https://untrusted.example');
      await failure(confirmPath, 400, 'POST', { ...unassigned, confirmedBy: randomUUID() }, operatorCookie);
      assert.equal((await failure(confirmPath, 409, 'POST', unassigned, operatorCookie)).code, 'VISIT_UNASSIGNED');

      current = DetailSchema.parse(await success(`${visitPath}/assign`, 'POST', {
        version: current.delivery.version, requestId: randomUUID(), crewIds: [crewA.id], templateIds: [template.id],
      }));
      const waitingVersion = current.delivery.version;
      assert.equal(latestAppointment(current).customerConfirmation, undefined);
      await failure(confirmPath, 409, 'POST', unassigned, operatorCookie);
      const operator = z.object({ id: z.uuid(), name: z.string() }).parse(await success('/auth/me'));
      current = DetailSchema.parse(await success(confirmPath, 'POST', { version: waitingVersion }));
      const firstConfirmation = CustomerConfirmationSchema.parse(latestAppointment(current).customerConfirmation);
      assert.deepEqual(firstConfirmation.confirmedBy, operator);
      assert.equal(current.delivery.version, waitingVersion + 1);
      assert.equal(latestAppointment(current).status, 'booked');
      assert.equal((await failure(confirmPath, 409, 'POST', { version: current.delivery.version }, adminCookie)).code, 'CUSTOMER_CONFIRMATION_EXISTS');

      const query = new URLSearchParams({ from: startsAt, to: endsAt });
      const calendar = ParticipantCalendarSchema.parse(await success(`/participants/${personA.id}/calendar?${query}`));
      assert.deepEqual(calendar.entries.find((entry) => entry.appointmentId === appointmentId)?.customerConfirmation, firstConfirmation);

      current = DetailSchema.parse(await success(visitPath, 'PATCH', {
        version: current.delivery.version, startsAt: '2026-11-18T09:00:00+01:00', endsAt: '2026-11-18T11:00:00+01:00',
      }));
      assert.deepEqual(latestAppointment(current).customerConfirmation, firstConfirmation);
      current = DetailSchema.parse(await success(visitPath, 'PATCH', {
        version: current.delivery.version, startsAt: '2026-11-18T10:00:00Z', endsAt: '2026-11-18T12:00:00Z',
      }));
      assert.equal(latestAppointment(current).customerConfirmation, undefined);
      const audit = z.object({ appointmentId: z.uuid(), customerConfirmation: CustomerConfirmationSchema });
      assert.deepEqual(audit.parse(current.history.find((entry) => entry.action === 'appointment.customer_confirmation_reset')?.details), {
        appointmentId, customerConfirmation: firstConfirmation,
      });

      const nextVersion = { version: current.delivery.version };
      const attempts = await Promise.all([
        request(confirmPath, 'POST', nextVersion, adminCookie), request(confirmPath, 'POST', nextVersion, adminCookie),
      ]);
      assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [201, 409]);
      current = await detail(delivery.id);
      const admin = z.object({ id: z.uuid(), name: z.string() }).parse(await success('/auth/me', 'GET', undefined, adminCookie));
      const finalConfirmation = CustomerConfirmationSchema.parse(latestAppointment(current).customerConfirmation);
      assert.deepEqual(finalConfirmation.confirmedBy, admin);
      assert.equal(current.history.filter((entry) => entry.action === 'appointment.customer_confirmed').length, 2);
      current = DetailSchema.parse(await success(`${visitPath}/cancel`, 'POST', { version: current.delivery.version, reason: 'DEMO customer cancelled' }));
      assert.equal(latestAppointment(current).status, 'cancelled');
      assert.deepEqual(latestAppointment(current).customerConfirmation, finalConfirmation);
      await failure(confirmPath, 409, 'POST', { version: current.delivery.version }, operatorCookie);
    });

    await context.test('reschedule/cancel preserve IDs, reasons and old time; disable/template edits retain snapshots', async () => {
      const before = await detail(primary.id);
      const firstAppointment = before.delivery.appointments[0];
      const secondAppointment = before.delivery.appointments[1];
      assert.ok(firstAppointment && secondAppointment);
      const snapshots = structuredClone(firstAppointment.assignments);
      await failure(`/deliveries/${primary.id}/appointments/${firstAppointment.id}`, 409, 'PATCH', {
        version: before.delivery.version, startsAt: '2026-11-10T09:30:00Z', endsAt: '2026-11-10T10:30:00Z',
      }, operatorCookie);
      assert.equal((await detail(primary.id)).delivery.appointments[0]?.startsAt, firstAppointment.startsAt);
      const replacement = await ensureParticipant({ id: randomUUID(), name: 'HTTP DEMO replacement', external: false });
      crewA = CrewSchema.parse(await success('/crews/' + crewA.id, 'PATCH', { version: crewA.version, name: crewA.name, classification: crewA.classification,
        area: crewA.area, enabled: false, participantIds: [replacement.id] }, adminCookie));
      template = TaskTemplateSchema.parse(await success('/templates/' + template.id, 'PATCH', { ...template, title: 'HTTP DEMO revised future template', checklist: ['A new future checklist'], severity: 'high' }, adminCookie));
      assert.deepEqual((await detail(primary.id)).delivery.appointments[0]?.assignments, snapshots);
      await failure(`/deliveries/${primary.id}/appointments/${secondAppointment.id}/assign`, 409, 'POST', { version: before.delivery.version, requestId: randomUUID(), crewIds: [crewA.id], templateIds: [template.id] }, operatorCookie);
      const moved = DetailSchema.parse(await success(`/deliveries/${primary.id}/appointments/${secondAppointment.id}`, 'PATCH', { version: before.delivery.version, startsAt: '2026-11-11T09:00:00Z', endsAt: '2026-11-11T10:00:00Z' }));
      assert.equal(moved.delivery.appointments[1]?.id, secondAppointment.id);
      assert.ok(moved.history.some((entry) => entry.action === 'appointment.previous_time'));
      const cancelled = DetailSchema.parse(await success(`/deliveries/${primary.id}/appointments/${secondAppointment.id}/cancel`, 'POST', { version: moved.delivery.version, reason: 'HTTP DEMO customer requested cancellation' }));
      assert.equal(cancelled.delivery.appointments[1]?.cancellationReason, 'HTTP DEMO customer requested cancellation');
      assert.equal(cancelled.delivery.appointments[1]?.status, 'cancelled');
      assert.equal(cancelled.delivery.completedAt, null);
      assert.ok(cancelled.history.some((entry) => entry.action === 'appointment.cancellation_reason'));
      const completion = await failure(`/deliveries/${primary.id}/complete`, 409, 'POST', { version: cancelled.delivery.version }, operatorCookie);
      assert.ok(completion.details?.some((reason) => reason.includes('Remaining quantity')));
    });

    await context.test('issues are operator-authored, validated against item ownership, and resolving does not auto-complete', async () => {
      const initial = await detail(primary.id);
      await failure(`/deliveries/${primary.id}/issues`, 400, 'POST', { version: initial.delivery.version, type: 'damage', description: 'HTTP DEMO rejected foreign line', itemIds: [999999999] }, operatorCookie);
      const opened = DetailSchema.parse(await success(`/deliveries/${primary.id}/issues`, 'POST', { version: initial.delivery.version, type: 'damage', description: 'HTTP DEMO customer reported damage', itemIds: [11] }));
      const issue = opened.delivery.issues.at(-1);
      assert.ok(issue);
      assert.equal(issue.source, 'operator');
      assert.equal(issue.authorName, 'Francesca Demo');
      assert.ok(opened.views.includes('issues'));
      const resolved = DetailSchema.parse(await success(`/deliveries/${primary.id}/issues/${issue.id}/resolve`, 'POST', { version: opened.delivery.version, resolution: 'HTTP DEMO clarification recorded' }));
      assert.equal(resolved.delivery.issues.at(-1)?.status, 'resolved');
      assert.equal(resolved.delivery.completedAt, null);
    });

    await context.test('private documents validate type, size, path, relation and authenticated download', async () => {
      const upload = { name: 'HTTP DEMO document.txt', base64: Buffer.from('DEMO synthetic document, no customer data').toString('base64'), kind: 'document', appointmentId: null, itemId: null, issueId: null };
      await failure(`/deliveries/${primary.id}/files`, 401, 'POST', upload);
      for (const invalid of [
        { ...upload, name: '../outside.txt' },
        { ...upload, name: 'wrong.png' },
        { ...upload, kind: 'photo' },
        { ...upload, base64: 'not valid base64' },
        { ...upload, name: 'invalid-utf8.txt', base64: Buffer.from([255]).toString('base64') },
        { ...upload, itemId: 999999999 },
        { ...upload, name: 'too-large.txt', base64: Buffer.alloc(MAX_FILE_BYTES + 1, 65).toString('base64') },
      ]) await failure(`/deliveries/${primary.id}/files`, 400, 'POST', invalid, operatorCookie);
      const result = DetailSchema.parse(await success(`/deliveries/${primary.id}/files`, 'POST', upload));
      const file = result.files.find((entry) => entry.name === upload.name);
      assert.ok(file);
      ownedFiles.add(file.id);
      assert.equal(file.status, 'ready');
      const download = await fetch(base + `/api/deliveries/${primary.id}/files/${file.id}`, { headers: { Cookie: operatorCookie } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('cache-control'), 'no-store');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(download.headers.get('cross-origin-resource-policy'), 'same-site');
      assert.equal(await download.text(), 'DEMO synthetic document, no customer data');
      await failure(`/deliveries/${primary.id}/files/${file.id}`, 401);
      await failure(`/deliveries/${parallel.id}/files/${file.id}`, 404, 'GET', undefined, operatorCookie);
      await unlink(path.resolve('.local/files-test', file.id));
      ownedFiles.delete(file.id);
      await failure(`/deliveries/${primary.id}/files/${file.id}`, 404, 'GET', undefined, operatorCookie);
      const principal = z.object({ id: z.string().uuid() }).parse(await success('/auth/me'));
      const pendingId = randomUUID();
      await db.source.query('INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [pendingId, primary.id, principal.id, 'HTTP DEMO interrupted.txt', 'text/plain', 1, 'document', 'pending']);
      await failure(`/deliveries/${primary.id}/files/${pendingId}`, 404, 'GET', undefined, operatorCookie);
      assert.equal((await detail(primary.id)).files.find((entry) => entry.id === pendingId)?.status, 'pending');
    });

    await context.test('issue/return notes and private photos preserve signed history and enforce ownership, versions, and crew return policy', async () => {
      const notesDelivery = await fixture(900);
      const foreignDelivery = await fixture(901);
      const notesCrew = await createCrew('HTTP DEMO notes crew', [{ id: randomUUID(), name: 'HTTP DEMO notes representative', external: false }]);
      const notesTemplate = TaskTemplateSchema.parse(await success('/templates', 'POST', { title: 'HTTP DEMO notes task', severity: 'low', order: 1, checklist: ['DEMO check'], enabled: true }, adminCookie));
      ownedTemplates.push(notesTemplate.id);
      const startsAt = new Date(Date.now() - 3_600_000).toISOString();
      const endsAt = new Date(Date.now() - 1_800_000).toISOString();
      let current = await book(notesDelivery.id, startsAt, endsAt, true);
      const appointment = latestAppointment(current);
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/appointments/${appointment.id}/assign`, 'POST', {
        version: current.delivery.version, requestId: randomUUID(), crewIds: [notesCrew.id], templateIds: [notesTemplate.id],
      }));
      const identity = testingModule.get<Identity>(Identity);
      const gateway = testingModule.get<Execution>(Execution);
      const principal = await identity.authenticate({ headers: { cookie: operatorCookie } });
      const crewContext = await gateway.authorizeLocalScenario(notesDelivery.id, appointment.id, principal);
      const representative = gateway.representative(crewContext);
      const assigned = current.delivery.appointments.find((entry) => entry.id === appointment.id);
      assert.ok(assigned);
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/appointments/${appointment.id}/confirm-customer`, 'POST', { version: current.delivery.version }));
      current = DetailSchema.parse(await gateway.receive(crewContext, current.delivery.version, {
        id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null, actualStart: startsAt, actualEnd: endsAt,
        summary: 'DEMO reported work before return request', responsiblePersonId: representative.id,
        quantities: current.delivery.source.items.map((item) => ({ sourceLineId: item.sourceLineId, deliveredMilli: quantityToMilli(item.quantity) })),
        completedChecklistIds: assigned.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))), evidence: [],
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer confirmation', at: endsAt },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew confirmation', at: endsAt },
      }));
      const signedHistory = JSON.stringify(current.delivery.appointments);
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/issues`, 'POST', { version: current.delivery.version,
        type: 'other', description: 'DEMO operator follow-up', itemIds: [], notes: 'Original issue notes' }));
      const issue = current.delivery.issues.at(-1);
      assert.ok(issue);
      assert.equal(issue.notes, 'Original issue notes');
      const issueVersion = current.delivery.version;
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/issues/${issue.id}/notes`, 'PATCH', { version: issueVersion, notes: 'Revised issue notes' }));
      assert.equal(current.delivery.issues.at(-1)?.notes, 'Revised issue notes');
      const revision = current.history.find((entry) => entry.action === 'issue.notes_revision');
      assert.ok(revision);
      assert.deepEqual(z.object({ previous: z.string(), notes: z.string() }).parse(revision.details), { previous: 'Original issue notes', notes: 'Revised issue notes' });
      await failure(`/deliveries/${notesDelivery.id}/issues/${issue.id}/notes`, 409, 'PATCH', { version: issueVersion, notes: 'Stale edit' }, operatorCookie);
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/returns`, 'POST', { version: current.delivery.version,
        appointmentId: appointment.id, reason: 'DEMO remaining service', remainingWork: 'DEMO follow-up inspection', notes: 'Original return notes' }));
      const returnRequest = current.delivery.returnRequests.at(-1);
      assert.ok(returnRequest);
      assert.equal(returnRequest.notes, 'Original return notes');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN4WBH1sCKKAUIBADG+Bs1pwHlWAAAAAElFTkSuQmCC';
      const photoInput = { name: 'HTTP DEMO notes photo.png', base64: png, kind: 'photo', appointmentId: null, itemId: null, issueId: null };
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/files`, 'POST', photoInput));
      const photo = current.files.find((file) => file.name === photoInput.name);
      assert.ok(photo);
      ownedFiles.add(photo.id);
      const foreign = DetailSchema.parse(await success(`/deliveries/${foreignDelivery.id}/files`, 'POST', photoInput));
      const foreignPhoto = foreign.files.find((file) => file.name === photoInput.name);
      assert.ok(foreignPhoto);
      ownedFiles.add(foreignPhoto.id);
      const txtInput = { ...photoInput, name: 'HTTP DEMO notes document.txt', kind: 'document', base64: Buffer.from('DEMO text is not a photo').toString('base64') };
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/files`, 'POST', txtInput));
      const txt = current.files.find((file) => file.name === txtInput.name);
      assert.ok(txt);
      ownedFiles.add(txt.id);
      const returnVersion = current.delivery.version;
      current = DetailSchema.parse(await success(`/deliveries/${notesDelivery.id}/returns/${returnRequest.id}/notes`, 'PATCH',
        { version: returnVersion, notes: 'Revised return notes', photoIds: [photo.id] }));
      assert.equal(current.delivery.returnRequests.at(-1)?.notes, 'Revised return notes');
      assert.deepEqual(current.delivery.returnRequests.at(-1)?.photoIds, [photo.id]);
      await failure(`/deliveries/${notesDelivery.id}/returns/${returnRequest.id}/notes`, 409, 'PATCH', { version: returnVersion, notes: 'Stale', photoIds: [] }, operatorCookie);
      for (const [photoIds, expectedStatus] of [[[photo.id, photo.id], 400], [[txt.id], 400], [[foreignPhoto.id], 404], [[randomUUID()], 404]] as const) {
        await failure(`/deliveries/${notesDelivery.id}/returns/${returnRequest.id}/notes`, expectedStatus, 'PATCH',
          { version: current.delivery.version, notes: 'Invalid link', photoIds }, operatorCookie);
      }
      const incomingReturn = { id: randomUUID(), originAppointmentId: appointment.id, reason: 'DEMO crew return report', remainingWork: 'DEMO further service',
        notes: 'Crew-authored DEMO notes', photoIds: [photo.id], issueIds: [issue.id] };
      const receivedVersion = current.delivery.version;
      current = DetailSchema.parse(await gateway.reportReturn(crewContext, receivedVersion, incomingReturn));
      assert.equal(current.delivery.returnRequests.at(-1)?.status, 'requested');
      assert.equal(current.delivery.returnRequests.at(-1)?.notes, 'Crew-authored DEMO notes');
      const crewAudit = current.history.find((entry) => entry.action === 'return.crew_reported');
      assert.equal(crewAudit?.actorId, representative.id);
      assert.equal(JSON.stringify(current.delivery.appointments), signedHistory);
      assert.equal((await gateway.reportReturn(crewContext, receivedVersion, incomingReturn)).delivery.version, current.delivery.version);
      await assert.rejects(() => gateway.reportReturn(crewContext, current.delivery.version, { ...incomingReturn, id: randomUUID(), photoIds: [txt.id] }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'RETURN_PHOTO_REQUIRED');
      await assert.rejects(() => gateway.reportReturn(crewContext, current.delivery.version, { ...incomingReturn, id: randomUUID(), photoIds: [foreignPhoto.id] }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EVIDENCE_UNAVAILABLE');
    });

    await context.test('logout invalidates the real server session', async () => {
      await success('/auth/logout', 'POST', {});
      await failure('/auth/me', 401, 'GET', undefined, operatorCookie);
    });
  } finally {
    if (db.source.isInitialized) {
      // Delete only objects created by this test, preserving seeded/public importer data and other sessions.
      if (ownedDeliveries.length) await db.source.transaction(async (manager) => {
        await manager.query('DELETE FROM reservation WHERE appointment_id IN (SELECT id FROM appointment WHERE delivery_id=ANY($1::uuid[]))', [ownedDeliveries]);
        await manager.query('DELETE FROM file_record WHERE delivery_id=ANY($1::uuid[])', [ownedDeliveries]);
        await manager.query('DELETE FROM appointment WHERE delivery_id=ANY($1::uuid[])', [ownedDeliveries]);
        await manager.query('DELETE FROM command_receipt WHERE delivery_id=ANY($1::uuid[])', [ownedDeliveries]);
        await manager.query('DELETE FROM audit WHERE delivery_id=ANY($1::uuid[])', [ownedDeliveries]);
        await manager.query('DELETE FROM delivery WHERE id=ANY($1::uuid[]) AND source_instance=$2', [ownedDeliveries, sourceInstance]);
      });
      if (ownedCrews.length) {
        await db.source.query('DELETE FROM crew_member WHERE crew_id=ANY($1::uuid[])', [ownedCrews]);
        await db.source.query('DELETE FROM crew WHERE id=ANY($1::uuid[])', [ownedCrews]);
      }
      if (ownedParticipants.length) await db.source.query('DELETE FROM person WHERE id=ANY($1::uuid[])', [ownedParticipants]);
      if (ownedTemplates.length) await db.source.query('DELETE FROM task_template WHERE id=ANY($1::uuid[])', [ownedTemplates]);
      if (ownedCrews.length + ownedTemplates.length + ownedParticipants.length) await db.source.query('DELETE FROM audit WHERE delivery_id IS NULL AND details->>\'id\'=ANY($1::text[])', [[...ownedCrews, ...ownedTemplates, ...ownedParticipants]]);
    }
    for (const id of ownedFiles) await unlink(path.resolve('.local/files-test', id)).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
    for (const cookie of cookies) {
      if (base) await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
    }
    await app.close();
  }
});
