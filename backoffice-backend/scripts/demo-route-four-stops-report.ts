import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { CrewFinishInput, CrewProfileSchema, CrewVisitDetailSchema } from '../src/crew/contracts';
import { DeliverySchema, IdSchema, LineServiceStatusSchema } from '../src/domain/model';
import { AuditSchema } from '../src/operations/contracts';
import { RouteOperationsSchema, RouteReconcileInputSchema } from '../src/routing/lifecycle-contracts';
import { demoSession } from './demo-stage10-report';

const Detail = z.object({ delivery: DeliverySchema, lineServices: z.array(LineServiceStatusSchema), history: z.array(AuditSchema) });
const Logout = z.object({ ok: z.literal(true) });
const reason = 'DEMO customer did not confirm the scheduled appointment. Crew did not attempt a delivery.';

async function run() {
  if (process.env['BACKOFFICE_TEST'] !== '1' || process.env['NODE_ENV'] === 'production') throw new Error('Use the isolated test runtime');
  const smoke = process.argv.includes('--smoke');
  const directory = `.local/four-stops-browser-demo${smoke ? '-smoke' : ''}`;
  const raw: unknown = JSON.parse(await readFile(`${directory}/connection.json`, 'utf8'));
  const manifest = z.object({
    schema: z.string().regex(/^route_four_stops_demo_[a-f0-9]{32}$/), database: z.literal('delivery_backoffice_test'),
    api: z.literal(smoke ? 'http://127.0.0.1:3041/api' : 'http://127.0.0.1:3011/api'),
    frontend: z.literal('http://127.0.0.1:3010'), crewFrontend: z.literal('http://127.0.0.1:3012'),
    operator: z.object({ email: z.email(), password: z.string().min(1) }),
    demos: z.tuple([z.object({ name: z.literal('DEMO · Four stops in Catania'), id: IdSchema, deliveryIds: z.array(IdSchema).length(4),
      crew: z.object({ id: IdSchema, login: z.email(), password: z.string().min(1) }) })]),
  }).parse(raw);
  const [demo] = manifest.demos;
  const operator = demoSession(manifest.api, manifest.frontend, 'backoffice_session');
  const crew = demoSession(manifest.api, manifest.crewFrontend, 'crew_session');
  const { id: ownerUserId } = await operator('/auth/login', z.object({ id: IdSchema }), 'POST', manifest.operator);
  const profile = await crew('/crew/auth/login', CrewProfileSchema, 'POST', { login: demo.crew.login, password: demo.crew.password });
  try {
    const operatorRoute = `/routes/${demo.id}`;
    const crewRoute = `/crew/routes/${demo.id}`;
    let route = await crew(crewRoute, RouteOperationsSchema);
    assert.equal(route.name, demo.name);
    assert.equal(route.status, 'published', 'Use a fresh fixture. Executed routes remain available in History.');
    assert.equal(route.resources.driver.kind, 'none');
    assert.equal(route.routeResponsible.id, demo.crew.id);
    assert.equal(profile.id, demo.crew.id);
    assert.deepEqual(route.stops.map(({ deliveryId }) => deliveryId), demo.deliveryIds);
    assert.equal(new Set(route.stops.map(({ address }) => address)).size, 4);
    assert.deepEqual(route.stops.map(({ confirmationStatus }) => confirmationStatus), [
      'customer_confirmed', 'customer_confirmed', 'customer_confirmed', 'awaiting_customer_confirmation',
    ]);
    const [ordinary, partial, installation, pending] = route.stops;
    assert.ok(ordinary && partial && installation && pending);
    assert.deepEqual(route.lines.map(({ plannedDeliveryMilli, plannedInstallationMilli }) => [plannedDeliveryMilli, plannedInstallationMilli]),
      [[2000, 0], [2000, 0], [0, 2000], [2000, 0]]);
    const prior = await operator(`/deliveries/${installation.deliveryId}`, Detail);
    assert.equal(prior.lineServices[0]?.deliveredMilli, 2000);
    assert.equal(prior.lineServices[0]?.installedMilli, 0);

    route = await crew(`${crewRoute}/depart`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID() });
    assert.equal(route.status, 'in_progress');
    const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#172638"/><text x="32" y="105" fill="white" font-size="36" font-family="sans-serif">DEMO ONLY</text><text x="32" y="170" fill="white" font-size="24" font-family="sans-serif">Synthetic four-stop route evidence</text></svg>');
    const demoPhoto = (await sharp(image).png().toBuffer()).toString('base64');
    for (const [stop, deliveredMilli, installedMilli] of [[ordinary, 2000, 0], [partial, 1000, 0], [installation, 0, 2000]] as const) {
      const endpoint = `/crew/visits/${stop.appointmentId}`;
      let visit = await crew(endpoint, CrewVisitDetailSchema);
      visit = await crew(`${endpoint}/start`, CrewVisitDetailSchema, 'POST', { version: visit.version, requestId: randomUUID() });
      for (const item of visit.tasks.flatMap(({ checklist }) => checklist)) {
        visit = await crew(`${endpoint}/checklist/${item.id}`, CrewVisitDetailSchema, 'PATCH', { version: visit.version, requestId: randomUUID(), done: true });
      }
      const line = visit.workScope?.lines[0];
      assert.ok(line);
      const report = CrewFinishInput.parse({
        version: visit.version, requestId: randomUUID(), summary: `DEMO ONLY · stop ${stop.sequence}, completed delivery ${deliveredMilli / 1000} and installation ${installedMilli / 1000}.`,
        quantities: [{ sourceLineId: line.sourceLineId, deliveredMilli, installedMilli, collectedMilli: 0 }],
        itemChecks: [{ sourceLineId: line.sourceLineId, status: 'ok', note: 'DEMO condition checked for the completed work.' }],
        incompleteWork: stop === partial ? [{ sourceLineId: line.sourceLineId, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'One of the two cabinets remained at the warehouse.' }] : [],
        customerSignature: { signerName: visit.customer.name, strokes: [[{ x: 120, y: 200 }, { x: 180, y: 120 }, { x: 270, y: 210 }]] },
        crewSignature: { strokes: [[{ x: 220, y: 150 }, { x: 300, y: 230 }, { x: 390, y: 130 }]] },
        photos: [{ name: `DEMO-four-stops-${stop.sequence}.png`, base64: demoPhoto, sourceLineId: line.sourceLineId }],
      });
      const finished = await crew(`${endpoint}/finish`, CrewVisitDetailSchema, 'POST', report);
      assert.equal(finished.status, 'completed');
      const detail = await operator(`/deliveries/${stop.deliveryId}`, Detail);
      const evidence = detail.delivery.appointments.find(({ id }) => id === stop.appointmentId)?.results[0];
      assert.ok(evidence?.customerSignature && evidence.crewSignature && evidence.evidence.length === 1);
      assert.ok(detail.history.some(({ action }) => action === 'execution.crew_reported'));
    }

    route = await crew(crewRoute, RouteOperationsSchema);
    assert.equal(route.nextAppointmentId, pending.appointmentId);
    assert.equal(route.stops[3]?.startBlockerCode, 'CUSTOMER_CONFIRMATION_REQUIRED');
    assert.equal(route.stops[3]?.canStart, false);
    const pendingEndpoint = `/crew/visits/${pending.appointmentId}`;
    const pendingVisit = await crew(pendingEndpoint, CrewVisitDetailSchema);
    await assert.rejects(crew(`${pendingEndpoint}/start`, CrewVisitDetailSchema, 'POST', { version: pendingVisit.version, requestId: randomUUID() }),
      /409.*confirm/i);
    route = await operator(`${operatorRoute}/stops/${pending.appointmentId}/skip`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID(), reason });
    assert.ok(route.stops[3]?.skipped && !route.stops[3].reported);
    route = await crew(`${crewRoute}/returning`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID() });
    route = await crew(`${crewRoute}/return`, RouteOperationsSchema, 'POST', {
      version: route.version, requestId: randomUUID(), actualReturnedAt: new Date().toISOString(), note: 'DEMO actual return recorded by the responsible crew participant.',
    });
    const reconciliation = RouteReconcileInputSchema.parse({ version: route.version, requestId: randomUUID(), reason: 'DEMO custody and callbacks reviewed by Francesca.',
      lines: route.lines.map((line) => {
        const undelivered = line.plannedDeliveryMilli - line.deliveredMilli;
        return {
          appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, ownerUserId, note: 'DEMO exact line verified.',
          nextActions: line.remainingDeliveryMilli > 0
            ? [{ operation: 'delivery', action: line.appointmentId === pending.appointmentId ? 'await_customer' : 'ready_for_repeat', ownerUserId, note: 'DEMO do not rebook completed work.' }] : [],
          cargo: undelivered > 0 ? [{ kind: 'undelivered', location: 'warehouse', quantityMilli: undelivered, note: 'DEMO dispatcher verified these goods are at the warehouse.' }] : [],
        };
      }),
    });
    route = await operator(`${operatorRoute}/reconcile`, RouteOperationsSchema, 'POST', reconciliation);
    assert.equal(route.capabilities.canClose, true, route.capabilities.closureBlockers.join('; '));
    route = await operator(`${operatorRoute}/close`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID(), reason: 'DEMO trip closed after return and exact-line reconciliation.' });
    assert.equal(route.status, 'closed');
    const details = await Promise.all(route.stops.map(({ deliveryId }) => operator(`/deliveries/${deliveryId}`, Detail)));
    const outstanding = details.map(({ lineServices }) => [lineServices[0]?.remainingDeliveryMilli, lineServices[0]?.remainingInstallationMilli]);
    assert.deepEqual(outstanding, [[0, 0], [1000, 0], [0, 0], [2000, 0]]);
    assert.ok(details.every(({ delivery }) => !delivery.completedAt), 'Closing the route itself must not complete its Pickings');
    for (const stop of [ordinary, installation]) {
      const detail = await operator(`/deliveries/${stop.deliveryId}`, Detail);
      const closed = await operator(`/deliveries/${stop.deliveryId}/complete`, Detail, 'POST', { version: detail.delivery.version });
      assert.ok(closed.delivery.completedAt);
    }
    const result = {
      schema: manifest.schema, routeId: route.id, status: route.status, driver: route.resources.driver.kind, actualReturnedAt: route.runtime.returned?.actualReturnedAt,
      stops: route.stops.map((stop, index) => ({ sequence: stop.sequence, destination: stop.address, picking: stop.pickingName, deliveryId: stop.deliveryId,
        appointmentId: stop.appointmentId, skipped: stop.skipped, reported: stop.reported, outstanding: outstanding[index] })),
      pendingStartRejected: true, pendingDisposition: 'await_customer', partialDisposition: 'ready_for_repeat',
    };
    await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally {
    await crew('/crew/auth/logout', Logout, 'POST', {});
    await operator('/auth/logout', Logout, 'POST', {});
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Four-stop route demo verification failed');
  process.exitCode = 1;
});
