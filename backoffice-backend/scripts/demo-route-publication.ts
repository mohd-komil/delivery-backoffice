import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, DeliverySchema, IdSchema, TaskTemplateSchema, type Delivery } from '../src/domain/model';
import { Files } from '../src/evidence/files';
import { hashPassword } from '../src/identity/identity';
import { CrewSchema, ParticipantSchema, VehicleSchema } from '../src/operations/contracts';
import { DeliveryStore } from '../src/operations/store';
import { RouteDraftInputSchema } from '../src/routing/contracts';
import { RouteDetailSchema, RoutePreviewSchema } from '../src/routing/http-contracts';
import { PublicationReviewSchema, PublicationSummarySchema } from '../src/routing/publication-contracts';
import { routeJob } from '../src/routing/service';
import { PublicDemoAddressesSchema } from './demo-public-addresses';
import { deliveryViewFilterFixtures } from './demo-delivery-view-filters';

class BrowserDemoDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [], migrations: applicationMigrations,
      synchronize: false, logging: false, extra: { options: `-c search_path=${schema}`, application_name: schema } });
  }
}

class BrowserDemoFiles extends Files {
  override readonly directory: string;
  constructor(store: DeliveryStore, directory: string) { super(store); this.directory = directory; }
}

const DetailSchema = z.object({ delivery: DeliverySchema });
const publicationWorkLines = [
  { sourceLineId: 101, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 },
  { sourceLineId: 102, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0 },
];

/** Dedicated schema/server only. Fresh by default; --resume reloads the manifest's exact owned namespace without reseeding. */
export async function runRouteBrowserDemo(mode: 'publication' | 'lifecycle' | 'acceptance' | 'quantities' | 'refusal' | 'filters' | 'four-stops' = 'publication') {
  if (process.env['NODE_ENV'] === 'production' || process.env['BACKOFFICE_TEST'] !== '1') throw new Error('Use the isolated development test runtime');
  const environment = config();
  if (!environment.ROUTE_PUBLICATION_ENABLED || environment.FRONTEND_ORIGIN !== 'http://127.0.0.1:3010') {
    throw new Error('Browser demo requires publication enabled and its separate loopback frontend on port 3010');
  }
  if (mode !== 'publication' && environment.CREW_FRONTEND_ORIGIN !== 'http://127.0.0.1:3012') throw new Error('Execution demo requires its separate Crew origin on port 3012');
  const smoke = mode === 'four-stops' && process.argv.includes('--smoke');
  const api = smoke ? 'http://127.0.0.1:3041/api' : 'http://127.0.0.1:3011/api';
  const demoDirectory = `.local/${mode}-browser-demo${smoke ? '-smoke' : ''}`;
  const destination = path.resolve(demoDirectory);
  const resume = process.argv.includes('--resume');
  const savedManifest: unknown = resume ? JSON.parse(await readFile(path.join(destination, 'connection.json'), 'utf8')) : null;
  const demoSchema = /^route_(publication|lifecycle|acceptance|quantities|refusal|filters|four_stops)_demo_[a-f0-9]{32}$/;
  const saved = resume ? z.object({ schema: z.string().regex(demoSchema),
    database: z.literal('delivery_backoffice_test'), api: z.literal(api),
    frontend: z.literal('http://127.0.0.1:3010') }).parse(savedManifest) : null;
  const schemaPrefix = `route_${mode.replaceAll('-', '_')}_demo_`;
  const schema = saved?.schema ?? `${schemaPrefix}${randomUUID().replaceAll('-', '')}`;
  if (!demoSchema.test(schema)) throw new Error('Invalid owned schema');
  if (!schema.startsWith(schemaPrefix)) throw new Error('The saved schema does not match this demonstration');
  const control = makeDataSource(true);
  const database = new BrowserDemoDatabase(schema);
  let app: NestExpressApplication | undefined;
  let started = false;
  try {
    await control.initialize();
    await rows(control.manager, z.object({ name: z.literal('delivery_backoffice_test'), port: z.literal(55432) }), 'SELECT current_database() AS name,inet_server_port() AS port');
    if (resume) {
      const matches = await rows(control.manager, z.object({ name: z.string() }), 'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name=$1', [schema]);
      if (matches.length !== 1) throw new Error('The saved demo schema no longer exists; no replacement will be seeded');
    } else await control.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize();
    await database.source.runMigrations({ transaction: 'all' });
    const password = randomBytes(24).toString('base64url');
    const admin = { email: 'admin@publication-demo.example.test', password };
    const operator = { email: 'francesca@publication-demo.example.test', password };
    for (const [role, account] of resume ? [] : [['admin', admin], ['operator', operator]] as const) {
      await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), account.email, role === 'admin' ? 'DEMO Admin' : 'DEMO Francesca', role, await hashPassword(password)]);
    }
    await database.source.destroy();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Database).useValue(database)
      .overrideProvider(Files).useFactory({ factory: (store: DeliveryStore) => new BrowserDemoFiles(store, path.join(destination, schema, 'files')), inject: [DeliveryStore] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(environment.PORT, environment.HOST);
    function retainServer(server: NestExpressApplication) {
      started = true;
      const close = () => { void server.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
    }
    if (resume) {
      retainServer(app);
      console.log(JSON.stringify({ ready: true, resumed: true, schema, credentialsFile: `${demoDirectory}/connection.json` }));
      return;
    }
    const base = `http://127.0.0.1:${environment.PORT}/api`;
    let cookie = '';
    async function request<T>(endpoint: string, reply: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(base + endpoint, { method, headers: { Origin: environment.FRONTEND_ORIGIN,
        'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        const error: unknown = await response.json();
        const message = z.object({ message: z.string() }).safeParse(error);
        throw new Error(`Demo ${method} ${endpoint}: ${response.status} ${message.success ? message.data.message : 'request failed'}`);
      }
      const loginCookie = response.headers.get('set-cookie')?.split(';')[0];
      if (endpoint === '/auth/login' && loginCookie) cookie = loginCookie;
      const raw: unknown = await response.json(); return reply.parse(raw);
    }
    async function bookAndAssign(delivery: Delivery, startsAt: string, endsAt: string, workLines: typeof publicationWorkLines,
      crewId: string, participantId: string, templateId: string) {
      const appointments = `/deliveries/${delivery.id}/appointments`;
      let detail = await request(appointments, DetailSchema, 'POST', { version: delivery.version, requestId: randomUUID(), startsAt, endsAt, workLines });
      const appointment = detail.delivery.appointments[0];
      if (!appointment) throw new Error('Demo booking missing');
      const endpoint = `${appointments}/${appointment.id}`;
      detail = await request(`${endpoint}/assign`, DetailSchema, 'POST', { version: detail.delivery.version, requestId: randomUUID(),
        crewIds: [crewId], templateIds: [templateId], staffing: [{ crewId, participantIds: [participantId] }] });
      detail = await request(`${endpoint}/responsible`, DetailSchema, 'PATCH', { version: detail.delivery.version, participantId });
      detail = await request(`${endpoint}/confirm-customer`, DetailSchema, 'POST', { version: detail.delivery.version });
      return { delivery: detail.delivery, appointmentId: appointment.id };
    }
    await request('/auth/login', z.object({ id: IdSchema }), 'POST', admin);
    const catalogRaw: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
    const addresses = PublicDemoAddressesSchema.parse(catalogRaw).filter(({ city }) => city === 'Catania');
    const fourStops = mode === 'four-stops';
    if (addresses.length < (fourStops ? 4 : 2)) throw new Error('The checked-in Catania address fixtures are unavailable');
    const day = new Date();
    if (mode === 'publication') { day.setUTCDate(day.getUTCDate() + 2); day.setUTCHours(8, 0, 0, 0); }
    else { day.setTime(day.getTime() + (mode === 'acceptance' || fourStops ? -10 : 10) * 60_000); }
    const departAt = day.toISOString();
    const shiftStart = new Date(day.getTime() - 3_600_000).toISOString();
    const shiftEnd = new Date(day.getTime() + 9 * 3_600_000).toISOString();
    const demos: { kind: string; id: string; name: string; deliveryIds: string[]; visitId?: string; reviewBody?: unknown; crew?: { id: string; login: string; password: string }; teamName?: string; taskTitle?: string }[] = [];
    async function insertDelivery(delivery: Delivery) {
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [delivery.id, schema, delivery.source.pickingId, delivery.version, JSON.stringify(delivery)]);
    }
    if (mode === 'filters') {
      for (const delivery of deliveryViewFilterFixtures()) {
        await insertDelivery(delivery);
        demos.push({ kind: 'list-fixture', id: delivery.id, name: delivery.source.pickingName, deliveryIds: [delivery.id] });
      }
    }
    const kinds = mode === 'filters' ? [] : mode === 'acceptance' || mode === 'quantities' || mode === 'refusal' || fourStops ? ['create'] as const : mode === 'lifecycle' ? ['create', 'attach', 'collection'] as const : ['create', 'attach'] as const;
    const pickingGroup = fourStops ? 'ROUTE4' : mode === 'quantities' ? 'CABINETS' : mode === 'refusal' ? 'REFUSAL' : mode === 'acceptance' ? 'STAGE10' : 'PUBLISH';
    const installationStop = 2;
    const pendingStop = 3;
    const fourStopNames = ['DEMO Giulia Rizzo', 'DEMO Davide Russo', 'DEMO Elena Greco', 'DEMO Luca Marino'];
    const checklist = mode === 'refusal' ? ['Check the order number before unloading', 'Check the furniture after handover']
      : ['Check the order number before unloading', 'Photograph the product and check its condition'];
    for (const kind of kinds) {
      const number = kind === 'create' ? 1 : kind === 'attach' ? 2 : 3;
      const crewCredentials = { login: `crew-${number}@route-lifecycle.example.test`, password: randomBytes(24).toString('base64url') };
      const workLines = mode === 'acceptance' ? [101, 102].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 2000, installationMilli: 2000, collectionMilli: 0 }))
        : kind === 'collection' ? [101, 102].map((sourceLineId) => ({ sourceLineId, deliveryMilli: 0, installationMilli: 0, collectionMilli: 1000 }))
        : mode === 'lifecycle' && kind === 'create' ? publicationWorkLines.map((line) => ({ ...line, installationMilli: line.deliveryMilli })) : publicationWorkLines;
      const participant = await request('/participants', ParticipantSchema, 'POST', {
        firstName: kind === 'create' ? 'Marco' : kind === 'attach' ? 'Alessandro' : 'Luca', lastName: 'Rossi DEMO', preferredName: null,
        phoneNumber: '+39 000 000 1111', address: 'Catania · synthetic participant', enabled: true, external: false,
        ...(mode !== 'publication' ? crewCredentials : {}),
      });
      const crew = await request('/crews', CrewSchema, 'POST', { name: `DEMO Publication ${number}`, area: 'Catania', classification: 'outdoor', participantIds: [participant.id], enabled: true });
      const vehicle = await request('/vehicles', VehicleSchema, 'POST', { ownership: 'company', name: `DEMO Route van ${number}`, plate: `DEMO PUB ${number}`,
        providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: 'Synthetic vehicle for the isolated publication demo' });
      const template = await request('/templates', TaskTemplateSchema, 'POST', { title: 'DEMO · Check exact source order and quantity', severity: 'high', order: 0,
        checklist, enabled: true, requiredSkillIds: [] });
      const deliveries: Delivery[] = [];
      for (let index = 0; index < (fourStops ? 4 : mode === 'quantities' ? 1 : 2); index++) {
        const address = addresses[index]; if (!address) throw new Error('Missing demo address');
        const sourceId = number * 100 + index + 1;
        const orderId = sourceId * 10;
        const singleLine = mode === 'quantities' || mode === 'refusal' || fourStops;
        const delivery = createDelivery({ pickingId: sourceId, pickingName: `DEMO/${pickingGroup}/${String(sourceId).padStart(4, '0')}`, saleOrderId: orderId, saleOrderName: `DEMO/SO/${orderId}`,
          salesOrders: (singleLine ? [orderId] : [orderId, orderId + 1]).map((order) => ({ id: order, name: `DEMO/SO/${order}` })), sourceState: 'assigned',
          salesTeam: mode === 'refusal' ? 'Isolated signature review demo' : 'Isolated route publication demo',
          customer: { id: sourceId, name: fourStops ? fourStopNames[index] ?? 'DEMO customer' : index === 0 ? 'DEMO Giulia Rizzo' : 'DEMO Davide Russo', address: address.street, city: address.city, country: 'IT',
            phones: ['+39 000 000 2222'], email: null, contact: 'Fictional customer at a public reference location' },
          items: (singleLine ? [101] : [101, 102]).map((sourceLineId, itemIndex) => ({ sourceLineId, saleOrderId: orderId + itemIndex, productId: 9701, name: singleLine ? 'DEMO Oak cabinet' : 'DEMO Oak chair · same SKU, separate orders', quantity: mode === 'quantities' ? 4 : 2, uom: 'unit',
            description: null, configuration: null, ambient: null, notes: 'Synthetic quantity for publication review', photoUrl: null })),
          serviceType: kind === 'collection' ? 'collection_only'
            : (fourStops ? index === installationStop : mode !== 'publication' && mode !== 'refusal' && kind === 'create') ? 'delivery_installation' : 'delivery_only',
          estimatedMinutes: 60, notes: 'Dedicated test-schema demonstration; no customer database or Google API.' }, randomUUID());
        delivery.routePoint = address.point;
        await insertDelivery(delivery);
        deliveries.push(delivery);
      }
      if (fourStops) {
        await request('/auth/login', z.object({ id: IdSchema }), 'POST', operator);
        const delivery = deliveries[installationStop];
        if (!delivery) throw new Error('Missing installation-only follow-up delivery');
        const prior = await request(`/deliveries/${delivery.id}/prior-work`, DetailSchema, 'PATCH', {
          version: delivery.version, requestId: randomUUID(), sourceLineId: 101, deliveredMilli: 2000, installedMilli: 0, collectedMilli: 0,
          sourceReference: 'DEMO signed dispatch record R4-103', reason: 'Francesca verified both cabinets were previously delivered. The customer now needs installation only.',
          acknowledgeCurrentPicking: true,
        });
        deliveries[installationStop] = prior.delivery;
      }
      if (mode === 'quantities') {
        const [delivery] = deliveries;
        if (!delivery) throw new Error('Missing cabinet delivery');
        demos.push({ kind, id: delivery.id, name: delivery.source.pickingName, deliveryIds: [delivery.id],
          crew: { id: participant.id, ...crewCredentials }, teamName: crew.name, taskTitle: template.title });
        continue;
      }
      if (mode === 'refusal') {
        for (const [index, delivery] of deliveries.entries()) {
          const startsAt = new Date(Date.now() - (4 - index * 2) * 3_600_000);
          const endsAt = new Date(startsAt.getTime() + 3_600_000);
          const { appointmentId } = await bookAndAssign(delivery, startsAt.toISOString(), endsAt.toISOString(),
            [{ sourceLineId: 101, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 }], crew.id, participant.id, template.id);
          demos.push({ kind: index === 0 ? 'photo' : 'no-photo', id: delivery.id, name: delivery.source.pickingName,
            deliveryIds: [delivery.id], visitId: appointmentId, crew: { id: participant.id, ...crewCredentials }, teamName: crew.name, taskTitle: template.title });
        }
        continue;
      }
      const draft = RouteDraftInputSchema.parse({ name: fourStops ? 'DEMO · Four stops in Catania' : mode === 'acceptance' ? 'DEMO Stage 10 · Partial delivery and Customer absent' : kind === 'collection' ? 'DEMO · Collection and warehouse receipt' : kind === 'create' ? 'DEMO · Publish two new visits' : 'DEMO · Attach confirmed visit and create next stop',
        departAt, crewId: crew.id, vehicleId: vehicle.id, startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', manualEstimates: [], useLocalEstimates: true,
        stops: deliveries.map((delivery) => ({ deliveryId: delivery.id, workMinutes: 30, workDurationSource: 'manual', workFingerprint: routeJob(delivery).workFingerprint, customerWindow: { kind: 'unrestricted' } })),
        planning: { participantIds: [participant.id], participantAvailability: [{ participantId: participant.id, workingIntervals: [{ startsAt: shiftStart, endsAt: shiftEnd }], unavailableIntervals: [] }],
          vehicleAvailability: null, driver: fourStops ? { kind: 'none' } : { kind: 'participant', participantId: participant.id }, transferBufferMinutes: 10 },
      });
      let attachedAppointmentId: string | undefined;
      if (kind === 'attach') {
        const first = deliveries[0]; const firstStop = draft.stops[0];
        if (!first || !firstStop) throw new Error('Missing first demo stop');
        const preview = await request('/routes/preview', RoutePreviewSchema, 'POST', draft);
        const service = preview.timeline.stops[0];
        if (!service?.workStartAt || !service.workEndAt) throw new Error('Demo work interval is incomplete');
        const booked = await bookAndAssign(first, service.workStartAt, service.workEndAt, workLines, crew.id, participant.id, template.id);
        attachedAppointmentId = booked.appointmentId;
        deliveries[0] = booked.delivery;
        firstStop.appointmentId = booked.appointmentId;
        firstStop.workFingerprint = routeJob(booked.delivery, undefined, booked.appointmentId).workFingerprint;
      }
      const saved = await request('/routes', RouteDetailSchema, 'POST', { ...draft, requestId: randomUUID() });
      const reviewBody = { version: saved.version, stops: deliveries.map((delivery, index) => kind === 'attach' && index === 0
        ? { mode: 'attach', deliveryId: delivery.id, appointmentId: attachedAppointmentId, responsibleParticipantId: participant.id }
        : { mode: 'create', deliveryId: delivery.id,
          workLines: fourStops ? [{ sourceLineId: 101, deliveryMilli: index === installationStop ? 0 : 2000,
            installationMilli: index === installationStop ? 2000 : 0, collectionMilli: 0 }] : workLines,
          templateIds: [template.id], responsibleParticipantId: participant.id }) };
      const review = await request(`/routes/${saved.id}/publication-review`, PublicationReviewSchema, 'POST', reviewBody);
      if (review.feasibility.status !== 'feasible_estimate') throw new Error(`Demo review needs work: ${review.feasibility.findings.map(({ code }) => code).join(', ')}`);
      if (mode !== 'publication') {
        const publication = await request(`/routes/${saved.id}/publish`, PublicationSummarySchema, 'POST', {
          ...reviewBody, requestId: randomUUID(), fingerprint: review.fingerprint, acknowledgeEstimates: true,
        });
        if (!publication.stops.length) throw new Error('Demo publication has no first stop');
        const confirmedStops = publication.stops.slice(0, fourStops ? pendingStop : 1);
        for (const stop of confirmedStops) {
          const current = await request(`/deliveries/${stop.deliveryId}`, DetailSchema);
          if (!current.delivery.appointments.find(({ id }) => id === stop.appointmentId)?.customerConfirmation) {
            await request(`/deliveries/${stop.deliveryId}/appointments/${stop.appointmentId}/confirm-customer`, DetailSchema, 'POST', { version: current.delivery.version });
          }
        }
      }
      demos.push({ kind, id: saved.id, name: saved.name, deliveryIds: deliveries.map(({ id }) => id), reviewBody,
        ...(mode !== 'publication' ? { crew: { id: participant.id, ...crewCredentials } } : {}) });
    }
    await request('/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
    await mkdir(destination, { recursive: true });
    const manifest = { schema, database: 'delivery_backoffice_test', createdAt: new Date().toISOString(),
      api, frontend: environment.FRONTEND_ORIGIN, ...(mode !== 'publication' ? { crewFrontend: environment.CREW_FRONTEND_ORIGIN, admin } : {}), operator, demos,
      note: 'Writes are limited to this owned schema. Shared application data is untouched. Schema and files remain after server shutdown for inspection.' };
    await writeFile(path.join(destination, 'connection.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    retainServer(app);
    console.log(JSON.stringify({ ready: true, schema, routes: demos.map(({ kind, id, name }) => ({ kind, id, name })), credentialsFile: `${demoDirectory}/connection.json` }));
  } finally {
    if (control.isInitialized) await control.destroy();
    if (!started) {
      if (app) await app.close();
      else if (database.source.isInitialized) await database.source.destroy();
    }
  }
}

if (require.main === module) void runRouteBrowserDemo(process.argv.includes('--four-stops') ? 'four-stops' : process.argv.includes('--filters') ? 'filters'
  : process.argv.includes('--refusal') ? 'refusal' : process.argv.includes('--quantities') ? 'quantities' : 'publication')
  .catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Browser demo failed'); process.exitCode = 1; });
