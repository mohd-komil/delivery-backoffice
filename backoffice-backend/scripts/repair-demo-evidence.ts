import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createApp } from '../src/app';
import { applicationUrl } from '../src/config';
import { rows } from '../src/database/database';
import { type ExecutionInput } from '../src/domain/model';
import { effectiveResults } from '../src/domain/rules';
import { Files, inspectFile, validateFileContent } from '../src/evidence/files';
import { Execution } from '../src/execution/execution';
import { Identity } from '../src/identity/identity';
import { Operations } from '../src/operations/operations';
import { DeliveryStore } from '../src/operations/store';

const reason = 'DEMO malformed synthetic evidence fixture correction';
const Accounts = z.object({ operator: z.object({ email: z.string().email(), password: z.string().min(16) }) });
const Marker = z.object({ deliveryId: z.string().uuid() });
const RepairPlan = z.object({ appointmentId: z.string().uuid(), oldFileId: z.string().uuid(), originalResultId: z.string().uuid() });
const PlanRow = z.object({ details: z.unknown() });

/** Corrects this implementation's initial synthetic fixture through the same versioned domain command. */
export async function repairDemoEvidence(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Synthetic evidence repair is disabled in production');
  const expected = new URL(applicationUrl(process.env['BACKOFFICE_TEST'] === '1'));
  const app = await createApp(true);
  await app.init();
  const store = app.get<DeliveryStore>(DeliveryStore);
  const operations = app.get<Operations>(Operations);
  const identity = app.get<Identity>(Identity);
  const gateway = app.get<Execution>(Execution);
  const files = app.get<Files>(Files);
  let request: { headers: { cookie: string } } | undefined;
  try {
    const target = (await rows(store.db.source.manager, z.object({ name: z.string(), port: z.literal(55432) }),
      'SELECT current_database() AS name,inet_server_port() AS port'))[0];
    if (!target || target.name !== expected.pathname.slice(1)) throw new Error('Repair requires the isolated local application database');
    const accountsRaw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
    const login = await identity.login(Accounts.parse(accountsRaw).operator);
    request = { headers: { cookie: `backoffice_session=${login.token}` } };
    const principal = await identity.authenticate(request);
    const marker = (await rows(store.db.source.manager, Marker,
      `SELECT delivery_id AS "deliveryId" FROM audit WHERE action='demo.scenario.completed' ORDER BY at DESC LIMIT 1`))[0];
    if (!marker) throw new Error('Run the local DEMO scenario before repairing its evidence fixture');
    const deliveryId = marker.deliveryId;
    const completedMarker = (await rows(store.db.source.manager, PlanRow,
      `SELECT details FROM audit WHERE action='demo.evidence.corrected' AND delivery_id=$1 ORDER BY at DESC LIMIT 1`, [deliveryId]))[0];
    if (completedMarker) {
      console.log(`DEMO evidence correction already recorded. Delivery ${deliveryId}`);
      return;
    }
    let detail = await store.detail(deliveryId);
    const existingPlan = (await rows(store.db.source.manager, PlanRow,
      `SELECT details FROM audit WHERE action='demo.evidence.repair_started' AND delivery_id=$1 ORDER BY at DESC LIMIT 1`, [deliveryId]))[0];
    let plan: z.infer<typeof RepairPlan> | undefined = existingPlan ? RepairPlan.parse(existingPlan.details) : undefined;
    if (!plan) {
      if (detail.delivery.completedAt === null) throw new Error('DEMO delivery has user-owned open work; inspect it before running fixture repair');
      for (const result of effectiveResults(detail.delivery)) {
        for (const evidence of result.evidence) {
          const file = detail.files.find((entry) => entry.id === evidence.id && entry.kind === 'evidence' && entry.name === 'DEMO synthetic damage.png');
          if (!file || file.status !== 'ready') continue;
          const downloaded = await files.download(deliveryId, file.id);
          let malformed = false;
          try { await validateFileContent(inspectFile(file.name, downloaded.bytes.toString('base64'))); }
          catch { malformed = true; }
          if (malformed) { plan = { appointmentId: result.appointmentId, originalResultId: result.id, oldFileId: file.id }; break; }
        }
        if (plan) break;
      }
      if (!plan) { console.log(`DEMO evidence already validates. Delivery ${deliveryId}`); return; }
      await store.audit(store.db.source.manager, principal, 'demo.evidence.repair_started', plan, deliveryId);
    }
    const original = detail.delivery.appointments.flatMap((appointment) => appointment.results).find((result) => result.id === plan.originalResultId);
    if (!original) throw new Error('Original DEMO result is missing; no historical result was changed');
    const originalSnapshot = JSON.stringify(original);
    const originalBytes = await readFile(path.join(files.directory, plan.oldFileId));
    let corrected = effectiveResults(detail.delivery).find((result) => result.supersedesResultId === original.id && result.correctionReason === reason);
    if (detail.delivery.completedAt !== null && !corrected) {
      detail = await operations.reopen(deliveryId, { version: detail.delivery.version, reason }, principal);
    }
    const repairPlan = plan;
    await store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const changed = await rows(manager, z.object({ id: z.string().uuid() }),
        `SELECT id FROM file_record WHERE id=$1 AND delivery_id=$2 AND status<>'failed' FOR UPDATE`, [repairPlan.oldFileId, deliveryId]);
      if (changed.length > 0) {
        await manager.query(`UPDATE file_record SET status='failed' WHERE id=$1 AND delivery_id=$2`, [repairPlan.oldFileId, deliveryId]);
        await store.audit(manager, principal, 'evidence.invalidated', {
          id: repairPlan.oldFileId, reason, originalBytesPreserved: true, originalResultId: original.id,
        }, deliveryId);
      }
    });
    if (!corrected) {
      const context = await gateway.authorizeLocalScenario(deliveryId, plan.appointmentId, principal);
      const representative = gateway.representative(context);
      let replacement = detail.files.find((file) => file.id !== repairPlan.oldFileId && file.kind === 'evidence' &&
        file.name === 'DEMO synthetic damage.png' && file.appointmentId === repairPlan.appointmentId && file.status === 'ready');
      if (!replacement) {
        const oldFile = detail.files.find((file) => file.id === repairPlan.oldFileId);
        if (!oldFile) throw new Error('Original evidence metadata is missing');
        const newFileId = await gateway.attachSyntheticEvidence(context, oldFile.itemId, oldFile.issueId);
        detail = await store.detail(deliveryId);
        replacement = detail.files.find((file) => file.id === newFileId);
      }
      if (!replacement) throw new Error('Replacement evidence was not registered');
      const now = new Date().toISOString();
      const correction: ExecutionInput = {
        id: randomUUID(), appointmentId: original.appointmentId, supersedesResultId: original.id, correctionReason: reason,
        actualStart: original.actualStart, actualEnd: original.actualEnd, summary: original.summary, responsiblePersonId: representative.id,
        quantities: structuredClone(original.quantities), completedChecklistIds: [...original.completedChecklistIds],
        evidence: original.evidence.map((evidence) => ({ ...evidence, id: evidence.id === repairPlan.oldFileId ? replacement.id : evidence.id })),
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO corrective evidence confirmation', at: now },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO corrective evidence confirmation', at: now },
      };
      detail = await gateway.receive(context, detail.delivery.version, correction);
      corrected = effectiveResults(detail.delivery).find((result) => result.id === correction.id);
    }
    if (!corrected) throw new Error('Corrective result is missing');
    if (detail.delivery.completedAt === null) detail = await operations.complete(deliveryId, { version: detail.delivery.version }, principal);
    const originalAfter = detail.delivery.appointments.flatMap((appointment) => appointment.results).find((result) => result.id === original.id);
    assert.equal(JSON.stringify(originalAfter), originalSnapshot);
    assert.ok((await readFile(path.join(files.directory, plan.oldFileId))).equals(originalBytes));
    assert.ok(detail.delivery.completions.length >= 2);
    await store.audit(store.db.source.manager, principal, 'demo.evidence.corrected', { ...plan, correctiveResultId: corrected.id, originalPreserved: true }, deliveryId);
    console.log(`DEMO evidence corrected. Delivery ${deliveryId}; original result ${original.id}; corrective result ${corrected.id}`);
  } finally {
    if (request) await identity.logout(request);
    await app.close();
  }
}

if (require.main === module) void repairDemoEvidence().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Synthetic fixture repair failed');
  process.exitCode = 1;
});
