import { randomUUID } from 'node:crypto';
import { AppointmentSchema, createDelivery, DeliverySchema, type Appointment, type Assignment, type Delivery, type DeliveryView, type Issue, type ReturnRequest } from '../src/domain/model';

/** Synthetic list snapshots for a disposable test schema. No imported record or appointment is copied. */
export function deliveryViewFilterFixtures() {
  const ownerId = randomUUID();
  const teamNames = { catania: 'DEMO Etna', messina: 'DEMO Ionio' };
  const teamIds = { catania: randomUUID(), messina: randomUUID() };
  const demoPlaces = {
    catania: { city: 'Catania', province: 'CT', postalCode: '95125' },
    messina: { city: 'Messina', province: 'ME', postalCode: '98121' },
  };
  type Place = keyof typeof demoPlaces;
  const dates = { first: '2026-11-16T08:00:00.000Z', second: '2026-11-18T08:00:00.000Z' };
  type Stage = Exclude<DeliveryView, 'inbox' | 'issues' | 'return_required'>;
  let sequence = 1200;
  function fixture(stage: Stage, key: string, place: Place, startsAt: string, crew = place, issueType?: Issue['type'], returnStatus?: ReturnRequest['status']) {
    const sourceId = ++sequence;
    const sourceLineId = sourceId * 10;
    const order = `DEMO/ORDER/${sourceId}`;
    const extraOrder = { id: sourceId + 10_000, name: `DEMO/EXTRA/${key}` };
    const delivery = createDelivery({
      pickingId: sourceId, pickingName: `DEMO/FILTER/${key}`, saleOrderId: sourceId, saleOrderName: order,
      salesOrders: [{ id: sourceId, name: order }, extraOrder], sourceState: 'assigned', salesTeam: 'Isolated demo',
      customer: { id: sourceId, name: `DEMO Cliente ${key}`, address: 'Indirizzo dimostrativo', ...demoPlaces[place], country: 'IT', phones: [], email: null, contact: null },
      items: [{ sourceLineId, saleOrderId: extraOrder.id, productId: 9701, name: 'DEMO cabinet', uom: 'unit', quantity: 2,
        description: null, configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: 45, notes: null,
    }, randomUUID());
    const endsAt = new Date(Date.parse(startsAt) + 3_600_000).toISOString();
    const ended = stage === 'partially_completed' || stage === 'completed';
    const assignments: Assignment[] = stage === 'planned' ? [] : [{
      id: randomUUID(), crewId: teamIds[crew], crewName: teamNames[crew],
      people: [{ id: randomUUID(), name: 'DEMO participant', external: false }],
      tasks: [{ id: randomUUID(), templateId: randomUUID(), title: 'DEMO check shipment', order: 0, severity: 'medium',
        checklist: [{ id: randomUUID(), label: 'DEMO inspect packages', done: ended, waiver: null }] }],
    }];
    const appointment: Appointment = AppointmentSchema.parse({
      id: randomUUID(), startsAt, endsAt, status: stage === 'in_progress' ? 'in_progress' : ended ? 'completed' : 'booked',
      cancellationReason: null, returnRequestId: null, assignments, results: [],
    });
    const actor = assignments[0]?.people[0];
    if (ended && actor) {
      appointment.results.push({
        id: randomUUID(), appointmentId: appointment.id, receivedAt: endsAt, actualStart: startsAt, actualEnd: endsAt,
        supersedesResultId: null, correctionReason: null, summary: 'DEMO list fixture, not field evidence',
        actor: { kind: 'crew', id: actor.id, name: actor.name }, responsiblePersonId: actor.id,
        quantities: [{ sourceLineId, deliveredMilli: stage === 'completed' ? 2000 : 1000, installedMilli: 0, collectedMilli: 0 }],
        completedChecklistIds: [], evidence: [], customerSignature: null, crewSignature: null,
        sourceSnapshot: delivery.source, instructionsSnapshot: delivery.instructions, assignmentsSnapshot: assignments,
      });
    }
    delivery.appointments.push(appointment);
    if (stage === 'completed') delivery.completedAt = place === 'catania' ? '2026-11-16T23:30:00.000Z' : '2026-11-19T08:00:00.000Z';
    if (issueType) delivery.issues.push({
      id: randomUUID(), type: issueType, description: 'DEMO open issue', itemIds: [sourceLineId], photoIds: [], notes: null, status: 'open',
      createdAt: endsAt, authorId: ownerId, authorName: 'DEMO Francesca', source: 'operator', appointmentId: appointment.id,
      resolution: null, resolvedAt: null, resolvedBy: null,
    });
    if (returnStatus) {
      const returnId = randomUUID();
      const followUp = returnStatus === 'planned' ? AppointmentSchema.parse({ ...appointment, id: randomUUID(),
        startsAt: '2026-11-20T08:00:00.000Z', endsAt: '2026-11-20T09:00:00.000Z', status: 'booked', returnRequestId: returnId, results: [] }) : undefined;
      if (followUp) delivery.appointments.push(followUp);
      delivery.returnRequests.push({
        id: returnId, originAppointmentId: appointment.id, reason: 'DEMO follow-up', remainingWork: 'One cabinet', notes: null,
        photoIds: [], issueIds: delivery.issues.map(({ id }) => id), status: returnStatus, appointmentId: followUp?.id ?? null,
        createdAt: endsAt, resolvedAt: null, resolution: null,
      });
    }
    return DeliverySchema.parse(delivery);
  }
  const deliveries: Delivery[] = [
    fixture('planned', 'PLANNED-A', 'catania', dates.first),
    fixture('planned', 'PLANNED-B', 'messina', dates.second),
    ...Array.from({ length: 12 }, (_, i) => {
      const place = i < 6 ? 'catania' : 'messina';
      return fixture('assigned', `ASSIGNED-${String(i + 1).padStart(2, '0')}`, place, i % 2 === 0 ? dates.first : dates.second);
    }),
    fixture('in_progress', 'ACTIVE-A', 'catania', dates.first),
    fixture('in_progress', 'ACTIVE-B', 'messina', dates.second),
    fixture('partially_completed', 'PARTIAL-A', 'catania', dates.first, 'catania', 'damage', 'requested'),
    fixture('partially_completed', 'PARTIAL-B', 'messina', dates.second, 'messina', 'access', 'planned'),
    fixture('completed', 'COMPLETED-A', 'catania', dates.first),
    fixture('completed', 'COMPLETED-B', 'messina', dates.second),
  ];
  return deliveries;
}
