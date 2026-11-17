import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { CrewFinishInput, CrewProfileSchema, CrewVisitDetailSchema } from '../src/crew/contracts';
import { DeliverySchema, IdSchema, LineServiceStatusSchema, type WorkLineInput } from '../src/domain/model';
import { AuditSchema } from '../src/operations/contracts';
import { RouteDetailSchema } from '../src/routing/http-contracts';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';
import { PublicationReviewSchema, PublicationSummarySchema } from '../src/routing/publication-contracts';
import { routeJob } from '../src/routing/service';

const directory = '.local/acceptance-browser-demo';
const Manifest = z.object({
  schema: z.string().regex(/^route_acceptance_demo_[a-f0-9]{32}$/), database: z.literal('delivery_backoffice_test'),
  api: z.literal('http://127.0.0.1:3011/api'), frontend: z.literal('http://127.0.0.1:3010'), crewFrontend: z.literal('http://127.0.0.1:3012'),
  operator: z.object({ email: z.email(), password: z.string().min(1) }),
  demos: z.array(z.object({ id: IdSchema, name: z.string(), deliveryIds: z.array(IdSchema),
    crew: z.object({ id: IdSchema, login: z.email(), password: z.string().min(1) }) })).length(1),
});
const Detail = z.object({ delivery: DeliverySchema, lineServices: z.array(LineServiceStatusSchema), history: z.array(AuditSchema) });

export function demoSession(base: string, origin: string, name: 'backoffice_session' | 'crew_session') {
  let cookie = '';
  return async function request<T>(endpoint: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(base + endpoint, { method, redirect: 'error', cache: 'no-store',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const raw: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ message: z.string(), code: z.string().optional() }).safeParse(raw);
      throw new Error(`Demo ${method} ${endpoint}: ${response.status} ${error.success ? error.data.message : 'Request failed'}`);
    }
    const next = response.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value?.startsWith(`${name}=`));
    if (next) cookie = next;
    return schema.parse(raw);
  };
}

async function run() {
  if (process.env['BACKOFFICE_TEST'] !== '1' || process.env['NODE_ENV'] === 'production') throw new Error('Use the isolated test runtime');
  const raw: unknown = JSON.parse(await readFile(`${directory}/connection.json`, 'utf8'));
  const manifest = Manifest.parse(raw);
  const demo = manifest.demos[0]; assert.ok(demo);
  const operator = demoSession(manifest.api, manifest.frontend, 'backoffice_session');
  const crew = demoSession(manifest.api, manifest.crewFrontend, 'crew_session');
  await operator('/auth/login', z.object({ id: IdSchema }), 'POST', manifest.operator);
  await crew('/crew/auth/login', CrewProfileSchema, 'POST', { login: demo.crew.login, password: demo.crew.password });
  try {
    let route = await crew(`/crew/routes/${demo.id}`, RouteOperationsSchema);
    assert.equal(route.name, 'DEMO Stage 10 · Partial delivery and Customer absent');
    assert.equal(route.status, 'published', 'Use a fresh demo namespace; completed scenarios are preserved for inspection');
    assert.equal(route.stops.length, 2);
    assert.deepEqual(route.stops.map(({ deliveryId }) => deliveryId), demo.deliveryIds);
    const [stopA, stopB] = route.stops; assert.ok(stopA && stopB);
    const first = await operator(`/deliveries/${stopA.deliveryId}`, Detail);
    const second = await operator(`/deliveries/${stopB.deliveryId}`, Detail);
    assert.notEqual(first.delivery.source.pickingId, second.delivery.source.pickingId);
    assert.notEqual(first.delivery.source.customer.address, second.delivery.source.customer.address);
    assert.ok([...first.delivery.source.items, ...second.delivery.source.items].every(({ productId }) => productId === 9701));
    assert.equal(route.lines.length, 4);
    assert.ok(route.lines.every((line) => line.plannedDeliveryMilli === 2000 && line.plannedInstallationMilli === 2000));

    for (const stop of route.stops) {
      const detail = await operator(`/deliveries/${stop.deliveryId}`, Detail);
      if (!detail.delivery.appointments.find(({ id }) => id === stop.appointmentId)?.customerConfirmation) {
        await operator(`/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}/confirm-customer`, Detail, 'POST', { version: detail.delivery.version });
      }
    }
    route = await crew(`/crew/routes/${demo.id}/depart`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID() });
    let visit = await crew(`/crew/visits/${stopA.appointmentId}`, CrewVisitDetailSchema);
    visit = await crew(`/crew/visits/${visit.id}/start`, CrewVisitDetailSchema, 'POST', { version: visit.version, requestId: randomUUID() });
    for (const item of visit.tasks.flatMap(({ checklist }) => checklist)) {
      visit = await crew(`/crew/visits/${visit.id}/checklist/${item.id}`, CrewVisitDetailSchema, 'PATCH', { version: visit.version, requestId: randomUUID(), done: true });
    }
    const photos = await Promise.all([101, 102].map(async (sourceLineId) => {
      const drawing = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#172638"/><text x="32" y="90" fill="white" font-size="32" font-family="sans-serif">DEMO ONLY - Stage 10</text><text x="32" y="150" fill="white" font-size="24" font-family="sans-serif">Picking 0101 / line ${sourceLineId}</text><text x="32" y="210" fill="white" font-size="20" font-family="sans-serif">Synthetic photo, not real delivery evidence</text></svg>`);
      return { name: `DEMO-stage10-line-${sourceLineId}.png`, base64: (await sharp(drawing).png().toBuffer()).toString('base64'), sourceLineId };
    }));
    const report = CrewFinishInput.parse({ version: visit.version, requestId: randomUUID(),
      summary: 'DEMO Stage 10: partial handover. Order 1010 delivered 2, installed 1. Order 1011 delivered 1, installed 0. Synthetic evidence and signature drawings.',
      quantities: [{ sourceLineId: 101, deliveredMilli: 2000, installedMilli: 1000, collectedMilli: 0 }, { sourceLineId: 102, deliveredMilli: 1000, installedMilli: 0, collectedMilli: 0 }],
      itemChecks: [101, 102].map((sourceLineId) => ({ sourceLineId, status: 'ok', note: `DEMO exact order line ${sourceLineId} checked separately.` })),
      incompleteWork: [{ sourceLineId: 101, operation: 'installation', reason: 'time_shortage', note: 'DEMO: one chair needs installation only.' },
        { sourceLineId: 102, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'DEMO: the second chair stayed at the warehouse.' },
        { sourceLineId: 102, operation: 'installation', reason: 'time_shortage', note: 'DEMO: both installations remain.' }],
      customerSignature: { signerName: 'DEMO Giulia Rizzo', strokes: [[{ x: 120, y: 200 }, { x: 180, y: 120 }, { x: 270, y: 210 }]] },
      crewSignature: { strokes: [[{ x: 220, y: 150 }, { x: 300, y: 230 }, { x: 390, y: 130 }]] }, photos,
    });
    // Discard the first success response to model an ambiguous network outcome, then replay the same command.
    await crew(`/crew/visits/${visit.id}/finish`, CrewVisitDetailSchema, 'POST', report);
    const partialBeforeReplay = await operator(`/deliveries/${stopA.deliveryId}`, Detail);
    await crew(`/crew/visits/${visit.id}/finish`, CrewVisitDetailSchema, 'POST', report);
    assert.deepEqual(await operator(`/deliveries/${stopA.deliveryId}`, Detail), partialBeforeReplay);
    const partial = partialBeforeReplay;
    assert.deepEqual(partial.lineServices.map(({ sourceLineId, deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli }) =>
      [sourceLineId, deliveredMilli, installedMilli, remainingDeliveryMilli, remainingInstallationMilli]), [[101, 2000, 1000, 0, 1000], [102, 1000, 0, 1000, 2000]]);
    const originalReport = partial.delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0]; assert.ok(originalReport);
    assert.equal(originalReport.evidence.length, 2);
    assert.ok(originalReport.customerSignature && originalReport.crewSignature);
    assert.equal(partial.history.filter(({ action }) => action === 'execution.crew_reported').length, 1);

    let absent = await crew(`/crew/visits/${stopB.appointmentId}`, CrewVisitDetailSchema);
    absent = await crew(`/crew/visits/${absent.id}/start`, CrewVisitDetailSchema, 'POST', { version: absent.version, requestId: randomUUID() });
    const failure = { version: absent.version, requestId: randomUUID(), reason: 'DEMO Customer absent: nobody answered the door or phone. Nothing handed over; all work remains for another appointment.' };
    await crew(`/crew/visits/${absent.id}/attempt-failure`, CrewVisitDetailSchema, 'POST', failure);
    const absentBeforeReplay = await operator(`/deliveries/${stopB.deliveryId}`, Detail);
    await crew(`/crew/visits/${absent.id}/attempt-failure`, CrewVisitDetailSchema, 'POST', failure);
    assert.deepEqual(await operator(`/deliveries/${stopB.deliveryId}`, Detail), absentBeforeReplay);
    const failed = absentBeforeReplay.delivery.appointments.find(({ id }) => id === stopB.appointmentId); assert.ok(failed);
    assert.equal(failed.status, 'failed'); assert.deepEqual(failed.results, []);
    assert.equal(failed.failedAttempt?.reason, failure.reason);
    assert.equal(absentBeforeReplay.history.filter(({ action }) => action === 'execution.customer_absent').length, 1);
    assert.deepEqual(absentBeforeReplay.lineServices.map(({ remainingDeliveryMilli, remainingInstallationMilli }) =>
      [remainingDeliveryMilli, remainingInstallationMilli]), [[2000, 2000], [2000, 2000]]);

    route = await crew(`/crew/routes/${demo.id}`, RouteOperationsSchema);
    route = await crew(`/crew/routes/${demo.id}/returning`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID() });
    route = await crew(`/crew/routes/${demo.id}/return`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'DEMO physical return recorded independently of reports.' });
    const [owner] = await operator('/routes/reconciliation-owners', z.array(z.object({ id: IdSchema }))); assert.ok(owner);
    route = await operator(`/routes/${demo.id}/reconcile`, RouteOperationsSchema, 'POST', {
      version: route.version, requestId: randomUUID(), reason: 'DEMO dispatcher independently verified remaining work and warehouse custody.',
      lines: route.lines.map((line) => ({ appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId: owner.id, note: 'DEMO exact order line reconciliation.',
        nextActions: [...(line.remainingDeliveryMilli ? [{ operation: 'delivery', action: 'ready_for_repeat', ownerUserId: owner.id, note: 'DEMO plan remaining delivery.' }] : []),
          ...(line.remainingInstallationMilli ? [{ operation: 'installation', action: 'installation_visit', ownerUserId: owner.id, note: 'DEMO plan remaining installation.' }] : [])],
        cargo: line.plannedDeliveryMilli > line.deliveredMilli ? [{ kind: 'undelivered', location: 'warehouse', quantityMilli: line.plannedDeliveryMilli - line.deliveredMilli,
          note: 'DEMO explicit dispatcher custody check: these undelivered chairs are at the warehouse.' }] : [],
      })),
    });
    route = await operator(`/routes/${demo.id}/close`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID(), reason: 'DEMO trip ended; unfinished Picking work stays open.' });
    assert.equal(route.status, 'closed');
    assert.equal((await operator(`/deliveries/${stopA.deliveryId}`, Detail)).delivery.completedAt, null);
    assert.equal((await operator(`/deliveries/${stopB.deliveryId}`, Detail)).delivery.completedAt, null);

    const remaining: WorkLineInput[][] = [
      [{ sourceLineId: 101, deliveryMilli: 0, installationMilli: 1000, collectionMilli: 0 }, { sourceLineId: 102, deliveryMilli: 1000, installationMilli: 2000, collectionMilli: 0 }],
      [101, 102].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 })),
    ];
    const details = await Promise.all(route.stops.map(({ deliveryId }) => operator(`/deliveries/${deliveryId}`, Detail)));
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(8, 0, 0, 0);
    const departAt = tomorrow.toISOString();
    const planning = route.draft.planning; assert.ok(planning);
    const draft = await operator('/routes', RouteDetailSchema, 'POST', { ...route.draft, requestId: randomUUID(), name: 'DEMO Stage 10 · Repeat ONLY remaining work', departAt,
      stops: details.map(({ delivery }) => ({ deliveryId: delivery.id, workMinutes: 45, workDurationSource: 'manual', workFingerprint: routeJob(delivery).workFingerprint, customerWindow: { kind: 'unrestricted' } })),
      planning: { ...planning, participantAvailability: planning.participantIds.map((participantId) => ({ participantId,
        workingIntervals: [{ startsAt: new Date(tomorrow.getTime() - 3_600_000).toISOString(), endsAt: new Date(tomorrow.getTime() + 8 * 3_600_000).toISOString() }], unavailableIntervals: [] })) },
    });
    const reviewInput = { version: draft.version, stops: details.map(({ delivery }, index) => {
      const previous = delivery.appointments.find(({ id }) => id === route.stops[index]?.appointmentId); assert.ok(previous);
      const templateIds = [...new Set(previous.assignments.flatMap(({ tasks }) => tasks.map(({ templateId }) => templateId)))];
      assert.ok(templateIds.length > 0, 'Repeat visits preserve the checked task templates');
      return { mode: 'create', deliveryId: delivery.id, responsibleParticipantId: demo.crew.id, templateIds, workLines: remaining[index] };
    }) };
    const review = await operator(`/routes/${draft.id}/publication-review`, PublicationReviewSchema, 'POST', reviewInput);
    assert.equal(review.feasibility.status, 'feasible_estimate', JSON.stringify(review.feasibility.findings));
    await operator(`/routes/${draft.id}/publish`, PublicationSummarySchema, 'POST', { ...reviewInput, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true });
    const followUp = await crew(`/crew/routes/${draft.id}`, RouteOperationsSchema);
    for (const [index, stop] of followUp.stops.entries()) {
      assert.deepEqual(stop.workScope?.lines.map(({ sourceLineId, deliveryMilli, installationMilli, collectionMilli }) =>
        ({ sourceLineId, deliveryMilli, installationMilli, collectionMilli })), remaining[index]);
    }
    assert.deepEqual((await operator(`/deliveries/${stopA.deliveryId}`, Detail)).delivery.appointments.find(({ id }) => id === stopA.appointmentId)?.results[0], originalReport);
    assert.deepEqual((await operator(`/deliveries/${stopB.deliveryId}`, Detail)).delivery.appointments.find(({ id }) => id === stopB.appointmentId), failed);
    const result = { schema: manifest.schema, database: manifest.database, checkedAt: new Date().toISOString(), routeId: route.id, routeStatus: route.status,
      followUpRouteId: followUp.id, followUpStatus: followUp.status, customerAbsentReason: failure.reason,
      deliveries: details.map(({ delivery }, index) => ({ id: delivery.id, picking: delivery.source.pickingName, customer: delivery.source.customer.name,
        originalVisitId: route.stops[index]?.appointmentId, followUpVisitId: followUp.stops[index]?.appointmentId, remainingWork: remaining[index] })),
      verified: ['Distinct Picking/order/line identity', 'Partial report with per-line photos and two DEMO signatures', 'Customer absent without signatures',
        'Same-command replay does not duplicate either result', 'Actual return and independent dispatcher reconciliation', 'Route closure keeps unfinished Pickings open',
        'Published follow-up reserves only exact remaining operations', 'Original reports and absence history unchanged'],
      limitations: ['Synthetic data and evidence', 'Follow-up remains published for hands-on review; its completion is exercised separately in the PostgreSQL regression',
        'No real-phone or physical network test; response-loss replay is simulated', 'Travel times are labelled estimates'],
    };
    await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally {
    await crew('/crew/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
    await operator('/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
  }
}

if (require.main === module) void run().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Stage 10 report verification failed'); process.exitCode = 1; });
