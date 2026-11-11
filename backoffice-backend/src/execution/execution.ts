import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { EntityManager } from 'typeorm';
import { applicationUrl } from '../config';
import { rows } from '../database/database';
import { ExecutionInputSchema, IdSchema, IssueInputSchema, ReturnInputSchema, type CrewActor, type ExecutionInput, type IssueInput, type OperatorActor, type ReturnInput } from '../domain/model';
import { assignedParticipant, DomainError, raiseIssue, raiseReturnRequest, recordExecution } from '../domain/rules';
import { Files, inspectFile, validateFileContent } from '../evidence/files';
import { FileSchema } from '../operations/contracts';
import { FILE_COLUMNS } from '../evidence/file-record';
import { DeliveryStore } from '../operations/store';
import { markVisitEnded, startAssignedVisit } from './visit';

const PrincipalSchema = z.object({ id: IdSchema, name: z.string(), role: z.enum(['admin', 'operator']) });
const LocalDatabaseSchema = z.object({ database: z.string(), port: z.number() });
const SyntheticPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN4WBH1sCKKAUIBADG+Bs1pwHlWAAAAAElFTkSuQmCC';

export type LocalScenarioContext = Readonly<{ kind: 'local-scenario' }>;
type AuthorizedContext = { deliveryId: string; appointmentId: string; actor: CrewActor; operator: OperatorActor };

/** No controller exposes this local fixture gateway. Incoming results still use the real domain policy. */
@Injectable()
export class Execution {
  private readonly contexts = new WeakMap<LocalScenarioContext, AuthorizedContext>();
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore, @Inject(Files) private readonly files: Files) {}

  private async requireLocalTarget(): Promise<void> {
    if (process.env['NODE_ENV'] === 'production') throw new ForbiddenException('Local execution scenarios are disabled in production');
    // applicationUrl also checks protocol, loopback host, exact port and the separate application database name.
    const expected = new URL(applicationUrl(process.env['BACKOFFICE_TEST'] === '1'));
    const database = (await rows(this.store.db.source.manager, LocalDatabaseSchema,
      'SELECT current_database() AS database, inet_server_port() AS port'))[0];
    if (!database || database.database !== expected.pathname.slice(1) || database.port !== 55432) {
      throw new ForbiddenException('Execution scenarios require the isolated local application database');
    }
  }

  async authorizeLocalScenario(deliveryId: string, appointmentId: string, operator: OperatorActor): Promise<LocalScenarioContext> {
    await this.requireLocalTarget();
    const principal = (await rows(this.store.db.source.manager, PrincipalSchema,
      'SELECT id,name,role FROM app_user WHERE id=$1', [IdSchema.parse(operator.id)]))[0];
    if (!principal || principal.name !== operator.name || principal.role !== operator.role) {
      throw new ForbiddenException('An authenticated local backoffice identity is required');
    }
    const delivery = await this.store.get(IdSchema.parse(deliveryId));
    const appointment = delivery.appointments.find((visit) => visit.id === IdSchema.parse(appointmentId));
    if (!appointment) throw new NotFoundException('Appointment not found');
    // Only the local fixture gateway retains the legacy representative for scenarios without a designation.
    const responsible = appointment.responsibleParticipant
      ? assignedParticipant(appointment, appointment.responsibleParticipant.id)
      : appointment.assignments[0]?.people[0];
    if (!responsible) throw new DomainError('CREW_NOT_ASSIGNED', 'Assign a crew before receiving execution', 403);
    const context: LocalScenarioContext = Object.freeze({ kind: 'local-scenario' });
    this.contexts.set(context, { deliveryId, appointmentId, operator: principal,
      actor: { kind: 'crew', id: responsible.id, name: responsible.name } });
    return context;
  }

  private context(context: LocalScenarioContext): AuthorizedContext {
    const authorized = this.contexts.get(context);
    if (!authorized) throw new ForbiddenException('Scenario context was not authorized by this execution gateway');
    return authorized;
  }

  /** The explicit name and return value make synthetic authorship visible in every scenario. */
  representative(context: LocalScenarioContext): CrewActor { return { ...this.context(context).actor }; }

  async start(context: LocalScenarioContext, version: number) {
    await this.requireLocalTarget();
    const authorized = this.context(context);
    await this.store.mutate(authorized.deliveryId, version, authorized.operator, 'execution.start_received', async (delivery, manager) => {
      const next = await startAssignedVisit(manager, delivery, authorized.appointmentId, authorized.actor);
      await this.store.audit(manager, authorized.actor, 'execution.started', { appointmentId: authorized.appointmentId, receiverId: authorized.operator.id }, delivery.id);
      return next;
    });
    return this.store.detail(authorized.deliveryId);
  }

  async reportIssue(context: LocalScenarioContext, version: number, input: IssueInput) {
    await this.requireLocalTarget();
    const authorized = this.context(context);
    const command = IssueInputSchema.parse(input);
    if (command.photoIds.length !== 0) throw new DomainError('ISSUE_PHOTO_LINK', 'Register crew photos through the evidence gateway after opening the issue', 400);
    await this.store.mutate(authorized.deliveryId, version, authorized.operator, 'execution.issue_received', async (delivery, manager) => {
      const next = raiseIssue(delivery, command, authorized.actor, new Date().toISOString(), authorized.appointmentId);
      await this.store.audit(manager, authorized.actor, 'issue.crew_reported', { issueId: command.id, receiverId: authorized.operator.id }, delivery.id);
      return next;
    }, { id: command.id, input: command });
    return this.store.detail(authorized.deliveryId);
  }

  private async readyPrivateFile(manager: EntityManager, deliveryId: string, fileId: string) {
    const file = (await rows(manager, FileSchema, `SELECT ${FILE_COLUMNS}
      FROM file_record f WHERE f.id=$1 AND f.delivery_id=$2`, [fileId, deliveryId]))[0];
    if (!file || file.status !== 'ready') throw new DomainError('EVIDENCE_UNAVAILABLE', 'File must be a ready private attachment of this delivery', 400);
    const downloaded = await this.files.download(deliveryId, file.id);
    const inspected = inspectFile(downloaded.file.name, downloaded.bytes.toString('base64'));
    await validateFileContent(inspected);
    if (inspected.mime !== file.mime) throw new DomainError('EVIDENCE_CONTENT_MISMATCH', 'Stored file content does not match its metadata', 400);
    return file;
  }

  async reportReturn(context: LocalScenarioContext, version: number, input: ReturnInput) {
    await this.requireLocalTarget();
    const authorized = this.context(context);
    const command = ReturnInputSchema.parse(input);
    await this.store.mutate(authorized.deliveryId, version, authorized.operator, 'execution.return_received', async (delivery, manager) => {
      for (const photoId of command.photoIds) {
        const file = await this.readyPrivateFile(manager, delivery.id, photoId);
        if (!file.mime.startsWith('image/')) throw new DomainError('RETURN_PHOTO_REQUIRED', 'Return photo links must contain image files', 400);
      }
      const next = raiseReturnRequest(delivery, command, authorized.actor, new Date().toISOString(), authorized.appointmentId);
      await this.store.audit(manager, authorized.actor, 'return.crew_reported', {
        requestId: command.id, originAppointmentId: command.originAppointmentId, receiverId: authorized.operator.id,
      }, delivery.id);
      return next;
    }, { id: command.id, input: command });
    return this.store.detail(authorized.deliveryId);
  }

  async receive(context: LocalScenarioContext, version: number, input: ExecutionInput) {
    await this.requireLocalTarget();
    const authorized = this.context(context);
    const command = ExecutionInputSchema.parse(input);
    if (command.appointmentId !== authorized.appointmentId) throw new ForbiddenException('Result belongs to another scenario visit');
    await this.store.mutate(authorized.deliveryId, version, authorized.operator, 'execution.received', async (delivery, manager) => {
      for (const evidence of command.evidence) {
        const file = await this.readyPrivateFile(manager, delivery.id, evidence.id);
        if (file.kind !== 'evidence' || file.appointmentId !== command.appointmentId) {
          throw new DomainError('EVIDENCE_UNAVAILABLE', 'Execution evidence must be a ready private file for this delivery and visit', 400);
        }
        if ((file.itemId === null && evidence.itemIds.length !== 0) ||
          (file.itemId !== null && (evidence.itemIds.length !== 1 || evidence.itemIds[0] !== file.itemId))) {
          throw new DomainError('EVIDENCE_ITEM_MISMATCH', 'Evidence item links must match the registered file', 400);
        }
      }
      const next = recordExecution(delivery, command, authorized.actor, new Date().toISOString());
      await markVisitEnded(manager, delivery.id, command.appointmentId, 'completed');
      await this.store.audit(manager, authorized.actor, 'execution.crew_reported', {
        resultId: command.id, appointmentId: command.appointmentId, receiverId: authorized.operator.id, source: 'local_demo',
        incompleteOperationCount: command.incompleteWork?.length ?? 0,
      }, delivery.id);
      return next;
    }, { id: command.id, input: command });
    return this.store.detail(authorized.deliveryId);
  }

  /** Registers a fixed 2px synthetic PNG as crew evidence, without accepting filesystem paths or arbitrary MIME. */
  async attachSyntheticEvidence(context: LocalScenarioContext, itemId: number | null, issueId: string | null = null): Promise<string> {
    await this.requireLocalTarget();
    const authorized = this.context(context);
    const id = randomUUID();
    const file = inspectFile('DEMO synthetic damage.png', SyntheticPng);
    await validateFileContent(file);
    await this.store.db.source.transaction(async (manager) => {
      const delivery = await this.store.get(authorized.deliveryId, manager, true);
      if (delivery.completedAt !== null) throw new DomainError('DELIVERY_CLOSED', 'Reopen delivery before receiving evidence');
      if (itemId !== null && !delivery.source.items.some((item) => item.sourceLineId === itemId)) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Evidence item belongs to another delivery', 400);
      const appointment = delivery.appointments.find((entry) => entry.id === authorized.appointmentId);
      if (!appointment || !appointment.assignments.some((assignment) => assignment.people.some((person) => person.id === authorized.actor.id))) {
        throw new DomainError('CREW_NOT_ASSIGNED', 'Evidence author is not assigned to this visit', 403);
      }
      if (issueId !== null && !delivery.issues.some((issue) => issue.id === issueId)) throw new DomainError('ISSUE_NOT_FOUND', 'Evidence issue belongs to another delivery', 400);
      await manager.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,appointment_id,item_id,issue_id,status)
        VALUES($1,$2,$3,$4,$5,$6,'evidence',$7,$8,$9,'pending')`, [id, delivery.id, authorized.actor.id,
        'DEMO synthetic damage.png', file.mime, file.bytes.length, authorized.appointmentId, itemId, issueId]);
      await this.store.audit(manager, authorized.actor, 'evidence.demo_upload_started', { id, appointmentId: authorized.appointmentId }, delivery.id);
    });
    try {
      await mkdir(this.files.directory, { recursive: true });
      await writeFile(path.join(this.files.directory, `${id}.pending`), file.bytes, { flag: 'wx' });
      await rename(path.join(this.files.directory, `${id}.pending`), path.join(this.files.directory, id));
      await this.store.db.source.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const delivery = await this.store.get(authorized.deliveryId, manager, true);
        if (delivery.completedAt !== null) throw new DomainError('DELIVERY_CLOSED', 'Delivery was completed while evidence was uploading; reopen before adding evidence');
        await manager.query('UPDATE file_record SET status=$2 WHERE id=$1', [id, 'ready']);
        const issue = delivery.issues.find((entry) => entry.id === issueId);
        if (issue) { issue.photoIds.push(id); delivery.version++; await this.store.save(manager, delivery); }
        await this.store.audit(manager, authorized.actor, 'evidence.demo_uploaded', { id, synthetic: true }, delivery.id);
      });
    } catch (error: unknown) {
      await this.store.db.source.query('UPDATE file_record SET status=$2 WHERE id=$1', [id, 'failed']);
      if (error instanceof DomainError) throw error;
      throw new DomainError('EVIDENCE_UPLOAD_FAILED', 'Synthetic evidence did not finish uploading; no ready evidence was reported');
    }
    // Readback verifies both metadata and the private bytes before a caller can reference this ID in a result.
    const ready = await this.files.download(authorized.deliveryId, id);
    if (!ready.bytes.equals(file.bytes)) throw new DomainError('EVIDENCE_UPLOAD_FAILED', 'Synthetic evidence verification failed');
    return id;
  }
}
