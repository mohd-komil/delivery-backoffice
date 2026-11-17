import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database, rows } from '../database/database';
import { createDelivery, type OperatorActor, type SourceImportState } from '../domain/model';
import { acceptSourceSnapshot, acknowledgeSourceReview, candidateHash, compareSourceEvidence, requiredWorkSourceConflicts, sourceChanges, sourceHash } from '../domain/source-import';
import type { SourceRead } from './source-evidence';
import { destinationAddressKey } from '../domain/destination-address';
import { DeliveryStore } from '../operations/store';
import { ImportSchema } from '../operations/contracts';
import { OdooSource, sourceInstance } from './source';
import { ImportGeocoding, importGeocodingDescription } from './import-geocoding';

const IMPORT_LOCK = 7041002;
const ImportSelect = `SELECT id,status,started_at::text AS "startedAt",finished_at::text AS "finishedAt",processed,error,details FROM import_run`;
type ImportRun = z.infer<typeof ImportSchema>;

@Injectable()
export class Importer {
  constructor(@Inject(Database) private readonly db: Database, @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(ImportGeocoding) private readonly geocoding: ImportGeocoding) {}

  async list(): Promise<ImportRun[]> {
    return rows(this.db.source.manager, ImportSchema, `${ImportSelect} ORDER BY started_at DESC,id DESC LIMIT 100`);
  }

  async run(actor: OperatorActor): Promise<ImportRun> {
    const instance = sourceInstance();
    const imported = await this.importSource(instance, actor);
    if (imported.status !== 'succeeded' && imported.status !== 'partial') return imported;
    let description: string;
    let summary: unknown;
    try {
      const result = await this.geocoding.run(instance, actor);
      description = importGeocodingDescription(result);
      summary = result;
    } catch {
      description = 'Geocoding: automatic lookup unavailable; source import is complete. Pending addresses will be checked on the next import.';
      summary = { stopReason: 'internal_error' };
    }
    // Source transactions and the import session lock have both ended before external lookup begins.
    // Keep the original source outcome even if geocoding or its diagnostic persistence fails.
    try {
      await this.db.source.transaction(async (manager) => {
        await manager.query('UPDATE import_run SET details=details||$2::jsonb WHERE id=$1', [imported.id, JSON.stringify([description])]);
        await this.store.audit(manager, actor, 'import.geocoding', { runId: imported.id, summary });
      });
      return await this.runRecord(imported.id);
    } catch {
      return { ...imported, details: [...imported.details, description] };
    }
  }

  private async importSource(instance: string, actor: OperatorActor): Promise<ImportRun> {
    const lockRunner = this.db.source.createQueryRunner();
    await lockRunner.connect();
    let locked = false;
    let runId: string | undefined;
    let processed = 0;
    const details: string[] = [];
    let errors = 0;
    try {
      const lock = await rows(lockRunner.manager, z.object({ locked: z.boolean() }),
        'SELECT pg_try_advisory_lock($1) AS locked', [IMPORT_LOCK]);
      locked = lock[0]?.locked === true;
      if (!locked) throw new ConflictException('An import is already running');
      await this.db.source.transaction(async (manager) => {
        // Once the source lock is acquired, a prior running record cannot still own it.
        await manager.query(`UPDATE import_run SET status='interrupted',finished_at=now(),error='Importer stopped before completion' WHERE status='running'`);
        runId = randomUUID();
        await manager.query('INSERT INTO import_run(id,status) VALUES($1,$2)', [runId, 'running']);
        await this.store.audit(manager, actor, 'import.started', { runId });
      });
      const tracked = await rows(this.db.source.manager, z.object({ sourceId: z.number().int().positive() }),
        `SELECT source_id AS "sourceId" FROM delivery WHERE source_instance=$1 ORDER BY source_id LIMIT 5001`, [instance]);
      if (tracked.length > 5000) throw new Error('Tracked source records exceed the documented 5000-picking demo limit');
      const currentRunId = runId;
      if (!currentRunId) throw new Error('Import run was not initialized');
      await new OdooSource().snapshot(async (source) => {
        const qualifying = new Set(await source.qualifyingIds());
        const ids = [...new Set([...qualifying, ...tracked.map((record) => record.sourceId)])].sort((a, b) => a - b);
        if (ids.length > 5000) throw new Error('Combined source scan exceeds the documented 5000-picking demo limit');
        for (const id of ids) {
          try {
            const snapshot = await source.readPicking(id);
            await this.apply(instance, id, snapshot, qualifying.has(id), actor);
            processed += 1;
          } catch (error) {
            // Query/connection/storage errors abort the run; a failed transaction is not a bad record.
            if (!(error instanceof z.ZodError)) throw error;
            errors += 1;
            const message = `Picking ${id}: source validation failed at ${error.issues.slice(0, 5).map((issue) => issue.path.join('.')).join(', ')}`;
            details.push(message);
            await this.flagInvalid(instance, id, actor);
          }
          await this.db.source.manager.query('UPDATE import_run SET processed=$2,details=$3::jsonb WHERE id=$1', [currentRunId, processed, JSON.stringify(details)]);
        }
      });
      const status = errors > 0 ? 'partial' : 'succeeded';
      await this.finish(currentRunId, status, processed, errors > 0 ? `${errors} source records failed; see details` : null, details, actor);
      return this.runRecord(currentRunId);
    } catch (error) {
      if (!runId) throw error;
      const message = error instanceof z.ZodError
        ? 'Source configuration or source payload failed validation'
        : 'Import failed or source is unavailable; rerun after checking the local source';
      details.push(message);
      await this.finish(runId, 'failed', processed, message, details, actor);
      return this.runRecord(runId);
    } finally {
      if (locked) await lockRunner.query('SELECT pg_advisory_unlock($1)', [IMPORT_LOCK]);
      await lockRunner.release();
    }
  }

  private async apply(instance: string, id: number, read: SourceRead, qualifies: boolean, actor: OperatorActor, invalid = false): Promise<void> {
    const { source, evidence } = read;
    await this.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const existing = await rows(manager, z.object({ id: z.string().uuid() }),
        'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2 FOR UPDATE', [instance, id]);
      const record = existing[0];
      if (!record) {
        if (!source || !qualifies) return;
        const delivery = createDelivery(source, randomUUID());
        delivery.sourceImport = { acceptedHash: sourceHash(source), acceptedEvidence: evidence,
          pending: null, keptHash: null, keptEvidence: null, lastRejectedHash: null, eligible: true, acceptedEligible: true };
        await manager.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
          [delivery.id, instance, id, delivery.version, JSON.stringify(delivery)]);
        await this.store.audit(manager, actor, 'source.imported', { pickingId: id }, delivery.id);
        return;
      }
      const delivery = await this.store.get(record.id, manager, true);
      const previous = JSON.stringify(delivery);
      const previousCandidate = delivery.sourceImport?.pending?.hash ?? null;
      const previousEligible = delivery.sourceImport?.eligible ?? !delivery.sourceReview;
      const previousSourceReview = delivery.sourceReview;
      const previousSourceChanged = delivery.sourceChanged;
      const differences = sourceChanges(delivery.source, source);
      const previousDestination = { customerId: delivery.source.customer.id, addressKey: destinationAddressKey(delivery.source.customer) };
      const state: SourceImportState = delivery.sourceImport ?? { acceptedHash: sourceHash(delivery.source),
        acceptedEvidence: { rows: [], readComplete: false }, pending: null, keptHash: null, keptEvidence: null, lastRejectedHash: null,
        eligible: !delivery.sourceReview, acceptedEligible: !delivery.sourceReview };
      delivery.sourceImport = state;
      const hash = candidateHash(source, qualifies);
      const acceptedOrder = compareSourceEvidence(state.acceptedEvidence, evidence);
      const observedOrder = compareSourceEvidence(state.pending?.evidence ?? state.keptEvidence ?? state.acceptedEvidence, evidence);
      const order = acceptedOrder === 'older' || observedOrder === 'older' ? 'older'
        : acceptedOrder === 'conflict' || observedOrder === 'conflict' ? 'conflict'
          : acceptedOrder === 'unverified' || observedOrder === 'unverified' ? 'unverified' : observedOrder;
      let action = 'source.refreshed';
      let auditNeeded = false;
      if (source !== null && order === 'older') {
        if (state.lastRejectedHash !== hash) { state.lastRejectedHash = hash; action = 'source.revision_rejected'; auditNeeded = true; }
      } else if (source !== null && qualifies && evidence.readComplete && sourceHash(source) === state.acceptedHash
        && order !== 'conflict' && (state.pending === null || acceptedOrder === 'newer' || acceptedOrder === 'same' || state.pending.source === null)) {
        if (acceptedOrder === 'newer' || acceptedOrder === 'same' || state.acceptedEvidence.rows.length === 0) state.acceptedEvidence = evidence;
        state.eligible = true;
        state.acceptedEligible = true;
        state.pending = null;
        state.keptHash = null;
        state.keptEvidence = null;
        acknowledgeSourceReview(delivery);
      } else if (source !== null && qualifies && evidence.readComplete && hash === state.keptHash && order !== 'conflict') {
        state.keptEvidence = evidence;
        state.pending = null;
        state.eligible = true;
        acknowledgeSourceReview(delivery);
      } else {
        const protectedWork = delivery.completedAt !== null || delivery.appointments.some((appointment) => appointment.status !== 'cancelled')
          || (delivery.priorWorkRevisions?.length ?? 0) > 0;
        const structural = differences.some(({ kind }) => ['line_removed', 'line_identity', 'service'].includes(kind))
          || (source !== null && requiredWorkSourceConflicts(delivery, source, differences).length > 0);
        state.eligible = source !== null && qualifies;
        if (source !== null && qualifies && order === 'newer' && evidence.readComplete && !protectedWork && !structural) {
          acceptSourceSnapshot(delivery, source);
          state.acceptedHash = sourceHash(source); state.acceptedEvidence = evidence;
          state.acceptedEligible = true;
          state.pending = null; state.keptHash = null; state.keptEvidence = null;
          acknowledgeSourceReview(delivery);
          auditNeeded = true;
        } else {
          const reasons = [
            ...(source === null ? [invalid ? 'source_invalid' : 'source_missing'] : []), ...(!qualifies ? ['source_ineligible'] : []),
            ...(!evidence.readComplete ? ['snapshot_incomplete'] : []),
            ...(order === 'unverified' ? ['revision_unverified'] : order === 'same' || order === 'conflict' ? ['revision_conflict'] : []),
            ...(structural ? ['line_scope_changed'] : []), ...(protectedWork ? ['source_changed_after_work'] : []),
          ];
          const prior = state.pending;
          state.pending = { id: prior?.hash === hash ? prior.id : randomUUID(), hash,
            firstSeenAt: prior?.hash === hash ? prior.firstSeenAt : new Date().toISOString(), source, qualifies, evidence, reasons };
          delivery.sourceChanged = true;
          action = 'source.candidate_detected';
          auditNeeded = prior?.hash !== hash;
        }
      }
      if (JSON.stringify(delivery) === previous) return;
      // Evidence-only refreshes preserve optimistic versions; every operational candidate/action changes it.
      const operationalChange = previousCandidate !== (state.pending?.hash ?? null) || previousEligible !== state.eligible
        || previousSourceReview !== delivery.sourceReview || previousSourceChanged !== delivery.sourceChanged;
      if (auditNeeded || operationalChange) delivery.version += 1;
      await this.store.save(manager, delivery);
      if (auditNeeded || operationalChange) await this.store.audit(manager, actor, action,
        { pickingId: id, candidateId: state.pending?.id ?? null, candidateHash: hash, revisionOrder: order,
          reasons: state.pending?.reasons ?? [], changes: differences, previousDestination }, delivery.id);
    });
  }

  private async flagInvalid(instance: string, id: number, actor: OperatorActor): Promise<void> {
    await this.apply(instance, id, { source: null, evidence: { rows: [], readComplete: false } }, false, actor, true);
  }

  private async finish(id: string, status: string, processed: number, error: string | null, details: string[], actor: OperatorActor): Promise<void> {
    await this.db.source.transaction(async (manager) => {
      await manager.query('UPDATE import_run SET status=$2,finished_at=now(),processed=$3,error=$4,details=$5::jsonb WHERE id=$1', [id, status, processed, error, JSON.stringify(details)]);
      await this.store.audit(manager, actor, 'import.finished', { runId: id, status, processed, errors: details.length });
    });
  }

  private async runRecord(id: string): Promise<ImportRun> {
    const found = await rows(this.db.source.manager, ImportSchema, `${ImportSelect} WHERE id=$1`, [id]);
    const record = found[0];
    if (!record) throw new Error('Import run log is missing');
    return record;
  }
}
