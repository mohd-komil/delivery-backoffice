import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Database, rows } from '../database/database';
import { DeliverySchema, type Delivery, type OperatorActor } from '../domain/model';
import { AuditSchema, FileSchema } from './contracts';
import { FILE_COLUMNS } from '../evidence/file-record';
import { appointmentScopeReviewReason, assignmentCoverage, closureBlockers, deriveProgress, deriveViews, lineServiceStatuses, lineWorkTimes, priorWorkStatus } from '../domain/rules';

const DataRow=z.object({data:z.unknown()});
type MutationAudit = string | {
  name: string;
  details: (delivery: Delivery) => Record<string, unknown>;
};

@Injectable()
export class DeliveryStore {
  constructor(@Inject(Database) readonly db:Database) {}
  async get(id:string,executor:EntityManager=this.db.source.manager,lock=false) {
    const found=await rows(executor,DataRow,'SELECT data FROM delivery WHERE id=$1'+(lock?' FOR UPDATE':''),[id]);
    if(!found[0]) throw new NotFoundException('Delivery not found');
    return DeliverySchema.parse(found[0].data);
  }
  async all() {
    const found=await rows(this.db.source.manager,DataRow,'SELECT data FROM delivery ORDER BY source_id,id LIMIT 5000');
    return found.map((row)=>DeliverySchema.parse(row.data));
  }
  async getMany(ids: readonly string[], executor: EntityManager = this.db.source.manager) {
    if (ids.length === 0) return [];
    const found = await rows(executor, DataRow, 'SELECT data FROM delivery WHERE id=ANY($1::uuid[])', [ids]);
    return found.map(({ data }) => DeliverySchema.parse(data));
  }
  async save(executor:EntityManager,delivery:Delivery) {
    const valid=DeliverySchema.parse(delivery);
    await executor.query('UPDATE delivery SET data=$2::jsonb,version=$3 WHERE id=$1',[valid.id,JSON.stringify(valid),valid.version]);
  }
  async audit(executor:EntityManager,principal:Pick<OperatorActor,'id'|'name'>,action:string,details:unknown,deliveryId:string|null=null) {
    await executor.query('INSERT INTO audit(id,delivery_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),deliveryId,principal.id,principal.name,action,JSON.stringify(details)]);
  }
  async mutate(id:string,version:number,principal:Pick<OperatorActor,'id'|'name'>,action:MutationAudit,change:(delivery:Delivery,manager:EntityManager)=>Promise<Delivery>|Delivery,receipt?:{id:string;input:unknown},authorize?:(delivery:Delivery,manager:EntityManager)=>Promise<void>|void) {
    const actionName = typeof action === 'string' ? action : action.name;
    return this.db.source.transaction(async(manager)=>{
      // All scheduling writers share this database lock; independent HTTP requests cannot race resources.
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const delivery=await this.get(id,manager,true);
      await authorize?.(delivery,manager);
      const fingerprint=receipt?createHash('sha256').update(JSON.stringify({action:actionName,input:receipt.input})).digest('hex'):null;
      if(receipt) {
        const existing=await rows(manager,z.object({fingerprint:z.string()}),'SELECT fingerprint FROM command_receipt WHERE delivery_id=$1 AND request_id=$2',[id,receipt.id]);
        if(existing[0]) {
          if(existing[0].fingerprint!==fingerprint) throw new ConflictException('Request ID reused with different input');
          return delivery;
        }
      }
      if(delivery.version!==version) throw new ConflictException('Delivery changed. Reload before editing.');
      const next=await change(structuredClone(delivery),manager);
      next.version=delivery.version+1;
      await this.save(manager,next);
      const details = typeof action === 'string' ? {} : action.details(next);
      await this.audit(manager,principal,actionName,{...details,version:next.version},id);
      if(receipt) await manager.query('INSERT INTO command_receipt(delivery_id,request_id,fingerprint) VALUES($1,$2,$3)',[id,receipt.id,fingerprint]);
      return next;
    });
  }
  async detail(id:string) {
    const delivery=await this.get(id);
    const files=await rows(this.db.source.manager,FileSchema,`SELECT ${FILE_COLUMNS} FROM file_record f WHERE f.delivery_id=$1 ORDER BY f.created_at,f.id`,[id]);
    const history=await rows(this.db.source.manager,AuditSchema,`SELECT id,actor_id AS "actorId",actor_name AS "actorName",action,at::text,details FROM audit WHERE delivery_id=$1 ORDER BY at DESC,id DESC LIMIT 1000`,[id]);
    const lineServices = lineServiceStatuses(delivery);
    const deliveredQuantities = lineServices.map(({ sourceLineId, deliveredMilli }) => ({ sourceLineId, deliveredMilli }));
    const appointmentPlanning=delivery.appointments.map((appointment)=>({appointmentId:appointment.id,reviewReason:appointmentScopeReviewReason(delivery,appointment),
      canEdit:appointment.status==='booked'||appointment.status==='in_progress'&&!appointment.workScope&&appointment.results.length===0}));
    return {delivery,views:deriveViews(delivery),progress:deriveProgress(delivery),coverage:assignmentCoverage(delivery),deliveredQuantities,lineServices,lineWorkTimes:lineWorkTimes(delivery),priorWork:priorWorkStatus(delivery),appointmentPlanning,closureBlockers:closureBlockers(delivery),files,history};
  }
}
