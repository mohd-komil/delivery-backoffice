import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DocumentSnapshotSchema, IdSchema, type Appointment, type CrewActor, type Delivery } from '../domain/model';
import { assignedParticipant, DomainError, finishCrewVisit, raiseIssue, recordCustomerAbsent, requireCrewChecklistItem, requireInProgressCrewVisit, requireVisitResponsible, updateCrewChecklist } from '../domain/rules';
import { Files, inspectCrewPhoto } from '../evidence/files';
import { markVisitEnded, recordedActualStart, startAssignedVisit } from '../execution/visit';
import { CrewIdentity, crewActor } from '../identity/crew-identity';
import { DeliveryStore } from '../operations/store';
import { CrewAttemptFailureInput, CrewChecklistInput, CrewFinishInput, CrewIssueInput, CrewStartInput, type CrewProfile } from './contracts';
import { CrewVisits } from './visits';

type CrewCommand = {
  version: number;
  requestId: string;
  action: string;
  data?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  authorize?: (appointment: Appointment, actor: CrewActor) => void;
  apply: (delivery: Delivery, manager: EntityManager, appointment: Appointment, actor: CrewActor) => Promise<Delivery> | Delivery;
};

function assignedActor(appointment: Appointment, principal: CrewProfile): CrewActor {
  if (appointment.status === 'cancelled') throw new NotFoundException('Visit not found');
  const person = assignedParticipant(appointment, principal.id);
  if (!person) throw new NotFoundException('Visit not found');
  return { kind: 'crew', id: person.id, name: person.name };
}

function requireCurrentAssignment(delivery: Delivery, appointmentId: string, principal: CrewProfile) {
  const appointment = delivery.appointments.find((entry) => entry.id === appointmentId);
  if (!appointment) throw new NotFoundException('Visit not found');
  return { appointment, actor: assignedActor(appointment, principal) };
}

function authorizeFinish(appointment: Appointment, actor: CrewActor) {
  if (appointment.status === 'booked') throw new DomainError('VISIT_NOT_IN_PROGRESS', 'Start this visit before recording work');
  requireVisitResponsible(appointment, actor);
}

@Injectable()
export class CrewExecution {
  constructor(
    @Inject(CrewVisits) private readonly visits: CrewVisits,
    @Inject(CrewIdentity) private readonly identity: CrewIdentity,
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(Files) private readonly files: Files,
  ) {}

  private async mutate(location: { deliveryId: string; appointment: Appointment }, request: unknown, command: CrewCommand) {
    const principal = crewActor(request);
    const appointmentId = location.appointment.id;
    const delivery = await this.store.mutate(location.deliveryId, command.version, assignedActor(location.appointment, principal), {
      name: command.action,
      details: () => ({ appointmentId, ...command.audit }),
    }, (current, manager) => {
      const { appointment, actor } = requireCurrentAssignment(current, appointmentId, principal);
      return command.apply(current, manager, appointment, actor);
    }, {
      id: command.requestId.toLowerCase(),
      input: { appointmentId, actorId: principal.id, ...command.data },
    }, async (current, manager) => {
      // Check the live session and locked aggregate before both replay and mutation.
      const fresh = await this.identity.authenticate(request, manager);
      const { appointment, actor } = requireCurrentAssignment(current, appointmentId, fresh);
      command.authorize?.(appointment, actor);
    });
    const { appointment } = requireCurrentAssignment(delivery, appointmentId, principal);
    const { id: deliveryId, source, instructions, version, appointments, servicePlan, priorWorkRevisions,sourceReview, sourceImport, issues, workHolds } = delivery;
    return this.visits.describe({ deliveryId, source, instructions, version, appointment, appointments, servicePlan, priorWorkRevisions,sourceReview, sourceImport, issues, workHolds }, principal);
  }

  async start(id: string, input: unknown, request: unknown) {
    const command = CrewStartInput.parse(input);
    const location = await this.visits.assignedRow(id, crewActor(request));
    return this.mutate(location, request, {
      ...command,
      action: 'execution.started',
      apply: (delivery, manager, appointment, actor) => startAssignedVisit(manager, delivery, appointment.id, actor),
    });
  }

  async checklist(id: string, itemId: string, input: unknown, request: unknown) {
    const command = CrewChecklistInput.parse(input);
    const checklistId = IdSchema.parse(itemId).toLowerCase();
    const location = await this.visits.assignedRow(id, crewActor(request));
    const data = { checklistId, done: command.done };
    return this.mutate(location, request, {
      ...command,
      action: 'checklist.crew_updated',
      data,
      audit: data,
      authorize: (appointment, actor) => { requireCrewChecklistItem(appointment, checklistId, actor.id); },
      apply: (delivery, _manager, appointment, actor) => updateCrewChecklist(delivery, appointment.id, checklistId, command.done, actor),
    });
  }

  async finish(id: string, input: unknown, request: unknown) {
    const { version, requestId, summary, quantities, itemChecks, incompleteWork, actualStart, customerSignature, signatureRefusal,
      crewSignature, photos: submittedPhotos } = CrewFinishInput.parse(input);
    const principal = crewActor(request);
    const location = await this.visits.assignedRow(id, principal);
    authorizeFinish(location.appointment, assignedActor(location.appointment, principal));
    const photos: { id: string; file: Awaited<ReturnType<typeof inspectCrewPhoto>>; digest: string; sourceLineId?: number }[] = [];
    for (const { sourceLineId, ...submittedPhoto } of submittedPhotos) {
      const file = await inspectCrewPhoto(submittedPhoto);
      photos.push({ id: randomUUID(), file, digest: createHash('sha256').update(file.bytes).digest('hex'), sourceLineId });
    }
    const photoIds = photos.map(({ id }) => id);
    const resultId = randomUUID();
    const writtenPhotoIds: string[] = [];
    try {
      return await this.mutate(location, request, {
        version,
        requestId,
        action: 'execution.crew_reported',
        data: {
          summary, quantities, itemChecks, incompleteWork, actualStart, customerSignature, signatureRefusal, crewSignature,
          photos: photos.map(({ file, digest, sourceLineId }) => ({ name: file.name, digest, sourceLineId })),
        },
        audit: { resultId, source: 'crew_frontoffice', photoIds, incompleteOperationCount: incompleteWork?.length ?? 0,
          ...(signatureRefusal ? { signatureRefusal } : {}) },
        authorize: authorizeFinish,
        apply: async (delivery, manager, appointment, actor) => {
          requireInProgressCrewVisit(delivery, appointment.id, actor);
          const recorded = await recordedActualStart(manager, delivery.id, appointment);
          if (recorded && actualStart && Date.parse(recorded) !== Date.parse(actualStart)) {
            throw new DomainError('ACTUAL_START_ALREADY_RECORDED', 'The visit already has a recorded start time');
          }
          const start = recorded ?? actualStart;
          if (!start) throw new DomainError('ACTUAL_START_REQUIRED', 'Enter the actual start time for this previously started visit');
          const documents = await this.files.crewDocuments(delivery.id, appointment.id, delivery.source.items.map(({ sourceLineId }) => sourceLineId), null, manager);
          const documentSnapshot = documents.map((document) => DocumentSnapshotSchema.strip().parse(document));
          const next = finishCrewVisit(delivery, appointment.id, actor, {
            id: resultId, summary, quantities, itemChecks, incompleteWork, customerSignature, signatureRefusal, crewSignature, photos, documentSnapshot,
          }, start, new Date().toISOString());
          const issueLinks = next.appointments.find(({ id }) => id === appointment.id)?.results.find(({ id }) => id === resultId)?.issueLinks ?? [];
          // The bytes are private until the file metadata, result and command receipt commit together.
          for (const { id, file, sourceLineId } of photos) {
            await this.files.writeCrewPhoto(id, file);
            writtenPhotoIds.push(id);
            await this.files.registerCrewPhoto(manager, file, {
              id, deliveryId: delivery.id, actorId: actor.id, appointmentId: appointment.id, itemId: sourceLineId ?? null,
              issueId: issueLinks.find((link) => link.sourceLineId === sourceLineId)?.issueId ?? null,
            });
          }
          await markVisitEnded(manager, delivery.id, appointment.id, 'completed');
          return next;
        },
      });
    } catch (error: unknown) {
      for (const photoId of writtenPhotoIds) await this.files.discardUnregisteredCrewPhoto(photoId);
      throw error;
    }
  }

  async attemptFailure(id: string, input: unknown, request: unknown) {
    const { version, requestId, reason } = CrewAttemptFailureInput.parse(input);
    const location = await this.visits.assignedRow(id, crewActor(request));
    return this.mutate(location, request, {
      version,
      requestId,
      action: 'execution.customer_absent',
      data: { reason },
      audit: { reason },
      authorize: authorizeFinish,
      apply: async (delivery, manager, appointment, actor) => {
        const next = recordCustomerAbsent(delivery, appointment.id, actor, reason, new Date().toISOString());
        await markVisitEnded(manager, delivery.id, appointment.id, 'failed');
        return next;
      },
    });
  }

  async issue(id: string, input: unknown, request: unknown) {
    const { version, requestId, type, description, itemIds, photo: submittedPhoto } = CrewIssueInput.parse(input);
    const location = await this.visits.assignedRow(id, crewActor(request));
    const photo = await inspectCrewPhoto(submittedPhoto);
    const digest = createHash('sha256').update(photo.bytes).digest('hex');
    const issueId = randomUUID();
    const photoId = randomUUID();
    let wrotePhoto = false;
    try {
      return await this.mutate(location, request, {
        version,
        requestId,
        action: 'issue.crew_reported',
        data: { type, description, itemIds, photo: { name: photo.name, digest } },
        audit: { issueId, photoId },
        apply: async (delivery, manager, appointment, actor) => {
          requireInProgressCrewVisit(delivery, appointment.id, actor);
          const next = raiseIssue(delivery, { id: issueId, type, description, itemIds, photoIds: [photoId], notes: null }, actor, new Date().toISOString(), appointment.id);
          // File is private and undiscoverable until the aggregate, metadata and receipt commit.
          await this.files.writeCrewPhoto(photoId, photo);
          wrotePhoto = true;
          await this.files.registerCrewPhoto(manager, photo, {
            id: photoId, deliveryId: delivery.id, actorId: actor.id, appointmentId: appointment.id, issueId,
            itemId: itemIds.length === 1 ? itemIds[0] ?? null : null,
          });
          return next;
        },
      });
    } catch (error: unknown) {
      if (wrotePhoto) await this.files.discardUnregisteredCrewPhoto(photoId);
      throw error;
    }
  }
}
