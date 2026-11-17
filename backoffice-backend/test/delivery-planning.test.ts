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
import { createDelivery, DeliverySchema, type Appointment, type Assignment, type Delivery, type VisitResult } from '../src/domain/model';
import { deriveProgress, planVisitWork, remainingWorkEstimate } from '../src/domain/rules';
import { hashPassword } from '../src/identity/identity';
import { DeliveryListSchema } from '../src/operations/delivery-list';
import { RouteJobsSchema } from '../src/routing/http-contracts';

function delivery(index: number, sourceMinutes: number | null = 90): Delivery {
  return { ...createDelivery({
    pickingId: index, pickingName: `PLANNING/${String(index).padStart(3, '0')}`, saleOrderId: index, saleOrderName: `SO/${index}`,
    sourceState: 'assigned', salesTeam: 'DEMO',
    customer: { id: index, name: `DEMO Planning ${index}`, address: `Via DEMO ${index}`, city: 'Catania', country: 'IT', phones: [], email: null, contact: null },
    items: [{ sourceLineId: index, productId: 1, name: 'DEMO Chair', description: null, quantity: 2, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
    serviceType: 'delivery_only', estimatedMinutes: sourceMinutes, notes: null,
  }, randomUUID()), routePoint: { latitude: 37.5 + index / 1000, longitude: 15.08 } };
}

function visit(status: Appointment['status'], startsAt = '2031-01-01T08:00:00Z'): Appointment {
  return { id: randomUUID(), status, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    cancellationReason: status === 'cancelled' ? 'DEMO cancelled' : null, returnRequestId: null, assignments: [], results: [] };
}

function crew(name: string): Assignment {
  return { id: randomUUID(), crewId: randomUUID(), crewName: name, people: [{ id: randomUUID(), name: 'DEMO Participant', external: false }],
    tasks: [{ id: randomUUID(), templateId: randomUUID(), title: 'DEMO Work', severity: 'low', order: 1,
      checklist: [{ id: randomUUID(), label: 'DEMO Check', done: false, waiver: null }] }] };
}

function reported(target: Delivery, quantities: VisitResult['quantities']) {
  const completed = visit('completed');
  completed.results.push({
    id: randomUUID(), appointmentId: completed.id, supersedesResultId: null, correctionReason: null,
    receivedAt: completed.endsAt, actualStart: completed.startsAt, actualEnd: completed.endsAt, summary: 'DEMO historical work',
    actor: { kind: 'crew', id: randomUUID(), name: 'DEMO Actor' }, responsiblePersonId: randomUUID(), quantities,
    completedChecklistIds: [], evidence: [], customerSignature: null, crewSignature: null,
    sourceSnapshot: structuredClone(target.source), instructionsSnapshot: structuredClone(target.instructions), assignmentsSnapshot: [],
  });
  target.appointments.push(completed);
  return completed;
}

function fixtures() {
  const partial = delivery(1);
  reported(partial, [{ sourceLineId: 1, deliveredMilli: 500 }]);
  const booked = visit('booked', '2031-01-03T08:00:00Z');
  booked.workScope = planVisitWork(partial, [{ sourceLineId: 1, deliveryMilli: 100, installationMilli: 0, collectionMilli: 0 }],
    { id: randomUUID(), name: 'DEMO planner', role: 'operator' }, '2031-01-02T08:00:00Z');
  booked.assignments = [crew('DEMO Catania One'), crew('DEMO Catania Two')];
  partial.appointments.push(booked, visit('cancelled'), visit('failed'));
  const installation = delivery(2, 100);
  installation.servicePlan = { defaultService: 'installation_only', overrides: [] };
  reported(installation, [{ sourceLineId: 2, deliveredMilli: 0, installedMilli: 500 }]);
  const collection = delivery(3, 60);
  collection.servicePlan = { defaultService: 'collection_only', overrides: [] };
  reported(collection, [{ sourceLineId: 3, deliveredMilli: 0, collectedMilli: 1000 }]);
  const assemblyRemaining = delivery(5, 120);
  assemblyRemaining.servicePlan = { defaultService: 'delivery_installation', overrides: [] };
  reported(assemblyRemaining, [{ sourceLineId: 5, deliveredMilli: 2000, installedMilli: 0 }]);
  const finished = delivery(6, 60);
  reported(finished, [{ sourceLineId: 6, deliveredMilli: 2000 }]);
  const mixed = delivery(8);
  const [item] = mixed.source.items;
  assert.ok(item);
  mixed.source.items.push({ ...item, sourceLineId: 80, uom: 'metre' });
  const review = delivery(9);
  review.sourceReview = true;
  const empty = delivery(10);
  empty.source.items = [];
  const active = delivery(11);
  const inProgress = visit('in_progress', '2031-01-04T08:00:00Z');
  inProgress.assignments = [crew('DEMO Active')];
  active.appointments = [visit('booked', '2031-01-05T08:00:00Z'), visit('cancelled'), inProgress,
    visit('booked', '2031-01-02T08:00:00Z'), visit('completed'), visit('failed')];
  return [partial, installation, collection, delivery(4, null), assemblyRemaining, finished, delivery(7, 3000), mixed, review, empty, active];
}

void test('remaining estimate uses corrected operation amounts and never trusts a closed flag over remaining work', () => {
  const target = delivery(1);
  const completed = reported(target, [{ sourceLineId: 1, deliveredMilli: 1500 }]);
  const original = completed.results[0];
  assert.ok(original);
  completed.results.push({ ...original, id: randomUUID(), supersedesResultId: original.id, correctionReason: 'DEMO corrected quantity',
    quantities: [{ sourceLineId: 1, deliveredMilli: 500 }] });
  assert.deepEqual(remainingWorkEstimate(target), { minutes: 68, basis: 'proportional_remaining_operations', sourceMinutes: 90,
    calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: 68, factorPercent: null, fixedMinutes: null,
      adjustmentVersion: null, adjustmentStatus: 'not_configured' } });
  target.completedAt = '2031-01-02T08:00:00Z';
  assert.equal(remainingWorkEstimate(target).minutes, 68);
  const tiny = delivery(2, 1);
  reported(tiny, [{ sourceLineId: 2, deliveredMilli: 1999 }]);
  assert.equal(remainingWorkEstimate(tiny).minutes, 1);
});

class PlanningDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

void test('list planning summaries and Routes/Nearby share remaining estimates through real authenticated PostgreSQL reads', async (context) => {
  const schema = `delivery_planning_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^delivery_planning_[0-9a-f]{32}$/);
  const control = makeDataSource(true);
  const db = new PlanningDatabase(schema);
  const before = fixtures();
  const password = randomBytes(24).toString('base64url');
  let created = false;
  let app: NestExpressApplication | undefined;
  let base = '';
  let cookie = '';
  async function request(route: string, expected = 200, session = cookie) {
    const response = await fetch(base + '/api' + route, { headers: { Origin: config().FRONTEND_ORIGIN, Cookie: session } });
    const raw: unknown = await response.json();
    assert.equal(response.status, expected, JSON.stringify(raw));
    return raw;
  }
  async function row(index: number) {
    const result = DeliveryListSchema.parse(await request('/deliveries?search=PLANNING%2F' + String(index).padStart(3, '0')));
    assert.equal(result.total, 1);
    const item = result.items[0];
    assert.ok(item);
    return item;
  }
  try {
    await control.initialize();
    assert.equal((await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.source.initialize();
    await db.source.runMigrations({ transaction: 'all' });
    for (const entry of before) await db.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [entry.id, schema, entry.source.pickingId, entry.version, JSON.stringify(entry)]);
    await db.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'planning-operator@example.test', 'DEMO Planning Operator', 'operator', await hashPassword(password)]);
    await db.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(db).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: config().FRONTEND_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'planning-operator@example.test', password }) });
    assert.equal(login.status, 201);
    const session = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(session);
    cookie = session;

    await context.test('partial, assembly-only and collection rows keep operation-specific remaining work and provenance', async () => {
      for (const [index, minutes, sourceMinutes] of [[1, 68, 90], [2, 75, 100], [3, 30, 60], [5, 60, 120]] as const) {
        const item = await row(index);
        assert.equal(item.planning.status, 'partially_completed');
        assert.deepEqual(item.planning.remainingWorkEstimate, { minutes, basis: 'proportional_remaining_operations', sourceMinutes,
          calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: minutes, factorPercent: null, fixedMinutes: null,
            adjustmentVersion: null, adjustmentStatus: 'not_configured' } });
      }
      assert.deepEqual((await row(6)).planning.remainingWorkEstimate, { minutes: 0, basis: 'no_remaining_work', sourceMinutes: 60,
        calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: 0, factorPercent: null, fixedMinutes: 0,
          adjustmentVersion: null, adjustmentStatus: 'not_configured' } });
      assert.equal((await row(6)).planning.status, 'awaiting_closure');
      for (const index of [4, 8, 9, 10]) assert.equal((await row(index)).planning.remainingWorkEstimate.basis, 'unknown');
    });

    await context.test('current visits preserve all assigned crew snapshots and exclude old terminal visits', async () => {
      const partial = (await row(1)).planning;
      assert.equal(partial.activeVisits.length, 1);
      assert.deepEqual(partial.activeVisits[0]?.crews.map(({ name }) => name), ['DEMO Catania One', 'DEMO Catania Two']);
      const current = (await row(11)).planning;
      assert.equal(current.status, 'in_progress');
      assert.deepEqual(current.activeVisits.map(({ status, startsAt }) => [status, startsAt]), [
        ['in_progress', '2031-01-04T08:00:00Z'], ['booked', '2031-01-02T08:00:00Z'], ['booked', '2031-01-05T08:00:00Z'],
      ]);
      for (const original of before) assert.equal((await row(original.source.pickingId)).planning.status, deriveProgress(original));
    });

    await context.test('Routes and Nearby estimate unreserved work and do not truncate long work into a one-day suggestion', async () => {
      const catalogue = RouteJobsSchema.parse(await request('/routes/jobs'));
      for (const job of catalogue.jobs.filter((job) => job.pickingName !== 'PLANNING/001')) assert.deepEqual(job.remainingWorkEstimate, (await row(Number(job.pickingName.slice(-3)))).planning.remainingWorkEstimate);
      assert.deepEqual(catalogue.jobs.find((job) => job.pickingName === 'PLANNING/001')?.remainingWorkEstimate,
        { minutes: 63, basis: 'proportional_remaining_operations', sourceMinutes: 90,
          calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: 63, factorPercent: null, fixedMinutes: null,
            adjustmentVersion: null, adjustmentStatus: 'not_configured' } });
      const long = catalogue.jobs.find(({ pickingName }) => pickingName === 'PLANNING/007');
      assert.equal(long?.remainingWorkEstimate?.minutes, 3000);
      assert.equal(long?.suggestedWorkMinutes, null);
      const anchor = before[0];
      assert.ok(anchor);
      const near = RouteJobsSchema.parse(await request(`/routes/jobs?anchorId=${anchor.id}&radiusKm=10`));
      assert.equal(near.anchorJob?.suggestedWorkMinutes, 63);
      assert.deepEqual(near.anchorJob?.remainingWorkEstimate, { minutes: 63, basis: 'proportional_remaining_operations', sourceMinutes: 90,
        calculation: { algorithmVersion: 'remaining_work_v2', baseMinutes: 63, factorPercent: null, fixedMinutes: null,
          adjustmentVersion: null, adjustmentStatus: 'not_configured' } });
      assert.equal((await row(1)).planning.remainingWorkEstimate.minutes, 68, 'Inbox includes the reserved remainder as well');
      assert.ok(near.jobs.some(({ pickingName }) => pickingName === 'PLANNING/002'));
    });

    await request('/deliveries', 401, '');
    const after = await rows(db.source.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery ORDER BY source_id');
    assert.deepEqual(after.map(({ data }) => data), before);
    const [audit] = await rows(db.source.manager, z.object({ count: z.number() }), 'SELECT count(*)::integer AS count FROM audit');
    assert.equal(audit?.count, 0);
  } finally {
    try {
      if (app) await app.close();
      if (db.source.isInitialized) await db.source.destroy();
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      if (control.isInitialized) await control.destroy();
    }
  }
});
