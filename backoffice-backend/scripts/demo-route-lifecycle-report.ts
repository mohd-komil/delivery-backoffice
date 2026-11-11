import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { CrewFinishInput, CrewProfileSchema, CrewVisitDetailSchema } from '../src/crew/contracts';
import { DeliverySchema, IdSchema } from '../src/domain/model';
import { RouteOperationsSchema } from '../src/routing/lifecycle-contracts';

const manifestSchema = z.object({
  schema: z.string().regex(/^route_lifecycle_demo_[a-f0-9]{32}$/), database: z.literal('delivery_backoffice_test'),
  api: z.literal('http://127.0.0.1:3011/api'), frontend: z.literal('http://127.0.0.1:3010'), crewFrontend: z.literal('http://127.0.0.1:3012'),
  operator: z.object({ email: z.email(), password: z.string().min(1) }),
  demos: z.array(z.object({ kind: z.string(), id: IdSchema, name: z.string(), deliveryIds: z.array(IdSchema),
    crew: z.object({ id: IdSchema, login: z.email(), password: z.string().min(1) }).optional() })),
});
const deliveryDetail = z.object({ delivery: DeliverySchema });

function session(base: string, origin: string, cookieName: 'crew_session' | 'backoffice_session') {
  let cookie = '';
  return async function request<T>(endpoint: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(base + endpoint, { method, redirect: 'error', cache: 'no-store',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Isolated collection demo: ${method} ${endpoint} returned ${response.status}`);
    const nextCookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value?.startsWith(`${cookieName}=`));
    if (nextCookie) cookie = nextCookie;
    const raw: unknown = await response.json();
    return schema.parse(raw);
  };
}

async function run() {
  if (process.env['BACKOFFICE_TEST'] !== '1' || process.env['NODE_ENV'] === 'production') throw new Error('Use the explicitly isolated development test stand');
  const raw: unknown = JSON.parse(await readFile('.local/lifecycle-browser-demo/connection.json', 'utf8'));
  const manifest = manifestSchema.parse(raw);
  const demo = manifest.demos.find(({ kind }) => kind === 'collection');
  if (!demo?.crew) throw new Error('The owned collection demo and Crew account are required');
  const operator = session(manifest.api, manifest.frontend, 'backoffice_session');
  const crew = session(manifest.api, manifest.crewFrontend, 'crew_session');
  await operator('/auth/login', z.object({ id: IdSchema }), 'POST', manifest.operator);
  try {
    const profile = await crew('/crew/auth/login', CrewProfileSchema, 'POST', { login: demo.crew.login, password: demo.crew.password });
    if (profile.id !== demo.crew.id) throw new Error('The authenticated participant does not match the owned fixture');
    let route = await crew(`/crew/routes/${demo.id}`, RouteOperationsSchema);
    if (route.name !== demo.name || route.stops.length !== 2 || route.stops.some(({ deliveryId }) => !demo.deliveryIds.includes(deliveryId))) {
      throw new Error('The route is not the exact two-stop collection fixture');
    }
    if (route.lines.some((line) => line.plannedCollectionMilli !== 1000 || line.plannedDeliveryMilli !== 0 || line.plannedInstallationMilli !== 0)) {
      throw new Error('The fixture must contain only one collected unit for each exact source line');
    }
    const demoImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#172638"/><text x="32" y="105" fill="#ffffff" font-size="36" font-family="sans-serif">DEMO COLLECTION</text><text x="32" y="165" fill="#b7ccdf" font-size="25" font-family="sans-serif">Synthetic training photo</text><text x="32" y="220" fill="#b7ccdf" font-size="22" font-family="sans-serif">Not evidence of a real delivery</text></svg>');
    const photo = (await sharp(demoImage).png().toBuffer()).toString('base64');
    const completed: string[] = [];
    for (const stop of route.stops) {
      let visit = await crew(`/crew/visits/${stop.appointmentId}`, CrewVisitDetailSchema);
      if (visit.status === 'completed') { completed.push(visit.id); continue; }
      if (visit.status !== 'booked' && visit.status !== 'in_progress') throw new Error('The collection stop is no longer eligible for this fixture');
      if (visit.confirmationStatus !== 'customer_confirmed') {
        const detail = await operator(`/deliveries/${stop.deliveryId}`, deliveryDetail);
        await operator(`/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}/confirm-customer`, deliveryDetail, 'POST', { version: detail.delivery.version });
      }
      if (route.status === 'published') route = await crew(`/crew/routes/${demo.id}/depart`, RouteOperationsSchema, 'POST', { version: route.version, requestId: randomUUID() });
      if (route.status !== 'in_progress') throw new Error('The route must remain on the road until the browser return check');
      visit = await crew(`/crew/visits/${stop.appointmentId}`, CrewVisitDetailSchema);
      if (visit.status === 'booked') visit = await crew(`/crew/visits/${visit.id}/start`, CrewVisitDetailSchema, 'POST', { version: visit.version, requestId: randomUUID() });
      for (const item of visit.tasks.flatMap(({ checklist }) => checklist)) {
        if (!item.done && !item.waived) visit = await crew(`/crew/visits/${visit.id}/checklist/${item.id}`, CrewVisitDetailSchema, 'PATCH', {
          version: visit.version, requestId: randomUUID(), done: true,
        });
      }
      const work = visit.workScope?.lines;
      if (!work?.length || !visit.canFinish || visit.responsibleParticipant?.id !== profile.id) throw new Error('The assigned responsible participant must have a current collection scope');
      const report = CrewFinishInput.parse({ version: visit.version, requestId: randomUUID(), summary: 'DEMO ONLY: synthetic collection report, photos and signature drawings for route-return acceptance.',
        quantities: work.map(({ sourceLineId }) => ({ sourceLineId, deliveredMilli: 0, installedMilli: 0, collectedMilli: 1000 })),
        itemChecks: work.map(({ sourceLineId }) => ({ sourceLineId, status: 'ok', note: 'DEMO synthetic collection condition check.' })),
        customerSignature: { signerName: `DEMO ${visit.customer.name}`, strokes: [[{ x: 120, y: 260 }, { x: 200, y: 180 }, { x: 290, y: 265 }]] },
        crewSignature: { strokes: [[{ x: 410, y: 145 }, { x: 460, y: 220 }, { x: 540, y: 160 }]] },
        photos: work.map(({ sourceLineId }) => ({ name: `DEMO-collection-${sourceLineId}.png`, base64: photo, sourceLineId })),
      } satisfies z.input<typeof CrewFinishInput>);
      visit = await crew(`/crew/visits/${visit.id}/finish`, CrewVisitDetailSchema, 'POST', report);
      if (visit.status !== 'completed') throw new Error('The synthetic collection report did not finish its stop');
      completed.push(visit.id);
      route = await crew(`/crew/routes/${demo.id}`, RouteOperationsSchema);
    }
    route = await crew(`/crew/routes/${demo.id}`, RouteOperationsSchema);
    if (route.status !== 'in_progress' || !route.capabilities.canReturn || route.runtime.returned || route.runtime.warehouseReceipts.length
      || route.lines.some((line) => line.collectedMilli !== 1000 || line.reportMissing || line.warehouseReceivedCollectionMilli !== 0)) {
      throw new Error('The collection fixture is not ready for independent return and warehouse acceptance');
    }
    console.log(JSON.stringify({ schema: manifest.schema, routeId: route.id, status: route.status, completedVisits: completed,
      collectionLineCount: route.lines.length, collectedUnitsPerLine: 1, actualReturnRecorded: false, warehouseReceiptRecorded: false }));
    await crew('/crew/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
  } finally {
    await operator('/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
  }
}

void run().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Collection demo failed'); process.exitCode = 1; });
