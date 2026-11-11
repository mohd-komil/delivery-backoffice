import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import type { Appointment, CrewActor, Delivery } from '../domain/model';
import { startVisit } from '../domain/rules';
import { assertRouteVisitStartAllowed } from '../operations/route-reservations';

export async function startAssignedVisit(manager: EntityManager, delivery: Delivery, appointmentId: string, actor: CrewActor) {
  await assertRouteVisitStartAllowed(manager,appointmentId);
  const next = startVisit(delivery, appointmentId, actor, new Date().toISOString());
  await manager.query('UPDATE appointment SET status=$2 WHERE id=$1 AND delivery_id=$3', [appointmentId, 'in_progress', delivery.id]);
  return next;
}

export async function recordedActualStart(manager: EntityManager, deliveryId: string, appointment: Appointment) {
  if (appointment.actualStartedAt !== undefined) return appointment.actualStartedAt;
  if (appointment.status !== 'in_progress') return null;
  const [event] = await rows(manager, z.object({ at: z.date() }), `
    SELECT at FROM audit WHERE delivery_id = $1 AND action = 'execution.started'
      AND lower(details->>'appointmentId') = $2 ORDER BY at DESC, id DESC LIMIT 1`,
  [deliveryId, appointment.id.toLowerCase()]);
  return event?.at.toISOString() ?? null;
}

export async function markVisitEnded(manager: EntityManager, deliveryId: string, appointmentId: string, status: 'completed' | 'failed') {
  await manager.query('UPDATE appointment SET status=$2 WHERE id=$1 AND delivery_id=$3', [appointmentId, status, deliveryId]);
}
