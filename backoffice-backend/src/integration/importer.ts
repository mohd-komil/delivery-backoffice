import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database, rows } from '../database/database';
import { destinationAddressKey } from '../domain/destination-address';
import { createDelivery, type OperatorActor, type SourceSnapshot } from '../domain/model';
import { DeliveryStore } from '../operations/store';
import { ImportSchema } from '../operations/contracts';
import { OdooSource, SOURCE_INSTANCE } from './source';

const IMPORT_LOCK = 7041002;
const SOURCE_REVIEW = 'Source picking no longer qualifies or is missing; new planning requires source review';
const SOURCE_INVALID = 'Source record is invalid; previous source snapshot retained for review';
const SOURCE_CHANGED = 'Source address, orders or quantities changed after booking; review the remaining work';
const ImportSelect = `SELECT id,status,started_at::text AS "startedAt",finished_at::text AS "finishedAt",processed,error,details FROM import_run`;
type ImportRun = z.infer<typeof ImportSchema>;

@Injectable()
export class Importer {
  constructor(@Inject(Database) private readonly db: Database, @Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async list(): Promise<ImportRun[]> {
    return rows(this.db.source.manager, ImportSchema, `${ImportSelect} ORDER BY started_at DESC,id DESC LIMIT 100`);
  }

  async run(actor: OperatorActor): Promise<ImportRun> {
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
        `SELECT source_id AS "sourceId" FROM delivery WHERE source_instance=$1 ORDER BY source_id LIMIT 5001`, [SOURCE_INSTANCE]);
      if (tracked.length > 5000) throw new Error('Tracked source records exceed the documented 5000-picking demo limit');
      const currentRunId = runId;
      if (!currentRunId) throw new Error('Import run was not initialized');
      await new OdooSource().snapshot(async (source) => {
        const qualifying = new Set(await source.qualifyingIds());
        const ids = [...new Set([...qualifying, ...tracked.map((record) => record.sourceId)])].sort((a, b) => a - b);
        if (ids.length > 5000) throw new Error('Combined source scan exceeds the documented 5000-picking demo limit');
        for (const id of ids) {
          try {
            const snapshot = await source.picking(id);
            await this.apply(id, snapshot, qualifying.has(id), actor);
            processed += 1;
          } catch (error) {
            // Query/connection/storage errors abort the run; a failed transaction is not a bad record.
            if (!(error instanceof z.ZodError)) throw error;
            errors += 1;
            const message = `Picking ${id}: source validation failed at ${error.issues.slice(0, 5).map((issue) => issue.path.join('.')).join(', ')}`;
            details.push(message);
            await this.flagInvalid(id, actor);
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

  private async apply(id: number, source: SourceSnapshot | null, qualifies: boolean, actor: OperatorActor): Promise<void> {
    await this.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const existing = await rows(manager, z.object({ id: z.string().uuid() }),
        'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2 FOR UPDATE', [SOURCE_INSTANCE, id]);
      const record = existing[0];
      if (!record) {
        if (!source || !qualifies) return;
        const delivery = createDelivery(source, randomUUID());
        await manager.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
          [delivery.id, SOURCE_INSTANCE, id, delivery.version, JSON.stringify(delivery)]);
        await this.store.audit(manager, actor, 'source.imported', { pickingId: id }, delivery.id);
        return;
      }
      const delivery = await this.store.get(record.id, manager, true);
      const previous = JSON.stringify(delivery);
      const sourceChanged = source !== null && this.materialChange(delivery.source, source);
      const previousDestination = {
        customerId: delivery.source.customer.id,
        addressKey: destinationAddressKey(delivery.source.customer),
      };
      const destinationChanged = source !== null && (source.customer.id !== previousDestination.customerId
        || destinationAddressKey(source.customer) !== previousDestination.addressKey);
      if (source) {
        if (destinationChanged) {
          delete delivery.routePoint;
          delete delivery.addressGeography;
        }
        delivery.source = source;
      }
      delivery.sourceReview = !qualifies || source === null;
      delivery.sourceWarnings = delivery.sourceWarnings.filter((warning) => warning !== SOURCE_REVIEW && warning !== SOURCE_INVALID);
      if (delivery.sourceReview) delivery.sourceWarnings.push(SOURCE_REVIEW);
      if (sourceChanged && delivery.appointments.some((appointment) => appointment.status !== 'cancelled')) {
        delivery.sourceChanged = true;
        if (!delivery.sourceWarnings.includes(SOURCE_CHANGED)) delivery.sourceWarnings.push(SOURCE_CHANGED);
      }
      if (JSON.stringify(delivery) === previous) return;
      delivery.version += 1;
      await this.store.save(manager, delivery);
      await this.store.audit(manager, actor, delivery.sourceReview ? 'source.review_required' : 'source.refreshed',
        {
          pickingId: id, materialChange: sourceChanged, sourceReview: delivery.sourceReview,
          ...(destinationChanged ? { previousDestination } : {}),
        }, delivery.id);
    });
  }

  private materialChange(previous: SourceSnapshot, next: SourceSnapshot): boolean {
    if (JSON.stringify([previous.customer.address, previous.customer.city, previous.customer.country]) !==
        JSON.stringify([next.customer.address, next.customer.city, next.customer.country])) return true;
    const previousOrders = (previous.salesOrders ?? [{ id: previous.saleOrderId, name: previous.saleOrderName }]).map((order) => order.id).sort((a, b) => a - b);
    const nextOrders = (next.salesOrders ?? [{ id: next.saleOrderId, name: next.saleOrderName }]).map((order) => order.id).sort((a, b) => a - b);
    if (JSON.stringify(previousOrders) !== JSON.stringify(nextOrders)) return true;
    return JSON.stringify(previous.items.map((item) => [item.sourceLineId, item.quantity, item.uom, item.saleOrderId ?? previous.saleOrderId])) !==
      JSON.stringify(next.items.map((item) => [item.sourceLineId, item.quantity, item.uom, item.saleOrderId ?? next.saleOrderId]));
  }

  private async flagInvalid(id: number, actor: OperatorActor): Promise<void> {
    await this.db.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const found = await rows(manager, z.object({ id: z.string().uuid() }),
        'SELECT id FROM delivery WHERE source_instance=$1 AND source_id=$2 FOR UPDATE', [SOURCE_INSTANCE, id]);
      if (!found[0]) return;
      const delivery = await this.store.get(found[0].id, manager, true);
      if (delivery.sourceReview && delivery.sourceWarnings.includes(SOURCE_INVALID)) return;
      delivery.sourceReview = true;
      if (!delivery.sourceWarnings.includes(SOURCE_INVALID)) delivery.sourceWarnings.push(SOURCE_INVALID);
      delivery.version += 1;
      await this.store.save(manager, delivery);
      await this.store.audit(manager, actor, 'source.invalid', { pickingId: id, warning: SOURCE_INVALID }, delivery.id);
    });
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
