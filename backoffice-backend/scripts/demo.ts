import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createApp } from '../src/app';
import { rows } from '../src/database/database';
import { type Appointment, type Delivery, type ExecutionInput } from '../src/domain/model';
import { DomainError, lineServiceStatuses, quantityToMilli } from '../src/domain/rules';
import { Files } from '../src/evidence/files';
import { Execution, type LocalScenarioContext } from '../src/execution/execution';
import { Identity } from '../src/identity/identity';
import { Importer } from '../src/integration/importer';
import { Operations } from '../src/operations/operations';
import { DeliveryStore } from '../src/operations/store';

const AccountSchema = z.object({ operator: z.object({ email: z.string().email(), password: z.string().min(16) }) });
const MarkerSchema = z.object({ deliveryId: z.string().uuid() });
const issueDescription = 'DEMO scenario: product damage reported by the assigned crew';
const returnReason = 'DEMO scenario: remaining quantity and assembly after damage';
const documentName = 'DEMO delivery instructions.txt';

function visit(delivery: Delivery, id: string): Appointment {
  const found = delivery.appointments.find((appointment) => appointment.id === id);
  if (!found) throw new Error('Scenario appointment is missing');
  return found;
}

function remainingDemoWork(delivery: Delivery) {
  const lines = lineServiceStatuses(delivery);
  if (lines.some((line) => line.planningBlockedReason !== null || line.service === 'installation_only')) {
    throw new Error('Review the demo services, existing visit scopes and customer stock explicitly before continuing this scenario');
  }
  return lines.map((line) => ({ sourceLineId: line.sourceLineId, deliveryMilli: line.availableDeliveryMilli,
    installationMilli: line.availableInstallationMilli, collectionMilli: line.availableCollectionMilli }))
    .filter((line) => line.deliveryMilli + line.installationMilli + line.collectionMilli > 0);
}

export async function runDemo(): Promise<{ deliveryId: string; alreadyCompleted: boolean }> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('The local DEMO scenario is disabled in production');
  const app = await createApp(true);
  await app.init();
  const identity = app.get<Identity>(Identity);
  const store = app.get<DeliveryStore>(DeliveryStore);
  const operations = app.get<Operations>(Operations);
  const execution = app.get<Execution>(Execution);
  const files = app.get<Files>(Files);
  const importer = app.get<Importer>(Importer);
  let request: { headers: { cookie: string } } | undefined;
  try {
    const accountRaw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
    const account = AccountSchema.parse(accountRaw).operator;
    const login = await identity.login(account);
    request = { headers: { cookie: `backoffice_session=${login.token}` } };
    const principal = await identity.authenticate(request);
    assert.equal(principal.role, 'operator');
    const finished = (await rows(store.db.source.manager, MarkerSchema,
      `SELECT delivery_id AS "deliveryId" FROM audit WHERE action='demo.scenario.completed' ORDER BY at DESC LIMIT 1`))[0];
    if (finished) {
      const previous = await store.get(finished.deliveryId);
      if (previous.completedAt !== null) {
        console.log(`DEMO already completed. Delivery ${previous.id}; retained ${previous.appointments.length} visits and immutable results.`);
        return { deliveryId: previous.id, alreadyCompleted: true };
      }
      throw new Error('The completed DEMO delivery was reopened. Its user-owned follow-up is preserved; inspect it before starting another scenario.');
    }
    const imported = await importer.run(principal);
    if (imported.status !== 'succeeded') throw new Error('The scenario requires a successful source import');
    const started = (await rows(store.db.source.manager, MarkerSchema,
      `SELECT delivery_id AS "deliveryId" FROM audit WHERE action='demo.scenario.started' ORDER BY at DESC LIMIT 1`))[0];
    const candidate = started ? await store.get(started.deliveryId) : (await store.all()).find((delivery) =>
      delivery.appointments.length === 0 && !delivery.sourceReview && delivery.source.customer.address !== null &&
      delivery.source.customer.city !== null && delivery.source.customer.phones.length > 0 && delivery.source.items.length > 0);
    if (!candidate) throw new Error('No unplanned imported DEMO delivery is available; existing work was preserved');
    const deliveryId = candidate.id;
    let detail = await store.detail(deliveryId);
    if (!started) await store.audit(store.db.source.manager, principal, 'demo.scenario.started', { synthetic: true }, deliveryId);

    const crews = (await operations.crews()).filter((crew) => crew.enabled);
    const templates = (await operations.templates()).filter((template) => template.enabled);
    const crewOne = crews[0];
    const crewTwo = crews[1];
    if (!crewOne || !crewTwo || templates.length < 2) throw new Error('The scenario requires two enabled crews and task templates');
    const firstTemplates = templates.slice(0, Math.max(1, Math.floor(templates.length / 2))).map((template) => template.id);
    const secondTemplates = templates.slice(Math.max(1, Math.floor(templates.length / 2))).map((template) => template.id);
    const base = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 4 * 3_600_000;
    let first = detail.delivery.appointments.find((appointment) => appointment.returnRequestId === null);
    if (!first) {
      detail = await operations.book(deliveryId, { version: detail.delivery.version, requestId: randomUUID(),
        startsAt: new Date(base).toISOString(), endsAt: new Date(base + 3_600_000).toISOString(), workLines: remainingDemoWork(detail.delivery) }, principal);
      first = detail.delivery.appointments[0];
    }
    if (!first) throw new Error('Initial appointment was not created');
    for (const [crew, templateIds] of [[crewOne, firstTemplates], [crewTwo, secondTemplates]] as const) {
      if (!first.assignments.some((assignment) => assignment.crewId === crew.id)) {
        detail = await operations.assign(deliveryId, first.id, { version: detail.delivery.version, requestId: randomUUID(), crewIds: [crew.id], templateIds }, principal);
        first = visit(detail.delivery, first.id);
      }
    }
    if (!detail.files.some((file) => file.name === documentName && file.status === 'ready')) {
      detail = await files.upload(deliveryId, { name: documentName,
        base64: Buffer.from('DEMO ONLY: synthetic delivery instructions. No real customer document.').toString('base64'),
        kind: 'document', appointmentId: first.id, itemId: null, issueId: null }, principal);
    }
    const firstContext = await execution.authorizeLocalScenario(deliveryId, first.id, principal);
    let issue = detail.delivery.issues.find((entry) => entry.description === issueDescription);
    if (!issue) {
      detail = await execution.reportIssue(firstContext, detail.delivery.version, {
        id: randomUUID(), type: 'damage', description: issueDescription,
        itemIds: [detail.delivery.source.items[0]?.sourceLineId].filter((id) => id !== undefined), photoIds: [], notes: 'DEMO: synthetic report, not a customer incident',
      });
      issue = detail.delivery.issues.find((entry) => entry.description === issueDescription);
    }
    if (!issue) throw new Error('Crew damage issue was not registered');
    const issueId = issue.id;
    let evidenceId = detail.files.find((file) => file.kind === 'evidence' && file.issueId === issueId && file.status === 'ready')?.id;
    if (!evidenceId) {
      evidenceId = await execution.attachSyntheticEvidence(firstContext, detail.delivery.source.items[0]?.sourceLineId ?? null, issue.id);
      detail = await store.detail(deliveryId);
    }

    const command = (context: LocalScenarioContext, appointment: Appointment, quantities: ExecutionInput['quantities'], completedChecklistIds: string[], evidence: ExecutionInput['evidence']): ExecutionInput => {
      const representative = execution.representative(context);
      return { id: randomUUID(), appointmentId: appointment.id, actualStart: appointment.startsAt, actualEnd: appointment.endsAt,
        supersedesResultId: null, correctionReason: null,
        summary: 'DEMO synthetic incoming execution, attributed to the assigned representative', responsiblePersonId: representative.id,
        quantities, completedChecklistIds, evidence,
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer confirmation', at: appointment.endsAt },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew confirmation', at: appointment.endsAt } };
    };
    first = visit(detail.delivery, first.id);
    if (first.results.length === 0) {
      if (first.status === 'booked') {
        if (!first.customerConfirmation) {
          detail = await operations.confirmCustomer(deliveryId, first.id, { version: detail.delivery.version }, principal);
        }
        detail = await execution.start(firstContext, detail.delivery.version);
        assert.equal(detail.progress, 'in_progress');
        first = visit(detail.delivery, first.id);
      }
      const firstAssignment = first.assignments[0];
      if (!firstAssignment) throw new Error('First visit lost its crew');
      const partial = command(firstContext, first, detail.delivery.source.items.map((item) => ({
        sourceLineId: item.sourceLineId, deliveredMilli: Math.floor(quantityToMilli(item.quantity) / 2),
      })), firstAssignment.tasks.flatMap((task) => task.checklist.map((item) => item.id)), [{ id: evidenceId, type: 'damage', itemIds: issue.itemIds }]);
      partial.incompleteWork = (first.workScope?.lines ?? []).flatMap((line) => {
        const actual = partial.quantities.find(({ sourceLineId }) => sourceLineId === line.sourceLineId);
        const reasons: NonNullable<ExecutionInput['incompleteWork']> = [];
        if ((actual?.deliveredMilli ?? 0) < line.deliveryMilli) reasons.push({ sourceLineId: line.sourceLineId, operation: 'delivery', reason: 'damage', note: 'DEMO damaged furniture retained for replacement.' });
        if ((actual?.installedMilli ?? 0) < line.installationMilli) reasons.push({ sourceLineId: line.sourceLineId, operation: 'installation', reason: 'missing_goods_or_parts', note: 'DEMO installation awaits replacement parts.' });
        if ((actual?.collectedMilli ?? 0) < line.collectionMilli) reasons.push({ sourceLineId: line.sourceLineId, operation: 'collection', reason: 'access', note: 'DEMO collection access unavailable.' });
        return reasons;
      });
      const submittedVersion = detail.delivery.version;
      detail = await execution.receive(firstContext, submittedVersion, partial);
      const version = detail.delivery.version;
      const repeated = await execution.receive(firstContext, submittedVersion, partial);
      assert.equal(repeated.delivery.version, version);
      assert.equal(visit(repeated.delivery, first.id).results.length, 1);
      console.log('PASS: assigned crew partial result, damage photo and DEMO signatures received; duplicate result did not add quantities or history.');
    }
    assert.ok(detail.delivery.issues.some((entry) => entry.status === 'open'));
    await assert.rejects(() => operations.complete(deliveryId, { version: detail.delivery.version }, principal),
      (error: unknown) => error instanceof DomainError && error.code === 'CLOSURE_BLOCKED');

    let returnRequest = detail.delivery.returnRequests.find((entry) => entry.reason === returnReason);
    if (!returnRequest) {
      detail = await operations.requestReturn(deliveryId, { version: detail.delivery.version, appointmentId: first.id, reason: returnReason,
        remainingWork: 'DEMO remaining quantities, assembly and cleanup' }, principal);
      returnRequest = detail.delivery.returnRequests.find((entry) => entry.reason === returnReason);
    }
    if (!returnRequest) throw new Error('Return request was not created');
    const returnId = returnRequest.id;
    const firstPending = visit(detail.delivery, first.id).assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist))
      .filter((item) => !item.done && item.waiver === null).map((item) => item.id);
    for (const checklistId of firstPending) {
      detail = await operations.waive(deliveryId, first.id, checklistId, { version: detail.delivery.version,
        reason: `DEMO remaining work transferred to return request ${returnRequest.id}; closure still requires that return to be resolved` }, principal);
    }
    returnRequest = detail.delivery.returnRequests.find((entry) => entry.id === returnId);
    if (!returnRequest) throw new Error('Return request disappeared');
    if (returnRequest.status === 'requested') {
      const returnStart = Date.parse(first.endsAt) + 3_600_000;
      detail = await operations.book(deliveryId, { version: detail.delivery.version, requestId: randomUUID(), returnRequestId: returnRequest.id,
        startsAt: new Date(returnStart).toISOString(), endsAt: new Date(returnStart + 3_600_000).toISOString(), workLines: remainingDemoWork(detail.delivery) }, principal);
      returnRequest = detail.delivery.returnRequests.find((entry) => entry.id === returnId);
    }
    if (!returnRequest?.appointmentId) throw new Error('Return appointment was not linked');
    assert.equal(returnRequest.status, 'planned');
    let followUp = visit(detail.delivery, returnRequest.appointmentId);
    if (followUp.assignments.length === 0) {
      detail = await operations.assign(deliveryId, followUp.id, { version: detail.delivery.version, requestId: randomUUID(),
        crewIds: [crewTwo.id], templateIds: secondTemplates }, principal);
      followUp = visit(detail.delivery, followUp.id);
    }
    if (followUp.results.length === 0) {
      if (followUp.status === 'booked' && !followUp.customerConfirmation) {
        detail = await operations.confirmCustomer(deliveryId, followUp.id, { version: detail.delivery.version }, principal);
        followUp = visit(detail.delivery, followUp.id);
      }
      const followUpContext = await execution.authorizeLocalScenario(deliveryId, followUp.id, principal);
      if (!followUp.workScope) throw new Error('Review the legacy follow-up work scope explicitly before continuing this scenario');
      detail = await execution.receive(followUpContext, detail.delivery.version, command(followUpContext, followUp,
        followUp.workScope.lines.map((line) => ({ sourceLineId: line.sourceLineId, deliveredMilli: line.deliveryMilli,
          installedMilli: line.installationMilli, collectedMilli: line.collectionMilli })),
        followUp.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))), []));
    }
    issue = detail.delivery.issues.find((entry) => entry.id === issueId);
    if (!issue) throw new Error('Crew issue disappeared');
    if (issue.status === 'open') detail = await operations.resolveIssue(deliveryId, issue.id,
      { version: detail.delivery.version, resolution: 'DEMO damaged part replaced during the linked return visit' }, principal);
    returnRequest = detail.delivery.returnRequests.find((entry) => entry.reason === returnReason);
    if (!returnRequest) throw new Error('Return request disappeared');
    if (returnRequest.status === 'planned') detail = await operations.resolveReturn(deliveryId, returnRequest.id,
      { version: detail.delivery.version, resolution: 'DEMO remaining quantities and checklist fulfilled; signatures retained' }, principal);
    detail = await operations.complete(deliveryId, { version: detail.delivery.version }, principal);
    const preserved = JSON.stringify({ appointments: detail.delivery.appointments, completions: detail.delivery.completions });
    assert.equal((await importer.run(principal)).status, 'succeeded');
    detail = await store.detail(deliveryId);
    assert.equal(JSON.stringify({ appointments: detail.delivery.appointments, completions: detail.delivery.completions }), preserved);
    await store.audit(store.db.source.manager, principal, 'demo.scenario.completed', { synthetic: true, retainedAfterImport: true }, deliveryId);
    console.log(`PASS: two visits, two crews on the first visit, private document/evidence, partial quantities, issue, return, checklist, DEMO signatures, explicit closure and reimport. Delivery ${deliveryId}`);
    return { deliveryId, alreadyCompleted: false };
  } finally {
    if (request) await identity.logout(request);
    await app.close();
  }
}

if (require.main === module) void runDemo().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local DEMO scenario failed');
  process.exitCode = 1;
});
