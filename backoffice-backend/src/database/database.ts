import 'reflect-metadata';
import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource, EntitySchema, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../config';
import { InitialSchema1793700000000 } from './migration';
import { RelationalParticipants1793700100000 } from './participants-migration';
import { UniqueDefaultCrew1793700200000 } from './default-crew-migration';
import { ParticipantSkills1793700300000 } from './skills-migration';
import { VehicleTransport1793700400000 } from './vehicles-migration';
import { CrewSession1793700500000 } from './crew-session-migration';
import { FailedAttempt1793700600000 } from './failed-attempt-migration';
import { RouteDraft1793700700000 } from './route-draft-migration';
import { DestinationEntrance1793700800000 } from './destination-entrance-migration';
import { DocumentVersions1793700900000 } from './document-versions-migration';
import { WorkReadiness1793701000000 } from './work-readiness-migration';
import { RoutePublication1793701100000 } from './route-publication-migration';
import { RouteLifecycle1793701200000 } from './route-lifecycle-migration';

export const DeliveryRecordSchema = new EntitySchema<{id:string;source_instance:string;source_id:number;version:number;data:unknown}>({
  name: 'DeliveryRecord', tableName: 'delivery',
  columns: {id:{type:'uuid',primary:true},source_instance:{type:'text'},source_id:{type:'integer'},version:{type:'integer'},data:{type:'jsonb'}},
});
export const applicationMigrations=[InitialSchema1793700000000,RelationalParticipants1793700100000,UniqueDefaultCrew1793700200000,ParticipantSkills1793700300000,VehicleTransport1793700400000,CrewSession1793700500000,FailedAttempt1793700600000,RouteDraft1793700700000,DestinationEntrance1793700800000,DocumentVersions1793700900000,WorkReadiness1793701000000,RoutePublication1793701100000,RouteLifecycle1793701200000];
export function makeDataSource(test = false) {
  return new DataSource({type:'postgres',url:applicationUrl(test),entities:[DeliveryRecordSchema],migrations:applicationMigrations,synchronize:false,logging:false});
}
export type Executor = Pick<EntityManager, 'query'>;
export async function rows<T>(executor: Executor, schema: z.ZodType<T>, sql: string, parameters: unknown[] = []): Promise<T[]> {
  const value: unknown = await executor.query(sql, parameters);
  return z.array(schema).parse(value);
}
@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly source = makeDataSource(process.env['BACKOFFICE_TEST'] === '1');
  async onModuleInit() { await this.source.initialize(); }
  async onModuleDestroy() { if (this.source.isInitialized) await this.source.destroy(); }
}
@Global()
@Module({providers:[Database],exports:[Database]})
export class DatabaseModule {}
