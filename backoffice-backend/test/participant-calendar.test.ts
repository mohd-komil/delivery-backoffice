import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule, configureApplication } from '../src/app';
import { applicationUrl, config } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { AppointmentSchema, createDelivery, DeliverySchema, type Appointment, type Assignment, type TaskTemplate } from '../src/domain/model';
import { instantiateTask, planVisitWork, raiseReturnRequest, recordExecution } from '../src/domain/rules';
import { hashPassword } from '../src/identity/identity';
import { ParticipantCalendarSchema } from '../src/operations/contracts';

class CalendarDatabase extends Database {
  override readonly source:DataSource;
  constructor(schema:string) {
    super();
    this.source=new DataSource({type:'postgres',url:applicationUrl(true),schema,entities:[],migrations:applicationMigrations,
      synchronize:false,logging:false,extra:{options:`-c search_path=${schema}`}});
  }
}

void test('participant calendar projects saved assignment snapshots through real guards and isolated PostgreSQL',async(context)=>{
  process.env['BACKOFFICE_TEST']='1';
  const schema=`participant_calendar_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^participant_calendar_[0-9a-f]{32}$/);
  const owner=makeDataSource(true); const database=new CalendarDatabase(schema);
  let app:NestExpressApplication|undefined;
  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager,z.object({name:z.literal('delivery_backoffice_test')}),'SELECT current_database() AS name')).length,1);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await database.source.initialize(); await database.source.runMigrations({transaction:'all'});
    const password=randomBytes(24).toString('base64url'); const passwordHash=await hashPassword(password);
    const adminUser={id:randomUUID(),email:'calendar-admin@example.test',role:'admin'};
    const operatorUser={id:randomUUID(),email:'calendar-operator@example.test',role:'operator'};
    const users=[adminUser,operatorUser];
    for(const user of users) await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [user.id,user.email,'DEMO calendar '+user.role,user.role,passwordHash]);
    const personId=randomUUID(); const sameNameId=randomUUID(); const rosterOnlyId=randomUUID(); const crewId=randomUUID(); const otherCrewId=randomUUID();
    for(const id of [personId,sameNameId,rosterOnlyId]) await database.source.query(`INSERT INTO person(id,first_name,last_name,phone_number,address,login,password_hash,external,enabled)
      VALUES($1,'DEMO','Same Name','+39 000 111 2222','DEMO synthetic address',$2,$3,false,$4)`,[id,id+'@example.test',passwordHash,id!==personId]);
    for(const id of [crewId,otherCrewId]) await database.source.query(`INSERT INTO crew(id,version,name,classification,area,enabled)
      VALUES($1,7,'DEMO CURRENT renamed crew','indoor','Messina',true)`,[id]);
    await database.source.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,0),($3,$4,0)',[crewId,sameNameId,otherCrewId,rosterOnlyId]);
    const template:TaskTemplate={id:randomUUID(),version:1,title:'DEMO SAVED task',severity:'high',order:2,checklist:['DEMO SAVED checkpoint'],enabled:true};
    await database.source.query('INSERT INTO task_template(id,version,data) VALUES($1,2,$2::jsonb)',[template.id,JSON.stringify({...template,version:2,title:'DEMO CURRENT replacement task',checklist:['DEMO CURRENT replacement checkpoint']})]);
    function assignment(id=personId,selectedCrew=crewId):Assignment {
      return {id:randomUUID(),crewId:selectedCrew,crewName:'DEMO SAVED crew name',people:[{id,name:'DEMO SAVED same person label',external:false}],tasks:[instantiateTask(template)]};
    }
    function appointment(start:string,end:string,status:Appointment['status']='booked',assignments:Assignment[]=[assignment()]):Appointment {
      return {id:randomUUID(),startsAt:`2026-11-10T${start}:00Z`,endsAt:`2026-11-10T${end}:00Z`,status,
        cancellationReason:status==='cancelled'?'DEMO cancellation':null,returnRequestId:null,assignments,results:[]};
    }
    let delivery=createDelivery({pickingId:1,pickingName:'PARTICIPANT/CALENDAR/DEMO/1',saleOrderId:1,saleOrderName:'DEMO/SO/1',sourceState:'assigned',salesTeam:'MOHD MESSINA',
      customer:{id:1,name:'DEMO calendar customer',address:'DEMO delivery address',city:'Messina',country:'IT',phones:['+390000000001'],email:null,contact:null},
      items:[{sourceLineId:10,productId:1,name:'DEMO item',description:null,quantity:1,uom:'unit',configuration:null,ambient:null,notes:null,photoUrl:null}],
      serviceType:'delivery_only',estimatedMinutes:null,notes:'DEMO PRIVATE SOURCE NOTE'},randomUUID());
    const before=appointment('07:00','08:00'); const after=appointment('12:00','13:00');
    const spanning=appointment('07:30','08:30'); const main=appointment('09:00','10:00','in_progress',[assignment(),assignment(sameNameId,otherCrewId)]);
    const cancelled=appointment('10:00','11:00','cancelled'); const completed=appointment('11:00','11:30','in_progress');
    completed.workScope=planVisitWork(delivery,[{sourceLineId:10,deliveryMilli:1000,installationMilli:0,collectionMilli:0}],
      {id:operatorUser.id,name:'DEMO calendar operator',role:'operator'},'2026-11-10T06:00:00Z');
    delivery.appointments=[completed];
    delivery=recordExecution(delivery,{id:randomUUID(),appointmentId:completed.id,supersedesResultId:null,correctionReason:null,
      actualStart:completed.startsAt,actualEnd:completed.endsAt,summary:'DEMO PRIVATE RESULT',responsiblePersonId:personId,
      quantities:[{sourceLineId:10,deliveredMilli:1000}],completedChecklistIds:completed.assignments.flatMap((entry)=>entry.tasks.flatMap((task)=>task.checklist.map((checkpoint)=>checkpoint.id))),evidence:[],
      customerSignature:{status:'signed',signerName:'DEMO customer',text:'DEMO PRIVATE SIGNATURE',at:completed.endsAt},
      crewSignature:{status:'signed',signerName:'DEMO SAVED same person label',text:'DEMO PRIVATE CREW SIGNATURE',at:completed.endsAt}},
    {kind:'crew',id:personId,name:'DEMO SAVED same person label'},'2026-11-10T11:30:00Z');
    delivery.appointments=[after,cancelled,...delivery.appointments,before,main,spanning];
    const requestId=randomUUID();
    delivery=raiseReturnRequest(delivery,{id:requestId,originAppointmentId:completed.id,reason:'DEMO follow up',remainingWork:'DEMO additional check',notes:null,photoIds:[],issueIds:[]},
      {id:operatorUser.id,name:'DEMO calendar operator',role:'operator'},'2026-11-10T11:30:00Z');
    const returnVisit=appointment('11:30','12:00'); returnVisit.returnRequestId=requestId;
    delivery.appointments.push(returnVisit);
    const request=delivery.returnRequests.find((entry)=>entry.id===requestId); assert.ok(request); request.status='planned';request.appointmentId=returnVisit.id;
    delivery=DeliverySchema.parse(delivery);
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,1,$3,$4::jsonb)',[delivery.id,schema,delivery.version,JSON.stringify(delivery)]);
    for(const visit of delivery.appointments) await database.source.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',[visit.id,delivery.id,visit.startsAt,visit.endsAt,visit.status]);
    await database.source.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,status) VALUES($1,$2,$3,'DEMO PRIVATE FILE','text/plain',1,'document','pending')`,[randomUUID(),delivery.id,adminUser.id]);
    await database.source.destroy();
    const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(Database).useValue(database).compile();
    app=module.createNestApplication<NestExpressApplication>({logger:false,bodyParser:false}); configureApplication(app); await app.listen(0,'127.0.0.1');
    const base=await app.getUrl();
    async function login(email:string):Promise<string> {
      const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:config().FRONTEND_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
      assert.equal(response.status,201);const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);return cookie;
    }
    const adminCookie=await login('calendar-admin@example.test');const operatorCookie=await login('calendar-operator@example.test');
    const range=new URLSearchParams({from:'2026-11-10T08:00:00Z',to:'2026-11-10T12:00:00Z'}).toString();
    function route(id:string=personId,query=range):string{return `/participants/${id}/calendar?${query}`;}
    async function get(path:string,cookie?:string) {
      const response=await fetch(base+'/api'+path,{headers:cookie?{Cookie:cookie}:{}});const raw:unknown=await response.json();return {status:response.status,raw};
    }
    async function calendar(id:string=personId,cookie=operatorCookie,query=range) {
      const reply=await get(route(id,query),cookie);assert.equal(reply.status,200);return ParticipantCalendarSchema.parse(reply.raw);
    }
    const businessBefore=await rows(database.source.manager,z.object({data:z.unknown()}),`SELECT jsonb_build_object(
      'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM delivery d),
      'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM person p),
      'crews',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM crew c),
      'roster',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.crew_id,m.person_id) FROM crew_member m),
      'appointments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM appointment a),
      'audit',(SELECT count(*) FROM audit),'reservations',(SELECT count(*) FROM reservation)) AS data`);

    await context.test('real admin/operator sessions can read, anonymous and malformed routes cannot',async()=>{
      assert.equal((await get(route())).status,401);
      assert.equal((await get('/participants/not-a-uuid/calendar?'+range,operatorCookie)).status,400);
      assert.equal((await get(route(randomUUID()),operatorCookie)).status,404);
      const operator=await calendar();const admin=await calendar(personId,adminCookie);assert.deepEqual(operator,admin);
      assert.deepEqual(await calendar(personId.toUpperCase()),operator,'UUID casing must not change identity');
      assert.equal(operator.participant.id,personId);assert.equal(operator.participant.enabled,false,'Existing assignments remain visible for a disabled person');
    });
    await context.test('range validation stays aligned with calendar: explicit instants, strict fields and at most 45 days',async()=>{
      const invalid:Record<string,string>[]=[{}, {from:'2026-11-10T08:00:00',to:'2026-11-10T12:00:00Z'},
        {from:'2026-02-30T08:00:00Z',to:'2026-03-01T12:00:00Z'}, {from:'2026-11-10T12:00:00Z',to:'2026-11-10T08:00:00Z'},
        {from:'2026-11-10T08:00:00Z',to:'2026-11-10T08:00:00Z'}, {from:'2026-11-01T00:00:00Z',to:'2026-12-16T00:00:00.001Z'},
        {from:'2026-11-10T08:00:00Z',to:'2026-11-10T12:00:00Z',role:'admin'}];
      for(const value of invalid) {
        const query=new URLSearchParams(value).toString();
        assert.equal((await get(route(personId,query),operatorCookie)).status,400);
        assert.equal((await get('/calendar?'+query,operatorCookie)).status,400);
      }
      const query=new URLSearchParams({from:'2026-11-01T00:00:00Z',to:'2026-12-16T00:00:00Z'}).toString();
      assert.equal((await get(route(personId,query),operatorCookie)).status,200);
      assert.equal((await get('/calendar?'+query,operatorCookie)).status,200);
    });
    await context.test('six-week month grids including an extra autumn DST hour are allowed through both real calendar routes',async()=>{
      const from='2026-10-05T00:00:00+02:00';const to='2026-11-16T00:00:00+01:00';
      assert.equal(Date.parse(to)-Date.parse(from),42*86400000+3600000);
      const query=new URLSearchParams({from,to}).toString();
      assert.equal((await get(route(personId,query))).status,401);
      assert.equal((await get('/calendar?'+query)).status,401);
      for(const cookie of [operatorCookie,adminCookie]) {
        const personal=await calendar(personId,cookie,query);
        assert.deepEqual(new Set(personal.entries.map((entry)=>entry.appointmentId)),new Set(delivery.appointments.map((entry)=>entry.id)));
        const reply=await get('/calendar?'+query,cookie);assert.equal(reply.status,200);
        const general=z.array(z.object({deliveryId:z.string().uuid(),pickingName:z.string(),customerName:z.string(),appointment:AppointmentSchema}).strict()).parse(reply.raw);
        assert.deepEqual(new Set(general.map((entry)=>entry.appointment.id)),new Set(delivery.appointments.map((entry)=>entry.id)));
        assert.ok(general.every((entry)=>entry.deliveryId===delivery.id));
      }
    });
    await context.test('actual UUID membership selects only the matching saved assignment, never the current default roster or name',async()=>{
      const result=await calendar();
      assert.deepEqual(result.entries.map((entry)=>entry.appointmentId),[spanning.id,main.id,cancelled.id,completed.id,returnVisit.id]);
      assert.deepEqual(result.entries.map((entry)=>entry.status),['booked','in_progress','cancelled','completed','booked']);
      assert.deepEqual(result.entries.map((entry)=>entry.returnVisit),[false,false,false,false,true]);
      assert.ok(result.entries.every((entry)=>entry.assignment.people.some((person)=>person.id===personId)));
      const namedColleague=await calendar(sameNameId);assert.equal(namedColleague.participant.name,result.participant.name);
      assert.deepEqual(namedColleague.entries.map((entry)=>entry.appointmentId),[main.id]);
      assert.equal(namedColleague.entries[0]?.assignment.crewId,otherCrewId);
      assert.deepEqual((await calendar(rosterOnlyId)).entries,[],'Default roster membership does not create calendar work');
    });
    await context.test('half-open overlap includes spanning visits and excludes both exact outside boundaries with offset-equivalent queries',async()=>{
      const result=await calendar();assert.equal(result.entries.some((entry)=>entry.appointmentId===before.id||entry.appointmentId===after.id),false);
      const offset=new URLSearchParams({from:'2026-11-10T09:00:00+01:00',to:'2026-11-10T13:00:00+01:00'}).toString();
      assert.deepEqual(await calendar(personId,operatorCookie,offset),result);
    });
    await context.test('projection retains crew/task/checklist snapshots and excludes credentials, results, files and source notes',async()=>{
      const reply=await get(route(),operatorCookie);const result=ParticipantCalendarSchema.parse(reply.raw);
      const visit=result.entries.find((entry)=>entry.appointmentId===main.id);assert.ok(visit);
      assert.deepEqual(visit.assignment,main.assignments[0]);
      assert.equal(visit.assignment.crewName,'DEMO SAVED crew name');assert.equal(visit.assignment.tasks[0]?.title,'DEMO SAVED task');
      assert.equal(visit.startsAt,main.startsAt);assert.equal(visit.endsAt,main.endsAt);
      const finished=result.entries.find((entry)=>entry.appointmentId===completed.id);assert.ok(finished);
      assert.equal(finished.assignment.tasks[0]?.checklist[0]?.done,true);
      const raw=JSON.stringify(reply.raw);
      for(const forbidden of ['login','hasPassword','password_hash','passwordHash','PRIVATE SIGNATURE','PRIVATE CREW SIGNATURE','PRIVATE RESULT','PRIVATE FILE','PRIVATE SOURCE NOTE','results','sourceSnapshot','instructionsSnapshot']) {
        assert.equal(raw.includes(forbidden),false,`Projection must omit ${forbidden}`);
      }
      assert.equal(raw.includes(password),false);assert.equal(raw.includes(passwordHash),false);
    });
    await context.test('OpenAPI documents the read-only route and all calendar reads leave business records unchanged',async()=>{
      const reply=await get('/openapi.json',adminCookie);assert.equal(reply.status,200);
      const document=z.object({paths:z.record(z.string(),z.record(z.string(),z.object({security:z.array(z.record(z.string(),z.array(z.unknown()))),
        parameters:z.array(z.object({name:z.string(),in:z.string(),required:z.boolean().optional()})),responses:z.record(z.string(),z.unknown())})))}).parse(reply.raw);
      const operation=document.paths['/participants/{id}/calendar']?.['get'];assert.ok(operation);
      assert.deepEqual(operation.security,[{session:[]}]);assert.deepEqual(operation.parameters.map((parameter)=>parameter.name),['id','from','to']);
      const response=z.object({content:z.object({'application/json':z.object({schema:z.object({properties:z.object({participant:z.object({properties:z.record(z.string(),z.unknown())}),entries:z.unknown()})})})})}).parse(operation.responses['200']);
      assert.equal(Object.hasOwn(response.content['application/json'].schema.properties.participant.properties,'login'),false);
      assert.equal(Object.hasOwn(response.content['application/json'].schema.properties.participant.properties,'hasPassword'),false);
      const businessAfter=await rows(database.source.manager,z.object({data:z.unknown()}),`SELECT jsonb_build_object(
        'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM delivery d),
        'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM person p),
        'crews',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM crew c),
        'roster',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.crew_id,m.person_id) FROM crew_member m),
        'appointments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM appointment a),
        'audit',(SELECT count(*) FROM audit),'reservations',(SELECT count(*) FROM reservation)) AS data`);
      assert.deepEqual(businessAfter,businessBefore);
    });
  } finally {
    if(app) await app.close();else if(database.source.isInitialized) await database.source.destroy();
    if(owner.isInitialized){await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.destroy();}
  }
});
