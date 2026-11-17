import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import type { CrewProfile } from '../crew/contracts';
import { CrewIdentity } from '../identity/crew-identity';
import { rows } from '../database/database';
import { AppointmentSchema, IdSchema, type Appointment, type Delivery, type OperatorActor } from '../domain/model';
import { destinationAddressKey } from '../domain/destination-address';
import { appointmentScopeReviewReason, assignedParticipant, customerConfirmationStatus, DomainError, requireReviewedVisitScope } from '../domain/rules';
import { recordedActualStart } from '../execution/visit';
import { Participants } from '../operations/participants';
import { Skills } from '../operations/skills';
import { DeliveryStore } from '../operations/store';
import { activeTransport, Vehicles } from '../operations/vehicles';
import { routeResourceStartBlocker, routeVisitStartBlocker } from '../operations/route-reservations';
import { listDispatcherOwners, requireDispatcherOwners } from '../operations/dispatcher-owners';
import { RouteDraftInputSchema, type RouteDraftInput } from './contracts';
import { routeDepots } from './demo-estimates';
import { DestinationEntrances } from './entrances';
import { PublicationReviewSchema, PublicationSnapshotSchema, PublicationStatusSchema } from './publication-contracts';
import { RouteActionInputSchema, RouteAmendInputSchema, RouteAmendReviewInputSchema, RouteAmendReviewSchema, RouteCancelInputSchema, RouteCloseInputSchema,
  RouteOperationsSchema, RouteReasonInputSchema, RouteReconcileInputSchema, RouteReturnInputSchema, RouteRevisionSchema, RouteRuntimeSchema, RouteWarehouseReceiptInputSchema } from './lifecycle-contracts';
import { normalizeRouteDraftInput, routeJob, RouteDrafts } from './service';
import { cargoReceiptBalance, routeLineStatuses } from './line-status';
import { buildRouteTiming } from './timing';
import { RouteTimingSchema } from './timing-contracts';

const RecordSchema = z.object({ id: IdSchema, version: z.number().int().positive(), status: PublicationStatusSchema, data: PublicationSnapshotSchema, runtime: RouteRuntimeSchema });
const ProvenanceSchema = z.object({ originalAppointment: AppointmentSchema.nullable(), serviceReservations: z.array(z.object({ resource: z.string() })),
  transportReservations: z.array(z.object({ allocationId: IdSchema, resource: z.string(), startsAt: z.string(), endsAt: z.string() })) });
const StopRowSchema = z.object({ id: IdSchema, appointmentId: IdSchema, deliveryId: IdSchema, sequence: z.number().int().positive(), source: z.enum(['created', 'attached']), provenance: ProvenanceSchema });
type Caller = OperatorActor | CrewProfile;
type Stop = z.infer<typeof StopRowSchema> & { appointment: Appointment; delivery: Delivery };
type State = { row: z.infer<typeof RecordSchema>; stops: Stop[]; dirty: Set<string> };
type Action = z.infer<typeof RouteActionInputSchema>;

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function actorSnapshot(actor: Caller) { return { id: actor.id, name: actor.name }; }
function event(actor: Caller, note: string | null = null) { return { at: new Date().toISOString(), actor: actorSnapshot(actor), note }; }
function terminal(visit: Appointment) { return ['completed', 'failed', 'cancelled'].includes(visit.status); }
function activePeople(state: State) { return [...new Map(state.stops.flatMap(({ appointment }) => appointment.assignments.flatMap(({ people }) => people.map((person) => [person.id, person] as const)))).values()]; }
function nextStop(state: State) { return state.stops.find(({ appointment }) => !terminal(appointment)); }
function routeResponsible(state: State) {
  const person = state.row.data.review.stops[0]?.responsibleParticipant;
  if (!person) throw new DomainError('ROUTE_RESPONSIBLE_REQUIRED', 'The route responsible participant is missing');
  return person;
}
function actionParticipant(state: State, actor: Caller) {
  const driver = state.row.data.draft.planning?.driver;
  return actor.role !== 'crew' || routeResponsible(state).id === actor.id || driver?.kind === 'participant' && driver.participantId === actor.id;
}
function actionParticipantRequirement(state: State) {
  return state.row.data.draft.planning?.driver.kind === 'participant'
    ? 'Only the route responsible participant or assigned driver can record this action'
    : 'Only the route responsible participant can record this action';
}
function requireActionParticipant(state: State, actor: Caller) {
  if (!actionParticipant(state, actor)) throw new DomainError('ROUTE_RESPONSIBLE_REQUIRED', actionParticipantRequirement(state), 403);
}

@Injectable()
export class RouteLifecycle {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore, @Inject(RouteDrafts) private readonly drafts: RouteDrafts,
    @Inject(Participants) private readonly people: Participants, @Inject(Skills) private readonly skills: Skills, @Inject(Vehicles) private readonly vehicles: Vehicles,
    @Inject(DestinationEntrances) private readonly entrances: DestinationEntrances, @Inject(CrewIdentity) private readonly identity: CrewIdentity) {}

  private async load(manager: EntityManager, id: string): Promise<State> {
    const [row] = await rows(manager, RecordSchema, 'SELECT id,version,status,data,runtime FROM route_publication WHERE id=$1', [id]);
    if (!row) throw new NotFoundException('Published route not found');
    const links = await rows(manager, StopRowSchema, `SELECT id,appointment_id AS "appointmentId",delivery_id AS "deliveryId",sequence,source,provenance
      FROM route_stop WHERE route_id=$1 ORDER BY sequence,id`, [id]);
    const deliveries = await this.store.getMany(links.map(({ deliveryId }) => deliveryId), manager);
    const stops = links.map((link) => {
      const delivery = deliveries.find(({ id: deliveryId }) => deliveryId === link.deliveryId);
      const appointment = delivery?.appointments.find(({ id: appointmentId }) => appointmentId === link.appointmentId);
      if (!delivery || !appointment) throw new Error('Published route references an unavailable visit');
      return { ...link, delivery, appointment };
    });
    return { row, stops, dirty: new Set() };
  }

  private async authorize(manager: EntityManager, state: State, actor: Caller) {
    if (actor.role !== 'crew') return;
    const [person] = await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM person WHERE id=$1 AND enabled', [actor.id]);
    if (!person || state.row.status === 'cancelled' || !activePeople(state).some(({ id }) => id === actor.id)) throw new NotFoundException('Route not found');
  }

  async owners() { return listDispatcherOwners(this.store.db.source.manager); }

  async get(id: string, actor: Caller) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const state = await this.load(manager, id); await this.authorize(manager, state, actor);
      return this.describe(manager, state, actor);
    });
  }

  async timing(id: string, actor: OperatorActor) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const state = await this.load(manager, id);
      await this.authorize(manager, state, actor);
      const { row } = state;
      const [revision] = await rows(manager, z.object({ version: z.number().int().positive(), at: z.date() }),
        `SELECT version,at FROM route_revision WHERE route_id=$1 AND action IN ('route.published','route.amended')
          ORDER BY version DESC LIMIT 1`, [id]);
      // Only explicit amendments replace data.review. Later runtime events preserve that published timeline.
      const plan = revision ? { version: revision.version, at: revision.at.toISOString() }
        : { version: 1, at: row.data.publishedAt };
      const stops = await Promise.all(state.stops.map(async ({ appointment, deliveryId }) => ({
        appointment,
        recordedStartAt: row.status === 'cancelled' ? null : await recordedActualStart(manager, deliveryId, appointment),
      })));
      return RouteTimingSchema.parse(buildRouteTiming(id, row.status, plan, row.data.review, row.runtime, stops));
    });
  }

  async list(actor: CrewProfile) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => {
      const found = await rows(manager, z.object({ id: IdSchema }), `SELECT DISTINCT p.id,p.created_at FROM route_publication p
        JOIN route_stop s ON s.route_id=p.id JOIN delivery d ON d.id=s.delivery_id
        JOIN LATERAL jsonb_array_elements(d.data->'appointments') a(data) ON a.data->>'id'=s.appointment_id::text
        WHERE p.status<>'cancelled' AND s.active AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.data->'assignments') assignment(data),jsonb_array_elements(assignment.data->'people') person(data)
          WHERE person.data->>'id'=$1) ORDER BY p.created_at DESC,p.id LIMIT 200`, [actor.id]);
      const routes: z.infer<typeof RouteOperationsSchema>[] = [];
      for (const entry of found) { const state = await this.load(manager, entry.id); await this.authorize(manager, state, actor); routes.push(await this.describe(manager, state, actor)); }
      return { routes };
    });
  }

  async revision(id: string, version: number) {
    const [record] = await rows(this.store.db.source.manager, RouteRevisionSchema, 'SELECT version,status,data,runtime FROM route_revision WHERE route_id=$1 AND version=$2', [id, version]);
    if (record) return record;
    const state = await this.load(this.store.db.source.manager, id);
    if (state.row.version !== version) throw new NotFoundException('Route version not found');
    return RouteRevisionSchema.parse({ version: state.row.version, status: state.row.status, data: state.row.data, runtime: state.row.runtime });
  }

  private async mutate<C extends Action>(id: string, command: C, actor: Caller, action: string, reason: string | null,
    change: (manager: EntityManager, state: State) => Promise<void> | void, request?: unknown) {
    return this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      await rows(manager, z.object({ id: IdSchema }), 'SELECT id FROM route_publication WHERE id=$1 FOR UPDATE', [id]);
      await rows(manager, z.object({ id: IdSchema }), `SELECT d.id FROM delivery d WHERE d.id IN
        (SELECT delivery_id FROM route_stop WHERE route_id=$1) ORDER BY d.id FOR UPDATE`, [id]);
      if (actor.role === 'crew') {
        const fresh = await this.identity.authenticate(request, manager);
        if (fresh.id !== actor.id) throw new UnauthorizedException('The Crew session changed; sign in again');
      }
      const state = await this.load(manager, id); await this.authorize(manager, state, actor);
      if (actor.role === 'crew') requireActionParticipant(state, actor);
      const fingerprint = digest({ action, command });
      const [receipt] = await rows(manager, z.object({ fingerprint: z.string() }), 'SELECT fingerprint FROM route_command WHERE route_id=$1 AND request_id=$2', [id, command.requestId]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new DomainError('REQUEST_ID_CONFLICT', 'Request ID was already used for different route input');
        return this.describe(manager, state, actor);
      }
      if (state.row.version !== command.version) throw new DomainError('ROUTE_VERSION_CHANGED', 'The route changed. Refresh and review this action again.');
      await manager.query(`INSERT INTO route_revision(route_id,version,status,data,runtime,actor_id,actor_name,action,reason,at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,'route.published',NULL,$8) ON CONFLICT(route_id,version) DO NOTHING`,
      [id, state.row.version, state.row.status, JSON.stringify(state.row.data), JSON.stringify(state.row.runtime), state.row.data.publishedBy.id, state.row.data.publishedBy.name, state.row.data.publishedAt]);
      await change(manager, state);
      for (const stop of state.stops) if (state.dirty.has(stop.delivery.id)) { stop.delivery.version += 1; await this.store.save(manager, stop.delivery); }
      state.row.version += 1;
      state.row.runtime = RouteRuntimeSchema.parse(state.row.runtime);
      state.row.data = PublicationSnapshotSchema.parse(state.row.data);
      await manager.query('UPDATE route_publication SET version=$2,status=$3,data=$4::jsonb,runtime=$5::jsonb WHERE id=$1',
        [id, state.row.version, state.row.status, JSON.stringify(state.row.data), JSON.stringify(state.row.runtime)]);
      await manager.query(`INSERT INTO route_revision(route_id,version,status,data,runtime,actor_id,actor_name,action,reason)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`, [id, state.row.version, state.row.status, JSON.stringify(state.row.data), JSON.stringify(state.row.runtime), actor.id, actor.name, action, reason]);
      await manager.query('INSERT INTO route_command(route_id,request_id,fingerprint,result_version) VALUES($1,$2,$3,$4)', [id, command.requestId, fingerprint, state.row.version]);
      for (const stop of state.stops) await this.store.audit(manager, actor, action, { routeId: id, routeVersion: state.row.version, appointmentId: stop.appointment.id, reason }, stop.delivery.id);
      return this.describe(manager, state, actor);
    });
  }

  private currentPlan(state: State): RouteDraftInput {
    return RouteDraftInputSchema.parse({ ...state.row.data.draft, stops: state.row.data.draft.stops.map((planned) => {
      const stop = state.stops.find(({ deliveryId }) => deliveryId === planned.deliveryId);
      if (!stop) throw new Error('Published stop plan is unavailable');
      return { ...planned, appointmentId: stop.appointment.id, workFingerprint: routeJob(stop.delivery, undefined, stop.appointment.id).workFingerprint };
    }) });
  }

  private async departureBlocker(manager: EntityManager, state: State, actor: Caller) {
    if (state.row.status !== 'published') return { code: 'ROUTE_NOT_PUBLISHED', message: 'Only a published route awaiting departure can depart' };
    if (!actionParticipant(state, actor)) return { code: 'ROUTE_RESPONSIBLE_REQUIRED', message: actionParticipantRequirement(state) };
    const next = nextStop(state);
    if (!next) return { code: 'ROUTE_NO_PENDING_STOP', message: 'The route has no pending stop' };
    if (next.appointment.status !== 'booked') return { code: 'ROUTE_HAS_STARTED_WORK', message: 'Review the already started stop before departure' };
    if (!next.appointment.customerConfirmation) return { code: 'CUSTOMER_CONFIRMATION_REQUIRED', message: 'The next customer must confirm before departure' };
    if (appointmentScopeReviewReason(next.delivery, next.appointment)) return { code: 'VISIT_WORK_REVIEW_REQUIRED', message: 'Review the next stop work before departure' };
    const locationBlocker = await this.drafts.locationDepartureBlocker(manager, state.row.data.draft, state.row.data.review.locations);
    if (locationBlocker) return locationBlocker;
    const calendarBlocker = await this.drafts.calendarDepartureBlocker(manager, state.row.data.draft, state.row.data.review.timeline, state.row.data.review.calendar);
    if (calendarBlocker) return calendarBlocker;
    if (state.row.data.draft.planning?.availabilityMode === 'shared_calendar') {
      try {
        const current = await this.drafts.preparePublication({ ...this.currentPlan(state), departAt: new Date().toISOString() }, manager,
          state.stops.map(({ delivery }) => delivery), state.row.id);
        if (current.preview.feasibility.status !== 'feasible_estimate') return {
          code: 'ROUTE_DEPARTURE_BLOCKED', message: 'The current departure-to-return schedule conflicts with availability or needs review.',
        };
      } catch (error: unknown) {
        if (error instanceof DomainError || error instanceof HttpException) return {
          code: 'ROUTE_DEPARTURE_BLOCKED', message: 'The current route needs review before departure.',
        };
        throw error;
      }
    }
    return this.inTransitConflict(manager, state);
  }

  private async inTransitConflict(manager: EntityManager, state: State) {
    const resources = await rows(manager, z.object({ resource: z.string() }), 'SELECT resource FROM route_reservation WHERE route_id=$1', [state.row.id]);
    return routeResourceStartBlocker(manager, resources.map(({ resource }) => resource), state.row.id, state.row.data.draft.planning?.transferBufferMinutes ?? 0);
  }

  async depart(id: string, input: unknown, actor: Caller, request?: unknown) {
    const command = actor.role === 'crew' ? RouteActionInputSchema.parse(input) : RouteReasonInputSchema.parse(input);
    const reason = 'reason' in command && typeof command.reason === 'string' ? command.reason : null;
    return this.mutate(id, command, actor, 'route.departed', reason, async (manager, state) => {
      requireActionParticipant(state, actor);
      const blocker = await this.departureBlocker(manager, state, actor);
      if (blocker) throw new DomainError(blocker.code, blocker.message);
      const now = new Date().toISOString();
      const plan = { ...this.currentPlan(state), departAt: now };
      const prepared = await this.drafts.preparePublication(plan, manager, state.stops.map(({ delivery }) => delivery), id);
      if (prepared.preview.feasibility.status !== 'feasible_estimate') throw new DomainError('ROUTE_DEPARTURE_BLOCKED', 'The current departure would conflict with the complete trip or needs review', 409, prepared.preview.feasibility.findings.map(({ code }) => code));
      const returnAt = prepared.preview.timeline.returnAt;
      if (!returnAt) throw new DomainError('ROUTE_DEPARTURE_BLOCKED', 'The estimated return is unknown');
      state.row.status = 'in_progress'; state.row.runtime.departed = { ...event(actor, reason), at: now };
      await manager.query('UPDATE route_reservation SET starts_at=$2,ends_at=$3 WHERE route_id=$1', [id, now, returnAt]);
    }, request);
  }

  async cancel(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteCancelInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.cancelled', command.reason, async (manager, state) => {
      if (state.row.status !== 'published' || state.row.runtime.departed) throw new DomainError('ROUTE_ALREADY_DEPARTED', 'Use the abort and return workflow after departure or loading');
      const explicit = new Set(command.cancelAttachedAppointmentIds);
      if (explicit.size !== command.cancelAttachedAppointmentIds.length || [...explicit].some((appointmentId) => !state.stops.some((stop) => stop.appointmentId === appointmentId && stop.source === 'attached'))) {
        throw new DomainError('INVALID_ATTACHED_SELECTION', 'Choose each attached appointment to cancel at most once', 400);
      }
      if (state.stops.some(({ appointment }) => appointment.actualStartedAt || appointment.results.length || appointment.status === 'in_progress')) throw new DomainError('ROUTE_HAS_STARTED_WORK', 'Started or reported work cannot be cancelled');
      // Deactivate exact memberships before rebuilding standalone ownership; rollback restores everything on conflict.
      await manager.query('UPDATE route_stop SET active=false WHERE route_id=$1', [id]);
      // All children switch ownership together. Stale route-introduced child rows must
      // not conflict with another child's standalone restoration mid-transaction.
      await manager.query('DELETE FROM reservation WHERE appointment_id=ANY($1::uuid[])', [state.stops.map(({ appointmentId }) => appointmentId)]);
      await manager.query('DELETE FROM transport_reservation WHERE appointment_id=ANY($1::uuid[])', [state.stops.map(({ appointmentId }) => appointmentId)]);
      state.row.status = 'cancelled'; state.row.runtime.cancelled = event(actor, command.reason);
      for (const stop of state.stops) {
        if (stop.source === 'created' || explicit.has(stop.appointmentId)) {
          await this.cancelStop(manager, state, stop, actor, command.reason);
        } else {
          const originalIds = new Set(stop.provenance.originalAppointment?.transportAllocations?.map(({ id }) => id) ?? []);
          for (const allocation of activeTransport(stop.appointment)) if (!originalIds.has(allocation.id)) this.vehicles.retire(stop.appointment, allocation.id, 'cancelled', `Route detached: ${command.reason}`, actor);
          for (const allocation of stop.provenance.originalAppointment ? activeTransport(stop.provenance.originalAppointment) : []) {
            if (activeTransport(stop.appointment).some(({ id: allocationId }) => allocationId === allocation.id)) continue;
            if (Date.parse(allocation.reserveFrom) > Date.parse(stop.appointment.startsAt) || Date.parse(allocation.reserveTo) < Date.parse(stop.appointment.endsAt)) {
              throw new DomainError('ATTACHED_TRANSPORT_RESTORE_REVIEW', 'The original attached transport no longer covers the current appointment. Review restoration or explicitly cancel that visit.');
            }
            const driver = allocation.driver.kind === 'participant' ? { kind: 'participant' as const, participantId: allocation.driver.person.id } : allocation.driver;
            await this.vehicles.add(manager, stop.appointment, [{ vehicleId: allocation.vehicle.id, reserveFrom: allocation.reserveFrom, reserveTo: allocation.reserveTo, driver }], actor, allocation.id);
          }
          // Preserve current scope/staffing/customer confirmation and post-publication facts. Provenance restores ownership, not an old aggregate.
          await this.vehicles.rebuild(manager, stop.appointment); state.dirty.add(stop.deliveryId);
        }
      }
    });
  }

  private async prepareAmend(manager: EntityManager, state: State, command: z.infer<typeof RouteAmendReviewInputSchema>) {
    if (state.row.version !== command.version) throw new DomainError('ROUTE_VERSION_CHANGED', 'The route changed. Refresh before reviewing it.');
    if (state.row.status !== 'published' || state.row.runtime.departed || state.stops.some(({ appointment }) => appointment.status !== 'booked' || appointment.actualStartedAt || appointment.results.length)) {
      throw new DomainError('ROUTE_ALREADY_STARTED', 'Only an unstarted, unloaded published route can be amended');
    }
    const plan = normalizeRouteDraftInput(command.plan);
    const planning = plan.planning;
    if (!plan.crewId || !plan.vehicleId || !planning || !planning.participantIds.length || planning.transferBufferMinutes === null) {
      throw new DomainError('ROUTE_RESOURCES_REQUIRED', 'Review crew, people, vehicle and transfer buffer');
    }
    if (plan.stops.length !== state.stops.length || plan.stops.some((stop) => !state.stops.some(({ appointmentId, deliveryId }) => appointmentId === stop.appointmentId && deliveryId === stop.deliveryId))) {
      throw new DomainError('ROUTE_EXACT_STOPS_REQUIRED', 'Amend the existing exact visits; additions and removals require a separate reviewed route');
    }
    const responsibleIds = new Map(command.responsibleParticipants.map(({ appointmentId, participantId }) => [appointmentId, participantId]));
    if (responsibleIds.size !== state.stops.length || command.responsibleParticipants.length !== state.stops.length || state.stops.some(({ appointmentId }) => !responsibleIds.has(appointmentId))) {
      throw new DomainError('ROUTE_RESPONSIBLE_REQUIRED', 'Choose one responsible participant for each exact stop', 400);
    }
    const [crew] = await this.people.crews(manager, [plan.crewId]);
    if (!crew?.enabled) throw new DomainError('CREW_UNAVAILABLE', 'The selected crew is disabled or unavailable');
    await this.vehicles.requireAvailable(manager, plan.vehicleId);
    const selected = await this.people.selected(manager, planning.participantIds);
    if (selected.some(({ enabled }) => !enabled)) throw new DomainError('PARTICIPANT_UNAVAILABLE', 'A selected participant is disabled');
    const projected = structuredClone(state.stops);
    for (const stop of projected) {
      requireReviewedVisitScope(stop.delivery, stop.appointment);
      const original = stop.appointment.assignments;
      const assignmentId = original[0]?.id;
      if (!assignmentId) throw new DomainError('TASK_REQUIREMENTS_UNKNOWN', 'The original visit assignment is missing');
      const tasks = original.flatMap(({ tasks }) => tasks);
      if (tasks.some(({ requiredSkillsSnapshot }) => requiredSkillsSnapshot === undefined)) throw new DomainError('TASK_SKILLS_UNKNOWN', 'Review the saved task skill requirements first');
      const requirements = [...new Map(tasks.flatMap(({ requiredSkillsSnapshot }) => requiredSkillsSnapshot ?? []).map((skill) => [skill.id, skill])).values()];
      const qualified = await this.skills.qualify(manager, selected, requirements, crew.name);
      // Preserve the exact task and checklist snapshots. Only reviewed staffing changes here.
      stop.appointment.assignments = [{ id: assignmentId, crewId: crew.id, crewName: crew.name, people: qualified, tasks }];
      const responsibleId = responsibleIds.get(stop.appointmentId);
      const person = responsibleId ? assignedParticipant(stop.appointment, responsibleId) : undefined;
      if (!person) throw new DomainError('VISIT_RESPONSIBLE_NOT_ASSIGNED', 'Every responsible participant must be among the newly assigned people');
      stop.appointment.responsibleParticipant = { id: person.id, name: person.name };
      // Existing allocations are preserved in history during apply, not compared as the proposed new vehicle.
      stop.appointment.transportAllocations = [];
    }
    const ordered = plan.stops.map((item) => {
      const stop = projected.find(({ appointmentId }) => appointmentId === item.appointmentId);
      if (!stop) throw new Error('Amendment projection lost an exact stop');
      return stop;
    });
    const prepared = await this.drafts.preparePublication(plan, manager, ordered.map(({ delivery }) => delivery), state.row.id);
    const reset: string[] = [];
    for (const stop of ordered) {
      const timeline = prepared.preview.timeline.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
      if (!timeline?.workStartAt || !timeline.workEndAt || !prepared.preview.timeline.returnAt) throw new DomainError('ROUTE_SCHEDULE_UNKNOWN', 'Complete the estimated travel and work times before amendment');
      const original = state.stops.find(({ appointmentId }) => appointmentId === stop.appointmentId);
      const oldPlan = state.row.data.draft.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
      const newPlan = plan.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
      if (!original) throw new Error('Original route stop missing');
      if (Date.parse(original.appointment.startsAt) !== Date.parse(timeline.workStartAt) || Date.parse(original.appointment.endsAt) !== Date.parse(timeline.workEndAt)
        || digest(oldPlan?.customerWindow ?? null) !== digest(newPlan?.customerWindow ?? null)) {
        delete stop.appointment.customerConfirmation; reset.push(stop.appointmentId);
      }
      stop.appointment.startsAt = timeline.workStartAt; stop.appointment.endsAt = timeline.workEndAt;
    }
    const fingerprint = digest({ version: state.row.version, command, sourceVersions: state.stops.map(({ delivery }) => ({ id: delivery.id, version: delivery.version })),
      dependencies: prepared.preview.feasibility.fingerprint, points: prepared.preview.pointContexts, appointments: ordered.map(({ appointment }) => appointment) });
    const review = PublicationReviewSchema.parse({ routeId: state.row.id, draftVersion: state.row.data.review.draftVersion, fingerprint,
      publicationEnabled: true, timeline: prepared.preview.timeline, feasibility: prepared.preview.feasibility, locations: prepared.preview.locations,
      calendar: prepared.preview.calendar,
      stops: ordered.map((stop) => ({ deliveryId: stop.deliveryId, pickingName: stop.delivery.source.pickingName, mode: stop.source === 'created' ? 'create' : 'attach', appointmentId: stop.appointmentId,
        startsAt: stop.appointment.startsAt, endsAt: stop.appointment.endsAt, workScope: stop.appointment.workScope, assignments: stop.appointment.assignments,
        responsibleParticipant: stop.appointment.responsibleParticipant, customerConfirmationStatus: customerConfirmationStatus(stop.appointment) })) });
    return { plan, ordered, response: RouteAmendReviewSchema.parse({ fingerprint, review, confirmationResetAppointmentIds: reset }) };
  }

  async amendReview(id: string, input: unknown) {
    const command = RouteAmendReviewInputSchema.parse(input);
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => (await this.prepareAmend(manager, await this.load(manager, id), command)).response);
  }

  async amend(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteAmendInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.amended', command.reason, async (manager, state) => {
      const selection = RouteAmendReviewInputSchema.strip().parse(command);
      const fingerprint = command.fingerprint;
      const prepared = await this.prepareAmend(manager, state, selection);
      if (prepared.response.fingerprint !== fingerprint) throw new DomainError('ROUTE_PREVIEW_STALE', 'The route or its dependencies changed. Review the amendment again.');
      if (prepared.response.review.feasibility.status !== 'feasible_estimate') throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'Resolve every conflict and unknown before applying the amendment');
      const { plan, ordered } = prepared;
      const planning = plan.planning; const returnAt = prepared.response.review.timeline.returnAt;
      if (!planning || planning.transferBufferMinutes === null || !returnAt || !plan.vehicleId || !plan.crewId) throw new Error('Reviewed amendment lost required resources');
      await manager.query('SET CONSTRAINTS route_stop_route_id_sequence_key DEFERRED');
      await manager.query('DELETE FROM route_reservation WHERE route_id=$1', [id]);
      const resources = new Set([`crew:${plan.crewId}`, `vehicle:${plan.vehicleId}`, ...planning.participantIds.map((personId) => `person:${personId}`)]);
      for (const resource of [...resources].sort()) await manager.query('INSERT INTO route_reservation(route_id,resource,starts_at,ends_at,buffer_minutes) VALUES($1,$2,$3,$4,$5)',
        [id, resource, plan.departAt, returnAt, planning.transferBufferMinutes]);
      for (const [index, stop] of ordered.entries()) {
        const original = state.stops.find(({ appointmentId }) => appointmentId === stop.appointmentId);
        if (!original) throw new Error('Original stop missing during amendment');
        stop.appointment.transportAllocations = structuredClone(original.appointment.transportAllocations ?? []);
        for (const allocation of activeTransport(stop.appointment)) this.vehicles.retire(stop.appointment, allocation.id, 'replaced', command.reason, actor);
        await this.vehicles.add(manager, stop.appointment, [{ vehicleId: plan.vehicleId, reserveFrom: plan.departAt, reserveTo: returnAt, driver: { kind: 'none' } }], actor);
        stop.sequence = index + 1;
        await manager.query('UPDATE route_stop SET sequence=$2 WHERE id=$1', [stop.id, stop.sequence]);
        await manager.query('UPDATE appointment SET starts_at=$2,ends_at=$3 WHERE id=$1', [stop.appointmentId, stop.appointment.startsAt, stop.appointment.endsAt]);
        await this.vehicles.rebuild(manager, stop.appointment); state.dirty.add(stop.deliveryId);
      }
      state.stops = ordered;
      state.row.data.draft = plan; state.row.data.review = prepared.response.review;
      delete state.row.data.command.externalDriverPhone;
      state.row.data.appointments = ordered.map(({ deliveryId, appointment }) => ({ deliveryId, appointment: structuredClone(appointment) }));
    });
  }

  private async cancelStop(manager: EntityManager, state: State, stop: Stop, actor: OperatorActor, reason: string) {
    if (stop.appointment.status !== 'booked' && stop.appointment.status !== 'cancelled') throw new DomainError('STOP_ALREADY_STARTED', 'Only an unstarted stop can be skipped or cancelled');
    stop.appointment.status = 'cancelled'; stop.appointment.cancellationReason = reason;
    for (const allocation of activeTransport(stop.appointment)) this.vehicles.retire(stop.appointment, allocation.id, 'cancelled', reason, actor);
    const request = stop.delivery.returnRequests.find(({ id }) => id === stop.appointment.returnRequestId);
    if (request) { request.status = 'requested'; request.appointmentId = null; }
    await manager.query('UPDATE appointment SET status=$2 WHERE id=$1', [stop.appointmentId, 'cancelled']);
    await this.vehicles.rebuild(manager, stop.appointment); state.dirty.add(stop.deliveryId);
  }

  async skip(id: string, appointmentId: string, input: unknown, actor: OperatorActor) {
    const command = RouteReasonInputSchema.parse(input);
    return this.mutate(id, { ...command, appointmentId }, actor, 'route.stop_skipped', command.reason, async (manager, state) => {
      if (['closed', 'cancelled'].includes(state.row.status)) throw new DomainError('ROUTE_CLOSED', 'This route no longer accepts stop changes');
      const stop = state.stops.find((entry) => entry.appointmentId === appointmentId);
      if (!stop) throw new NotFoundException('Route stop not found');
      if (stop.appointment.status !== 'booked' || stop.appointment.results.length) throw new DomainError('STOP_ALREADY_STARTED', 'A stop that has started or was reported cannot be skipped');
      await this.cancelStop(manager, state, stop, actor, command.reason);
      state.row.runtime.skipped.push({ ...event(actor, command.reason), appointmentId });
    });
  }

  async abort(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteReasonInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.aborted', command.reason, (_manager, state) => {
      if (!['published', 'in_progress', 'returning'].includes(state.row.status)) throw new DomainError('ROUTE_NOT_ACTIVE', 'Only a published or active route can be aborted');
      state.row.status = 'returning'; state.row.runtime.aborted = event(actor, command.reason);
      state.row.runtime.returning ??= event(actor, command.reason);
      // Keep all custody and reservations until explicit physical return. Missing reports are not zero-quantity reports.
    });
  }

  async returning(id: string, input: unknown, actor: Caller, request?: unknown) {
    const command = actor.role === 'crew' ? RouteActionInputSchema.parse(input) : RouteReasonInputSchema.parse(input);
    const reason = 'reason' in command && typeof command.reason === 'string' ? command.reason : null;
    return this.mutate(id, command, actor, 'route.returning', reason, (_manager, state) => {
      requireActionParticipant(state, actor);
      if (state.row.status !== 'in_progress') throw new DomainError('ROUTE_NOT_IN_PROGRESS', 'Only a route in progress can begin returning');
      if (actor.role === 'crew' && state.stops.some(({ appointment }) => !terminal(appointment))) throw new DomainError('ROUTE_UNFINISHED_STOPS', 'Ask the dispatcher to review unfinished stops before ending the queue');
      state.row.status = 'returning'; state.row.runtime.returning = event(actor, reason);
    }, request);
  }

  async returned(id: string, input: unknown, actor: Caller, request?: unknown) {
    const command = RouteReturnInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.returned', command.note ?? null, async (manager, state) => {
      requireActionParticipant(state, actor);
      if (!['in_progress', 'returning'].includes(state.row.status)) throw new DomainError('ROUTE_NOT_IN_TRANSIT', 'Only an active or returning route can record physical return');
      const at = Date.parse(command.actualReturnedAt); const departed = state.row.runtime.departed?.at;
      if (at > Date.now() || at < Date.parse(state.row.data.publishedAt) || departed && at <= Date.parse(departed)) throw new DomainError('INVALID_RETURN_TIME', 'Actual return must be after publication and departure and cannot be in the future', 400);
      state.row.runtime.returned = { ...event(actor, command.note ?? null), actualReturnedAt: command.actualReturnedAt };
      state.row.status = 'returned';
      // An aborted loaded route may never have departed. Preserve that uncertainty instead of inventing departure.
      await manager.query(`UPDATE route_reservation SET starts_at=LEAST(starts_at,$2::timestamptz-interval '1 millisecond'),ends_at=$2 WHERE route_id=$1`, [id, command.actualReturnedAt]);
    }, request);
  }

  private async validateReconciliation(manager: EntityManager, state: State, declarations: z.infer<typeof RouteReconcileInputSchema>['lines']) {
    const lines = this.lines(state);
    const key = (line: { appointmentId: string; sourceLineId: number }) => `${line.appointmentId}:${line.sourceLineId}`;
    if (declarations.length !== lines.length || new Set(declarations.map(key)).size !== lines.length || declarations.some((entry) => !lines.some((line) => key(line) === key(entry)))) {
      throw new DomainError('RECONCILIATION_EXACT_LINES_REQUIRED', 'Review every exact visit and source product line once');
    }
    const ownerIds = [...new Set(declarations.flatMap((line) => [line.ownerUserId, ...line.nextActions.map(({ ownerUserId }) => ownerUserId)]))];
    await requireDispatcherOwners(manager, ownerIds, 'RECONCILIATION_OWNER_UNAVAILABLE');
    for (const declaration of declarations) {
      const line = lines.find((item) => key(item) === key(declaration));
      const stop = state.stops.find(({ appointmentId }) => appointmentId === declaration.appointmentId);
      if (!line || !stop) throw new Error('Exact reconciliation line unavailable');
      const remaining = { delivery: line.remainingDeliveryMilli, installation: line.remainingInstallationMilli, collection: line.remainingCollectionMilli };
      if (new Set(declaration.nextActions.map(({ operation }) => operation)).size !== declaration.nextActions.length) throw new DomainError('RECONCILIATION_DUPLICATE_ACTION', 'Choose one next action for each remaining operation');
      for (const operation of ['delivery', 'installation', 'collection'] as const) {
        const action = declaration.nextActions.find((entry) => entry.operation === operation);
        if (remaining[operation] > 0 && !action) throw new DomainError('RECONCILIATION_NEXT_ACTION_REQUIRED', 'Every remaining operation needs an owner and next action');
        if (action && remaining[operation] === 0) throw new DomainError('RECONCILIATION_WORK_CHANGED', 'Remove next actions for work that is already complete');
        if (!action) continue;
        if (action.action === 'installation_visit' && operation !== 'installation') throw new DomainError('RECONCILIATION_INVALID_ACTION', 'Installation visits apply only to installation work');
        if (line.planningBlockedReason && ['ready_for_repeat', 'installation_visit', 'already_planned'].includes(action.action)) throw new DomainError('RECONCILIATION_WORK_BLOCKED', 'Resolve the product-line planning hold or record an appropriate waiting action');
        if (action.action === 'already_planned') {
          const followUp = stop.delivery.appointments.find(({ id }) => id === action.followUpAppointmentId && id !== declaration.appointmentId);
          const scope = followUp?.workScope?.lines.find(({ sourceLineId }) => sourceLineId === declaration.sourceLineId);
          const quantities = scope ? { delivery: scope.deliveryMilli, installation: scope.installationMilli, collection: scope.collectionMilli } : null;
          if (!followUp || !['booked', 'in_progress'].includes(followUp.status) || !quantities || quantities[operation] <= 0) throw new DomainError('RECONCILIATION_FOLLOWUP_MISMATCH', 'Choose a live follow-up visit reserving this exact product-line operation');
        } else if (action.followUpAppointmentId !== null) throw new DomainError('RECONCILIATION_FOLLOWUP_MISMATCH', 'A follow-up reference is used only with already planned work');
      }
      if (new Set(declaration.cargo.map(({ kind }) => kind)).size !== declaration.cargo.length) throw new DomainError('RECONCILIATION_DUPLICATE_CARGO', 'Declare each cargo kind once per product line');
      for (const cargo of declaration.cargo) {
        const maximum = cargo.kind === 'collection' ? line.collectedMilli : Math.max(0, line.plannedDeliveryMilli - line.deliveredMilli);
        if (cargo.kind === 'collection' && line.plannedCollectionMilli === 0 || cargo.kind === 'undelivered' && line.plannedDeliveryMilli <= line.deliveredMilli) {
          throw new DomainError('RECONCILIATION_CARGO_MISMATCH', 'This cargo kind does not belong to the selected visit and line');
        }
        if (cargo.quantityMilli !== null && cargo.quantityMilli > maximum) throw new DomainError('RECONCILIATION_CARGO_EXCEEDS_FACTS', 'Declared cargo exceeds the exact reported collection or outstanding visit delivery');
        if (cargo.location === 'customer' && (cargo.quantityMilli ?? 0) > 0) throw new DomainError('RECONCILIATION_CARGO_CONTRADICTS_REPORT', 'Goods reported as collected or still undelivered cannot be claimed as completed customer handover; review the report or record unknown custody');
        if (cargo.location !== 'unknown' && cargo.quantityMilli === null) throw new DomainError('RECONCILIATION_CARGO_QUANTITY_REQUIRED', 'Enter a verified quantity or explicitly keep cargo unknown');
        if (cargo.kind === 'collection' && cargo.location === 'warehouse' && (cargo.quantityMilli ?? 0) > line.warehouseReceivedCollectionMilli) throw new DomainError('WAREHOUSE_RECEIPT_REQUIRED', 'Collected furniture needs a separate warehouse receipt before claiming warehouse custody');
      }
    }
  }

  async reconcile(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteReconcileInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.reconciled', command.reason, async (manager, state) => {
      if (state.row.status !== 'returned' && !(state.row.status === 'closed' && state.row.runtime.closureException)) throw new DomainError('ROUTE_RETURN_REQUIRED', 'Reconcile a returned route or append follow-up to an explicitly closed exception');
      await this.validateReconciliation(manager, state, command.lines);
      state.row.runtime.reconciliation = { at: new Date().toISOString(), actor: actorSnapshot(actor), reason: command.reason, lines: command.lines };
    });
  }

  async warehouseReceipt(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteWarehouseReceiptInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.warehouse_received', command.reason, (_manager, state) => {
      if (!['returned', 'closed'].includes(state.row.status)) throw new DomainError('ROUTE_RETURN_REQUIRED', 'Record actual return before warehouse receipt');
      const lines = this.lines(state); const seen = new Set<string>();
      for (const item of command.items) {
        const key = `${item.appointmentId}:${item.sourceLineId}:${item.kind}`;
        if (seen.has(key)) throw new DomainError('WAREHOUSE_DUPLICATE_LINE', 'Choose each exact cargo line once');
        seen.add(key);
        const line = lines.find((entry) => entry.appointmentId === item.appointmentId && entry.sourceLineId === item.sourceLineId);
        if (!line) throw new DomainError('WAREHOUSE_LINE_MISMATCH', 'The cargo does not belong to this route visit and source line');
        const limit = cargoReceiptBalance(line, item.kind);
        if (item.quantityMilli > limit) throw new DomainError('WAREHOUSE_RECEIPT_EXCEEDS_CARGO', 'Receipt exceeds the remaining verified cargo quantity for this exact line');
      }
      state.row.runtime.warehouseReceipts.push({ id: randomUUID(), at: new Date().toISOString(), actor: actorSnapshot(actor), reason: command.reason, items: command.items });
    });
  }

  async close(id: string, input: unknown, actor: OperatorActor) {
    const command = RouteCloseInputSchema.parse(input);
    return this.mutate(id, command, actor, 'route.closed', command.reason, async (manager, state) => {
      if (state.row.status !== 'returned' || !state.row.runtime.returned) throw new DomainError('ROUTE_RETURN_REQUIRED', 'Record physical return before closing the route');
      if (state.stops.some(({ appointment }) => appointment.status === 'booked')) throw new DomainError('UNSTARTED_STOP_REQUIRES_SKIP', 'Explicitly skip each unstarted stop before closing; its remaining work must stay available for planning');
      const reconciliation = state.row.runtime.reconciliation;
      if (!reconciliation) throw new DomainError('RECONCILIATION_REQUIRED', 'Assign the remaining-work and cargo actions before closure');
      await this.validateReconciliation(manager, state, reconciliation.lines);
      const blockers = this.closureBlockers(state);
      if (blockers.length && !command.exceptionReason) throw new DomainError('ROUTE_RECONCILIATION_INCOMPLETE', 'Resolve the missing reports or cargo, or document an explicit dispatcher exception', 409, blockers);
      state.row.status = 'closed'; state.row.runtime.closed = event(actor, command.reason);
      state.row.runtime.closureException = blockers.length ? command.exceptionReason ?? null : null;
      // Administrative closure never fabricates reports, warehouse receipts or delivery completion.
    });
  }

  private lines(state: State) {
    return routeLineStatuses(state.stops, state.row.runtime);
  }

  private closureBlockers(state: State) {
    return this.closureIssues(state).map(({ message }) => message);
  }

  private closureIssues(state: State) {
    const blockers: { code: string; message: string; appointmentId: string | null; sourceLineId: number | null }[] = [];
    const add = (code: string, message: string, line?: { appointmentId: string; sourceLineId: number }) => blockers.push({ code, message, appointmentId: line?.appointmentId ?? null, sourceLineId: line?.sourceLineId ?? null });
    if (!state.row.runtime.returned) add('RETURN_REQUIRED', 'Record the actual return before closing the route');
    if (state.stops.some(({ appointment }) => appointment.status === 'booked')) add('UNSTARTED_STOP_REQUIRES_SKIP', 'Explicitly skip each unstarted stop before closing the route');
    if (!state.row.runtime.reconciliation) add('RECONCILIATION_REQUIRED', 'Review every product line and its next action');
    for (const line of this.lines(state)) {
      const label = `${line.orderName} · ${line.productName}`;
      if (line.remainingBasis === 'visit_snapshot_source_missing') add('SOURCE_LINE_MISSING', `${label}: the current source line is missing; quantities show only the original visit remainder`, line);
      if (line.reportMissing) add('REPORT_MISSING', `${label}: the stop report is missing`, line);
      if (!line.declaration) { add('LINE_RECONCILIATION_REQUIRED', `${label}: reconciliation is missing`, line); continue; }
      const needsUndelivered = line.plannedDeliveryMilli > line.deliveredMilli;
      const needsCollection = line.collectedMilli > 0 || line.reportMissing && line.plannedCollectionMilli > 0;
      if (needsUndelivered && !line.declaration.cargo.some(({ kind }) => kind === 'undelivered')
        || needsCollection && !line.declaration.cargo.some(({ kind }) => kind === 'collection')
        || line.declaration.cargo.some(({ quantityMilli, location }) => quantityMilli === null || location === 'unknown')) add('CARGO_UNKNOWN', `${label}: cargo is unknown`, line);
      for (const cargo of line.declaration.cargo) {
        const expected = cargo.kind === 'collection' ? line.collectedMilli : Math.max(0, line.plannedDeliveryMilli - line.deliveredMilli);
        if (cargo.quantityMilli !== null && cargo.quantityMilli !== expected) add('CARGO_QUANTITY_UNRESOLVED', `${label}: the declared cargo does not account for every outstanding unit`, line);
      }
      for (const [operation, quantity] of [['delivery', line.remainingDeliveryMilli], ['installation', line.remainingInstallationMilli], ['collection', line.remainingCollectionMilli]] as const) {
        if (quantity > 0 && !line.declaration.nextActions.some((action) => action.operation === operation)) add('NEXT_ACTION_REQUIRED', `${label}: ${operation} needs its next action`, line);
      }
      if (line.collectedMilli > line.warehouseReceivedCollectionMilli) add('COLLECTION_RECEIPT_REQUIRED', `${label}: collected goods await warehouse receipt`, line);
      if (line.warehouseReceivedCollectionMilli > line.collectedMilli || line.warehouseReceivedUndeliveredMilli > Math.max(0, line.plannedDeliveryMilli - line.deliveredMilli)) {
        add('CARGO_QUANTITY_UNRESOLVED', `${label}: report corrections and warehouse receipts need reconciliation`, line);
      }
      for (const cargo of line.declaration.cargo) if (cargo.kind === 'undelivered' && cargo.quantityMilli !== null && ['vehicle', 'awaiting_receipt'].includes(cargo.location) && cargo.quantityMilli > line.warehouseReceivedUndeliveredMilli) add('UNDELIVERED_RECEIPT_REQUIRED', `${label}: returned goods await warehouse receipt`, line);
    }
    return blockers;
  }

  private async describe(manager: EntityManager, state: State, actor: Caller) {
    const { row } = state;
    const lines = this.lines(state); const next = nextStop(state);
    const departBlocker = await this.departureBlocker(manager, state, actor);
    const closureBlockers = this.closureBlockers(state);
    const snapshots = row.data.appointments.flatMap(({ appointment }) => activeTransport(appointment));
    const transport = snapshots.find(({ vehicle }) => vehicle.id === row.data.draft.vehicleId);
    const assignment = state.stops[0]?.appointment.assignments[0] ?? row.data.review.stops[0]?.assignments[0];
    if (!transport || !assignment) throw new Error('Published route resource snapshots are unavailable');
    const stops = [];
    const effectivePoints = await this.entrances.effectivePointsFor(state.stops.map(({ delivery }) => delivery), manager);
    for (const stop of state.stops) {
      const timeline = row.data.review.timeline.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
      const plan = row.data.draft.stops.find(({ deliveryId }) => deliveryId === stop.deliveryId);
      const addressKey = destinationAddressKey(stop.delivery.source.customer);
      const effective = effectivePoints.get(stop.deliveryId);
      const pin = plan?.pin?.addressKey === addressKey ? plan.pin : undefined;
      const point = effective?.pointSource === 'confirmed_entrance' ? effective.point : pin ?? effective?.point;
      const rule = appointmentScopeReviewReason(stop.delivery, stop.appointment);
      const routeBlocker = stop.appointment.status === 'booked' ? await routeVisitStartBlocker(manager, stop.appointmentId) : null;
      const canStart = stop.appointment.status === 'booked' && rule === null && !!stop.appointment.customerConfirmation && routeBlocker === null;
      stops.push({ deliveryId: stop.deliveryId, appointmentId: stop.appointmentId, sequence: stop.sequence, source: stop.source,
        pickingName: stop.delivery.source.pickingName, customerName: stop.delivery.source.customer.name, address: stop.delivery.source.customer.address,
        city: stop.delivery.source.customer.city, entrance: point ? { ...point, addressKey } : null, customerWindow: plan?.customerWindow ?? null,
        ...(!pin && effective?.pointSource === 'geocoded' ? { geocoding: effective.geocoding } : {}),
        eta: timeline?.eta ?? null, workStartAt: timeline?.workStartAt ?? null, workEndAt: timeline?.workEndAt ?? null,
        status: stop.appointment.status, confirmationStatus: customerConfirmationStatus(stop.appointment), responsibleParticipant: stop.appointment.responsibleParticipant ?? null,
        workScope: stop.appointment.workScope ?? null, canStart, startBlocker: routeBlocker?.message ?? (rule ? 'Review the selected work' : !stop.appointment.customerConfirmation && stop.appointment.status === 'booked' ? 'Awaiting customer confirmation' : null),
        startBlockerCode: routeBlocker?.code ?? (rule ? 'VISIT_WORK_REVIEW_REQUIRED' : !stop.appointment.customerConfirmation && stop.appointment.status === 'booked' ? 'CUSTOMER_CONFIRMATION_REQUIRED' : null),
        skipped: row.runtime.skipped.some(({ appointmentId }) => appointmentId === stop.appointmentId), reported: stop.appointment.results.length > 0 || !!stop.appointment.failedAttempt,
      });
    }
    const history = await rows(manager, z.object({ version: z.number().int().positive(), action: z.string(), actorId: IdSchema, actorName: z.string(), at: z.date(), reason: z.string().nullable(), status: PublicationStatusSchema }),
      'SELECT version,action,actor_id AS "actorId",actor_name AS "actorName",at,reason,status FROM route_revision WHERE route_id=$1 ORDER BY version DESC LIMIT 1000', [row.id]);
    const canAct = actionParticipant(state, actor);
    const returnBlocker = row.status !== 'in_progress' ? 'The route is not in progress' : state.stops.some(({ appointment }) => !terminal(appointment)) ? 'Some stops still need a report or an explicit dispatcher skip' : null;
    return RouteOperationsSchema.parse({ id: row.id, version: row.version, status: row.status, name: row.data.draft.name,
      draft: this.currentPlan(state), review: row.data.review, runtime: row.runtime, externalDriverPhone: row.data.command.externalDriverPhone ?? null,
      resources: { crew: { id: assignment.crewId, name: assignment.crewName }, vehicle: transport.vehicle, driver: transport.driver, participants: activePeople(state).map(({ id, name }) => ({ id, name })),
        start: { id: row.data.draft.startPointId, name: row.data.review.locations?.start.name ?? routeDepots.find(({ id }) => id === row.data.draft.startPointId)?.name ?? row.data.draft.startPointId },
        end: { id: row.data.draft.endPointId, name: row.data.review.locations?.end.name ?? routeDepots.find(({ id }) => id === row.data.draft.endPointId)?.name ?? row.data.draft.endPointId } },
      routeResponsible: routeResponsible(state), nextAppointmentId: next?.appointmentId ?? null, stops, lines,
      capabilities: { canDepart: departBlocker === null, canReturn: canAct && returnBlocker === null,
        canMarkReturned: canAct && ['in_progress', 'returning'].includes(row.status), canAmend: actor.role !== 'crew' && row.status === 'published',
        canCancel: actor.role !== 'crew' && row.status === 'published',
        canReconcile: actor.role !== 'crew' && (row.status === 'returned' || row.status === 'closed' && !!row.runtime.closureException),
        canClose: actor.role !== 'crew' && row.status === 'returned' && closureBlockers.length === 0,
        departBlocker: departBlocker?.message ?? null, departBlockerCode: departBlocker?.code ?? null,
        returnBlocker: !canAct ? actionParticipantRequirement(state) : returnBlocker,
        returnBlockerCode: !canAct ? 'ROUTE_RESPONSIBLE_REQUIRED' : row.status !== 'in_progress' ? 'ROUTE_NOT_IN_PROGRESS' : returnBlocker ? 'ROUTE_UNFINISHED_STOPS' : null,
        closureBlockers, closureIssues: this.closureIssues(state) },
      history: history.length ? history.map(({ actorId, actorName, at, ...entry }) => ({ ...entry, actor: { id: actorId, name: actorName }, at: at.toISOString() }))
        : [{ version: 1, action: 'route.published', actor: row.data.publishedBy, at: row.data.publishedAt, reason: null, status: 'published' }],
    });
  }
}
