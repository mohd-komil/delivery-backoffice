import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { rows } from '../src/database/database';
import { TaskTemplateSchema } from '../src/domain/model';
import { DirectoryDeletionSchema, ParticipantSchema, SkillSchema, VehicleSchema } from '../src/operations/contracts';
import { DeliveryDetail, lifecycleFixture, type LifecycleFixture } from './support/route-lifecycle-fixture';

async function skill(h:LifecycleFixture,name:string,cookie=h.adminCookie) {
  return SkillSchema.parse(await h.ok('/skills',{method:'POST',cookie,body:{name,description:'DEMO qualification',enabled:true}}));
}
async function vehicle(h:LifecycleFixture,name:string,cookie=h.adminCookie) {
  return VehicleSchema.parse(await h.ok('/vehicles',{method:'POST',cookie,body:{name,plate:`D${randomUUID().slice(0,8)}`,
    ownership:'company',providerName:null,providerContact:null,operationalStatus:'available',enabled:true,notes:'DEMO vehicle'}}));
}

void test('skill and vehicle CRUD protect grants, history and concurrent planning on isolated PostgreSQL',async(context)=>{
  const h=await lifecycleFixture();
  try {
    await context.test('single reads and unused deletion enforce session, origin and captured version',async()=>{
      const records=[{path:'skills',kind:'skill',record:await skill(h,'DEMO removable skill')},
        {path:'vehicles',kind:'vehicle',record:await vehicle(h,'DEMO removable vehicle')}];
      for(const {path,kind,record} of records) {
        const route=`/${path}/${record.id}`;
        assert.deepEqual(await h.ok(route),record);
        assert.equal((await h.request(route,{cookie:''})).status,401);
        assert.equal((await h.request(`/${path}/invalid`)).status,400);
        assert.equal((await h.request(`/${path}/${randomUUID()}`)).status,404);
        const command={version:record.version};
        assert.equal((await h.request(route,{method:'DELETE',body:command,cookie:''})).status,401);
        assert.equal((await h.request(route,{method:'DELETE',body:command,origin:'https://untrusted.example'})).status,403);
        assert.equal((await h.request(route,{method:'DELETE',body:command,cookie:h.adminCookie,origin:'https://untrusted.example'})).status,403);
        assert.equal((await h.request(route,{method:'DELETE',body:{version:0},cookie:h.adminCookie})).status,400);
        assert.equal((await h.request(route,{method:'DELETE',body:{...command,force:true},cookie:h.adminCookie})).status,400);
        assert.equal((await h.request(route,{method:'DELETE',body:{version:record.version+1},cookie:h.adminCookie})).status,409);
        assert.deepEqual(DirectoryDeletionSchema.parse(await h.ok(route,{method:'DELETE',body:command,cookie:h.adminCookie})),{id:record.id,deleted:true});
        assert.equal((await h.request(route)).status,404);
        assert.equal((await h.request(route,{method:'DELETE',body:command,cookie:h.adminCookie})).status,404);
        const audit=await rows(h.database.source.manager,z.object({action:z.string(),details:z.object({id:z.string(),version:z.number()})}),
          'SELECT action,details FROM audit WHERE action=$1 AND details->>\'id\'=$2',[`${kind}.deleted`,record.id]);
        assert.deepEqual(audit,[{action:`${kind}.deleted`,details:{id:record.id,version:record.version}}]);
      }
    });

    await context.test('operator can create, read, edit, disable and delete unused skills and vehicles',async()=>{
      const records=[{path:'skills',record:await skill(h,'DEMO operator skill',h.operatorCookie)},
        {path:'vehicles',record:await vehicle(h,'DEMO operator vehicle',h.operatorCookie)}];
      for(const {path,record} of records) {
        const {id,...editable}=record;
        const route=`/${path}/${id}`;
        assert.deepEqual(await h.ok(route),record);
        const result=await h.ok(route,{method:'PATCH',body:{...editable,name:`${record.name} revised`,enabled:false}});
        const updated=path==='skills'?SkillSchema.parse(result):VehicleSchema.parse(result);
        assert.equal(updated.version,record.version+1);assert.equal(updated.enabled,false);
        assert.equal(updated.name,`${record.name} revised`);
        assert.equal((await h.request(route,{method:'DELETE',body:{version:record.version}})).status,409);
        assert.deepEqual(DirectoryDeletionSchema.parse(await h.ok(route,{method:'DELETE',body:{version:updated.version}})),{id,deleted:true});
        assert.equal((await h.request(route)).status,404);
      }
    });

    await context.test('skill grants and template requirements prevent deletion; explicit disable preserves them',async()=>{
      const used=await skill(h,'DEMO granted skill');
      const person=await h.person('Skill owner');
      const granted=ParticipantSchema.parse(await h.ok(`/participants/${person.id}/skills`,{method:'PATCH',body:{version:person.version,skillIds:[used.id]}}));
      assert.deepEqual(granted.skillIds,[used.id]);
      const route=`/skills/${used.id}`;
      assert.equal((await h.request(route,{method:'DELETE',body:{version:used.version}})).status,409);
      const disabled=SkillSchema.parse(await h.ok(route,{method:'PATCH',cookie:h.adminCookie,body:{version:used.version,name:'DEMO retired skill',description:used.description,enabled:false}}));
      assert.deepEqual(ParticipantSchema.parse(await h.ok(`/participants/${person.id}`)).skillIds,[used.id]);
      assert.equal((await h.request(route,{method:'DELETE',cookie:h.adminCookie,body:{version:disabled.version}})).status,409);
      await h.ok(`/participants/${person.id}/skills`,{method:'PATCH',cookie:h.adminCookie,body:{version:granted.version,skillIds:[]}});
      await h.ok(route,{method:'DELETE',cookie:h.adminCookie,body:{version:disabled.version}});

      const required=await skill(h,'DEMO required skill');
      const template=await h.ok('/templates',{method:'POST',cookie:h.adminCookie,body:{title:'DEMO protected requirement',severity:'low',order:1,checklist:['Inspect'],requiredSkillIds:[required.id],enabled:false}});
      assert.equal((await h.request(`/skills/${required.id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:required.version}})).status,409);
      const templateId=z.object({id:z.string()}).parse(template).id;
      assert.deepEqual(await h.ok(`/templates/${templateId}`),template);
    });

    await context.test('operator manages task templates with version checks and safe unused deletion',async()=>{
      const created=TaskTemplateSchema.parse(await h.ok('/templates',{method:'POST',body:{title:'DEMO operator task',severity:'low',order:1,checklist:['Inspect'],enabled:true,requiredSkillIds:[]}}));
      const route=`/templates/${created.id}`;
      assert.deepEqual(TaskTemplateSchema.parse(await h.ok(route)),created);
      const updated=TaskTemplateSchema.parse(await h.ok(route,{method:'PATCH',body:{...created,title:'DEMO revised operator task',enabled:false,checklist:['Inspect','Check quantity']}}));
      assert.equal(updated.version,2); assert.equal(updated.enabled,false); assert.equal(updated.checklist.length,2);
      assert.equal((await h.request(route,{method:'PATCH',body:created})).status,409);
      assert.equal((await h.request(route,{method:'DELETE',body:{version:created.version}})).status,409);
      assert.deepEqual(DirectoryDeletionSchema.parse(await h.ok(route,{method:'DELETE',body:{version:updated.version}})),{id:created.id,deleted:true});
      assert.equal((await h.request(route)).status,404);
    });

    const f=await h.fixture({count:1});
    await context.test('crew and anonymous credentials cannot mutate Backoffice catalogues or participant grants',async()=>{
      const records=[{path:'skills',record:await skill(h,'DEMO crew protected skill')},{path:'vehicles',record:f.vehicle},
        {path:'participants',record:f.participant},{path:'crews',record:f.crew},{path:'templates',record:f.template}];
      for(const {path,record} of records) {
        for(const cookie of [f.cookie,'']) {
          assert.equal((await h.request(`/${path}/${record.id}`,{cookie})).status,401);
          assert.equal((await h.request(`/${path}`,{method:'POST',cookie,body:{}})).status,401);
          assert.equal((await h.request(`/${path}/${record.id}`,{method:'PATCH',cookie,body:{}})).status,401);
          assert.equal((await h.request(`/${path}/${record.id}`,{method:'DELETE',cookie,body:{version:1}})).status,401);
        }
      }
      for(const cookie of [f.cookie,'']) {
        assert.equal((await h.request(`/participants/${f.participant.id}/skills`,{method:'PATCH',cookie,body:{version:f.participant.version,skillIds:[]}})).status,401);
      }
    });

    await context.test('saved routes protect vehicles and history retains the allocated vehicle after catalogue edits',async()=>{
      const published=await h.publish(f);
      const route=`/vehicles/${f.vehicle.id}`;
      const before=await h.detail(f.deliveries[0]?.id??'');
      assert.equal((await h.request(route,{method:'DELETE',body:{version:f.vehicle.version}})).status,409);
      const {id,...editable}=f.vehicle;
      const updated=VehicleSchema.parse(await h.ok(`/vehicles/${id}`,{method:'PATCH',cookie:h.adminCookie,body:{...editable,name:'DEMO renamed vehicle'}}));
      assert.equal(updated.version,2);
      assert.deepEqual(await h.detail(before.delivery.id),before,'Catalogue editing/deletion must not rewrite allocated snapshots');
      assert.equal((await h.request(route,{method:'PATCH',body:{...editable,version:updated.version,enabled:false}})).status,409,
        'Active published route must be resolved before disabling its vehicle');
      assert.ok(published);
      const oldVehicle=await vehicle(h,'DEMO only in route revision');
      const oldSkill=await skill(h,'DEMO only in route revision');
      // An isolated historical revision preserves references no longer in current catalogues/drafts.
      await h.database.source.query(`INSERT INTO route_revision(route_id,version,status,data,runtime,actor_id,actor_name,action)
        SELECT id,version,status,data||$1::jsonb,runtime,$2,'DEMO historical planner','route.test_snapshot' FROM route_publication`,
        [JSON.stringify({previousVehicle:{id:oldVehicle.id},previousSkill:{id:oldSkill.id}}),randomUUID()]);
      const [revision]=await rows(h.database.source.manager,z.object({route_id:z.string(),version:z.number(),data:z.record(z.string(),z.unknown())}),
        'SELECT route_id,version,data FROM route_revision ORDER BY version LIMIT 1');
      assert.ok(revision);
      assert.equal((await h.request(`/vehicles/${oldVehicle.id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:oldVehicle.version}})).status,409,
        'A vehicle referenced only in an older route revision still belongs to history');
      assert.equal((await h.request(`/skills/${oldSkill.id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:oldSkill.version}})).status,409,
        'A skill referenced only in an older route revision still belongs to history');
      const [after]=await rows(h.database.source.manager,z.object({data:z.unknown()}),'SELECT data FROM route_revision WHERE route_id=$1 AND version=$2',[revision.route_id,revision.version]);
      assert.deepEqual(after?.data,revision.data);
    });

    await context.test('delete cannot race a skill grant or a vehicle update',async()=>{
      const candidate=await skill(h,'DEMO concurrent skill');
      const person=await h.person('Concurrent skill owner');
      const [grant,removed]=await Promise.all([
        h.request(`/participants/${person.id}/skills`,{method:'PATCH',cookie:h.adminCookie,body:{version:person.version,skillIds:[candidate.id]}}),
        h.request(`/skills/${candidate.id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:candidate.version}}),
      ]);
      if(removed.status===200) {assert.equal(grant.status,404);assert.deepEqual(ParticipantSchema.parse(await h.ok(`/participants/${person.id}`)).skillIds,[]);}
      else {assert.equal(removed.status,409);assert.equal(grant.status,200);assert.deepEqual(ParticipantSchema.parse(await h.ok(`/participants/${person.id}`)).skillIds,[candidate.id]);}
      const car=await vehicle(h,'DEMO concurrent vehicle'); const {id,...editable}=car;
      const [updated,deleted]=await Promise.all([
        h.request(`/vehicles/${id}`,{method:'PATCH',cookie:h.adminCookie,body:{...editable,name:'DEMO changed vehicle'}}),
        h.request(`/vehicles/${id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:car.version}}),
      ]);
      if(deleted.status===200) {assert.equal(updated.status,404);assert.equal((await h.request(`/vehicles/${id}`)).status,404);}
      else {assert.equal(deleted.status,409);assert.equal(updated.status,200);assert.equal(VehicleSchema.parse(await h.ok(`/vehicles/${id}`)).version,2);}
    });

    await context.test('delete and transport allocation cannot leave an orphan vehicle',async()=>{
      const car=await vehicle(h,'DEMO allocation race');
      const next=await h.fixture({count:1,departAt:'2031-03-03T08:00:00Z'});
      const delivery=next.deliveries[0]; assert.ok(delivery);
      const booked=DeliveryDetail.parse(await h.ok(`/deliveries/${delivery.id}/appointments`,{method:'POST',body:{version:delivery.version,requestId:randomUUID(),
        startsAt:'2031-03-03T09:00:00Z',endsAt:'2031-03-03T10:00:00Z',workLines:next.workLines}}));
      const appointment=booked.delivery.appointments[0];assert.ok(appointment);
      const [allocated,deleted]=await Promise.all([
        h.request(`/deliveries/${delivery.id}/appointments/${appointment.id}/transport`,{method:'POST',body:{version:booked.delivery.version,requestId:randomUUID(),vehicleId:car.id,
          reserveFrom:appointment.startsAt,reserveTo:appointment.endsAt,driver:{kind:'none'}}}),
        h.request(`/vehicles/${car.id}`,{method:'DELETE',cookie:h.adminCookie,body:{version:car.version}}),
      ]);
      if(deleted.status===200) {assert.equal(allocated.status,404);assert.equal((await h.detail(delivery.id)).delivery.appointments[0]?.transportAllocations?.length??0,0);}
      else {assert.equal(deleted.status,409);assert.equal(allocated.status,201);assert.equal((await h.detail(delivery.id)).delivery.appointments[0]?.transportAllocations?.[0]?.vehicle.id,car.id);}
    });
  }finally{await h.close();}
});
