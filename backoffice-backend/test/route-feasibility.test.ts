import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppointmentSchema, createDelivery, type Delivery } from '../src/domain/model';
import { planVisitWork } from '../src/domain/rules';
import { CrewSchema, ParticipantSchema, VehicleSchema } from '../src/operations/contracts';
import { calculateRouteTimeline } from '../src/routing/calculation';
import { RouteDraftInputSchema, type RouteDraftInput } from '../src/routing/contracts';
import { demoRouteAddressIds, getDemoRouteEstimates, routeDepots } from '../src/routing/demo-estimates';
import { assessRoute, RouteFeasibilitySchema, type RouteResources, type RouteWorkAssessment } from '../src/routing/feasibility';
import { routeJob } from '../src/routing/service';
import { suggestRouteOrder, type PreparedRoute } from '../src/routing/suggestion';

function fixture() {
  const person = ParticipantSchema.parse({ id: randomUUID(), version: 1, name: 'DEMO Luca Bianchi', firstName: 'Luca', lastName: 'Bianchi',
    preferredName: null, phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds: [] });
  const crew = CrewSchema.parse({ id: randomUUID(), version: 1, name: 'DEMO route crew', classification: 'outdoor', area: 'DEMO Milano', enabled: true,
    people: [{ id: person.id, name: person.name, external: false }] });
  const vehicle = VehicleSchema.parse({ id: randomUUID(), version: 1, ownership: 'company', name: 'DEMO van', plate: 'DEMO 11',
    providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: null });
  const operator = { id: randomUUID(), name: 'DEMO operator', role: 'operator' as const };
  const deliveries = [demoRouteAddressIds.monza, demoRouteAddressIds.milano, demoRouteAddressIds.sesto].map((id, index) => {
    const delivery = createDelivery({ pickingId: 100 + index, pickingName: `DEMO/ROUTE/${index}`, saleOrderId: index + 1, saleOrderName: `DEMO/SO/${index}`,
      sourceState: 'assigned', salesTeam: 'DEMO', customer: { id: index + 1, name: `DEMO Customer ${index}`, address: 'DEMO address', city: 'Milano', country: 'IT', phones: [], email: null, contact: null },
      items: [{ sourceLineId: 101 + index, productId: 1, name: 'DEMO identical chair', quantity: 1, uom: 'unit', description: null, configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: 30, notes: null,
    }, id);
    const appointment = AppointmentSchema.parse({ id: randomUUID(), status: 'booked', startsAt: '2026-11-12T10:00:00Z', endsAt: '2026-11-12T11:00:00Z',
      cancellationReason: null, returnRequestId: null, results: [],
      workScope: planVisitWork(delivery, [{ sourceLineId: 101 + index, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], operator, '2026-11-11T08:00:00Z'),
      assignments: [{ id: randomUUID(), crewId: crew.id, crewName: crew.name, people: [{ id: person.id, name: person.name, external: false, skillsSnapshot: [] }],
        tasks: [{ id: randomUUID(), templateId: randomUUID(), title: 'Unload', severity: 'high', order: 0, requiredSkillsSnapshot: [],
          checklist: [{ id: randomUUID(), label: 'Verify item', done: false, waiver: null }] }] }],
    });
    delivery.appointments.push(appointment);
    return delivery;
  });
  const jobs = deliveries.map((delivery) => routeJob(delivery, undefined, delivery.appointments[0]?.id));
  const input = RouteDraftInputSchema.parse({ name: 'DEMO feasibility', departAt: '2026-11-12T08:00:00Z', crewId: crew.id, vehicleId: vehicle.id,
    startPointId: 'warehouse-milano', endPointId: 'warehouse-milano', manualEstimates: [],
    stops: jobs.map((job) => ({ deliveryId: job.deliveryId, appointmentId: job.appointmentId, workMinutes: 30, workDurationSource: 'manual',
      workFingerprint: job.workFingerprint, customerWindow: { kind: 'unrestricted' } })),
    planning: { participantIds: [person.id], participantAvailability: [{ participantId: person.id,
      workingIntervals: [{ startsAt: '2026-11-12T07:00:00Z', endsAt: '2026-11-12T18:00:00Z' }], unavailableIntervals: [] }],
    driver: { kind: 'participant', participantId: person.id }, vehicleAvailability: null, transferBufferMinutes: 0 },
  });
  const resources: RouteResources = { participants: [person], crews: [crew], vehicles: [vehicle], busy: [] };
  const work: RouteWorkAssessment[] = jobs.map((job) => ({ deliveryId: job.deliveryId, source: 'manual', minutes: 30, fingerprint: job.workFingerprint, blockedReason: job.workReviewReason }));
  const stops = input.stops.map((stop) => ({ ...stop, pointId: stop.deliveryId, windowKind: 'unrestricted' as const }));
  const chain = [input.startPointId, ...stops.map(({ deliveryId }) => deliveryId), input.endPointId];
  const timeline = calculateRouteTimeline({ ...input, stops, travelEstimates: getDemoRouteEstimates(chain) });
  const evaluate = (changedInput = input, changedResources = resources, changedDeliveries: Delivery[] = deliveries) =>
    RouteFeasibilitySchema.parse(assessRoute(changedInput, timeline, changedDeliveries, changedResources, work));
  return { person, crew, vehicle, deliveries, jobs, input, resources, work, stops, timeline, evaluate };
}

void test('fixed composition, explicit windows and full-trip shifts produce an estimate, never a booking', () => {
  const data = fixture();
  const before = JSON.stringify(data.deliveries);
  assert.equal(data.evaluate().status, 'feasible_estimate');
  assert.equal(JSON.stringify(data.deliveries), before);
  const legacy = { ...data.input, planning: undefined, stops: data.input.stops.map(({ deliveryId, workMinutes }) => ({ deliveryId, workMinutes })) };
  assert.equal(data.evaluate(legacy).status, 'insufficient_data');
  assert.ok(data.evaluate(legacy).findings.some(({ code }) => code === 'customer_window_unknown'));
});

void test('freshness includes exact point context even if rounded travel minutes do not change', () => {
  const data = fixture();
  const originalPoint = [{ pointId: data.input.startPointId, addressKey: null, point: { latitude: 37.5, longitude: 15.08 } }];
  const changedPoint = [{ pointId: data.input.startPointId, addressKey: null, point: { latitude: 37.50001, longitude: 15.08 } }];
  const original = assessRoute(data.input, data.timeline, data.deliveries, data.resources, data.work, [], originalPoint);
  const changed = assessRoute(data.input, data.timeline, data.deliveries, data.resources, data.work, [], changedPoint);
  assert.notEqual(changed.fingerprint, original.fingerprint);
});

void test('participant or vehicle occupied only on the return journey blocks the complete trip', () => {
  const data = fixture();
  assert.ok(data.timeline.returnAt && data.timeline.returnDepartAt);
  for (const resource of [`person:${data.person.id}`, `vehicle:${data.vehicle.id}`, `crew:${data.crew.id}`]) {
    const result = data.evaluate(data.input, { ...data.resources, busy: [{ resource, appointmentId: randomUUID(), pickingName: 'DEMO other trip',
      startsAt: data.timeline.returnDepartAt, endsAt: data.timeline.returnAt }] });
    assert.equal(result.status, 'conflict');
    assert.ok(result.findings.some(({ code }) => code === 'resource_busy'));
  }
});

void test('hours, breaks, absences, missing skills and altered composition are checked for each actual person', () => {
  const data = fixture(); const planning = data.input.planning; const availability = planning?.participantAvailability[0];
  assert.ok(planning && availability);
  for (const kind of ['break', 'absence'] as const) {
    const result = data.evaluate({ ...data.input, planning: { ...planning, participantAvailability: [{ ...availability,
      unavailableIntervals: [{ kind, startsAt: '2026-11-12T08:30:00Z', endsAt: '2026-11-12T09:00:00Z' }] }] } });
    assert.equal(result.status, 'conflict');
  }
  assert.equal(data.evaluate({ ...data.input, planning: { ...planning, participantAvailability: [{ ...availability,
    workingIntervals: [{ startsAt: data.input.departAt, endsAt: '2026-11-12T09:00:00Z' }] }] } }).status, 'conflict');
  const first = data.deliveries[0]?.appointments[0]?.assignments[0]; assert.ok(first);
  const task = first.tasks[0]; assert.ok(task);
  task.requiredSkillsSnapshot = [{ id: randomUUID(), name: 'DEMO assembly' }];
  assert.ok(data.evaluate().findings.some(({ code }) => code === 'missing_skill'));
  first.crewId = randomUUID();
  assert.ok(data.evaluate().findings.some(({ code }) => code === 'composition_changes'));
});

void test('only exactly linked own appointment resources are excluded; another visit on the same delivery is not', () => {
  const data = fixture(); const appointment = data.deliveries[0]?.appointments[0]; assert.ok(appointment);
  const busy = { resource: `person:${data.person.id}`, appointmentId: appointment.id, pickingName: 'DEMO own visit', startsAt: '2026-11-12T08:30:00Z', endsAt: '2026-11-12T09:00:00Z' };
  assert.equal(data.evaluate(data.input, { ...data.resources, busy: [busy] }).status, 'feasible_estimate');
  assert.equal(data.evaluate(data.input, { ...data.resources, busy: [{ ...busy, appointmentId: randomUUID() }] }).status, 'conflict');
});

void test('external driver and vehicle need full interval confirmation and transfer buffer is explicit', () => {
  const data = fixture(); const planning = data.input.planning; assert.ok(planning);
  const resources = { ...data.resources, vehicles: [{ ...data.vehicle, ownership: 'external' as const, providerName: 'DEMO provider' }] };
  const input: RouteDraftInput = { ...data.input, planning: { ...planning, driver: { kind: 'external', name: 'DEMO Paolo', availability: null } } };
  const missing = data.evaluate(input, resources);
  assert.ok(missing.findings.some(({ code }) => code === 'external_vehicle_unknown'));
  assert.ok(missing.findings.some(({ code }) => code === 'external_driver_unknown'));
  assert.ok(data.evaluate({ ...data.input, planning: { ...planning, transferBufferMinutes: null } }).findings.some(({ code }) => code === 'transfer_buffer_unknown'));
});

void test('explicit arrival window differs from work-end and unknown work never becomes zero', () => {
  const data = fixture(); const first = data.stops[0]; assert.ok(first);
  const route = { ...data.input, stops: [{ ...first, windowStart: '2026-11-12T08:00:00Z', windowEnd: '2026-11-12T09:00:00Z', windowKind: 'arrival' as const }],
    travelEstimates: getDemoRouteEstimates(['warehouse-milano', first.deliveryId, 'warehouse-milano']) };
  assert.equal(calculateRouteTimeline(route).stops[0]?.late, false);
  assert.equal(calculateRouteTimeline({ ...route, stops: route.stops.map((stop) => ({ ...stop, windowKind: 'work_end' as const })) }).stops[0]?.late, true);
  const unknown = calculateRouteTimeline({ ...route, stops: [{ ...first, workMinutes: null }] });
  assert.equal(unknown.returnAt, null); assert.equal(unknown.workMinutes, null);
});

void test('suggestion compares the same directed estimates, preserves work and never applies automatically', () => {
  const data = fixture();
  const prepared: PreparedRoute = { preview: { timeline: data.timeline, jobs: data.jobs, pointContexts: [], warnings: [], feasibility: data.evaluate() },
    stops: data.stops, selected: data.deliveries, resources: data.resources, work: data.work, coordinates: new Map(routeDepots.map(({ id, latitude, longitude }) => [id, { latitude, longitude }])),
    manualEstimates: [], extraFindings: [] };
  const before = JSON.stringify(data.input);
  const result = suggestRouteOrder(data.input, 'travel_minutes', prepared);
  assert.equal(result.status, 'suggested'); assert.ok(result.suggested);
  assert.ok(result.travelMinutesSaved !== null && result.travelMinutesSaved > 0);
  assert.deepEqual([...result.deliveryIds].sort(), data.input.stops.map(({ deliveryId }) => deliveryId).sort());
  assert.equal(result.suggested.timeline.workMinutes, data.timeline.workMinutes);
  assert.equal(JSON.stringify(data.input), before);
  const incompleteManual = { ...data.input, manualEstimates: [{ fromPointId: 'warehouse-milano', toPointId: demoRouteAddressIds.monza, minutes: 100 }] };
  assert.equal(suggestRouteOrder(incompleteManual, 'travel_minutes', prepared).status, 'insufficient_data');
});
