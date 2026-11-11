import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule } from '../src/app';
import { applicationUrl } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, type Appointment, type ExecutionInput, type SourceSnapshot } from '../src/domain/model';
import { DomainError, deliveredMilli } from '../src/domain/rules';
import { Files } from '../src/evidence/files';
import { Execution, type LocalScenarioContext } from '../src/execution/execution';
import { Identity, hashPassword } from '../src/identity/identity';
import { Operations } from '../src/operations/operations';
import { DeliveryStore } from '../src/operations/store';

class ExecutionDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}` } });
  }
}

void test('execution gateway on owned real PostgreSQL: identity, private evidence, duplicates and signed corrections', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `execution_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^execution_[0-9a-f]{32}$/);
  const admin = makeDataSource(true);
  const database = new ExecutionDatabase(schema);
  const ownedFiles = new Set<string>();
  let shutdown: (() => Promise<void>) | undefined;
  try {
    await admin.initialize();
    const target = (await rows(admin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name'))[0];
    assert.ok(target);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database).compile();
    const application = module.createNestApplication({ logger: false });
    shutdown = () => application.close();
    // Database is already initialized for reviewed migrations; its lifecycle must not initialize twice.
    await database.source.destroy();
    await application.init();
    const store = module.get<DeliveryStore>(DeliveryStore);
    const operations = module.get<Operations>(Operations);
    const gateway = module.get<Execution>(Execution);
    const files = module.get<Files>(Files);
    const identity = module.get<Identity>(Identity);
    const password = randomBytes(24).toString('base64url');
    const principalId = randomUUID();
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [principalId, 'execution@example.test', 'DEMO execution operator', 'operator', await hashPassword(password)]);
    const login = await identity.login({ email: 'execution@example.test', password });
    const principal = await identity.authenticate({ headers: { cookie: `backoffice_session=${login.token}` } });
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'execution-admin@example.test', 'DEMO execution administrator', 'admin', await hashPassword(password)]);
    const adminLogin = await identity.login({ email: 'execution-admin@example.test', password });
    const adminPrincipal = await identity.authenticate({ headers: { cookie: `backoffice_session=${adminLogin.token}` } });
    const person = await operations.saveParticipant(null, { firstName: 'DEMO', lastName: 'Representative', preferredName: 'DEMO execution representative' }, adminPrincipal);
    const personId = person.id;
    const crew = await operations.saveCrew(null, { name: 'DEMO execution crew', classification: 'indoor', area: 'DEMO', enabled: true,
      participantIds: [personId] }, adminPrincipal);
    const template = await operations.saveTemplate(null, { title: 'DEMO assemble', severity: 'low', order: 4, checklist: ['Assemble', 'Clean'], enabled: true }, adminPrincipal);
    const source: SourceSnapshot = { pickingId: 1, pickingName: 'EXECUTION/DEMO/0001', saleOrderId: 1, saleOrderName: 'EXECUTION/SO/0001',
      sourceState: 'assigned', salesTeam: 'MOHD MESSINA', customer: { id: 1, name: 'DEMO execution customer', address: 'Synthetic Lane 1', city: 'Messina', country: 'IT', phones: ['+390000000001'], email: null, contact: null },
      items: [{ sourceLineId: 10, productId: 1, name: 'DEMO execution item', description: null, quantity: 1.125, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: null, notes: null };
    let delivery = createDelivery(source, randomUUID());
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [delivery.id, schema, 1, 1, JSON.stringify(delivery)]);
    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() - 1_800_000).toISOString();
    let detail = await operations.book(delivery.id, { version: 1, requestId: randomUUID(), startsAt: start, endsAt: end,
      workLines: [{ sourceLineId: 10, deliveryMilli: 1125, installationMilli: 0, collectionMilli: 0 }] }, principal);
    const booked = detail.delivery.appointments[0];
    assert.ok(booked);
    await assert.rejects(() => gateway.authorizeLocalScenario(delivery.id, booked.id, principal),
      (error: unknown) => error instanceof DomainError && error.code === 'CREW_NOT_ASSIGNED');
    detail = await operations.assign(delivery.id, booked.id, { version: detail.delivery.version, requestId: randomUUID(), crewIds: [crew.id], templateIds: [template.id] }, principal);
    let appointment = detail.delivery.appointments[0];
    assert.ok(appointment);
    const authorized = await gateway.authorizeLocalScenario(delivery.id, appointment.id, principal);
    const representative = gateway.representative(authorized);
    const input = (visit: Appointment, overrides: Partial<ExecutionInput> = {}): ExecutionInput => ({ id: randomUUID(), appointmentId: visit.id,
      supersedesResultId: null, correctionReason: null, actualStart: start, actualEnd: end, summary: 'DEMO controlled execution result', responsiblePersonId: representative.id,
      quantities: [{ sourceLineId: 10, deliveredMilli: 1125 }], completedChecklistIds: visit.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))),
      evidence: [], customerSignature: null, crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew signature', at: end }, ...overrides });

    await context.test('opaque local context rejects body impersonation and production invocation', async () => {
      const fake: LocalScenarioContext = { kind: 'local-scenario' };
      await assert.rejects(() => gateway.receive(fake, detail.delivery.version, input(booked)), ForbiddenException);
      await assert.rejects(() => gateway.authorizeLocalScenario(delivery.id, booked.id, { ...principal, name: 'Impersonation' }), ForbiddenException);
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try { await assert.rejects(() => gateway.authorizeLocalScenario(delivery.id, booked.id, principal), ForbiddenException); }
      finally { if (previous === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = previous; }
    });
    await context.test('assigned crew waits for confirmation before start or result; confirmed start updates both stores', async () => {
      const version = detail.delivery.version;
      const waitingForCustomer = (error: unknown) => error instanceof DomainError && error.code === 'CUSTOMER_CONFIRMATION_REQUIRED';
      await assert.rejects(() => gateway.start(authorized, version), waitingForCustomer);
      await assert.rejects(() => gateway.receive(authorized, version, input(booked)), waitingForCustomer);
      assert.deepEqual(await store.get(delivery.id), detail.delivery);
      assert.equal((await rows(database.source.manager, z.object({ status: z.literal('booked') }), 'SELECT status FROM appointment WHERE id=$1', [booked.id])).length, 1);

      detail = await operations.confirmCustomer(delivery.id, booked.id, { version }, principal);
      assert.deepEqual(detail.delivery.appointments[0]?.customerConfirmation?.confirmedBy, { id: principal.id, name: principal.name });
      assert.equal(detail.delivery.appointments[0]?.status, 'booked');
      detail = await gateway.start(authorized, detail.delivery.version);
      assert.equal(detail.progress, 'in_progress');
      assert.equal((await rows(database.source.manager, z.object({ status: z.literal('in_progress') }), 'SELECT status FROM appointment WHERE id=$1', [booked.id])).length, 1);
    });
    await context.test('evidence belongs to the exact ready visit/item and missing bytes never count as successful', async () => {
      const issueId = randomUUID();
      detail = await gateway.reportIssue(authorized, detail.delivery.version, { id: issueId, type: 'damage', description: 'DEMO crew issue', itemIds: [10], photoIds: [], notes: null });
      assert.equal(detail.delivery.issues[0]?.authorId, personId);
      const fileId = await gateway.attachSyntheticEvidence(authorized, 10, issueId);
      ownedFiles.add(fileId);
      detail = await store.detail(delivery.id);
      const file = detail.files.find((entry) => entry.id === fileId);
      assert.equal(file?.kind, 'evidence');
      assert.equal(file?.status, 'ready');
      await assert.rejects(() => gateway.receive(authorized, detail.delivery.version, input(booked, { evidence: [{ id: fileId, type: 'damage', itemIds: [] }] })),
        (error: unknown) => error instanceof DomainError && error.code === 'EVIDENCE_ITEM_MISMATCH');
      await database.source.query('UPDATE file_record SET status=$2 WHERE id=$1', [fileId, 'pending']);
      await assert.rejects(() => gateway.receive(authorized, detail.delivery.version, input(booked, { evidence: [{ id: fileId, type: 'damage', itemIds: [10] }] })),
        (error: unknown) => error instanceof DomainError && error.code === 'EVIDENCE_UNAVAILABLE');
      await database.source.query('UPDATE file_record SET status=$2 WHERE id=$1', [fileId, 'ready']);
      const bytes = await readFile(path.join(files.directory, fileId));
      await unlink(path.join(files.directory, fileId));
      await assert.rejects(() => gateway.receive(authorized, detail.delivery.version, input(booked, { evidence: [{ id: fileId, type: 'damage', itemIds: [10] }] })));
      await writeFile(path.join(files.directory, fileId), bytes, { flag: 'wx' });
      assert.equal((await store.get(delivery.id)).appointments[0]?.results.length, 0);
    });
    await context.test('repeat result is idempotent, missing signature blocks closure, correction preserves first signed version', async () => {
      appointment = detail.delivery.appointments[0];
      assert.ok(appointment);
      const original = input(appointment);
      const submittedVersion = detail.delivery.version;
      detail = await gateway.receive(authorized, submittedVersion, original);
      const repeated = await gateway.receive(authorized, submittedVersion, original);
      assert.equal(repeated.delivery.version, detail.delivery.version);
      assert.equal(repeated.delivery.appointments[0]?.results.length, 1);
      const firstSnapshot = JSON.stringify(detail.delivery.appointments[0]?.results[0]);
      await assert.rejects(() => operations.complete(delivery.id, { version: detail.delivery.version }, principal),
        (error: unknown) => error instanceof DomainError && error.code === 'CLOSURE_BLOCKED');
      const partialCorrection = input(appointment, { supersedesResultId: original.id, correctionReason: 'DEMO corrected quantity after inspection',
        quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], incompleteWork: [
          { sourceLineId: 10, operation: 'delivery', reason: 'damage', note: 'DEMO damaged part returned to the van.' },
        ] });
      const beforeCorrection = detail.delivery.version;
      await assert.rejects(() => gateway.receive(authorized, beforeCorrection, { ...partialCorrection, incompleteWork: [] }),
        (error: unknown) => error instanceof DomainError && error.code === 'INCOMPLETE_WORK_REASON_REQUIRED');
      assert.equal((await store.get(delivery.id)).version, beforeCorrection);
      detail = await gateway.receive(authorized, beforeCorrection, partialCorrection);
      assert.deepEqual((await store.detail(delivery.id)).delivery.appointments[0]?.results[1]?.incompleteWork, partialCorrection.incompleteWork);
      assert.equal(deliveredMilli(detail.delivery, 10), 1000);
      assert.equal(JSON.stringify(detail.delivery.appointments[0]?.results[0]), firstSnapshot);
      assert.equal((await gateway.receive(authorized, beforeCorrection, partialCorrection)).delivery.version, detail.delivery.version);
      await assert.rejects(() => gateway.receive(authorized, beforeCorrection, { ...partialCorrection,
        incompleteWork: [{ sourceLineId: 10, operation: 'delivery', reason: 'access', note: null }],
      }), (error: unknown) => error instanceof ConflictException && error.message === 'Request ID reused with different input');
      const correction = input(appointment, { supersedesResultId: partialCorrection.id, correctionReason: 'DEMO missing customer confirmation supplied as a new version',
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer signature', at: end } });
      detail = await gateway.receive(authorized, detail.delivery.version, correction);
      assert.equal(detail.delivery.appointments[0]?.results.length, 3);
      assert.deepEqual(detail.delivery.appointments[0]?.results[1]?.incompleteWork, partialCorrection.incompleteWork);
      assert.deepEqual(detail.delivery.appointments[0]?.results[2]?.incompleteWork, []);
      assert.equal(JSON.stringify(detail.delivery.appointments[0]?.results[0]), firstSnapshot);
      assert.equal(deliveredMilli(detail.delivery, 10), 1125);
      const issue = detail.delivery.issues[0];
      assert.ok(issue);
      detail = await operations.resolveIssue(delivery.id, issue.id, { version: detail.delivery.version, resolution: 'DEMO issue resolved' }, principal);
      assert.ok(detail.closureBlockers.includes('Damaged products await dispatcher readiness confirmation'));
      detail = await operations.releaseDamagedWork(delivery.id, 10, { version: detail.delivery.version, note: 'Corrected full handover inspected; no replacement remains outstanding.' }, principal);
      detail = await operations.complete(delivery.id, { version: detail.delivery.version }, principal);
      assert.equal(detail.progress, 'completed');
      assert.equal(detail.delivery.completions[0]?.resultIds[0], correction.id);
      await assert.rejects(() => gateway.reportIssue(authorized, detail.delivery.version, { id: randomUUID(), type: 'other', description: 'New issue after closure', itemIds: [], photoIds: [], notes: null }),
        (error: unknown) => error instanceof DomainError && error.code === 'DELIVERY_CLOSED');
      delivery = detail.delivery;
    });
    assert.equal(delivery.completedAt !== null, true);
    await identity.logout({ headers: { cookie: `backoffice_session=${login.token}` } });
    await identity.logout({ headers: { cookie: `backoffice_session=${adminLogin.token}` } });
  } finally {
    if (shutdown) await shutdown();
    else if (database.source.isInitialized) await database.source.destroy();
    for (const fileId of ownedFiles) {
      try { await unlink(path.resolve('.local', 'files-test', fileId)); }
      catch (error: unknown) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    }
    if (admin.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
});
