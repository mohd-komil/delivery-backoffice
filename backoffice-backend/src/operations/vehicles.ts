import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { IdSchema, TransportAllocationSchema, VehicleSnapshotSchema, type Appointment, type OperatorActor, type TransportAllocation } from '../domain/model';
import { validateInterval } from '../domain/rules';
import { CalendarQuerySchema, TRANSPORT_MAX_DAYS, TransportAvailabilitySchema, VehicleCreateInput, VehicleSchema, VehicleUpdateInput, type TransportPlan, type Vehicle } from './contracts';
import { Participants } from './participants';
import { DeliveryStore } from './store';
import { appointmentRoute, assertRouteResourceMutable, RESOURCE_BOOKINGS_SQL } from './route-reservations';

const VehicleSelect=`SELECT id,version,ownership,name,plate,provider_name AS "providerName",provider_contact AS "providerContact",operational_status AS "operationalStatus",enabled,notes FROM vehicle`;
const BusySchema=z.object({resource:z.string(),appointmentId:IdSchema,pickingName:z.string(),startsAt:z.date(),endsAt:z.date()});
type Interval={resource:string;startsAt:string;endsAt:string};

/** Physical vehicle reservations use their own loading/departure-to-return interval. */
export function validateTransportWindow(appointment:Appointment,from:string,to:string):void {
  validateInterval(from,to);
  if(Date.parse(to)-Date.parse(from)>TRANSPORT_MAX_DAYS*86400000) throw new BadRequestException(`Transport reservation is limited to ${TRANSPORT_MAX_DAYS} days`);
  if(Date.parse(from)>Date.parse(appointment.startsAt)||Date.parse(to)<Date.parse(appointment.endsAt)) throw new BadRequestException('Transport reservation must cover the complete visit interval');
}

export function activeTransport(appointment:Appointment):TransportAllocation[] {
  return (appointment.transportAllocations??[]).filter((allocation)=>allocation.status==='active');
}

@Injectable()
export class Vehicles {
  constructor(@Inject(DeliveryStore) private readonly store:DeliveryStore,@Inject(Participants) private readonly people:Participants) {}

  async list(manager:EntityManager=this.store.db.source.manager):Promise<Vehicle[]> {
    const found=await rows(manager,VehicleSchema,`${VehicleSelect} ORDER BY lower(name),plate,id LIMIT 5001`);
    if(found.length>5000) throw new ConflictException('The vehicle catalogue exceeds the 5000-record local demo limit');
    return found;
  }

  async requireAvailable(manager: EntityManager, id: string): Promise<Vehicle> {
    const [vehicle] = await rows(manager, VehicleSchema, `${VehicleSelect} WHERE id=$1`, [id]);
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (!vehicle.enabled || vehicle.operationalStatus !== 'available') {
      throw new ConflictException(`Vehicle "${vehicle.name}" (${vehicle.plate}) is disabled or unavailable`);
    }
    return vehicle;
  }

  async save(id:string|null,input:unknown,actor:OperatorActor):Promise<Vehicle> {
    if(actor.role!=='admin') throw new ForbiddenException('Administrator permission required');
    const command=id?VehicleUpdateInput.parse(input):VehicleCreateInput.parse(input);
    const vehicleId=id?IdSchema.parse(id).toLowerCase():randomUUID();
    try {
      return await this.store.db.source.transaction(async(manager)=>{
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const previous=id?(await rows(manager,VehicleSchema,`${VehicleSelect} WHERE id=$1 FOR UPDATE`,[vehicleId]))[0]:undefined;
        if(id&&!previous) throw new NotFoundException('Vehicle not found');
        if(previous&&(!('version' in command)||command.version!==previous.version)) throw new ConflictException('Vehicle changed. Reload before editing.');
        if(previous && (!command.enabled || command.operationalStatus!=='available')) await assertRouteResourceMutable(manager,`vehicle:${vehicleId}`);
        const version=previous?previous.version+1:1;
        const notes=command.notes?.trim()||null;
        if(previous) await manager.query(`UPDATE vehicle SET version=$2,ownership=$3,name=$4,plate=$5,provider_name=$6,provider_contact=$7,operational_status=$8,enabled=$9,notes=$10 WHERE id=$1`,
          [vehicleId,version,command.ownership,command.name,command.plate,command.providerName,command.providerContact,command.operationalStatus,command.enabled,notes]);
        else await manager.query(`INSERT INTO vehicle(id,version,ownership,name,plate,provider_name,provider_contact,operational_status,enabled,notes) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vehicleId,command.ownership,command.name,command.plate,command.providerName,command.providerContact,command.operationalStatus,command.enabled,notes]);
        // A catalogue status change never cancels or rewrites existing transport allocations.
        await this.store.audit(manager,actor,previous?'vehicle.updated':'vehicle.created',{id:vehicleId,version,operationalStatus:command.operationalStatus,enabled:command.enabled});
        return VehicleSchema.parse({...command,id:vehicleId,version,notes});
      });
    }catch(error:unknown){
      const driver:unknown=error instanceof QueryFailedError?error.driverError:null;
      if(z.object({code:z.literal('23505'),constraint:z.literal('vehicle_plate_unique')}).safeParse(driver).success) throw new ConflictException('A vehicle with this registration plate already exists');
      throw error;
    }
  }

  async add(manager:EntityManager,appointment:Appointment,plans:TransportPlan[],actor:OperatorActor,replacesAllocationId:string|null=null):Promise<void> {
    if(plans.length===0) return;
    if(appointment.status!=='booked'||appointment.results.length>0) throw new ConflictException('Transport can change only on an unstarted booked visit without results');
    if((appointment.transportAllocations?.length??0)+plans.length>200) throw new ConflictException('The visit transport history is limited to 200 entries');
    if(activeTransport(appointment).length+plans.length>20) throw new ConflictException('A visit can have at most 20 active vehicles');
    const additions:TransportAllocation[]=[];
    const at=new Date().toISOString();
    for(const plan of plans) {
      validateTransportWindow(appointment,plan.reserveFrom,plan.reserveTo);
      const vehicleId=plan.vehicleId.toLowerCase();
      const vehicle=await this.requireAvailable(manager,vehicleId);
      let driver:TransportAllocation['driver'];
      if(plan.driver.kind==='participant') {
        const person=(await this.people.selected(manager,[plan.driver.participantId.toLowerCase()]))[0];
        if(!person) throw new NotFoundException('Driver participant not found');
        if(!person.enabled) throw new ConflictException(`Driver "${person.name}" is disabled`);
        driver={kind:'participant',person:{id:person.id,name:person.name,external:person.external}};
      }else driver=plan.driver;
      additions.push(TransportAllocationSchema.parse({id:randomUUID(),vehicle:VehicleSnapshotSchema.parse({id:vehicle.id,version:vehicle.version,ownership:vehicle.ownership,name:vehicle.name,plate:vehicle.plate,providerName:vehicle.providerName,providerContact:vehicle.providerContact}),driver,
        reserveFrom:plan.reserveFrom,reserveTo:plan.reserveTo,status:'active',createdAt:at,createdBy:{id:actor.id,name:actor.name},replacesAllocationId,
        retiredAt:null,retiredBy:null,retirementReason:null}));
    }
    appointment.transportAllocations=[...(appointment.transportAllocations??[]),...additions];
    this.validateActive(appointment);
  }

  retire(appointment:Appointment,allocationId:string,status:'replaced'|'cancelled',reason:string,actor:OperatorActor):void {
    const allocation=appointment.transportAllocations?.find((entry)=>entry.id===allocationId.toLowerCase());
    if(!allocation) throw new NotFoundException('Transport allocation not found');
    if(allocation.status!=='active') throw new ConflictException('Only active transport can be replaced or cancelled');
    allocation.status=status;allocation.retiredAt=new Date().toISOString();allocation.retiredBy={id:actor.id,name:actor.name};allocation.retirementReason=reason;
  }

  private validateActive(appointment:Appointment):void {
    const active=activeTransport(appointment);
    const vehicleIds=new Set<string>();const driverIds=new Set<string>();
    for(const allocation of active) {
      validateTransportWindow(appointment,allocation.reserveFrom,allocation.reserveTo);
      if(vehicleIds.has(allocation.vehicle.id)) throw new ConflictException(`Vehicle "${allocation.vehicle.name}" is already active on this visit`);
      vehicleIds.add(allocation.vehicle.id);
      if(allocation.driver.kind==='participant') {
        if(driverIds.has(allocation.driver.person.id)) throw new ConflictException(`Participant "${allocation.driver.person.name}" cannot drive two active vehicles on the same visit`);
        driverIds.add(allocation.driver.person.id);
      }
    }
  }

  private transportIntervals(appointment:Appointment):{allocationId:string;resource:string;startsAt:string;endsAt:string}[] {
    if(appointment.status==='cancelled') return [];
    return activeTransport(appointment).flatMap((allocation)=>{
      const base={allocationId:allocation.id,startsAt:allocation.reserveFrom,endsAt:allocation.reserveTo};
      return [{...base,resource:'vehicle:'+allocation.vehicle.id},...(allocation.driver.kind==='participant'?[{...base,resource:'person:'+allocation.driver.person.id}]:[])];
    });
  }

  /** Rebuild both ledgers together; staffing edits must not erase independent vehicle/driver reservations. */
  async rebuild(manager:EntityManager,appointment:Appointment):Promise<void> {
    this.validateActive(appointment);
    const serviceResources=['booked','in_progress'].includes(appointment.status)?[...new Set(appointment.assignments.flatMap((assignment)=>['crew:'+assignment.crewId,...assignment.people.map((person)=>'person:'+person.id)]))]:[];
    const transport=this.transportIntervals(appointment);
    const wanted:Interval[]=[...serviceResources.map((resource)=>({resource,startsAt:appointment.startsAt,endsAt:appointment.endsAt})),...transport];
    const ownRoute=await appointmentRoute(manager,appointment.id);
    // Only a server-owned exact route membership permits sharing the route reservation.
    const conflict=await rows(manager,z.object({resource:z.string()}),`WITH wanted AS (
      SELECT resource,"startsAt"::timestamptz AS starts_at,"endsAt"::timestamptz AS ends_at
      FROM jsonb_to_recordset($1::jsonb) AS w(resource text,"startsAt" text,"endsAt" text)
    ), busy AS (${RESOURCE_BOOKINGS_SQL})
    SELECT busy.resource FROM busy JOIN wanted ON wanted.resource=busy.resource
      AND busy.starts_at-(busy.buffer_minutes*interval '1 minute')<wanted.ends_at
      AND busy.ends_at+(busy.buffer_minutes*interval '1 minute')>wanted.starts_at
      WHERE (busy.route_id IS NOT NULL OR busy.appointment_id<>$2)
        AND ($3::uuid IS NULL OR busy.route_id IS DISTINCT FROM $3::uuid)
      LIMIT 1`,[JSON.stringify(wanted),appointment.id,ownRoute?.id??null]);
    const blocked=conflict[0];
    if(blocked) {
      const vehicle=activeTransport(appointment).find((allocation)=>'vehicle:'+allocation.vehicle.id===blocked.resource)?.vehicle;
      throw new ConflictException(vehicle?`Vehicle "${vehicle.name}" (${vehicle.plate}) is already reserved in this interval`:'Crew, driver or shared participant is already booked in this interval');
    }
    await manager.query('DELETE FROM reservation WHERE appointment_id=$1',[appointment.id]);
    for(const resource of serviceResources) await manager.query('INSERT INTO reservation(appointment_id,resource) VALUES($1,$2)',[appointment.id,resource]);
    await manager.query('DELETE FROM transport_reservation WHERE appointment_id=$1',[appointment.id]);
    for(const interval of transport) await manager.query('INSERT INTO transport_reservation(allocation_id,appointment_id,resource,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',[interval.allocationId,appointment.id,interval.resource,interval.startsAt,interval.endsAt]);
  }

  async conflicts(manager:EntityManager,appointmentId:string,from:string,to:string) {
    const ownRoute=await appointmentRoute(manager,appointmentId);
    const found=await rows(manager,BusySchema,`WITH busy AS (${RESOURCE_BOOKINGS_SQL})
    SELECT DISTINCT b.resource,b.appointment_id AS "appointmentId",
      CASE WHEN b.route_id IS NULL THEN d.data->'source'->>'pickingName' ELSE 'Route: '||(rd.data->>'name') END AS "pickingName",
      b.starts_at-(b.buffer_minutes*interval '1 minute') AS "startsAt",b.ends_at+(b.buffer_minutes*interval '1 minute') AS "endsAt"
      FROM busy b JOIN appointment a ON a.id=b.appointment_id JOIN delivery d ON d.id=a.delivery_id
      LEFT JOIN route_draft rd ON rd.id=b.route_id
      WHERE b.starts_at-(b.buffer_minutes*interval '1 minute')<$3::timestamptz
        AND b.ends_at+(b.buffer_minutes*interval '1 minute')>$2::timestamptz
        AND (b.route_id IS NOT NULL OR b.appointment_id<>$1)
        AND ($4::uuid IS NULL OR b.route_id IS DISTINCT FROM $4::uuid)
      ORDER BY "startsAt","appointmentId",b.resource LIMIT 5001`,[appointmentId,from,to,ownRoute?.id??null]);
    if(found.length>5000) throw new ConflictException('Availability exceeds the 5000-conflict local demo limit; narrow the interval');
    return found;
  }

  async availability(appointment:Appointment,input:unknown) {
    const query=CalendarQuerySchema.parse(input);
    validateTransportWindow(appointment,query.from,query.to);
    const manager=this.store.db.source.manager;
    const conflicts=await this.conflicts(manager,appointment.id,query.from,query.to);
    const byResource=new Map<string,{appointmentId:string;pickingName:string;startsAt:string;endsAt:string}[]>();
    for(const conflict of conflicts) {
      const entries=byResource.get(conflict.resource)??[];
      entries.push({appointmentId:conflict.appointmentId,pickingName:conflict.pickingName,startsAt:conflict.startsAt.toISOString(),endsAt:conflict.endsAt.toISOString()});
      byResource.set(conflict.resource,entries);
    }
    return TransportAvailabilitySchema.parse({
      vehicles:(await this.list(manager)).map((vehicle)=>({...vehicle,busy:byResource.has('vehicle:'+vehicle.id),conflicts:byResource.get('vehicle:'+vehicle.id)??[]})),
      people:(await this.people.list(manager)).map(({id,name,external,enabled})=>({id,name,external,enabled,busy:byResource.has('person:'+id),conflicts:byResource.get('person:'+id)??[]})),
    });
  }
}
