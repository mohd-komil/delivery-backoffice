import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { destinationAddressKey } from '../src/domain/destination-address';
import { createDelivery, DeliverySchema, IdSchema, TaskTemplateSchema, type Delivery } from '../src/domain/model';
import { CrewSchema, ParticipantSchema, VehicleSchema } from '../src/operations/contracts';
import { RouteDraftInputSchema, type RouteDraftInput } from '../src/routing/contracts';
import { calculateRouteTimeline } from '../src/routing/calculation';
import { getLocalDemoRouteEstimates, routeDepots } from '../src/routing/demo-estimates';
import { RouteDetailSchema, RoutePreviewSchema, RouteSuggestionSchema } from '../src/routing/http-contracts';
import { routeJob } from '../src/routing/service';
import { PublicDemoAddressesSchema } from './demo-public-addresses';

const sourceInstance = 'route_feasibility_demo';
const draftId = 'b15b5395-8a73-4a52-9289-950000000099';
const fixtureIds = ['b15b5395-8a73-4a52-9289-950000000001', 'b15b5395-8a73-4a52-9289-950000000002', 'b15b5395-8a73-4a52-9289-950000000003'];
const departAt = '2026-11-16T08:00:00Z';
const DetailSchema = z.object({ delivery: DeliverySchema });

export function routeFeasibilityFixtures(catalog: unknown): { sourceId: number; delivery: Delivery }[] {
  const addresses = PublicDemoAddressesSchema.parse(catalog);
  return [9, 7, 3].map((referenceId, index) => {
    const address = addresses.find(({ customerId }) => customerId === referenceId);
    const id = fixtureIds[index];
    if (!address || !id) throw new Error('Route demo public reference is missing');
    const orderId = 9501 + index;
    const customer = { id: orderId, name: ['DEMO Giulia Rizzo', 'DEMO Lorenzo Greco', 'DEMO Chiara Russo'][index] ?? 'DEMO route customer',
      address: address.street, city: address.city, country: 'IT', phones: [`+39 000 000 ${orderId}`], email: null, contact: 'Fictional route demonstration customer' };
    const delivery = createDelivery({ pickingId: 95001 + index, pickingName: `DEMO/ROUTE/000${index + 1}`, saleOrderId: orderId, saleOrderName: `DEMO/ROUTE/SO/${orderId}`,
      salesOrders: [{ id: orderId, name: `DEMO/ROUTE/SO/${orderId}` }], sourceState: 'assigned', salesTeam: 'DEMO route feasibility', customer,
      items: [{ sourceLineId: 950011 + index * 10, saleOrderId: orderId, productId: 9501, name: 'DEMO Oak chair (ROUTE-CHAIR)', quantity: 2, uom: 'unit',
        description: 'Identical demo SKU on separate source orders', configuration: null, ambient: null, notes: 'Verify the order and source line before unloading.', photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: [30, 45, 20][index] ?? 30,
      notes: `Synthetic teaching fixture; not imported from Odoo. Public reference ${address.venue}; building coordinates, not a verified unloading entrance.`,
    }, id);
    return { sourceId: 950001 + index, delivery: DeliverySchema.parse({ ...delivery, routePoint: address.point,
      addressGeography: { addressKey: destinationAddressKey(customer), sourceCustomerId: customer.id, province: address.province, postalCode: address.postalCode, source: 'synthetic_fixture' } }) };
  });
}

export async function seedRouteFeasibility(database: DataSource, catalog: unknown, testDatabase: boolean) {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Route fixtures are restricted to the local teaching stand');
  return database.transaction(async (manager) => {
    const target = await rows(manager, z.object({ name: z.literal(testDatabase ? 'delivery_backoffice_test' : 'delivery_backoffice'), port: z.literal(55432) }), 'SELECT current_database() AS name,inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected isolated local PostgreSQL');
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    let inserted = 0;
    for (const { sourceId, delivery } of routeFeasibilityFixtures(catalog)) {
      const added = await rows(manager, z.object({ id: IdSchema }), `INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (source_instance,source_id) DO NOTHING RETURNING id`, [delivery.id, sourceInstance, sourceId, delivery.version, JSON.stringify(delivery)]);
      if (added.length) inserted++;
      else {
        const [existing] = await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2', [sourceInstance, sourceId]);
        if (existing?.id !== delivery.id) throw new Error('Route fixture identity conflict; transaction stopped');
      }
    }
    return inserted;
  });
}

/** One-time repair of this script's pristine initial fixtures only; no operator/source history is overwritten. */
async function repairInitialContacts(database: DataSource, catalog: unknown) {
  return database.transaction(async (manager) => {
    const target = await rows(manager, z.object({ name: z.literal('delivery_backoffice'), port: z.literal(55432) }), 'SELECT current_database() AS name,inet_server_port() AS port');
    if (target.length !== 1) throw new Error('Expected isolated local PostgreSQL');
    await manager.query('SELECT pg_advisory_xact_lock(7041001)');
    let repaired = 0;
    for (const { sourceId, delivery } of routeFeasibilityFixtures(catalog)) {
      const initial = { ...delivery, source: { ...delivery.source, customer: { ...delivery.source.customer, phones: [] } } };
      const updated = await rows(manager, z.object({ id: IdSchema }), `WITH changed AS (UPDATE delivery SET data=$4::jsonb
        WHERE id=$1 AND source_instance=$2 AND source_id=$3 AND version=1 AND data=$5::jsonb RETURNING id) SELECT id FROM changed`,
      [delivery.id, sourceInstance, sourceId, JSON.stringify(delivery), JSON.stringify(initial)]);
      repaired += updated.length;
    }
    return repaired;
  });
}

async function prepare() {
  const accountsRaw: unknown = JSON.parse(await readFile('.local/demo-accounts.json', 'utf8'));
  const accounts = z.object({ admin: z.object({ email: z.string().email(), password: z.string().min(1) }) }).parse(accountsRaw);
  let cookie = '';
  async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:3001/api${path}`, { method,
      headers: { Origin: 'http://127.0.0.1:3000', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Route demo HTTP ${method} ${path} failed with ${response.status}; existing state is preserved`);
    const token = response.headers.get('set-cookie')?.split(';')[0];
    if (token && path === '/auth/login') cookie = token;
    const raw: unknown = await response.json();
    return schema.parse(raw);
  }
  await request('/auth/login', z.object({ id: IdSchema }), 'POST', accounts.admin);
  try {
    const people = await request('/participants', z.array(ParticipantSchema));
    const person = people.find(({ firstName, lastName }) => firstName === 'DEMO Route Marco' && lastName === 'Rossi')
      ?? await request('/participants', ParticipantSchema, 'POST', { firstName: 'DEMO Route Marco', lastName: 'Rossi', external: false, enabled: true });
    if (!person.enabled) throw new Error('Owned demo participant has been disabled; preserve the operator change');
    const crews = await request('/crews', z.array(CrewSchema));
    const crew = crews.find(({ name }) => name === 'DEMO Route Preview')
      ?? await request('/crews', CrewSchema, 'POST', { name: 'DEMO Route Preview', classification: 'outdoor', area: 'Catania · teaching demo', enabled: true, participantIds: [person.id] });
    if (!crew.enabled || !crew.people.some(({ id }) => id === person.id)) throw new Error('Owned demo crew has been edited; preserve the operator change');
    const vehicles = await request('/vehicles', z.array(VehicleSchema));
    const vehicle = vehicles.find(({ plate }) => plate === 'DEMO ROUTE 11')
      ?? await request('/vehicles', VehicleSchema, 'POST', { ownership: 'company', name: 'DEMO Route Preview van', plate: 'DEMO ROUTE 11', providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: 'Dedicated synthetic route demonstration vehicle.' });
    if (!vehicle.enabled || vehicle.operationalStatus !== 'available') throw new Error('Owned demo vehicle is unavailable; preserve the operator change');
    const templates = await request('/templates', z.array(TaskTemplateSchema));
    const template = templates.find(({ title }) => title === 'DEMO Route unloading check')
      ?? await request('/templates', TaskTemplateSchema, 'POST', { title: 'DEMO Route unloading check', severity: 'high', order: 0, checklist: ['Verify the source order and line before unloading'], enabled: true, requiredSkillIds: [] });
    if (!template.enabled) throw new Error('Owned demo task has been disabled; preserve the operator change');
    const deliveries: Delivery[] = [];
    for (const [index, id] of fixtureIds.entries()) {
      let detail = await request(`/deliveries/${id}`, DetailSchema);
      if (detail.delivery.source.pickingName !== `DEMO/ROUTE/000${index + 1}`) throw new Error('Route fixture identity mismatch');
      if (detail.delivery.appointments.length > 1 || detail.delivery.appointments.some(({ status }) => status !== 'booked')) throw new Error('Route demo already has operational activity; do not reset it');
      if (detail.delivery.appointments.length === 0) {
        detail = await request(`/deliveries/${id}/appointments`, DetailSchema, 'POST', { version: detail.delivery.version, requestId: `b15b5395-8a73-4a52-9289-95000000001${index + 1}`,
          startsAt: `2026-11-16T${10 + index}:00:00Z`, endsAt: `2026-11-16T${10 + index}:45:00Z`,
          workLines: detail.delivery.source.items.map(({ sourceLineId, quantity }) => ({ sourceLineId, deliveryMilli: quantity * 1000, installationMilli: 0, collectionMilli: 0 })),
        });
      }
      const appointment = detail.delivery.appointments[0];
      if (!appointment) throw new Error('Route demo appointment not found after booking');
      if (appointment.assignments.length === 0) detail = await request(`/deliveries/${id}/appointments/${appointment.id}/assign`, DetailSchema, 'POST', {
        version: detail.delivery.version, requestId: `b15b5395-8a73-4a52-9289-95000000002${index + 1}`, crewIds: [crew.id], templateIds: [template.id], staffing: [{ crewId: crew.id, participantIds: [person.id] }],
      });
      const assigned = detail.delivery.appointments[0];
      if (!assigned?.assignments.every((assignment) => assignment.crewId === crew.id && assignment.people.length === 1 && assignment.people[0]?.id === person.id)) throw new Error('Route demo staffing has changed; preserve it');
      deliveries.push(detail.delivery);
    }
    const jobs = deliveries.map((delivery) => routeJob(delivery, undefined, delivery.appointments[0]?.id));
    const coordinates = new Map(routeDepots.map(({ id, latitude, longitude }) => [id, { latitude, longitude }]));
    for (const job of jobs) if (job.point) coordinates.set(job.deliveryId, job.point);
    const stops = jobs.map((job) => ({ deliveryId: job.deliveryId, appointmentId: job.appointmentId ?? undefined, workMinutes: job.suggestedWorkMinutes,
      workDurationSource: 'remaining_estimate' as const, workFingerprint: job.workFingerprint,
      customerWindow: { kind: 'arrival' as const, startsAt: departAt, endsAt: '2026-11-16T17:00:00Z' },
    }));
    const first = stops[0]; const second = stops[1]; const third = stops[2];
    if (!first || !second || !third) throw new Error('Three dedicated demo stops are required');
    const orders = [[first, second, third], [first, third, second], [second, first, third], [second, third, first], [third, first, second], [third, second, first]];
    const scores = orders.map((order) => {
      const chain = ['demo-start-catania', ...order.map(({ deliveryId }) => deliveryId), 'demo-start-catania'];
      const timeline = calculateRouteTimeline({ departAt, startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', stops: order.map((stop) => ({ ...stop, pointId: stop.deliveryId })), travelEstimates: getLocalDemoRouteEstimates(chain, coordinates) });
      if (timeline.travelMinutes === null) throw new Error('Demo travel estimates are incomplete');
      return { order, minutes: timeline.travelMinutes };
    }).sort((left, right) => right.minutes - left.minutes);
    const initial = scores[0]; if (!initial) throw new Error('Demo order not available');
    const input: RouteDraftInput = RouteDraftInputSchema.parse({ name: 'DEMO · Catania route feasibility', departAt, crewId: crew.id, vehicleId: vehicle.id,
      startPointId: 'demo-start-catania', endPointId: 'demo-start-catania', stops: initial.order, manualEstimates: [], useLocalEstimates: true,
      planning: { participantIds: [person.id], participantAvailability: [{ participantId: person.id, workingIntervals: [{ startsAt: '2026-11-16T07:30:00Z', endsAt: '2026-11-16T17:00:00Z' }], unavailableIntervals: [] }],
        driver: { kind: 'participant', participantId: person.id }, vehicleAvailability: null, transferBufferMinutes: 15 },
    });
    const preview = await request('/routes/preview', RoutePreviewSchema, 'POST', input);
    if (preview.feasibility.status !== 'feasible_estimate') throw new Error(`Demo requires review: ${preview.feasibility.findings.map(({ code }) => code).join(', ')}`);
    const suggestion = await request('/routes/suggest-order', RouteSuggestionSchema, 'POST', { ...input, objective: 'travel_minutes' });
    if (suggestion.status !== 'suggested' || suggestion.travelMinutesSaved === null || suggestion.travelMinutesSaved <= 0) throw new Error('Demo did not yield a feasible improvement; stop before saving');
    const saved = await request('/routes', RouteDetailSchema, 'POST', { ...input, requestId: draftId });
    const planning = input.planning; const availability = planning?.participantAvailability[0];
    if (!planning || !availability || !preview.timeline.returnDepartAt) throw new Error('Demo availability or return is missing');
    const returnConflict = await request('/routes/preview', RoutePreviewSchema, 'POST', { ...input, planning: { ...planning,
      participantAvailability: [{ ...availability, workingIntervals: [{ startsAt: availability.workingIntervals[0]?.startsAt, endsAt: preview.timeline.returnDepartAt }] }] } });
    if (!returnConflict.feasibility.findings.some(({ code }) => code === 'outside_working_hours')) throw new Error('Expected return-journey shift conflict');
    const unknown = await request('/routes/preview', RoutePreviewSchema, 'POST', { ...input, stops: input.stops.map((stop) => ({ ...stop, customerWindow: { kind: 'unknown' } })) });
    if (unknown.feasibility.status !== 'insufficient_data') throw new Error('Unknown customer windows must not pass');
    await mkdir('.local', { recursive: true });
    await writeFile('.local/route-feasibility-demo-evidence.json', JSON.stringify({ saved, suggestion, returnConflict, unknown }, null, 2));
    console.log(JSON.stringify({ routeId: saved.id, routeName: saved.name, participantId: person.id, crewId: crew.id, vehicleId: vehicle.id,
      deliveries: deliveries.map(({ id, source }) => ({ id, picking: source.pickingName })), currentTravelMinutes: saved.timeline.travelMinutes,
      proposedTravelMinutes: suggestion.suggested?.timeline.travelMinutes, travelMinutesSaved: suggestion.travelMinutesSaved,
      currentReturn: saved.timeline.returnAt, proposedReturn: suggestion.suggested?.timeline.returnAt,
      returnConflict: returnConflict.feasibility.status, unknown: unknown.feasibility.status }, null, 2));
  } finally {
    if (cookie) await request('/auth/logout', z.object({ ok: z.literal(true) }), 'POST', {});
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--seed', '--test', '--prepare', '--repair-empty-contact'].includes(mode ?? '')) throw new Error('Choose --seed (local teaching source), --test (isolated source) or --prepare (loopback authenticated demo)');
  if (mode === '--prepare') { await prepare(); return; }
  const raw: unknown = JSON.parse(await readFile('local/public-demo-addresses.json', 'utf8'));
  const database = makeDataSource(mode === '--test');
  await database.initialize();
  try {
    if (mode === '--repair-empty-contact') console.log(`Pristine owned demo contacts repaired: ${await repairInitialContacts(database, raw)}.`);
    else console.log(`Dedicated route fixtures inserted: ${await seedRouteFeasibility(database, raw, mode === '--test')}; existing state preserved.`);
  }
  finally { await database.destroy(); }
}

if (require.main === module) void main().catch((error: unknown) => {
  // Never print database URLs, credentials, request headers or raw dependency errors.
  const safeMessage = error instanceof Error && /^(Demo requires review:|Route demo HTTP |Owned demo |Route fixture |Three dedicated |Expected return|Demo did not|Route demo staffing|Route demo already|Route demo appointment)/u.test(error.message);
  console.error(error instanceof z.ZodError ? 'Route demo contract validation failed; stop and inspect the owned fixture.' : safeMessage && error instanceof Error ? error.message : 'Route demo stopped. Check the local stand and owned fixtures before retrying.');
  process.exitCode = 1;
});
