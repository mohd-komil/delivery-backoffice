import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { makeDataSource, rows } from '../src/database/database';
import { InitialSchema1793700000000 } from '../src/database/migration';
import { RelationalParticipants1793700100000 } from '../src/database/participants-migration';
import { UniqueDefaultCrew1793700200000 } from '../src/database/default-crew-migration';
import { ParticipantSkills1793700300000 } from '../src/database/skills-migration';
import { createDelivery, DeliverySchema, TaskTemplateSchema, type Appointment } from '../src/domain/model';
import { planVisitWork, recordExecution } from '../src/domain/rules';

void test('participant skills migration adds only empty catalog/grants and preserves legacy JSON and signed snapshots byte-for-byte',async()=>{
  const schema=`skills_migration_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^skills_migration_[0-9a-f]{32}$/);
  const options={type:'postgres' as const,url:applicationUrl(true),schema,entities:[],synchronize:false,logging:false,extra:{options:`-c search_path=${schema}`}};
  const owner=makeDataSource(true);
  const previous=new DataSource({...options,migrations:[InitialSchema1793700000000,RelationalParticipants1793700100000,UniqueDefaultCrew1793700200000]});
  const updated=new DataSource({...options,migrations:[InitialSchema1793700000000,RelationalParticipants1793700100000,UniqueDefaultCrew1793700200000,ParticipantSkills1793700300000]});
  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager,z.object({name:z.literal('delivery_backoffice_test')}),'SELECT current_database() AS name')).length,1);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await previous.initialize();await previous.runMigrations({transaction:'all'});
    const personId=randomUUID();const crewId=randomUUID();
    await previous.query('INSERT INTO person(id,legacy_name,external) VALUES($1,$2,false)',[personId,'DEMO legacy person']);
    await previous.query(`INSERT INTO crew(id,version,name,classification,area,enabled,legacy_data) VALUES($1,9,'DEMO legacy crew','indoor','Messina',true,$2::jsonb)`,[crewId,JSON.stringify({oldRoster:[personId]})]);
    await previous.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0)',[crewId,personId]);
    const template=TaskTemplateSchema.parse({id:randomUUID(),version:4,title:'DEMO legacy task',severity:'low',order:1,checklist:['DEMO legacy checkpoint'],enabled:true});
    assert.equal(Object.hasOwn(template,'requiredSkillIds'),false);
    await previous.query('INSERT INTO task_template(id,version,data) VALUES($1,$2,$3::jsonb)',[template.id,template.version,JSON.stringify(template)]);
    const delivery=createDelivery({pickingId:1,pickingName:'DEMO/SKILLS/MIGRATION',saleOrderId:1,saleOrderName:'DEMO/SO/1',sourceState:'assigned',salesTeam:'MOHD MESSINA',
      customer:{id:1,name:'DEMO legacy customer',address:null,city:null,country:'IT',phones:[],email:null,contact:null},
      items:[{sourceLineId:10,productId:1,name:'DEMO legacy item',description:null,quantity:1,uom:'unit',configuration:null,ambient:null,notes:null,photoUrl:null}],
      serviceType:'delivery_only',estimatedMinutes:null,notes:null},randomUUID());
    const visit:Appointment={id:randomUUID(),startsAt:'2026-11-03T08:00:00Z',endsAt:'2026-11-03T09:00:00Z',status:'booked',cancellationReason:null,returnRequestId:null,
      assignments:[{id:randomUUID(),crewId,crewName:'DEMO legacy crew',people:[{id:personId,name:'DEMO legacy person',external:false}],tasks:[{
        id:randomUUID(),templateId:template.id,title:template.title,severity:template.severity,order:template.order,
        checklist:[{id:randomUUID(),label:'DEMO legacy checkpoint',done:false,waiver:null}],
      }]}],results:[]};
    visit.workScope=planVisitWork(delivery,[{sourceLineId:10,deliveryMilli:1000,installationMilli:0,collectionMilli:0}],
      {id:randomUUID(),name:'DEMO planner',role:'operator'},'2026-11-03T07:00:00Z');
    visit.status='in_progress';
    delivery.appointments.push(visit);
    const signed=recordExecution(delivery,{id:randomUUID(),appointmentId:visit.id,supersedesResultId:null,correctionReason:null,actualStart:visit.startsAt,actualEnd:visit.endsAt,
      summary:'DEMO legacy signed result',responsiblePersonId:personId,quantities:[{sourceLineId:10,deliveredMilli:1000}],
      completedChecklistIds:visit.assignments.flatMap((assignment)=>assignment.tasks.flatMap((task)=>task.checklist.map((checkpoint)=>checkpoint.id))),evidence:[],
      customerSignature:{status:'signed',signerName:'DEMO legacy customer',text:'DEMO customer signature',at:visit.endsAt},
      crewSignature:{status:'signed',signerName:'DEMO legacy person',text:'DEMO crew signature',at:visit.endsAt}},
    {kind:'crew',id:personId,name:'DEMO legacy person'},'2026-11-03T09:00:00Z');
    await previous.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,$3,$4::jsonb)',[signed.id,schema,signed.version,JSON.stringify(signed)]);
    await previous.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',[visit.id,delivery.id,visit.startsAt,visit.endsAt,'completed']);
    const snapshotSql=`SELECT jsonb_build_object(
      'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM person p),
      'crews',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM crew c),
      'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.crew_id,m.person_id) FROM crew_member m),
      'templates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM task_template t),
      'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM delivery d),
      'appointments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM appointment a),
      'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.appointment_id,r.resource) FROM reservation r)) AS data`;
    const before=await rows(previous.manager,z.object({data:z.unknown()}),snapshotSql);
    const rawBefore=(await rows(previous.manager,z.object({data:z.string()}),'SELECT data::text FROM delivery WHERE id=$1',[delivery.id]))[0];assert.ok(rawBefore);
    await previous.destroy();await updated.initialize();
    const applied=await updated.runMigrations({transaction:'all'});
    assert.deepEqual(applied.map((migration)=>migration.name),['ParticipantSkills1793700300000']);
    assert.deepEqual(await rows(updated.manager,z.object({data:z.unknown()}),snapshotSql),before);
    assert.deepEqual(await updated.runMigrations({transaction:'all'}),[]);
    const rawAfter=(await rows(updated.manager,z.object({data:z.string()}),'SELECT data::text FROM delivery WHERE id=$1',[delivery.id]))[0];assert.ok(rawAfter);
    assert.equal(rawAfter.data,rawBefore.data);
    const old:unknown=JSON.parse(rawAfter.data);const parsed=DeliverySchema.parse(old);const original=parsed.appointments[0]?.results[0];assert.ok(original);
    assert.equal(Object.hasOwn(original.assignmentsSnapshot[0]?.people[0]??{},'skillsSnapshot'),false);
    assert.equal(Object.hasOwn(original.assignmentsSnapshot[0]?.tasks[0]??{},'requiredSkillsSnapshot'),false);
    const oldTemplate=(await rows(updated.manager,z.object({data:z.record(z.string(),z.unknown())}),'SELECT data FROM task_template WHERE id=$1',[template.id]))[0];assert.ok(oldTemplate);
    assert.equal(Object.hasOwn(oldTemplate.data,'requiredSkillIds'),false);
    assert.deepEqual(await rows(updated.manager,z.object({skills:z.number(),grants:z.number()}),'SELECT (SELECT count(*)::int FROM skill) AS skills,(SELECT count(*)::int FROM participant_skill) AS grants'),[{skills:0,grants:0}]);
  } finally {
    if(previous.isInitialized)await previous.destroy();if(updated.isInitialized)await updated.destroy();
    if(owner.isInitialized){await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.destroy();}
  }
});
