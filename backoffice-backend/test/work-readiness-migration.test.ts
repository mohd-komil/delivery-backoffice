import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { applicationMigrations, makeDataSource, rows } from '../src/database/database';
import { WorkReadiness1793701000000 } from '../src/database/work-readiness-migration';
import { createDelivery, DeliverySchema, type Appointment, type ExecutionInput, type OperatorActor } from '../src/domain/model';
import { planVisitWork, raiseIssue, recordExecution, releaseDamagedWork } from '../src/domain/rules';

void test('damage readiness migration preserves signed reports, backfills only effective unfinished damage and is repeatable', async () => {
  const schema = `readiness_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^readiness_[0-9a-f]{32}$/);
  const options = { type: 'postgres' as const, url: applicationUrl(true), schema, entities: [], synchronize: false, logging: false,
    extra: { options: `-c search_path=${schema}` } };
  const owner = makeDataSource(true);
  const previous = new DataSource({ ...options, migrations: applicationMigrations.filter((migration) => migration !== WorkReadiness1793701000000) });
  const updated = new DataSource({ ...options, migrations: applicationMigrations });
  let created = false;
  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager, z.object({ name: z.literal('delivery_backoffice_test'), port: z.literal(55432) }),
      'SELECT current_database() AS name, inet_server_port() AS port')).length, 1);
    await owner.query(`CREATE SCHEMA "${schema}"`); created = true;
    await previous.initialize(); await previous.runMigrations({ transaction: 'all' });
    const operator: OperatorActor = { id: randomUUID(), name: 'DEMO dispatcher', role: 'operator' };
    const actor = { kind: 'crew' as const, id: randomUUID(), name: 'DEMO responsible' };
    const start = '2031-01-01T08:00:00Z'; const end = '2031-01-01T09:00:00Z';
    const item = { productId: 5, name: 'DEMO same SKU', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null };
    const delivery = createDelivery({ pickingId: 1, pickingName: 'DEMO/MIGRATION/1', saleOrderId: 1, saleOrderName: 'DEMO/SO/1', sourceState: 'assigned', salesTeam: 'DEMO',
      customer: { id: 1, name: 'DEMO Customer', address: null, city: null, country: 'IT', phones: [], email: null, contact: null },
      serviceType: 'delivery_only', estimatedMinutes: 60, notes: null, items: [{ ...item, sourceLineId: 11 }, { ...item, sourceLineId: 22 }] }, randomUUID());
    const appointment: Appointment = { id: randomUUID(), startsAt: start, endsAt: end, status: 'booked', cancellationReason: null, returnRequestId: null, results: [],
      workScope: planVisitWork(delivery, [{ sourceLineId: 11, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], operator, start),
      customerConfirmation: { confirmedAt: start, confirmedBy: { id: operator.id, name: operator.name } }, responsibleParticipant: { id: actor.id, name: actor.name },
      assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO Team', people: [{ id: actor.id, name: actor.name, external: false }], tasks: [
        { id: randomUUID(), templateId: randomUUID(), title: 'DEMO inspection', severity: 'low', order: 1,
          checklist: [{ id: randomUUID(), label: 'Inspect furniture', done: false, waiver: null }] },
      ] }] };
    delivery.appointments.push(appointment);
    const report: ExecutionInput = { id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
      actualStart: start, actualEnd: end, summary: 'DEMO damage report', responsiblePersonId: actor.id, quantities: [],
      incompleteWork: [{ sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'Damaged chair.' }],
      completedChecklistIds: [], evidence: [], customerSignature: null, crewSignature: null };
    const damaged = recordExecution(delivery, report, actor, end);
    const withIssue = raiseIssue(damaged, { id: randomUUID(), type: 'damage', description: 'Other order damaged', itemIds: [22], photoIds: [], notes: null }, operator, end);
    const legacy = structuredClone(withIssue); delete legacy.workHolds;
    const corrected = recordExecution(damaged, { ...report, id: randomUUID(), supersedesResultId: report.id, correctionReason: 'Original classification corrected',
      quantities: [{ sourceLineId: 11, deliveredMilli: 1000 }], incompleteWork: [] }, actor, end);
    corrected.id = randomUUID(); delete corrected.workHolds;
    const closed = { ...structuredClone(legacy), id: randomUUID(), completedAt: end };
    const alreadyReady = releaseDamagedWork(releaseDamagedWork(withIssue, 11, 'Replacement ready', operator, end), 22, 'Second replacement ready', operator, end);
    alreadyReady.id = randomUUID();
    for (const [index, data] of [legacy, corrected, closed, alreadyReady].entries()) {
      await previous.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [data.id, schema, index + 1, data.version, JSON.stringify(data)]);
    }
    const fingerprints = await rows(previous.manager, z.object({ id: z.string(), hash: z.string() }),
      `SELECT id,md5((data->'appointments')::text) AS hash FROM delivery ORDER BY id`);
    await previous.destroy(); await updated.initialize();
    assert.equal((await updated.runMigrations({ transaction: 'all' })).length, 1);
    assert.deepEqual(await updated.runMigrations({ transaction: 'all' }), []);
    const migration = new WorkReadiness1793701000000();
    await updated.transaction(async (manager) => {
      assert.ok(manager.queryRunner);
      await migration.up(manager.queryRunner);
    });
    const persisted = (await rows(updated.manager, z.object({ data: DeliverySchema }), 'SELECT data FROM delivery')).map(({ data }) => data);
    const changed = persisted.find(({ id }) => id === legacy.id); assert.ok(changed);
    assert.equal(changed.version, legacy.version + 1); assert.equal(changed.workHolds?.length, 2);
    assert.deepEqual(changed.workHolds?.map(({ sourceLineId }) => sourceLineId).sort(), [11, 22]);
    assert.ok(changed.workHolds?.every((hold) => hold.release === undefined));
    assert.equal(persisted.find(({ id }) => id === corrected.id)?.workHolds, undefined, 'A superseded damage classification must not become a new hold');
    assert.equal(persisted.find(({ id }) => id === closed.id)?.workHolds, undefined, 'Closed delivery history stays unchanged');
    assert.deepEqual(persisted.find(({ id }) => id === alreadyReady.id)?.workHolds, alreadyReady.workHolds, 'An existing release must not be undone');
    assert.deepEqual(await rows(updated.manager, z.object({ id: z.string(), hash: z.string() }),
      `SELECT id,md5((data->'appointments')::text) AS hash FROM delivery ORDER BY id`), fingerprints);
    const audit = await rows(updated.manager, z.object({ action: z.literal('work.readiness_backfilled'), details: z.object({ migration: z.string(), holdIds: z.array(z.string()) }) }), 'SELECT action,details FROM audit');
    assert.equal(audit.length, 1); assert.equal(audit[0]?.details.holdIds.length, 2);
    await assert.rejects(() => migration.down(), /reviewed recovery procedure/u);
  } finally {
    if (previous.isInitialized) await previous.destroy();
    if (updated.isInitialized) await updated.destroy();
    if (owner.isInitialized) {
      if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
      await owner.destroy();
    }
  }
});
