import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { config } from '../config';
import { rows } from '../database/database';
import { AppointmentSchema, IdSchema, TaskTemplateSchema, type Appointment, type Assignment, type Delivery, type OperatorActor, type TaskTemplate } from '../domain/model';
import { assignedParticipant, customerConfirmationStatus, DomainError, planVisitWork, requireReviewedVisitScope } from '../domain/rules';
import { instantiateAssignment } from '../operations/assignment-snapshot';
import { Participants } from '../operations/participants';
import { assertPlanningReady, retainWorkServiceDefault } from '../operations/planning';
import { Skills } from '../operations/skills';
import { DeliveryStore } from '../operations/store';
import { activeTransport, Vehicles } from '../operations/vehicles';
import { RouteDraftInputSchema, type RouteDraftInput } from './contracts';
import { PublicationReviewInputSchema, PublicationReviewSchema, PublicationSnapshotSchema, PublicationStatusSchema, PublicationSummarySchema, PublishInputSchema, type PublicationReviewInput } from './publication-contracts';
import { routeJob, RouteDrafts } from './service';

const DraftRowSchema = z.object({ id: IdSchema, version: z.number().int().positive(), data: RouteDraftInputSchema, updatedAt: z.date() });
const PublicationRowSchema = z.object({
  id: IdSchema, version: z.number().int().positive(), draftVersion: z.number().int().positive(), status: PublicationStatusSchema,
  data: PublicationSnapshotSchema, requestId: IdSchema, commandFingerprint: z.string(),
});
const PublicationColumns = 'id,version,draft_version AS "draftVersion",status,data,request_id AS "requestId",command_fingerprint AS "commandFingerprint"';
const ServiceReservationSchema = z.object({ resource: z.string() });
const TransportReservationSchema = z.object({ allocationId: IdSchema, resource: z.string(), startsAt: z.date(), endsAt: z.date() });
type Selection = PublicationReviewInput['stops'][number];
type PreparedStop = {
  selection: Selection; delivery: Delivery; appointment: Appointment;
  originalAppointment: Appointment | null;
  serviceReservations: z.infer<typeof ServiceReservationSchema>[];
  transportReservations: z.infer<typeof TransportReservationSchema>[];
};

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Stable review IDs avoid writing speculative appointments and keep retries independent of RNG. */
function reviewId(routeId: string, version: number, key: string): string {
  const value = hash({ routeId, version, key });
  return IdSchema.parse(`${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`);
}

function canonical(input: PublicationReviewInput): PublicationReviewInput {
  return {
    version: input.version,
    stops: input.stops.map((stop) => stop.mode === 'attach' ? stop : {
      ...stop, templateIds: [...stop.templateIds].sort(), workLines: [...stop.workLines].sort((a, b) => a.sourceLineId - b.sourceLineId),
    }),
    ...(input.externalDriverPhone ? { externalDriverPhone: input.externalDriverPhone } : {}),
  };
}

function publicationSummary(publication: z.infer<typeof PublicationRowSchema>) {
  return PublicationSummarySchema.parse({
    id: publication.id, version: publication.version, draftVersion: publication.draftVersion, status: publication.status,
    publishedAt: publication.data.publishedAt,
    stops: publication.data.review.stops.map(({ deliveryId, appointmentId, mode }) => ({ deliveryId, appointmentId, source: mode === 'create' ? 'created' : 'attached' })),
  });
}

@Injectable()
export class RoutePublication {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(RouteDrafts) private readonly drafts: RouteDrafts,
    @Inject(Participants) private readonly people: Participants,
    @Inject(Skills) private readonly skills: Skills,
    @Inject(Vehicles) private readonly vehicles: Vehicles,
  ) {}

  capability() {
    const enabled = config().ROUTE_PUBLICATION_ENABLED;
    return { enabled, reason: enabled ? null : 'Publication is disabled until departure, return and cancellation controls are available. Review is available without reserving resources.' };
  }

  private async find(manager: EntityManager, id: string) {
    return (await rows(manager, PublicationRowSchema, `SELECT ${PublicationColumns} FROM route_publication WHERE id=$1`, [id]))[0];
  }

  async get(id: string) {
    const publication = await this.find(this.store.db.source.manager, id);
    return publication ? { ...publicationSummary(publication), review: publication.data.review } : null;
  }

  async review(id: string, input: unknown, actor: OperatorActor) {
    const command = canonical(PublicationReviewInputSchema.parse(input));
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => (await this.prepare(manager, id, command, actor)).review);
  }

  async publish(id: string, input: unknown, actor: OperatorActor) {
    const command = PublishInputSchema.parse(input);
    if (!this.capability().enabled) throw new DomainError('ROUTE_PUBLICATION_DISABLED', 'Publication is disabled until the route execution controls are available');
    const { requestId, fingerprint, acknowledgeEstimates, ...selection } = command;
    const reviewed = canonical(selection);
    const commandFingerprint = hash({ routeId: id, ...reviewed, fingerprint, acknowledgeEstimates });
    return this.store.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const [receipt] = await rows(manager, PublicationRowSchema, `SELECT ${PublicationColumns} FROM route_publication WHERE request_id=$1`, [requestId]);
      if (receipt) {
        if (receipt.id !== id || receipt.commandFingerprint !== commandFingerprint) throw new DomainError('REQUEST_ID_CONFLICT', 'Request ID was already used for different publication input');
        return publicationSummary(receipt);
      }
      // Evidence finalization also writes delivery JSON under row locks, without
      // the scheduling advisory lock. Lock before reading so neither writer loses facts.
      await rows(manager,z.object({id:IdSchema}),
        'SELECT id FROM delivery WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [reviewed.stops.map(({deliveryId})=>deliveryId)]);
      const prepared = await this.prepare(manager, id, reviewed, actor);
      if (prepared.review.fingerprint !== fingerprint) throw new DomainError('ROUTE_PREVIEW_STALE', 'The reviewed route or its dependencies changed. Review publication again.');
      if (!acknowledgeEstimates) throw new DomainError('ROUTE_ESTIMATE_ACK_REQUIRED', 'Acknowledge that this reviewed schedule uses approximate travel estimates');
      if (prepared.review.feasibility.status !== 'feasible_estimate') {
        throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'Resolve all route conflicts and missing data before publication', 409,
          prepared.review.feasibility.findings.map(({ code }) => code));
      }
      const { timeline } = prepared.review;
      const reserveTo = timeline.returnAt;
      const planning = prepared.draft.data.planning;
      const vehicleId = prepared.draft.data.vehicleId;
      if (!reserveTo || !planning || planning.transferBufferMinutes === null || !vehicleId || planning.driver.kind === 'unknown') {
        throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'A complete trip, vehicle, driver and transfer buffer are required');
      }
      const driver = planning.driver.kind === 'participant'
        ? { kind: 'participant' as const, participantId: planning.driver.participantId }
        : { kind: 'external' as const, name: planning.driver.name, phone: reviewed.externalDriverPhone ?? '' };
      const publishedAt = new Date().toISOString();
      for (const stop of prepared.stops) {
        if (stop.selection.mode === 'create') {
          await manager.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',
            [stop.appointment.id, stop.delivery.id, stop.appointment.startsAt, stop.appointment.endsAt, 'booked']);
          const request = stop.delivery.returnRequests.find(({ id: returnId }) => returnId === stop.appointment.returnRequestId);
          if (request) { request.status = 'planned'; request.appointmentId = stop.appointment.id; }
        }
        if (activeTransport(stop.appointment).length === 0) {
          await this.vehicles.add(manager, stop.appointment, [{ vehicleId, reserveFrom: timeline.departAt, reserveTo, driver }], actor);
        }
      }
      const snapshot = PublicationSnapshotSchema.parse({
        draft: prepared.draft.data, command: reviewed, review: prepared.review,
        publishedBy: { id: actor.id, name: actor.name }, publishedAt, estimateAcknowledged: true,
        appointments: prepared.stops.map(({ delivery, appointment }) => ({ deliveryId: delivery.id, appointment })),
      });
      await manager.query(`INSERT INTO route_publication(id,version,draft_version,status,data,request_id,command_fingerprint)
        VALUES($1,1,$2,'published',$3::jsonb,$4,$5)`, [id, prepared.draft.version, JSON.stringify(snapshot), requestId, commandFingerprint]);
      for (const [index, stop] of prepared.stops.entries()) {
        const provenance = { originalAppointment: stop.originalAppointment, serviceReservations: stop.serviceReservations, transportReservations: stop.transportReservations };
        await manager.query(`INSERT INTO route_stop(id,route_id,appointment_id,delivery_id,sequence,source,active,provenance)
          VALUES($1,$2,$3,$4,$5,$6,true,$7::jsonb)`,
        [reviewId(id, prepared.draft.version, `stop:${index}`), id, stop.appointment.id, stop.delivery.id, index + 1, stop.selection.mode === 'create' ? 'created' : 'attached', JSON.stringify(provenance)]);
      }
      const resources = new Set([
        ...planning.participantIds.map((personId) => `person:${personId}`),
        `crew:${prepared.draft.data.crewId}`, `vehicle:${vehicleId}`,
      ]);
      for (const resource of [...resources].sort()) {
        await manager.query('INSERT INTO route_reservation(route_id,resource,starts_at,ends_at,buffer_minutes) VALUES($1,$2,$3,$4,$5)',
          [id, resource, timeline.departAt, reserveTo, planning.transferBufferMinutes]);
      }
      for (const stop of prepared.stops) {
        await this.vehicles.rebuild(manager, stop.appointment);
        stop.delivery.version += 1;
        await this.store.save(manager, stop.delivery);
        await this.store.audit(manager, actor, 'route.stop_published', {
          routeId: id, routeVersion: 1, appointmentId: stop.appointment.id, source: stop.selection.mode,
          workScope: stop.appointment.workScope, version: stop.delivery.version,
        }, stop.delivery.id);
      }
      await this.store.audit(manager, actor, 'route.published', { routeId: id, version: 1, draftVersion: prepared.draft.version, fingerprint, requestId });
      const publication = await this.find(manager, id);
      if (!publication) throw new Error('Published route insert did not return a record');
      return publicationSummary(publication);
    });
  }

  private async prepare(manager: EntityManager, id: string, command: PublicationReviewInput, actor: OperatorActor) {
    const [draft] = await rows(manager, DraftRowSchema, 'SELECT id,version,data,updated_at AS "updatedAt" FROM route_draft WHERE id=$1', [id]);
    if (!draft) throw new NotFoundException('Route draft not found');
    if (draft.version !== command.version) throw new DomainError('ROUTE_DRAFT_CHANGED', 'The saved route changed. Reload and review publication again.');
    if (await this.find(manager, id)) throw new DomainError('ROUTE_ALREADY_PUBLISHED', 'This draft has already been published');
    if (draft.data.stops.length !== command.stops.length || draft.data.stops.some((stop, index) => stop.deliveryId !== command.stops[index]?.deliveryId)) {
      throw new DomainError('ROUTE_STOP_SELECTION_CHANGED', 'Publication selections must match every stop in saved order', 400);
    }
    const planning = draft.data.planning;
    if (!draft.data.crewId || !planning || planning.participantIds.length === 0) {
      throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'Select the crew and actual participants before publication review');
    }
    if (planning.driver.kind === 'external' && !command.externalDriverPhone) {
      throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'Enter a contact phone for the external driver');
    }
    const deliveries = await this.store.getMany(command.stops.map(({ deliveryId }) => deliveryId), manager);
    deliveries.sort((a, b) => a.id.localeCompare(b.id));
    const stops: PreparedStop[] = [];
    const templateSnapshots: TaskTemplate[] = [];
    for (const [index, selection] of command.stops.entries()) {
      const delivery = deliveries.find(({ id: deliveryId }) => deliveryId === selection.deliveryId);
      if (!delivery) throw new NotFoundException('A selected delivery does not exist');
      assertPlanningReady(delivery);
      const selectedDraftStop = draft.data.stops[index];
      if (!selectedDraftStop) throw new DomainError('ROUTE_STOP_SELECTION_CHANGED', 'The selected route stop is unavailable');
      let appointment: Appointment;
      let originalAppointment: Appointment | null = null;
      let serviceReservations: z.infer<typeof ServiceReservationSchema>[] = [];
      let transportReservations: z.infer<typeof TransportReservationSchema>[] = [];
      if (selection.mode === 'attach') {
        if (selectedDraftStop.appointmentId !== selection.appointmentId) throw new DomainError('ROUTE_STOP_SELECTION_CHANGED', 'Save the exact selected appointment in the draft before review');
        const existing = delivery.appointments.find(({ id: visitId }) => visitId === selection.appointmentId);
        if (!existing || existing.status !== 'booked' || existing.results.length > 0 || existing.actualStartedAt) throw new DomainError('APPOINTMENT_UNAVAILABLE', 'Only an unstarted booked visit without results can be attached');
        const [membership] = await rows(manager, z.object({ routeId: IdSchema }), 'SELECT route_id AS "routeId" FROM route_stop WHERE appointment_id=$1 AND active', [existing.id]);
        if (membership) throw new DomainError('APPOINTMENT_ALREADY_ROUTED', 'The selected appointment already belongs to an active route');
        requireReviewedVisitScope(delivery, existing);
        if (existing.responsibleParticipant?.id !== selection.responsibleParticipantId || !assignedParticipant(existing,selection.responsibleParticipantId)) throw new DomainError('APPOINTMENT_RESPONSIBLE_MISMATCH', 'Review the responsible participant on the existing appointment before attaching it');
        originalAppointment = structuredClone(existing);
        appointment = existing;
        serviceReservations = await rows(manager, ServiceReservationSchema, 'SELECT resource FROM reservation WHERE appointment_id=$1 ORDER BY resource', [existing.id]);
        transportReservations = await rows(manager, TransportReservationSchema,
          'SELECT allocation_id AS "allocationId",resource,starts_at AS "startsAt",ends_at AS "endsAt" FROM transport_reservation WHERE appointment_id=$1 ORDER BY allocation_id,resource', [existing.id]);
      } else {
        if (selectedDraftStop.appointmentId) throw new DomainError('ROUTE_STOP_SELECTION_CHANGED', 'This saved stop refers to an existing appointment; attach that visit or explicitly change the draft');
        const request = selection.returnRequestId ? delivery.returnRequests.find(({ id: returnId }) => returnId === selection.returnRequestId) : undefined;
        if (selection.returnRequestId && (!request || request.status !== 'requested')) throw new DomainError('RETURN_REQUEST_UNAVAILABLE', 'The return request must be awaiting planning');
        const scope = planVisitWork(delivery, selection.workLines, actor, new Date().toISOString());
        retainWorkServiceDefault(delivery);
        const assignment = await this.assignment(manager, draft.data.crewId, planning.participantIds, selection.templateIds,
          (key) => reviewId(id, draft.version, `${selection.deliveryId}:${key}`));
        templateSnapshots.push(...assignment.templates);
        appointment = AppointmentSchema.parse({
          id: reviewId(id, draft.version, `visit:${delivery.id}`), startsAt: draft.data.departAt,
          endsAt: new Date(Date.parse(draft.data.departAt) + 60_000).toISOString(), status: 'booked', cancellationReason: null,
          returnRequestId: selection.returnRequestId ?? null, assignments: [assignment.value], results: [], workScope: scope,
        });
        const person = assignedParticipant(appointment, selection.responsibleParticipantId);
        if (!person) throw new DomainError('VISIT_RESPONSIBLE_NOT_ASSIGNED', 'The responsible participant must be one of the actual assigned people');
        appointment.responsibleParticipant = { id: person.id, name: person.name };
        delivery.appointments.push(appointment);
        requireReviewedVisitScope(delivery, appointment);
      }
      stops.push({ selection, delivery, appointment, originalAppointment, serviceReservations, transportReservations });
    }
    const projection: RouteDraftInput = {
      ...draft.data,
      stops: draft.data.stops.map((stop, index) => {
        const prepared = stops[index];
        if (!prepared) throw new Error('Missing publication stop projection');
        return { ...stop, appointmentId: prepared.appointment.id, workFingerprint: routeJob(prepared.delivery, undefined, prepared.appointment.id).workFingerprint };
      }),
    };
    const calculated = await this.drafts.preparePublication(projection, manager, deliveries);
    const { timeline, feasibility } = calculated.preview;
    for (const stop of stops) {
      const service = timeline.stops.find(({ deliveryId }) => deliveryId === stop.delivery.id);
      if (!service?.workStartAt || !service.workEndAt || !timeline.returnAt) throw new DomainError('ROUTE_FEASIBILITY_INCOMPLETE', 'Complete the travel estimates and work duration before publication review');
      if (stop.selection.mode === 'create') {
        stop.appointment.startsAt = service.workStartAt; stop.appointment.endsAt = service.workEndAt;
      } else if (Date.parse(service.workStartAt) < Date.parse(stop.appointment.startsAt) || Date.parse(service.workEndAt) > Date.parse(stop.appointment.endsAt)) {
        throw new DomainError('APPOINTMENT_SCHEDULE_MISMATCH', 'The calculated work interval must fit the existing booked interval. Reschedule explicitly and review again.');
      }
      const ranges = [stop.appointment, ...activeTransport(stop.appointment).map(({ reserveFrom, reserveTo }) => ({ startsAt: reserveFrom, endsAt: reserveTo }))];
      if (ranges.some(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(timeline.departAt) || Date.parse(endsAt) > Date.parse(timeline.returnAt ?? ''))) {
        throw new DomainError('APPOINTMENT_SCHEDULE_MISMATCH', 'The existing booking or transport extends outside the route reservation. Correct it explicitly before publication.');
      }
    }
    const reviewStops = stops.map(({ selection, delivery, appointment }) => ({
      deliveryId: delivery.id, pickingName: delivery.source.pickingName, mode: selection.mode, appointmentId: appointment.id,
      startsAt: appointment.startsAt, endsAt: appointment.endsAt, workScope: appointment.workScope,
      assignments: appointment.assignments, responsibleParticipant: appointment.responsibleParticipant,
      customerConfirmationStatus: customerConfirmationStatus(appointment),
    }));
    const fingerprint = hash({ draftId: id, draftVersion: draft.version, command, timeline, feasibilityFingerprint: feasibility.fingerprint,
      stops: stops.map(({ delivery, ...stop }) => {
        const scope = stop.appointment.workScope;
        // A newly generated review timestamp is not a changed work decision. Existing scope timestamps remain part of provenance.
        const appointment = stop.selection.mode === 'create' && scope ? { ...stop.appointment,
          workScope: { revision: scope.revision, sourceFingerprint: scope.sourceFingerprint, confirmedBy: scope.confirmedBy, lines: scope.lines },
        } : stop.appointment;
        return { ...stop, appointment, deliveryId: delivery.id, deliveryVersion: delivery.version };
      }),
      templates: templateSnapshots, pointContexts: calculated.preview.pointContexts });
    const review = PublicationReviewSchema.parse({ routeId: id, draftVersion: draft.version, fingerprint,
      publicationEnabled: this.capability().enabled, timeline, feasibility, stops: reviewStops });
    return { draft, stops, review };
  }

  private async assignment(manager: EntityManager, crewId: string, participantIds: string[], templateIds: string[], id: (key: string) => string): Promise<{ value: Assignment; templates: TaskTemplate[] }> {
    const [crew] = await this.people.crews(manager, [crewId]);
    if (!crew?.enabled) throw new DomainError('CREW_UNAVAILABLE', 'The selected crew is disabled or unavailable');
    const people = await this.people.selected(manager, participantIds);
    if (people.some((person) => !person.enabled)) throw new DomainError('PARTICIPANT_UNAVAILABLE', 'A selected participant is disabled');
    const templates = (await rows(manager, z.object({ data: TaskTemplateSchema }), 'SELECT data FROM task_template WHERE id=ANY($1::uuid[]) ORDER BY id', [templateIds])).map(({ data }) => data);
    if (templates.length !== templateIds.length || templates.some(({ enabled }) => !enabled)) throw new DomainError('TASK_TEMPLATE_UNAVAILABLE', 'A selected task template is disabled or unavailable');
    const requirements = await this.skills.requiredSnapshots(manager, templates.flatMap((template) => template.requiredSkillIds ?? []));
    const qualified = await this.skills.qualify(manager, people, requirements, crew.name);
    return { templates, value: instantiateAssignment(crew, qualified, templates, requirements, id) };
  }
}
