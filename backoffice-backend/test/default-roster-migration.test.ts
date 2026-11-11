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
import { createDelivery, type Appointment, type TaskTemplate } from '../src/domain/model';
import { instantiateTask, planVisitWork, recordExecution } from '../src/domain/rules';

void test('exclusive default-roster migration refuses ambiguous data, preserves explicit resolutions and protects UUID membership independently',async()=>{
  const schema=`exclusive_roster_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^exclusive_roster_[0-9a-f]{32}$/);
  const options={type:'postgres' as const,url:applicationUrl(true),schema,entities:[],synchronize:false,logging:false,extra:{options:`-c search_path=${schema}`}};
  const owner=makeDataSource(true);
  const previous=new DataSource({...options,migrations:[InitialSchema1793700000000,RelationalParticipants1793700100000]});
  const updated=new DataSource({...options,migrations:[InitialSchema1793700000000,RelationalParticipants1793700100000,UniqueDefaultCrew1793700200000]});
  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager,z.object({name:z.literal('delivery_backoffice_test')}),'SELECT current_database() AS name')).length,1);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await previous.initialize();await previous.runMigrations({transaction:'all'});
    const personId=randomUUID();const sameNameId=randomUUID();const firstCrew=randomUUID();const secondCrew=randomUUID();const sameNameCrew=randomUUID();
    for(const id of [personId,sameNameId]) await previous.query('INSERT INTO person(id,legacy_name,external) VALUES($1,$2,false)',[id,'DEMO same legacy name']);
    for(const [index,id] of [firstCrew,secondCrew,sameNameCrew].entries()) await previous.query(`INSERT INTO crew(id,version,name,classification,area,enabled,legacy_data)
      VALUES($1,$2,$3,'indoor','Messina',true,$4::jsonb)`,[id,10+index,'DEMO migration crew '+String(index+1),JSON.stringify({originalId:id,reviewed:false})]);
    await previous.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0),($3,$2,0),($4,$5,0)',[firstCrew,personId,secondCrew,sameNameCrew,sameNameId]);
    const delivery=createDelivery({pickingId:1,pickingName:'DEMO/EXCLUSIVE/1',saleOrderId:1,saleOrderName:'DEMO/SO/1',sourceState:'assigned',salesTeam:'MOHD MESSINA',
      customer:{id:1,name:'DEMO migration customer',address:null,city:null,country:'IT',phones:[],email:null,contact:null},
      items:[{sourceLineId:10,productId:1,name:'DEMO item',description:null,quantity:1,uom:'unit',configuration:null,ambient:null,notes:null,photoUrl:null}],
      serviceType:'delivery_only',estimatedMinutes:null,notes:null},randomUUID());
    const template:TaskTemplate={id:randomUUID(),version:1,title:'DEMO signed historical task',severity:'low',order:1,checklist:['DEMO checkpoint'],enabled:true};
    const visit:Appointment={id:randomUUID(),startsAt:'2026-11-10T08:00:00Z',endsAt:'2026-11-10T09:00:00Z',status:'booked',cancellationReason:null,returnRequestId:null,
      assignments:[{id:randomUUID(),crewId:secondCrew,crewName:'DEMO migration crew 2',people:[{id:personId,name:'DEMO historical name',external:false}],tasks:[instantiateTask(template)]}],results:[]};
    visit.workScope=planVisitWork(delivery,[{sourceLineId:10,deliveryMilli:1000,installationMilli:0,collectionMilli:0}],
      {id:randomUUID(),name:'DEMO planner',role:'operator'},'2026-11-10T07:00:00Z');
    visit.status='in_progress';
    delivery.appointments.push(visit);
    const signed=recordExecution(delivery,{id:randomUUID(),appointmentId:visit.id,supersedesResultId:null,correctionReason:null,
      actualStart:visit.startsAt,actualEnd:visit.endsAt,summary:'DEMO immutable result',responsiblePersonId:personId,quantities:[{sourceLineId:10,deliveredMilli:1000}],
      completedChecklistIds:visit.assignments.flatMap((assignment)=>assignment.tasks.flatMap((task)=>task.checklist.map((checkpoint)=>checkpoint.id))),evidence:[],
      customerSignature:{status:'signed',signerName:'DEMO customer',text:'DEMO signed customer',at:visit.endsAt},
      crewSignature:{status:'signed',signerName:'DEMO historical name',text:'DEMO signed crew',at:visit.endsAt}},
    {kind:'crew',id:personId,name:'DEMO historical name'},'2026-11-10T09:00:00Z');
    await previous.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,$3,$4::jsonb)',[signed.id,schema,signed.version,JSON.stringify(signed)]);
    await previous.destroy();await updated.initialize();
    async function snapshot() {
      return rows(updated.manager,z.object({data:z.unknown()}),`SELECT jsonb_build_object(
        'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM person p),
        'crews',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM crew c),
        'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.crew_id,m.person_id) FROM crew_member m),
        'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM delivery d)) AS data`);
    }
    const ambiguous=await snapshot();
    await assert.rejects(()=>updated.runMigrations({transaction:'all'}),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('explicit membership decision'));
      for(const expected of [personId,'DEMO same legacy name',firstCrew,secondCrew,'DEMO migration crew 1','DEMO migration crew 2']) assert.ok(error.message.includes(expected));
      return true;
    });
    assert.deepEqual(await snapshot(),ambiguous,'Refusal must preserve all default members, versions, legacy archives and signed results');
    const migrations=await rows(updated.manager,z.object({name:z.string()}),'SELECT name FROM migrations ORDER BY id');
    assert.equal(migrations.length,2,'The refused migration must not be recorded as applied');
    // This decision concerns only the test-owned fixture. The production migration never chooses a crew.
    await updated.query('DELETE FROM crew_member WHERE crew_id=$1 AND person_id=$2',[secondCrew,personId]);
    const reviewed=await snapshot();
    const applied=await updated.runMigrations({transaction:'all'});
    assert.deepEqual(applied.map((migration)=>migration.name),['UniqueDefaultCrew1793700200000']);
    assert.deepEqual(await snapshot(),reviewed,'The additive constraint must not rewrite profiles, rosters, crew archives or historical delivery data');
    assert.deepEqual(await updated.runMigrations({transaction:'all'}),[]);
    let rejected=false;
    try{await updated.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0)',[secondCrew,personId.toUpperCase()]);}
    catch(error:unknown){
      const driver:unknown=error instanceof QueryFailedError?error.driverError:null;
      rejected=z.object({code:z.literal('23505'),constraint:z.literal('crew_member_person_unique')}).safeParse(driver).success;
    }
    assert.equal(rejected,true,'The database must enforce UUID identity independently of application checks and UUID casing');
    assert.deepEqual(await snapshot(),reviewed);
  } finally {
    if(previous.isInitialized)await previous.destroy();if(updated.isInitialized)await updated.destroy();
    if(owner.isInitialized){await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.destroy();}
  }
});
