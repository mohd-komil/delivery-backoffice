import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDelivery, TransportAllocationSchema, type Appointment } from '../src/domain/model';
import { planVisitWork, recordExecution } from '../src/domain/rules';
import { TransportCreateInput, VehicleCreateInput } from '../src/operations/contracts';
import { validateTransportWindow } from '../src/operations/vehicles';

function fixture() {
  const person={id:randomUUID(),name:'DEMO transport representative',external:false};
  const delivery=createDelivery({pickingId:1,pickingName:'DEMO/TRANSPORT/RULES',saleOrderId:1,saleOrderName:'DEMO/SO/1',sourceState:'assigned',salesTeam:'MOHD MESSINA',
    customer:{id:1,name:'DEMO customer',address:null,city:null,country:'IT',phones:[],email:null,contact:null},
    items:[{sourceLineId:10,productId:1,name:'DEMO transport item',description:null,quantity:1,uom:'unit',configuration:null,ambient:null,notes:null,photoUrl:null}],
    serviceType:'delivery_only',estimatedMinutes:null,notes:null},randomUUID());
  const appointment:Appointment={id:randomUUID(),startsAt:'2026-11-03T08:00:00Z',endsAt:'2026-11-03T09:00:00Z',status:'booked',cancellationReason:null,returnRequestId:null,
    assignments:[{id:randomUUID(),crewId:randomUUID(),crewName:'DEMO crew',people:[person],tasks:[{id:randomUUID(),templateId:randomUUID(),title:'DEMO inspect',severity:'low',order:1,checklist:[{id:randomUUID(),label:'DEMO check',done:false,waiver:null}]}]}],results:[]};
  appointment.workScope=planVisitWork(delivery,[{sourceLineId:10,deliveryMilli:1000,installationMilli:0,collectionMilli:0}],
    {id:randomUUID(),name:'DEMO planner',role:'operator'},'2026-11-03T07:00:00Z');
  delivery.appointments.push(appointment);
  return {delivery,appointment,person};
}

void test('transport DTOs normalize plate case, require physical IDs and keep strict provider/driver boundaries',()=>{
  const company={ownership:'company',name:'DEMO van',plate:'  demo-123  ',providerName:null,providerContact:null,operationalStatus:'available',enabled:true,notes:null};
  assert.equal(VehicleCreateInput.parse(company).plate,'DEMO-123');
  assert.equal(VehicleCreateInput.safeParse({...company,providerName:'DEMO provider'}).success,false);
  assert.equal(VehicleCreateInput.safeParse({...company,ownership:'external'}).success,false);
  assert.equal(VehicleCreateInput.safeParse({...company,ownership:'external',providerName:'DEMO provider'}).success,true);
  assert.equal(VehicleCreateInput.safeParse({...company,capacity:'unverified'}).success,false);
  const command={version:1,requestId:randomUUID(),vehicleId:randomUUID(),reserveFrom:'2026-11-03T07:00:00Z',reserveTo:'2026-11-03T11:00:00Z',driver:{kind:'none'}};
  assert.equal(TransportCreateInput.safeParse(command).success,true);
  assert.equal(TransportCreateInput.safeParse({...command,vehicleId:null}).success,false);
  assert.equal(TransportCreateInput.safeParse({...command,driver:{kind:'participant',participantId:randomUUID(),hasLicense:true}}).success,false);
  assert.equal(TransportCreateInput.safeParse({...command,driver:{kind:'external',name:'DEMO driver',phone:''}}).success,false);
});

void test('transport windows cover service, require absolute instants and allow exactly 45 elapsed days',()=>{
  const {appointment}=fixture();
  assert.doesNotThrow(()=>validateTransportWindow(appointment,appointment.startsAt,appointment.endsAt));
  assert.doesNotThrow(()=>validateTransportWindow(appointment,'2026-11-03T00:00:00Z','2026-12-18T00:00:00Z'));
  assert.throws(()=>validateTransportWindow(appointment,'2026-11-03T00:00:00Z','2026-12-18T00:00:00.001Z'));
  assert.throws(()=>validateTransportWindow(appointment,'2026-11-03T08:00:00.001Z',appointment.endsAt));
  assert.throws(()=>validateTransportWindow(appointment,appointment.startsAt,'2026-11-03T08:59:59.999Z'));
  assert.throws(()=>validateTransportWindow(appointment,'2026-11-03T08:00:00','2026-11-03T09:00:00'));
});

void test('execution freezes active transport independently and leaves legacy results without invented transport',()=>{
  const {delivery,appointment,person}=fixture();
  appointment.status='in_progress';
  const allocation=TransportAllocationSchema.parse({id:randomUUID(),vehicle:{id:randomUUID(),version:2,ownership:'company',name:'DEMO van original',plate:'DEMO-123',providerName:null,providerContact:null},driver:{kind:'participant',person},
    reserveFrom:'2026-11-03T07:00:00Z',reserveTo:'2026-11-03T11:00:00Z',status:'active',createdAt:'2026-11-02T08:00:00Z',createdBy:{id:randomUUID(),name:'DEMO operator'},replacesAllocationId:null,retiredAt:null,retiredBy:null,retirementReason:null});
  const command={id:randomUUID(),appointmentId:appointment.id,supersedesResultId:null,correctionReason:null,actualStart:appointment.startsAt,actualEnd:appointment.endsAt,summary:'DEMO completed work',responsiblePersonId:person.id,quantities:[],
    incompleteWork:[{sourceLineId:10,operation:'delivery' as const,reason:'access' as const,note:'DEMO entrance blocked.'}],
    completedChecklistIds:appointment.assignments.flatMap((assignment)=>assignment.tasks.flatMap((task)=>task.checklist.map((item)=>item.id))),evidence:[],customerSignature:null,crewSignature:null};
  const legacy=recordExecution(delivery,command,{kind:'crew',...person},'2026-11-03T09:00:00Z');
  assert.equal(Object.hasOwn(legacy.appointments[0]?.results[0]??{},'transportSnapshot'),false);
  appointment.transportAllocations=[allocation];
  const completed=recordExecution(delivery,command,{kind:'crew',...person},'2026-11-03T09:00:00Z');
  const saved=completed.appointments[0]?.results[0]?.transportSnapshot;assert.ok(saved);
  assert.deepEqual(saved,[allocation]);
  allocation.vehicle.name='DEMO changed after receipt';
  allocation.status='cancelled';
  assert.equal(saved[0]?.vehicle.name,'DEMO van original');
  assert.equal(saved[0]?.status,'active');
  assert.equal(saved[0]?.reserveTo,'2026-11-03T11:00:00Z');
});
