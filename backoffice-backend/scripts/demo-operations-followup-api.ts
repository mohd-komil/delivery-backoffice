import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { CrewProfileSchema, CrewVisitDetailSchema } from '../src/crew/contracts';
import { DeliverySchema, LineServiceStatusSchema, TaskTemplateSchema } from '../src/domain/model';
import { CrewSchema, FileSchema, ParticipantSchema } from '../src/operations/contracts';
import { operationsFollowupDemoId } from './demo-operations-followup';

const base = 'http://127.0.0.1:3001/api';
const operatorOrigin = 'http://127.0.0.1:3000';
const crewOrigin = 'http://127.0.0.1:3002';
const path = `/deliveries/${operationsFollowupDemoId}`;
const Detail = z.object({ delivery: DeliverySchema, files: z.array(FileSchema), lineServices: z.array(LineServiceStatusSchema) });

async function login(endpoint: string, origin: string, credentials: unknown) {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!response.ok) throw new Error(`Demo login failed (${response.status}); no credentials are printed`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Demo login did not return a session');
  return cookie;
}

function api(cookie: string, origin: string) {
  return async (endpoint: string, body?: unknown, method = 'POST', expectedStatus?: number): Promise<unknown> => {
    const response = await fetch(`${base}${endpoint}`, { method: body === undefined ? 'GET' : method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: unknown = await response.json();
    if (expectedStatus !== undefined ? response.status !== expectedStatus : !response.ok) {
      throw new Error(`Demo API action ${endpoint} failed (${response.status}); existing work was preserved`);
    }
    return value;
  };
}

async function main() {
  if (process.argv.length !== 3 || !['--inspect', '--prepare', '--exercise', '--verify-report'].includes(process.argv[2] ?? '')) throw new Error('Use --inspect, --prepare, --exercise or --verify-report');
  const raw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
  const credentials = z.object({ admin: z.object({ email: z.string(), password: z.string() }), crew: z.object({ login: z.string(), password: z.string() }).optional() }).parse(raw);
  let crewCredentials = credentials.crew;
  if (crewCredentials === undefined) {
    const participantData: unknown = JSON.parse(await readFile('.local/participant-demo-accounts.json', 'utf8'));
    const accounts = z.object({ accounts: z.array(z.object({ id: z.string().uuid(), login: z.string(), password: z.string() })) }).parse(participantData);
    const selected = accounts.accounts.find(({ id }) => id === '20000000-0000-4000-8000-000000000010');
    if (!selected) throw new Error('The existing Matteo demo account is unavailable; no credentials were changed');
    crewCredentials = { login: selected.login, password: selected.password };
  }
  const office = api(await login('/auth/login', operatorOrigin, credentials.admin), operatorOrigin);
  let detail = Detail.parse(await office(path));
  assert.equal(detail.delivery.source.pickingName, 'DEMO/FOLLOWUP/0001');
  if (process.argv[2] === '--verify-report') {
    const results = detail.delivery.appointments.flatMap(({ results }) => results);
    assert.equal(results.length, 1, 'The dedicated demo expects one original signed report');
    const result = results[0]; assert.ok(result);
    assert.equal(result.customerSignature?.status, 'signed'); assert.equal(result.crewSignature?.status, 'signed');
    assert.deepEqual(result.quantities.map(({ sourceLineId, deliveredMilli, installedMilli }) => ({ sourceLineId, deliveredMilli, installedMilli: installedMilli ?? 0 })),
      [{ sourceLineId: 940011, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 940021, deliveredMilli: 1000, installedMilli: 1000 }]);
    assert.equal(detail.delivery.issues.length, 1); assert.equal(detail.delivery.workHolds?.length, 1);
    assert.equal(result.issueLinks?.length, 1); assert.equal(result.issueLinks[0]?.sourceLineId, 940011);
    assert.equal(result.issueLinks[0]?.issueId, detail.delivery.issues[0]?.id);
    assert.ok(result.evidence.some(({ itemIds }) => itemIds.includes(940011)));
    assert.ok(result.evidence.some(({ itemIds }) => itemIds.includes(940021)));
    assert.equal(result.documentSnapshot?.find(({ itemId }) => itemId === 940011)?.documentVersion, 2);
    const first = detail.lineServices.find(({ sourceLineId }) => sourceLineId === 940011);
    const second = detail.lineServices.find(({ sourceLineId }) => sourceLineId === 940021);
    assert.ok(first && second);
    assert.equal(first.remainingDeliveryMilli, 1000); assert.equal(first.remainingInstallationMilli, 2000);
    assert.equal(second.remainingDeliveryMilli, 1000); assert.equal(second.remainingInstallationMilli, 1000);
    assert.equal(second.planningBlockedReason, null);
    const verification = { deliveryId: detail.delivery.id, resultId: result.id, resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
      issueCount: detail.delivery.issues.length, holdCount: detail.delivery.workHolds.length, firstLineReleased: detail.delivery.workHolds[0]?.release !== undefined,
      signedInstructionVersion: 2, latestFirstLineInstructionVersion: Math.max(...detail.files.filter(({ itemId }) => itemId === 940011).map(({ documentVersion }) => documentVersion ?? 0)),
      bothSignaturesPresent: true, photoCount: result.evidence.length, expectedRemainingWorkVerified: true };
    await writeFile('.local/operations-followup-report-verification.json', JSON.stringify(verification, null, 2));
    console.log(JSON.stringify(verification, null, 2)); return;
  }
  if (process.argv[2] === '--inspect' || detail.delivery.appointments.length > 0) {
    console.log(JSON.stringify({ deliveryId: detail.delivery.id, visits: detail.delivery.appointments.map(({ id, status }) => ({ id, status })),
      issues: detail.delivery.issues.map(({ id, itemIds, status }) => ({ id, itemIds, status })), workHolds: detail.delivery.workHolds,
      note: 'Read-only inspection; an existing demo is never reset or replayed.' }, null, 2));
    return;
  }
  const crew = api(await login('/crew/auth/login', crewOrigin, crewCredentials), crewOrigin);
  const participant = CrewProfileSchema.parse(await crew('/crew/auth/me'));
  const people = z.array(ParticipantSchema).parse(await office('/participants'));
  const person = people.find(({ id }) => id === participant.id); assert.ok(person?.enabled);
  const teams = z.array(CrewSchema).parse(await office('/crews'));
  const team = teams.find((candidate) => candidate.enabled && candidate.people.some(({ id }) => id === person.id));
  assert.ok(team, 'Demo account needs an enabled default team');
  const templates = z.array(TaskTemplateSchema.extend({ requiredSkillIds: z.array(z.string()) })).parse(await office('/templates'));
  const template = templates.find((candidate) => candidate.enabled && candidate.requiredSkillIds.every((id) => person.skillIds.includes(id)));
  assert.ok(template, 'Demo participant needs a compatible task template');

  async function document(name: string, itemId: number | null, purpose: 'general' | 'instruction' | 'drawing', text: string, supersedesFileId?: string) {
    detail = Detail.parse(await office(`${path}/files`, { requestId: randomUUID(), kind: 'document', name, itemId, appointmentId: null, issueId: null,
      documentPurpose: purpose, ...(supersedesFileId === undefined ? {} : { supersedesFileId }), base64: Buffer.from(text, 'utf8').toString('base64') }));
    const file = detail.files.find((entry) => entry.name === name); assert.ok(file); return file;
  }
  const firstInstruction = await document('DEMO order 9401 instruction v1.txt', 940011, 'instruction', 'DEMO v1: check order 9401 and protect the floor.');
  const signedInstruction = await document('DEMO order 9401 instruction v2.txt', 940011, 'instruction', 'DEMO v2: inspect all chair legs before unloading. Order 9401 only.', firstInstruction.id);
  await document('DEMO order 9402 drawing.txt', 940021, 'drawing', 'DEMO drawing reference: chair 9402, front left leg A, front right leg B. This is teaching text, not a manufacturer drawing.');
  await document('DEMO general unloading notes.txt', null, 'general', 'DEMO general delivery note. Furniture and signatures in this demonstration are synthetic.');
  detail = Detail.parse(await office(`${path}/appointments`, { version: detail.delivery.version, requestId: randomUUID(),
    startsAt: '2026-11-15T08:00:00Z', endsAt: '2026-11-15T10:00:00Z',
    workLines: [940011, 940021].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 })) }));
  const visit = detail.delivery.appointments.at(-1); assert.ok(visit);
  const appointmentPath = `${path}/appointments/${visit.id}`;
  detail = Detail.parse(await office(`${appointmentPath}/assign`, { version: detail.delivery.version, requestId: randomUUID(), crewIds: [team.id],
    templateIds: [template.id], staffing: [{ crewId: team.id, participantIds: [person.id] }] }));
  detail = Detail.parse(await office(`${appointmentPath}/responsible`, { version: detail.delivery.version, participantId: person.id }, 'PATCH'));
  detail = Detail.parse(await office(`${appointmentPath}/confirm-customer`, { version: detail.delivery.version }));
  const crewPath = `/crew/visits/${visit.id}`;
  let assigned = CrewVisitDetailSchema.parse(await crew(crewPath));
  assert.equal(assigned.documents?.find(({ id }) => id === signedInstruction.id)?.documentVersion, 2);
  assigned = CrewVisitDetailSchema.parse(await crew(`${crewPath}/start`, { version: assigned.version, requestId: randomUUID() }));
  for (const checkpoint of assigned.tasks.flatMap(({ checklist }) => checklist).filter(({ done, waived }) => !done && !waived)) {
    assigned = CrewVisitDetailSchema.parse(await crew(`${crewPath}/checklist/${checkpoint.id}`, { version: assigned.version, requestId: randomUUID(), done: true }, 'PATCH'));
  }
  const syntheticPhoto = (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#334455' } }).png().toBuffer()).toString('base64');
  assigned = CrewVisitDetailSchema.parse(await crew(`${crewPath}/issues`, { version: assigned.version, requestId: randomUUID(), type: 'damage',
    description: 'DEMO order 9401: second chair has a damaged leg. Replacement requires dispatcher readiness confirmation.',
    itemIds: [940011], photo: { name: 'DEMO synthetic damage proof.png', base64: syntheticPhoto } }));
  const issue = assigned.issues?.find(({ itemIds }) => itemIds.includes(940011)); assert.ok(issue);
  if (process.argv[2] === '--prepare') {
    for (const sourceLineId of [940011, 940021]) await writeFile(`.local/DEMO-followup-line-${sourceLineId}.png`, Buffer.from(syntheticPhoto, 'base64'));
    const state = { deliveryId: operationsFollowupDemoId, visitId: visit.id, participantId: person.id, participantName: person.name, crewName: team.name,
      issueId: issue.id, signedInstructionId: signedInstruction.id, sourceLineIds: [940011, 940021],
      note: 'Synthetic demo prepared through authenticated APIs; visit remains in progress for browser reporting. Existing damage Issue should be linked by the first product check.' };
    await writeFile('.local/operations-followup-demo-state.json', JSON.stringify(state, null, 2));
    console.log(JSON.stringify(state, null, 2)); return;
  }
  const report = { version: assigned.version, requestId: randomUUID(), summary: 'DEMO: two separate orders with the same SKU; damage on order 9401 and time shortage on order 9402.',
    quantities: [{ sourceLineId: 940011, deliveredMilli: 1000, installedMilli: 0 }, { sourceLineId: 940021, deliveredMilli: 1000, installedMilli: 1000 }],
    itemChecks: [{ sourceLineId: 940011, status: 'problem', problemType: 'damage', linkedIssueId: issue.id, note: 'DEMO damaged leg; linked to the existing incident.' },
      { sourceLineId: 940021, status: 'ok', note: 'DEMO accepted chair inspected; other identical chair awaits a later visit.' }],
    incompleteWork: [{ sourceLineId: 940011, operation: 'delivery', reason: 'damage', note: 'DEMO replacement chair required.' },
      { sourceLineId: 940011, operation: 'installation', reason: 'missing_goods_or_parts', note: 'DEMO assembly kit unavailable.' },
      { sourceLineId: 940021, operation: 'delivery', reason: 'time_shortage', note: 'DEMO next appointment started; return for the other chair.' },
      { sourceLineId: 940021, operation: 'installation', reason: 'time_shortage', note: 'DEMO only the delivered chair was assembled.' }],
    photos: [940011, 940021].map((sourceLineId) => ({ name: `DEMO synthetic line ${sourceLineId}.png`, sourceLineId, base64: syntheticPhoto })),
    customerSignature: { signerName: 'DEMO Giulia Moretti', strokes: [[{ x: 100, y: 100 }, { x: 200, y: 170 }, { x: 320, y: 110 }]] },
    crewSignature: { strokes: [[{ x: 400, y: 130 }, { x: 510, y: 230 }, { x: 630, y: 140 }]] },
  };
  const finished = CrewVisitDetailSchema.parse(await crew(`${crewPath}/finish`, report));
  assert.deepEqual(CrewVisitDetailSchema.parse(await crew(`${crewPath}/finish`, report)), finished, 'Identical retry must not duplicate the report or issue');
  detail = Detail.parse(await office(path));
  assert.equal(detail.delivery.issues.length, 1); assert.equal(detail.delivery.workHolds?.length, 1);
  assert.equal(detail.lineServices.find(({ sourceLineId }) => sourceLineId === 940011)?.planningBlockedReason, 'damage_hold');
  assert.equal(detail.lineServices.find(({ sourceLineId }) => sourceLineId === 940021)?.planningBlockedReason, null);
  const result = detail.delivery.appointments.find(({ id }) => id === visit.id)?.results[0]; assert.ok(result);
  assert.equal(result.documentSnapshot?.find(({ id }) => id === signedInstruction.id)?.documentVersion, 2);
  await office(`${path}/appointments`, { version: detail.delivery.version, requestId: randomUUID(), startsAt: '2026-11-16T08:00:00Z', endsAt: '2026-11-16T09:00:00Z',
    workLines: [{ sourceLineId: 940011, deliveryMilli: 1000, installationMilli: 2000, collectionMilli: 0 }] }, 'POST', 409);
  await document('DEMO order 9401 instruction v3.txt', 940011, 'instruction', 'DEMO v3: replacement packaging has changed. Use for a future authorized visit only.', signedInstruction.id);
  assert.deepEqual(detail.delivery.appointments.find(({ id }) => id === visit.id)?.results[0], result, 'Later instructions cannot rewrite the signed report');
  const state = { deliveryId: detail.delivery.id, visitId: visit.id, participantId: person.id, issueId: issue.id,
    resultId: result.id, signedInstructionId: signedInstruction.id, heldSourceLineId: 940011, availableSourceLineId: 940021,
    note: 'Synthetic local demonstration. One damage hold deliberately remains for Francesca to release with an explanation in the browser.' };
  await writeFile('.local/operations-followup-demo-state.json', JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Authenticated local demo failed'); process.exitCode = 1; });
