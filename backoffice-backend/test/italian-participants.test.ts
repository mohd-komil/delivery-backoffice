import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, DeliverySchema, type Appointment, type TaskTemplate } from '../src/domain/model';
import { completeDelivery, instantiateTask, planVisitWork, recordExecution } from '../src/domain/rules';
import { hashPassword, verifyPassword } from '../src/identity/identity';
import { ParticipantSchema, type Participant } from '../src/operations/contracts';
import { italianParticipantById } from '../scripts/italian-participant-data';
import { planItalianProfile, runItalianParticipants } from '../scripts/italian-participants';

const targetId = (number: number) => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const Manifest = z.object({ formatVersion: z.literal(1), accounts: z.array(z.object({ id: z.string().uuid(), login: z.string(), password: z.string().min(15) }).strict()) }).strict();
function legacyProfile(id: string): Participant {
  return ParticipantSchema.parse({ id, version: 1, name: 'DEMO Person 16', firstName: 'DEMO', lastName: 'Person 16', preferredName: null,
    phoneNumber: null, address: null, login: null, external: true, enabled: false, hasPassword: false, skillIds: [] });
}

void test('Italian profile planning recognizes synthetic labels, preserves meaningful fields and keeps same-name identities distinct', () => {
  const one = italianParticipantById.get(targetId(1)); const two = italianParticipantById.get(targetId(2));
  assert.ok(one && two);
  const first = planItalianProfile(legacyProfile(one.id), one);
  const second = planItalianProfile(legacyProfile(two.id), two);
  assert.ok(first.update && second.update);
  assert.equal(first.update.firstName, one.firstName); assert.equal(first.update.lastName, one.lastName);
  assert.equal(second.update.firstName, two.firstName); assert.equal(second.update.lastName, two.lastName);
  assert.notEqual(one.id, two.id);
  assert.equal(first.update.external, true); assert.equal(first.update.enabled, false);
  assert.equal(first.update.phoneNumber, one.phoneNumber); assert.equal(first.update.address, one.address);
  assert.equal(first.needsCredentials, true);
  const human = ParticipantSchema.parse({ ...legacyProfile(one.id), name: 'Andrea Scelto', firstName: 'Andrea', lastName: 'Scelto', preferredName: 'Nome scelto',
    phoneNumber: '+39 000 123 4567', address: 'Indirizzo sintetico scelto dall’utente', login: 'preserved@example.test', hasPassword: true });
  const preserved = planItalianProfile(human, one);
  if (preserved.update) {
    assert.equal(preserved.update.firstName, human.firstName); assert.equal(preserved.update.lastName, human.lastName);
    assert.equal(preserved.update.preferredName, human.preferredName); assert.equal(preserved.update.phoneNumber, human.phoneNumber);
    assert.equal(preserved.update.address, human.address); assert.equal(preserved.update.login, human.login);
  }
  assert.equal(preserved.needsCredentials, false);
  const passwordWithoutLogin = planItalianProfile({ ...legacyProfile(one.id), hasPassword: true }, one);
  assert.equal(passwordWithoutLogin.needsCredentials, false, 'An unknown retained password must not be rotated to configure a new login');
  assert.ok(passwordWithoutLogin.credentialWarning);
  assert.equal(passwordWithoutLogin.update?.login ?? null, null);
  const completed = ParticipantSchema.parse({ ...legacyProfile(one.id), name: one.preferredName, firstName: one.firstName, lastName: one.lastName,
    preferredName: one.preferredName, phoneNumber: one.phoneNumber, address: one.address, login: one.login, hasPassword: true });
  assert.equal(planItalianProfile(completed, one).update, null);
  assert.equal(planItalianProfile(completed, one).needsCredentials, false);
});

class ItalianTestDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}` } });
  }
}

void test('Italian enrichment uses authenticated HTTP, persists credentials before updates and recovers without overwriting profiles or history', async () => {
  process.env['BACKOFFICE_TEST'] = '1';
  const fixtureOne = italianParticipantById.get(targetId(1)); const fixtureTwo = italianParticipantById.get(targetId(2)); const fixtureThree = italianParticipantById.get(targetId(3));
  assert.ok(fixtureOne && fixtureTwo && fixtureThree);
  const schema = `italian_profiles_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^italian_profiles_[0-9a-f]{32}$/);
  const admin = makeDataSource(true); const database = new ItalianTestDatabase(schema);
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local', 'italian-test-'));
  const accountsPath = path.join(directory, 'admin.json'); const manifestPath = path.join(directory, 'manifest.json');
  let app: NestExpressApplication | undefined;
  try {
    await admin.initialize();
    assert.equal((await rows(admin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize(); await database.source.runMigrations({ transaction: 'all' });
    const adminPassword = randomBytes(24).toString('base64url'); const existingPassword = randomBytes(24).toString('base64url');
    const adminId = randomUUID(); const existingHash = await hashPassword(existingPassword);
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [adminId, 'italian-test-admin@example.test', 'DEMO enrichment administrator', 'admin', await hashPassword(adminPassword)]);
    await writeFile(accountsPath, JSON.stringify({ admin: { email: 'italian-test-admin@example.test', password: adminPassword } }), { flag: 'wx' });
    for (const fixture of [fixtureOne, fixtureTwo]) await database.source.query(`INSERT INTO person(id,first_name,last_name,phone_number,address,external,enabled)
      VALUES($1,'DEMO','Person 16',$2,$3,$4,$5)`, [fixture.id, fixture.id === fixtureTwo.id ? '+39 000 123 4567' : null,
      fixture.id === fixtureTwo.id ? 'Indirizzo sintetico scelto dall’utente' : null, fixture.id === fixtureTwo.id, fixture.id !== fixtureTwo.id]);
    await database.source.query(`INSERT INTO person(id,first_name,last_name,preferred_name,phone_number,address,login,password_hash,external,enabled)
      VALUES($1,'Utente','Confermato','Nome scelto',$2,$3,$4,$5,false,true)`, [fixtureThree.id, '+39 000 987 6543', 'Indirizzo personale sintetico', 'already.configured@example.test', existingHash]);
    const outsiderId = randomUUID();
    await database.source.query(`INSERT INTO person(id,first_name,last_name,external,enabled) VALUES($1,'DEMO','Person 16',false,true)`, [outsiderId]);
    const crewId = randomUUID();
    await database.source.query(`INSERT INTO crew(id,version,name,classification,area,enabled) VALUES($1,7,'DEMO preservation crew','indoor','Messina',true)`, [crewId]);
    await database.source.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0),($1,$3,1)', [crewId, fixtureOne.id, fixtureTwo.id]);
    const delivery = createDelivery({ pickingId: 1, pickingName: 'ITALIAN/DEMO/1', saleOrderId: 1, saleOrderName: 'ITALIAN/SO/1', sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
      customer: { id: 1, name: 'DEMO synthetic customer', address: 'Synthetic Street 1', city: 'Messina', country: 'IT', phones: ['+390000000001'], email: null, contact: null },
      items: [{ sourceLineId: 10, productId: 1, name: 'DEMO item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: null, notes: null }, randomUUID());
    const task: TaskTemplate = { id: randomUUID(), version: 1, title: 'DEMO task', severity: 'low', order: 1, checklist: ['Check'], enabled: true };
    const appointment: Appointment = { id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
      assignments: [{ id: randomUUID(), crewId, crewName: 'DEMO preservation crew', people: [{ id: fixtureOne.id, name: 'DEMO Person 16', external: false },
        { id: fixtureTwo.id, name: 'DEMO Person 16', external: true }], tasks: [instantiateTask(task)] }], results: [] };
    appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }],
      { id: adminId, name: 'DEMO enrichment administrator', role: 'admin' }, '2026-11-03T07:00:00Z');
    appointment.status = 'in_progress';
    delivery.appointments.push(appointment);
    const closed = completeDelivery(recordExecution(delivery, { id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
      actualStart: appointment.startsAt, actualEnd: appointment.endsAt, summary: 'DEMO immutable enrichment history', responsiblePersonId: fixtureOne.id,
      quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((instance) => instance.checklist.map((item) => item.id))), evidence: [],
      customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer', at: appointment.endsAt },
      crewSignature: { status: 'signed', signerName: 'DEMO Person 16', text: 'DEMO crew', at: appointment.endsAt } },
    { kind: 'crew', id: fixtureOne.id, name: 'DEMO Person 16' }, '2026-11-03T10:00:00Z'), { id: adminId, name: 'DEMO enrichment administrator', role: 'admin' }, randomUUID(), '2026-11-03T10:00:00Z');
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,1,$3::jsonb)', [closed.id, schema, JSON.stringify(closed)]);
    const beforeDelivery = (await rows(database.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [closed.id]))[0]?.data;
    const beforeCrew = await rows(database.source.manager, z.record(z.string(), z.unknown()), 'SELECT id,version,name,classification,area,enabled,legacy_data FROM crew ORDER BY id');
    const beforeRoster = await rows(database.source.manager, z.object({ crew_id: z.string().uuid(), person_id: z.string().uuid(), position: z.number() }), 'SELECT crew_id,person_id,position FROM crew_member ORDER BY crew_id,position');
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false }); configureApplication(app); await app.listen(0, '127.0.0.1');
    const baseUrl = `${await app.getUrl()}/api`;
    let lostResponse = false; const patchIds: string[] = [];
    const realFetch = fetch;
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method.toUpperCase() === 'PATCH' && url.pathname.startsWith('/api/participants/')) {
        const id = z.string().uuid().parse(url.pathname.split('/').at(-1));
        const rawBody: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
        const body = z.object({ login: z.string().nullable(), password: z.string().optional() }).parse(rawBody);
        if (body.password !== undefined) {
          const manifestRaw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
          const account = Manifest.parse(manifestRaw).accounts.find((entry) => entry.id === id);
          assert.ok(account, 'Generated credentials must be durable before the authenticated PATCH');
          assert.ok(account.password === body.password && account.login === body.login, 'The request must use the already-persisted credentials');
        }
        const response = await realFetch(input, options);
        assert.equal(response.ok, true, `Fixture PATCH failed (${response.status})`);
        const publicRaw: unknown = await response.clone().json(); ParticipantSchema.parse(publicRaw);
        if (body.password !== undefined) assert.equal(JSON.stringify(publicRaw).includes(body.password), false);
        patchIds.push(id);
        if (!lostResponse) { lostResponse = true; throw new TypeError('DEMO response lost after the real authenticated update committed'); }
        return response;
      }
      return realFetch(input, options);
    };
    const options = { baseUrl, accountsPath, manifestPath, fetcher };
    await assert.rejects(() => runItalianParticipants(options)); assert.equal(lostResponse, true);
    const firstManifestRaw: unknown = JSON.parse(await readFile(manifestPath, 'utf8')); const firstManifest = Manifest.parse(firstManifestRaw);
    const firstAccount = firstManifest.accounts[0]; assert.ok(firstAccount);
    const firstHash = (await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [firstAccount.id]))[0]?.password_hash;
    assert.ok(firstHash); assert.equal(await verifyPassword(firstAccount.password, firstHash), true);
    await runItalianParticipants(options);
    const manifestAfterRecoveryRaw: unknown = JSON.parse(await readFile(manifestPath, 'utf8')); const recovered = Manifest.parse(manifestAfterRecoveryRaw);
    const recoveredFirst = recovered.accounts.find((entry) => entry.id === firstAccount.id); assert.ok(recoveredFirst);
    assert.ok(recoveredFirst.password === firstAccount.password, 'Response-loss recovery must reuse the original generated secret');
    assert.ok((await rows(database.source.manager, z.object({ password_hash: z.string() }), 'SELECT password_hash FROM person WHERE id=$1', [firstAccount.id]))[0]?.password_hash === firstHash, 'Retry must not rotate a committed credential');
    const profiles = await rows(database.source.manager, z.object({ id: z.string().uuid(), version: z.number() }), 'SELECT id,version FROM person ORDER BY id');
    const manifestBytes = await readFile(manifestPath); const manifestStat = await stat(manifestPath, { bigint: true }); const patchesBeforeRerun = patchIds.length;
    const repeat = await runItalianParticipants(options);
    assert.equal(repeat.updated, 0); assert.equal(patchIds.length, patchesBeforeRerun);
    assert.deepEqual(await rows(database.source.manager, z.object({ id: z.string().uuid(), version: z.number() }), 'SELECT id,version FROM person ORDER BY id'), profiles);
    assert.ok((await readFile(manifestPath)).equals(manifestBytes), 'A no-op rerun must not rewrite credential bytes');
    assert.equal((await stat(manifestPath, { bigint: true })).mtimeNs, manifestStat.mtimeNs);
    const after = await rows(database.source.manager, z.object({ id: z.string().uuid(), first_name: z.string(), last_name: z.string(), preferred_name: z.string().nullable(), phone_number: z.string().nullable(), address: z.string().nullable(), login: z.string().nullable(), password_hash: z.string().nullable(), external: z.boolean(), enabled: z.boolean() }),
      'SELECT id,first_name,last_name,preferred_name,phone_number,address,login,password_hash,external,enabled FROM person ORDER BY id');
    const one = after.find((person) => person.id === fixtureOne.id); const two = after.find((person) => person.id === fixtureTwo.id); const existing = after.find((person) => person.id === fixtureThree.id); const outsider = after.find((person) => person.id === outsiderId);
    assert.equal(one?.first_name, fixtureOne.firstName); assert.equal(two?.first_name, fixtureTwo.firstName);
    assert.equal(two?.phone_number, '+39 000 123 4567'); assert.equal(two?.address, 'Indirizzo sintetico scelto dall’utente'); assert.equal(two?.external, true); assert.equal(two?.enabled, false);
    assert.equal(existing?.first_name, 'Utente'); assert.equal(existing?.preferred_name, 'Nome scelto'); assert.equal(existing?.login, 'already.configured@example.test');
    assert.ok(existing?.password_hash === existingHash, 'Existing configured credentials must remain unchanged');
    assert.equal(outsider?.first_name, 'DEMO'); assert.equal(outsider?.last_name, 'Person 16'); assert.equal(outsider?.login, null);
    assert.equal(recovered.accounts.some((entry) => entry.id === fixtureThree.id || entry.id === outsiderId), false);
    assert.deepEqual(await rows(database.source.manager, z.record(z.string(), z.unknown()), 'SELECT id,version,name,classification,area,enabled,legacy_data FROM crew ORDER BY id'), beforeCrew);
    assert.deepEqual(await rows(database.source.manager, z.object({ crew_id: z.string().uuid(), person_id: z.string().uuid(), position: z.number() }), 'SELECT crew_id,person_id,position FROM crew_member ORDER BY crew_id,position'), beforeRoster);
    assert.deepEqual((await rows(database.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery WHERE id=$1', [closed.id]))[0]?.data, beforeDelivery);
  } finally {
    if (app) await app.close(); else if (database.source.isInitialized) await database.source.destroy();
    if (admin.isInitialized) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.destroy(); }
    assert.equal(path.dirname(directory), path.resolve('.local')); assert.ok(path.basename(directory).startsWith('italian-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
