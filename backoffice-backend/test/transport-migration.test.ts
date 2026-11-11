import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource, QueryFailedError } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { makeDataSource, rows } from '../src/database/database';
import { InitialSchema1793700000000 } from '../src/database/migration';
import { RelationalParticipants1793700100000 } from '../src/database/participants-migration';
import { UniqueDefaultCrew1793700200000 } from '../src/database/default-crew-migration';
import { ParticipantSkills1793700300000 } from '../src/database/skills-migration';
import { VehicleTransport1793700400000 } from '../src/database/vehicles-migration';
import { createDelivery, DeliverySchema, type Appointment } from '../src/domain/model';
import { planVisitWork, recordExecution } from '../src/domain/rules';

void test('vehicle migration preserves legacy rows and signed JSON and adds empty constrained transport tables',async()=>{
  const schema=`transport_migration_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^transport_migration_[0-9a-f]{32}$/);
  const legacyMigrations=[InitialSchema1793700000000,RelationalParticipants1793700100000,UniqueDefaultCrew1793700200000,ParticipantSkills1793700300000];
  const options={type:'postgres' as const,url:applicationUrl(true),schema,entities:[],synchronize:false,logging:false,extra:{options:`-c search_path=${schema}`}};
  const owner=makeDataSource(true);
  const previous=new DataSource({...options,migrations:legacyMigrations});
  const updated=new DataSource({...options,migrations:[...legacyMigrations,VehicleTransport1793700400000]});
  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager,z.object({name:z.literal('delivery_backoffice_test')}),'SELECT current_database() AS name')).length,1);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await previous.initialize();await previous.runMigrations({transaction:'all'});
    const personId=randomUUID();const crewId=randomUUID();const skillId=randomUUID();const templateId=randomUUID();
    await previous.query('INSERT INTO person(id,legacy_name,external) VALUES($1,$2,false)',[personId,'DEMO preserved person']);
    await previous.query(`INSERT INTO crew(id,version,name,classification,area,enabled,legacy_data) VALUES($1,7,'DEMO preserved crew','indoor','Messina',true,$2::jsonb)`,[crewId,JSON.stringify({legacy:[personId]})]);
    await previous.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0)',[crewId,personId]);
    await previous.query(`INSERT INTO skill(id,name,description,enabled) VALUES($1,'DEMO preserved skill',NULL,true)`,[skillId]);
    await previous.query('INSERT INTO participant_skill(person_id,skill_id) VALUES($1,$2)',[personId,skillId]);
    await previous.query('INSERT INTO task_template(id,version,data) VALUES($1,3,$2::jsonb)',[templateId,JSON.stringify({id:templateId,version:3,title:'DEMO preserved task',severity:'low',order:1,checklist:['DEMO preserved checkpoint'],enabled:true})]);
    const delivery=createDelivery({pickingId:1,pickingName:'DEMO/TRANSPORT/MIGRATION',saleOrderId:1,saleOrderName:'DEMO/SO/1',sourceState:'assigned',salesTeam:'MOHD MESSINA',
      customer:{id:1,name:'DEMO preserved customer',address:null,city:null,country:'IT',phones:[],email:null,contact:null},
      items:[{sourceLineId:10,productId:1,name:'DEMO preserved item',description:null,quantity:1,uom:'unit',configuration:null,ambient:null,notes:null,photoUrl:null}],
      serviceType:'delivery_only',estimatedMinutes:null,notes:null},randomUUID());
    const visit:Appointment={id:randomUUID(),startsAt:'2026-11-03T08:00:00Z',endsAt:'2026-11-03T09:00:00Z',status:'booked',cancellationReason:null,returnRequestId:null,
      assignments:[{id:randomUUID(),crewId,crewName:'DEMO preserved crew',people:[{id:personId,name:'DEMO preserved person',external:false}],tasks:[{
        id:randomUUID(),templateId,title:'DEMO preserved task',severity:'low',order:1,checklist:[{id:randomUUID(),label:'DEMO preserved checkpoint',done:false,waiver:null}],
      }]}],results:[]};
    visit.workScope=planVisitWork(delivery,[{sourceLineId:10,deliveryMilli:1000,installationMilli:0,collectionMilli:0}],
      {id:randomUUID(),name:'DEMO planner',role:'operator'},'2026-11-03T07:00:00Z');
    visit.status='in_progress';
    delivery.appointments.push(visit);
    const signed=recordExecution(delivery,{id:randomUUID(),appointmentId:visit.id,supersedesResultId:null,correctionReason:null,actualStart:visit.startsAt,actualEnd:visit.endsAt,
      summary:'DEMO preserved signed result',responsiblePersonId:personId,quantities:[{sourceLineId:10,deliveredMilli:1000}],
      completedChecklistIds:visit.assignments.flatMap((assignment)=>assignment.tasks.flatMap((task)=>task.checklist.map((checkpoint)=>checkpoint.id))),evidence:[],
      customerSignature:{status:'signed',signerName:'DEMO preserved customer',text:'DEMO customer signature',at:visit.endsAt},
      crewSignature:{status:'signed',signerName:'DEMO preserved person',text:'DEMO crew signature',at:visit.endsAt}},
    {kind:'crew',id:personId,name:'DEMO preserved person'},'2026-11-03T09:00:00Z');
    await previous.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,$3,$4::jsonb)',[signed.id,schema,signed.version,JSON.stringify(signed)]);
    await previous.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',[visit.id,delivery.id,visit.startsAt,visit.endsAt,'completed']);
    await previous.query('INSERT INTO reservation(appointment_id,resource) VALUES($1,$2),($1,$3)',[visit.id,'crew:'+crewId,'person:'+personId]);
    await previous.query(`INSERT INTO audit(id,delivery_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,'DEMO preserved person','DEMO.old',$4::jsonb)`,[randomUUID(),delivery.id,personId,JSON.stringify({signedResultId:signed.appointments[0]?.results[0]?.id})]);
    const oldTables=['person','crew','crew_member','skill','participant_skill','task_template','delivery','appointment','reservation','audit'];
    const snapshot=async(source:DataSource)=>{
      const result:Record<string,unknown>={};
      for(const table of oldTables) result[table]=await rows(source.manager,z.object({row:z.unknown()}),`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
      return result;
    };
    const before=await snapshot(previous);
    const rawBefore=(await rows(previous.manager,z.object({data:z.string()}),'SELECT data::text FROM delivery WHERE id=$1',[delivery.id]))[0];assert.ok(rawBefore);
    await previous.destroy();await updated.initialize();
    assert.deepEqual((await updated.runMigrations({transaction:'all'})).map((migration)=>migration.name),['VehicleTransport1793700400000']);
    assert.deepEqual(await snapshot(updated),before);
    assert.deepEqual(await updated.runMigrations({transaction:'all'}),[]);
    const rawAfter=(await rows(updated.manager,z.object({data:z.string()}),'SELECT data::text FROM delivery WHERE id=$1',[delivery.id]))[0];assert.ok(rawAfter);
    assert.equal(rawAfter.data,rawBefore.data);
    const parsed=DeliverySchema.parse(JSON.parse(rawAfter.data));
    assert.equal(Object.hasOwn(parsed.appointments[0]??{},'transportAllocations'),false);
    assert.equal(Object.hasOwn(parsed.appointments[0]?.results[0]??{},'transportSnapshot'),false);
    assert.deepEqual(await rows(updated.manager,z.object({vehicles:z.number(),reservations:z.number()}),'SELECT (SELECT count(*)::int FROM vehicle) AS vehicles,(SELECT count(*)::int FROM transport_reservation) AS reservations'),[{vehicles:0,reservations:0}]);
    const vehicleId=randomUUID();
    await updated.query(`INSERT INTO vehicle(id,ownership,name,plate,operational_status,enabled) VALUES($1,'company','DEMO car','DEMO-100','available',true)`,[vehicleId]);
    await assert.rejects(updated.query(`INSERT INTO vehicle(id,ownership,name,plate,operational_status,enabled) VALUES($1,'company','DEMO duplicate','DEMO-100','available',true)`,[randomUUID()]),QueryFailedError);
    await assert.rejects(updated.query(`INSERT INTO vehicle(id,ownership,name,plate,operational_status,enabled) VALUES($1,'external','DEMO missing provider','DEMO-101','available',true)`,[randomUUID()]),QueryFailedError);
    await assert.rejects(updated.query('INSERT INTO transport_reservation(allocation_id,appointment_id,resource,starts_at,ends_at) VALUES($1,$2,$3,$4,$4)',[randomUUID(),visit.id,'vehicle:'+vehicleId,visit.startsAt]),QueryFailedError);
    await assert.rejects(updated.query('INSERT INTO transport_reservation(allocation_id,appointment_id,resource,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),visit.id,'vehicle:'+vehicleId,'2026-11-01T00:00:00Z','2026-12-17T00:00:00Z']),QueryFailedError);
    assert.deepEqual(await snapshot(updated),before);
  }finally{
    if(previous.isInitialized)await previous.destroy();if(updated.isInitialized)await updated.destroy();
    if(owner.isInitialized){await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.destroy();}
  }
});
