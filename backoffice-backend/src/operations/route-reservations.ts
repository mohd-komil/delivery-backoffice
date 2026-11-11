import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { AppointmentSchema, IdSchema } from '../domain/model';

/** Raw intervals, never pre-padded. An active route owns its exact children only. */
export const RESOURCE_BOOKINGS_SQL = `
  SELECT r.resource, a.id AS appointment_id, a.starts_at, a.ends_at,
    NULL::uuid AS route_id, 0::integer AS buffer_minutes
  FROM reservation r JOIN appointment a ON a.id=r.appointment_id
  WHERE a.status IN ('booked','in_progress') AND NOT EXISTS (
    SELECT 1 FROM route_stop s JOIN route_publication p ON p.id=s.route_id
    WHERE s.appointment_id=a.id AND s.active AND p.status<>'cancelled'
  )
  UNION ALL
  SELECT t.resource, t.appointment_id, t.starts_at, t.ends_at,
    NULL::uuid AS route_id, 0::integer AS buffer_minutes
  FROM transport_reservation t WHERE NOT EXISTS (
    SELECT 1 FROM route_stop s JOIN route_publication p ON p.id=s.route_id
    WHERE s.appointment_id=t.appointment_id AND s.active AND p.status<>'cancelled'
  )
  UNION ALL
  SELECT r.resource, first_stop.appointment_id, r.starts_at, r.ends_at, r.route_id, r.buffer_minutes
  FROM route_reservation r JOIN route_publication p ON p.id=r.route_id
  JOIN LATERAL (SELECT s.appointment_id FROM route_stop s
    WHERE s.route_id=r.route_id AND s.active ORDER BY s.sequence,s.id LIMIT 1) first_stop ON true
  WHERE p.status<>'cancelled'
`;

export async function appointmentRoute(manager: EntityManager, appointmentId: string) {
  const [route] = await rows(manager, z.object({ id: IdSchema, status: z.enum(['published','in_progress','returning','returned','closed']) }),
    `SELECT p.id,p.status FROM route_stop s JOIN route_publication p ON p.id=s.route_id
     WHERE s.appointment_id=$1 AND s.active AND p.status<>'cancelled'`, [appointmentId]);
  return route;
}

export async function assertStandaloneAppointment(manager: EntityManager, appointmentId: string): Promise<void> {
  const route = await appointmentRoute(manager, appointmentId);
  if (route) throw new ConflictException({ code: 'ROUTE_CHANGE_REQUIRED', message: 'This visit belongs to a published route. Change it through the route workflow.', routeId: route.id });
}

export async function assertRouteResourceMutable(manager: EntityManager, resource: string): Promise<void> {
  const [route] = await rows(manager, z.object({ id: IdSchema }),
    `SELECT p.id FROM route_reservation r JOIN route_publication p ON p.id=r.route_id
     WHERE r.resource=$1 AND p.status IN ('published','in_progress','returning') ORDER BY p.id LIMIT 1`, [resource]);
  if (route) throw new ConflictException({ code: 'ROUTE_CHANGE_REQUIRED', message: 'This resource is assigned to a published route. Review its route before making it unavailable.', routeId: route.id });
}

async function activeRouteAppointments(manager: EntityManager, resource: string | null) {
  const result = await rows(manager, z.object({ id: IdSchema, appointment: AppointmentSchema }),
    `SELECT p.id,v.data AS appointment FROM route_stop s JOIN route_publication p ON p.id=s.route_id
     JOIN delivery d ON d.id=s.delivery_id
     JOIN LATERAL jsonb_array_elements(d.data->'appointments') v(data) ON v.data->>'id'=s.appointment_id::text
     WHERE s.active AND p.status IN ('published','in_progress','returning')
       AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM route_reservation r WHERE r.route_id=p.id AND r.resource=$1))
     ORDER BY p.id,s.sequence LIMIT 5001`, [resource]);
  if (result.length > 5000) throw new ConflictException('Route dependency review exceeds the 5000-stop local limit');
  return result;
}

export async function assertRouteSkillsRetained(manager: EntityManager, removedSkillIds: readonly string[], personId?: string): Promise<void> {
  if (removedSkillIds.length === 0) return;
  const removed = new Set(removedSkillIds);
  const appointments = await activeRouteAppointments(manager, personId ? `person:${personId}` : null);
  const affected = appointments.find(({ appointment }) => appointment.assignments.some((assignment) =>
    (personId === undefined || assignment.people.some(({ id }) => id === personId)) &&
    assignment.tasks.some((task) => task.requiredSkillsSnapshot?.some(({ id }) => removed.has(id)))));
  if (affected) throw new ConflictException({ code: 'ROUTE_CHANGE_REQUIRED', message: 'A published route requires this skill. Review the route before removing or disabling it.', routeId: affected.id });
}

/** The planned return is never proof that a resource has physically returned. */
export async function routeResourceStartBlocker(manager: EntityManager, resources: readonly string[], ownRouteId: string | null, bufferMinutes = 0) {
  const [busy] = await rows(manager, z.object({ id: IdSchema, status: z.enum(['in_progress', 'returning', 'returned', 'closed']) }),
    `SELECT p.id,p.status FROM route_reservation r JOIN route_publication p ON p.id=r.route_id
       WHERE r.resource=ANY($1::text[]) AND p.id IS DISTINCT FROM $2::uuid
         AND (p.status IN ('in_progress','returning') OR
           p.status IN ('returned','closed') AND r.ends_at + make_interval(mins=>GREATEST(r.buffer_minutes,$3::integer)) > $4::timestamptz)
       ORDER BY CASE WHEN p.status IN ('in_progress','returning') THEN 0 ELSE 1 END,p.id LIMIT 1`,
    [resources, ownRouteId, bufferMinutes, new Date().toISOString()]);
  if (!busy) return null;
  return busy.status === 'returned' || busy.status === 'closed'
    ? { code: 'ROUTE_TURNAROUND_REQUIRED', message: 'The turnaround buffer after the previous actual return has not elapsed.', routeId: busy.id }
    : { code: 'ROUTE_RETURN_REQUIRED', message: 'A previous route using these resources has not recorded its actual return.', routeId: busy.id };
}

export async function routeVisitStartBlocker(manager: EntityManager, appointmentId: string) {
  const own = await appointmentRoute(manager, appointmentId);
  if (own && own.status !== 'in_progress') return { code: 'ROUTE_DEPARTURE_REQUIRED', message: 'The published route must depart before starting this visit.', routeId: own.id };
  if (own) {
    const [next] = await rows(manager, z.object({ appointmentId: IdSchema }),
      `SELECT s.appointment_id AS "appointmentId" FROM route_stop s JOIN appointment a ON a.id=s.appointment_id
       WHERE s.route_id=$1 AND s.active AND a.status IN ('booked','in_progress') ORDER BY s.sequence,s.id LIMIT 1`, [own.id]);
    if (next?.appointmentId !== appointmentId) return { code: 'ROUTE_STOP_ORDER_REQUIRED', message: 'Finish or ask the dispatcher to skip the preceding stop before starting this visit.', routeId: own.id };
  }
  const resources = await rows(manager, z.object({ resource: z.string() }),
    `SELECT resource FROM reservation WHERE appointment_id=$1
     UNION SELECT resource FROM transport_reservation WHERE appointment_id=$1
     UNION SELECT resource FROM route_reservation WHERE route_id=$2::uuid`, [appointmentId, own?.id ?? null]);
  const [buffer] = own ? await rows(manager, z.object({ minutes: z.number().int().nonnegative() }),
    'SELECT max(buffer_minutes)::int AS minutes FROM route_reservation WHERE route_id=$1', [own.id]) : [];
  return routeResourceStartBlocker(manager, resources.map(({ resource }) => resource), own?.id ?? null, buffer?.minutes ?? 0);
}

export async function assertRouteVisitStartAllowed(manager: EntityManager, appointmentId: string): Promise<void> {
  const blocker = await routeVisitStartBlocker(manager, appointmentId);
  if (blocker) throw new ConflictException(blocker);
}
