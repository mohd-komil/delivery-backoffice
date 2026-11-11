import type { Appointment } from './contracts';

export type VisitConfirmationState = 'awaitingCustomerConfirmation' | 'customerConfirmed';

export function visitConfirmationState(
  visit: Pick<Appointment, 'status' | 'customerConfirmation'>,
  staffed: boolean,
): VisitConfirmationState | null {
  if (visit.status !== 'booked' || !staffed) return null;
  return visit.customerConfirmation ? 'customerConfirmed' : 'awaitingCustomerConfirmation';
}
