import { appointmentSchema, participantCalendarSchema, type CalendarEntry } from '../src/lib/contracts';
import { ApiFixture, deliveryId } from './refresh-fixtures';

export const monthParticipantId = '72000000-0000-4000-8000-000000000001';
export const monthParticipantPath = `/participants/${monthParticipantId}/calendar`;

function entry(suffix: number, pickingName: string, startsAt: string, endsAt: string, status: 'booked' | 'cancelled' = 'booked'): CalendarEntry {
  const identifier = String(suffix).padStart(12, '0');
  return {
    deliveryId, pickingName, customerName: 'Synthetic month customer',
    appointment: appointmentSchema.parse({ id: `72000000-0000-4000-8000-${identifier}`, startsAt, endsAt, status, cancellationReason: status === 'cancelled' ? 'Synthetic cancelled visit' : null, returnRequestId: null, results: [],
      assignments: [{ id: `73000000-0000-4000-8000-${identifier}`, crewId: '72000000-0000-4000-8000-000000000010', crewName: 'Saved Catania crew',
        people: [{ id: monthParticipantId, name: 'Saved person name', external: false }],
        tasks: [{ id: `74000000-0000-4000-8000-${identifier}`, templateId: '72000000-0000-4000-8000-000000000020', title: 'Saved assembly task', severity: 'medium', order: 1, checklist: [] }] }],
    }),
  };
}

export function monthApiFixture() {
  const api = new ApiFixture();
  api.calendar = [
    entry(100, 'DEMO/OUT/MONTH', '2026-11-03T08:00:00Z', '2026-11-03T10:30:00Z'),
    entry(101, 'DEMO/OUT/SECOND', '2026-11-03T11:00:00Z', '2026-11-03T12:00:00Z'),
    entry(102, 'DEMO/OUT/THIRD', '2026-11-03T13:00:00Z', '2026-11-03T14:00:00Z'),
    entry(103, 'DEMO/OUT/FOURTH', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
    entry(104, 'DEMO/OUT/MIDNIGHT-END', '2026-11-02T22:30:00Z', '2026-11-02T23:00:00Z'),
    entry(105, 'DEMO/OUT/CROSSES-MIDNIGHT', '2026-11-03T22:30:00Z', '2026-11-04T00:00:00Z'),
    entry(106, 'DEMO/OUT/CANCELLED-MONTH', '2026-11-05T08:00:00Z', '2026-11-05T09:00:00Z', 'cancelled'),
    entry(107, 'DEMO/OUT/ADJACENT', '2026-12-01T08:00:00Z', '2026-12-01T09:00:00Z'),
  ];
  const participant = { id: monthParticipantId, version: 1, name: 'Francesca Conti', firstName: 'Francesca', lastName: 'Conti', preferredName: null, phoneNumber: null, address: null, external: false, enabled: true };
  api.participantCalendars.set(monthParticipantPath, participantCalendarSchema.parse({ participant, entries: api.calendar.map((row) => ({
    deliveryId: row.deliveryId, pickingName: row.pickingName, customerName: row.customerName, appointmentId: row.appointment.id,
    startsAt: row.appointment.startsAt, endsAt: row.appointment.endsAt, status: row.appointment.status, assignment: row.appointment.assignments[0], returnVisit: false,
  })) }));
  return api;
}
