import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { DeliveryStore } from './store';
import { AssignInput, AvailabilitySchema, BookInput, CALENDAR_MAX_DAYS, CalendarQuerySchema, ChangeServiceInput, InstructionsInput, MoveInput, ParticipantCalendarProfileSchema, ParticipantCalendarSchema, ReasonInput, ResolveInput, ResponsibleParticipantInput, StaffingInput, TaskTemplateUpdateInput, TransportCancelInput, TransportCreateInput, TransportReplaceInput, VersionSchema, WorkReadinessInput, WorkScopeInput } from './contracts';
import { AppointmentSchema, IdSchema, IssueSchema, NullableTextSchema, TaskTemplateSchema, TextSchema, ViewSchema, type Appointment, type Delivery, type OperatorActor, type PriorWorkRevision, type Signature } from '../domain/model';
import { assignedParticipant, changeServicePlan, completeDelivery, confirmCustomerVisit, deriveViews, DomainError, effectiveResults, hasRemainingLineWork, planVisitWork, raiseIssue, raiseReturnRequest, releaseDamagedWork, reopenDelivery, reviewSignatureRefusal, validateInterval, waiveChecklist } from '../domain/rules';
import { Files, validateFileContent } from '../evidence/files';
import { distinctParticipants, Participants } from './participants';
import { Skills, validateSkillSelection } from './skills';
import { activeTransport, Vehicles } from './vehicles';
import { deliveryPlanning, DeliveryListQuerySchema, geographyFacets, matchingGeographyFacets, operationalGeographyFacets, selectDeliveryList } from './delivery-list';
import { areaBounds } from './delivery-area';
import { DeliveryPoints } from './delivery-points';
import { deleteDirectoryEntry, type DeletableDirectory } from './directory-deletion';
import { assertSignatureRefusalCorrectionPreservesCargo, assertStandaloneAppointment } from './route-reservations';
import { assertPlanningReady, retainWorkServiceDefault } from './planning';
import { instantiateAssignment } from './assignment-snapshot';
import { ChangeWorkQuantitiesInput, ChangeWorkTimeAdjustmentsInput, ChangeWorkTimesInput, ConfirmPriorWorkInput, SignatureRefusalReviewInput } from './contracts';
import { confirmPriorWork } from '../domain/rules';
import { latestPriorWork } from '../domain/prior-work';
import { changeRequiredWork, changeWorkTimeAdjustments, changeWorkTimes, lineServiceStatuses } from '../domain/rules';
import { deliveryGeography } from '../domain/delivery-geography';
import { calendarDestinationOptions, CalendarFilterCrewSchema, CalendarGeographyRowSchema } from './calendar-filters';

const DataRow=z.object({data:z.unknown()});
function calendarRange(input:unknown) {
  const query=CalendarQuerySchema.parse(input);
  validateInterval(query.from,query.to);
  if(Date.parse(query.to)-Date.parse(query.from)>CALENDAR_MAX_DAYS*86400000) throw new BadRequestException(`Calendar range is limited to ${CALENDAR_MAX_DAYS} days`);
  return query;
}
export function open(delivery:Delivery) { if(delivery.completedAt) throw new ConflictException('Reopen the delivery with a reason before changing work'); }
function visit(delivery:Delivery,id:string) {
  const appointment=delivery.appointments.find((entry)=>entry.id===id);
  if(!appointment) throw new NotFoundException('Appointment not found');
  return appointment;
}

function redactDrawing(signature: Signature | null) {
  return signature && 'strokes' in signature ? null : signature;
}

function appointmentOverview(appointment: Appointment): Appointment {
  return {
    ...appointment,
    results: appointment.results.map((result) => ({
      ...result,
      customerSignature: redactDrawing(result.customerSignature),
      crewSignature: redactDrawing(result.crewSignature),
    })),
  };
}

function requiredQuantities(delivery: Delivery, sourceLineId: number) {
  const line = lineServiceStatuses(delivery).find((entry) => entry.sourceLineId === sourceLineId);
  return line ? {
    deliveryMilli: line.totalDeliveryMilli,
    installationMilli: line.totalInstallationMilli,
    collectionMilli: line.totalCollectionMilli,
  } : null;
}
@Injectable()
export class Operations {
  constructor(@Inject(DeliveryStore) readonly store:DeliveryStore,@Inject(Files) private readonly files:Files,@Inject(Participants) private readonly directory:Participants,@Inject(Skills) private readonly skillCatalogue:Skills,@Inject(Vehicles) private readonly transport:Vehicles,@Inject(DeliveryPoints) private readonly points:DeliveryPoints) {}
  async list(input:unknown) {
    const query=DeliveryListQuerySchema.parse(input);
    const operationalView = query.view !== undefined && query.view !== 'inbox';
    const [all, crews] = await Promise.all([this.store.all(), operationalView && query.view !== 'planned' ? this.filterCrews() : []]);
    const counts=Object.fromEntries(ViewSchema.options.map((view)=>[view,all.filter((delivery)=>deriveViews(delivery).includes(view)).length]));
    const points=areaBounds(query)?await this.points.effectiveFor(all):undefined;
    const {filtered,area,facetGeographies,filterFacets}=selectDeliveryList(all,query,points,crews);
    const geographyCatalogue = operationalView ? all.map(deliveryGeography) : facetGeographies;
    const items = filtered.slice((query.page-1)*10, query.page*10).map(({delivery,geography}) => ({
      ...delivery, geography, planning:deliveryPlanning(delivery), appointments: delivery.appointments.map(appointmentOverview),
    }));
    return {items,total:filtered.length,page:query.page,pageSize:10,counts,area,filterFacets,
      geographyFacets: operationalView ? operationalGeographyFacets(geographyCatalogue, facetGeographies, query) : geographyFacets(facetGeographies, query),
      matchingGeographyFacets: matchingGeographyFacets(geographyCatalogue, query)};
  }
  async instructions(id:string,input:unknown,principal:OperatorActor) {
    const {version,...instructions}=InstructionsInput.parse(input);
    await this.store.mutate(id,version,principal,'instructions.updated',(delivery)=>{delivery.instructions=instructions;return delivery;});
    return this.store.detail(id);
  }
  async services(id: string, input: unknown, principal: OperatorActor) {
    const { version, ...change } = ChangeServiceInput.parse(input);
    await this.store.mutate(id, version, principal, { name: 'services.updated', details: () => change },
      (delivery) => changeServicePlan(delivery, change));
    return this.store.detail(id);
  }
  async workTimes(id: string, input: unknown, principal: OperatorActor) {
    const { version, ...change } = ChangeWorkTimesInput.parse(input);
    await this.store.mutate(id, version, principal, { name: 'work_times.updated', details: (delivery) => ({
      ...change, saved: delivery.servicePlan?.timeEstimates?.find(({ sourceLineId }) => sourceLineId === change.sourceLineId) ?? null,
    }) }, (delivery) => changeWorkTimes(delivery, change, principal, new Date().toISOString()));
    return this.store.detail(id);
  }
  async workTimeAdjustments(id: string, input: unknown, principal: OperatorActor) {
    const command = ChangeWorkTimeAdjustmentsInput.parse(input);
    const { version, requestId, reason, ...fields } = command;
    await this.store.mutate(id, version, principal, { name: 'work_times.adjustments_updated', details: (delivery) => ({
      reason, saved: delivery.workTimeAdjustments,
    }) }, (delivery) => changeWorkTimeAdjustments(delivery, fields, principal, new Date().toISOString()),
    { id: requestId, input: { ...command, actorId: principal.id } });
    return this.store.detail(id);
  }
  async workQuantities(id: string, input: unknown, principal: OperatorActor) {
    const { version, ...change } = ChangeWorkQuantitiesInput.parse(input);
    let previous: ReturnType<typeof requiredQuantities> = null;
    await this.store.mutate(id, version, principal, { name: 'work_quantities.updated', details: (delivery) => ({
      sourceLineId: change.sourceLineId, reason: change.reason, previous, current: requiredQuantities(delivery, change.sourceLineId),
      sourceItem: delivery.source.items.find(({ sourceLineId }) => sourceLineId === change.sourceLineId) ?? null,
    }) }, (delivery) => {
      const updated = changeRequiredWork(delivery, change, principal, new Date().toISOString());
      previous = requiredQuantities(delivery, change.sourceLineId);
      return updated;
    });
    return this.store.detail(id);
  }
  async priorWork(id: string, input: unknown, principal: OperatorActor) {
    const command = ConfirmPriorWorkInput.parse(input);
    const { version, ...change } = command;
    let previous: PriorWorkRevision | null = null;
    await this.store.mutate(id, version, principal, { name: 'prior_work.confirmed', details: (delivery) => ({
      previous, current: latestPriorWork(delivery).get(command.sourceLineId) ?? null,
    }) }, (delivery) => {
      previous = latestPriorWork(delivery).get(command.sourceLineId) ?? null;
      return confirmPriorWork(delivery, change, principal, new Date().toISOString());
    }, { id: command.requestId, input: { ...command, actorId: principal.id } });
    return this.store.detail(id);
  }
  private ready(delivery:Delivery) {
    assertPlanningReady(delivery);
  }
  private retainWorkServiceDefault(delivery:Delivery) {
    retainWorkServiceDefault(delivery);
  }
  async book(id:string,input:unknown,principal:OperatorActor) {
    const command=BookInput.parse(input); validateInterval(command.startsAt,command.endsAt);
    const appointmentId=randomUUID();
    await this.store.mutate(id,command.version,principal,{name:'appointment.booked',details:(delivery)=>({appointmentId,workScope:visit(delivery,appointmentId).workScope})},async(delivery,manager)=>{
      this.ready(delivery);
      const request=command.returnRequestId?delivery.returnRequests.find((entry)=>entry.id===command.returnRequestId):undefined;
      if(command.returnRequestId && (!request || request.status!=='requested')) throw new ConflictException('Return request must be awaiting planning');
      const workScope=planVisitWork(delivery,command.workLines,principal,new Date().toISOString());
      this.retainWorkServiceDefault(delivery);
      const appointment=AppointmentSchema.parse({id:appointmentId,startsAt:command.startsAt,endsAt:command.endsAt,status:'booked',cancellationReason:null,returnRequestId:command.returnRequestId??null,assignments:[],results:[],workScope});
      delivery.appointments.push(appointment);
      if(request){request.status='planned';request.appointmentId=appointment.id;}
      await manager.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)',[appointment.id,id,appointment.startsAt,appointment.endsAt,appointment.status]);
      return delivery;
    },{id:command.requestId,input:command});
    return this.store.detail(id);
  }
  async workScope(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=WorkScopeInput.parse(input);
    let previousScope:Appointment['workScope'];
    let previousConfirmation:Appointment['customerConfirmation'];
    await this.store.mutate(id,command.version,principal,{name:'appointment.work_scope_updated',details:(delivery)=>({
      appointmentId,reason:command.reason,previousScope:previousScope??null,workScope:visit(delivery,appointmentId).workScope,
      previousCustomerConfirmation:previousConfirmation??null,
    })},async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery);
      const appointment=visit(delivery,appointmentId);
      const scope=planVisitWork(delivery,command.workLines,principal,new Date().toISOString(),appointmentId);
      this.retainWorkServiceDefault(delivery);
      previousScope=appointment.workScope;
      previousConfirmation=appointment.customerConfirmation;
      appointment.workScope=scope;
      if(appointment.status==='booked') delete appointment.customerConfirmation;
      return delivery;
    },{id:command.requestId,input:{appointmentId,...command}});
    return this.store.detail(id);
  }
  async crews() {
    return this.directory.crews();
  }
  async participants() { return this.directory.list(); }
  async saveParticipant(id:string|null,input:unknown,principal:OperatorActor) {return this.directory.save(id,input,principal);}
  async saveParticipantSkills(id:string,input:unknown,principal:OperatorActor) {return this.directory.saveSkills(id,input,principal);}
  async skills() {return this.skillCatalogue.list();}
  async skill(id:string) {return this.skillCatalogue.get(id);}
  async saveSkill(id:string|null,input:unknown,principal:OperatorActor) {return this.skillCatalogue.save(id,input,principal);}
  async vehicles() {return this.transport.list();}
  async vehicle(id:string) {return this.transport.get(id);}
  async saveVehicle(id:string|null,input:unknown,principal:OperatorActor) {return this.transport.save(id,input,principal);}
  async transportAvailability(id:string,appointmentId:string,input:unknown) {
    return this.transport.availability(visit(await this.store.get(id),appointmentId),input);
  }
  async allocateTransport(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=TransportCreateInput.parse(input);
    await this.store.mutate(id,command.version,principal,'transport.allocated',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery);const appointment=visit(delivery,appointmentId);
      await this.transport.add(manager,appointment,[command],principal);
      await this.resources(manager,appointment);
      return delivery;
    },{id:command.requestId,input:{appointmentId:appointmentId.toLowerCase(),...command}});
    return this.store.detail(id);
  }
  async replaceTransport(id:string,appointmentId:string,allocationId:string,input:unknown,principal:OperatorActor) {
    const command=TransportReplaceInput.parse(input);
    await this.store.mutate(id,command.version,principal,'transport.replaced',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery);const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked'||appointment.results.length>0) throw new ConflictException('Transport can change only on an unstarted booked visit without results');
      this.transport.retire(appointment,allocationId,'replaced',command.reason,principal);
      await this.transport.add(manager,appointment,[command],principal,allocationId.toLowerCase());
      await this.resources(manager,appointment);
      return delivery;
    },{id:command.requestId,input:{appointmentId:appointmentId.toLowerCase(),allocationId:allocationId.toLowerCase(),...command}});
    return this.store.detail(id);
  }
  async cancelTransport(id:string,appointmentId:string,allocationId:string,input:unknown,principal:OperatorActor) {
    const command=TransportCancelInput.parse(input);
    await this.store.mutate(id,command.version,principal,'transport.cancelled',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      open(delivery);const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked'||appointment.results.length>0) throw new ConflictException('Transport can change only on an unstarted booked visit without results');
      this.transport.retire(appointment,allocationId,'cancelled',command.reason,principal);
      await this.resources(manager,appointment);
      return delivery;
    },{id:command.requestId,input:{appointmentId:appointmentId.toLowerCase(),allocationId:allocationId.toLowerCase(),...command}});
    return this.store.detail(id);
  }
  async templates() {
    return (await rows(this.store.db.source.manager,DataRow,'SELECT data FROM task_template ORDER BY (data->>\'order\')::int,id')).map((row)=>{
      const template=TaskTemplateSchema.parse(row.data);
      return {...template,requiredSkillIds:template.requiredSkillIds??[]};
    });
  }
  async template(id:string) {
    const [record]=await rows(this.store.db.source.manager,DataRow,'SELECT data FROM task_template WHERE id=$1',[IdSchema.parse(id)]);
    if(!record) throw new NotFoundException('Task template not found');
    const template=TaskTemplateSchema.parse(record.data);
    return {...template,requiredSkillIds:template.requiredSkillIds??[]};
  }
  async participant(id:string) {
    const [participant]=await this.directory.selected(this.store.db.source.manager,[IdSchema.parse(id).toLowerCase()]);
    if(!participant) throw new NotFoundException('Participant not found');
    return participant;
  }
  async crew(id:string) {
    const [crew]=await this.directory.crews(this.store.db.source.manager,[IdSchema.parse(id)]);
    if(!crew) throw new NotFoundException('Crew not found');
    return crew;
  }
  async deleteDirectory(kind:DeletableDirectory,id:string,input:unknown,principal:OperatorActor) {
    return deleteDirectoryEntry(this.store,kind,id,input,principal);
  }
  async resources(manager:EntityManager,appointment:Appointment) {
    await this.transport.rebuild(manager,appointment);
  }
  async assign(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=AssignInput.parse(input);
    if(new Set(command.crewIds).size!==command.crewIds.length || new Set(command.templateIds).size!==command.templateIds.length) throw new BadRequestException('Duplicate crew or template IDs');
    await this.store.mutate(id,command.version,principal,'appointment.assigned',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery);
      const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked') throw new ConflictException('Only an unstarted visit can be assigned');
      const crews=await this.directory.crews(manager,command.crewIds);
      const templates=(await rows(manager,DataRow,'SELECT data FROM task_template WHERE id=ANY($1::uuid[])',[command.templateIds])).map((row)=>TaskTemplateSchema.parse(row.data));
      if(crews.length!==command.crewIds.length || templates.length!==command.templateIds.length) throw new NotFoundException('Crew or task template not found');
      if(crews.some((crew)=>!crew.enabled)||templates.some((template)=>!template.enabled)) throw new ConflictException('Disabled crews or templates cannot receive new assignments');
      const requirements=await this.skillCatalogue.requiredSnapshots(manager,templates.flatMap((template)=>template.requiredSkillIds??[]));
      if(command.staffing&&(command.staffing.length!==command.crewIds.length||new Set(command.staffing.map((entry)=>entry.crewId)).size!==command.crewIds.length||command.staffing.some((entry)=>!command.crewIds.includes(entry.crewId)))) throw new BadRequestException('Staffing must specify each selected crew exactly once');
      for(const crew of crews) {
        if(appointment.assignments.some((assignment)=>assignment.crewId===crew.id)) throw new ConflictException('Crew already assigned to this visit');
        const personIds=command.staffing?.find((entry)=>entry.crewId===crew.id)?.participantIds??crew.people.map((person)=>person.id);
        if(personIds.length===0) throw new BadRequestException('Choose at least one participant for every assigned crew');
        const people=await this.directory.selected(manager,personIds);
        if(people.some((person)=>!person.enabled)) throw new ConflictException('Disabled participants cannot receive a new assignment');
        const qualified=await this.skillCatalogue.qualify(manager,people,requirements,crew.name);
        appointment.assignments.push(instantiateAssignment(crew,qualified,templates,requirements,()=>randomUUID()));
      }
      distinctParticipants(appointment.assignments.flatMap((assignment)=>assignment.people.map((person)=>person.id)));
      await this.transport.add(manager,appointment,command.transport??[],principal);
      await this.resources(manager,appointment);
      return delivery;
    },{id:command.requestId,input:command.transport===undefined?command:{appointmentId:appointmentId.toLowerCase(),...command}});
    return this.store.detail(id);
  }
  async confirmCustomer(id: string, appointmentId: string, input: unknown, principal: OperatorActor) {
    const { version } = VersionSchema.strict().parse(input);
    await this.store.mutate(id, version, principal, {
      name: 'appointment.customer_confirmed',
      details: (delivery) => {
        const { startsAt, endsAt, customerConfirmation } = visit(delivery, appointmentId);
        return { appointmentId, startsAt, endsAt, customerConfirmation };
      },
    }, (delivery) => confirmCustomerVisit(delivery, appointmentId, principal, new Date().toISOString()));
    return this.store.detail(id);
  }

  async selectResponsible(id: string, appointmentId: string, input: unknown, principal: OperatorActor) {
    const { version, participantId } = ResponsibleParticipantInput.parse(input);
    const visitId = appointmentId.toLowerCase();
    let previous: Appointment['responsibleParticipant'];
    await this.store.mutate(id, version, principal, {
      name: 'appointment.responsible_selected',
      details: (delivery) => ({
        appointmentId: visitId, previousResponsibleParticipant: previous ?? null,
        responsibleParticipant: visit(delivery, visitId).responsibleParticipant,
      }),
    }, async (delivery, manager) => {
      await assertStandaloneAppointment(manager,visitId);
      open(delivery);
      const appointment = visit(delivery, visitId);
      if (appointment.status !== 'booked' && appointment.status !== 'in_progress') {
        throw new DomainError('VISIT_RESPONSIBLE_LOCKED', 'The responsible participant can change only before the visit is reported');
      }
      const candidate = assignedParticipant(appointment, participantId);
      if (!candidate) throw new DomainError('RESPONSIBLE_NOT_ASSIGNED', 'Choose a participant from the actual visit staffing', 400);
      const [person] = await this.directory.selected(manager, [candidate.id.toLowerCase()]);
      if (!person?.enabled) throw new DomainError('RESPONSIBLE_PARTICIPANT_DISABLED', 'Choose an enabled participant');
      previous = appointment.responsibleParticipant;
      appointment.responsibleParticipant = { id: candidate.id, name: candidate.name };
      return delivery;
    });
    return this.store.detail(id);
  }

  async participantAvailability(id:string,appointmentId:string) {
    const delivery=await this.store.get(id);
    const appointment=visit(delivery,appointmentId);
    const people=await this.directory.list();
    const conflicts=await this.transport.conflicts(this.store.db.source.manager,appointmentId,appointment.startsAt,appointment.endsAt);
    const byPerson=new Map<string,{appointmentId:string;pickingName:string;startsAt:string;endsAt:string}[]>();
    for(const conflict of conflicts) {
      if(!conflict.resource.startsWith('person:')) continue;
      const personId=IdSchema.parse(conflict.resource.slice('person:'.length));
      const entries=byPerson.get(personId)??[];
      entries.push({appointmentId:conflict.appointmentId,pickingName:conflict.pickingName,startsAt:conflict.startsAt.toISOString(),endsAt:conflict.endsAt.toISOString()});
      byPerson.set(personId,entries);
    }
    return AvailabilitySchema.parse({people:people.map(({id:personId,name,external,enabled,skillIds})=>({id:personId,name,external,enabled,skillIds,busy:byPerson.has(personId),conflicts:byPerson.get(personId)??[]}))});
  }
  async updateParticipants(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=StaffingInput.parse(input);
    await this.store.mutate(id,command.version,principal,'appointment.participants_updated',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery);
      const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked'||appointment.results.length>0) throw new ConflictException('Only an unstarted booked visit without results can change participants');
      const expected=appointment.assignments.map((assignment)=>assignment.id);
      const supplied=command.assignments.map((assignment)=>assignment.assignmentId);
      if(expected.length===0||supplied.length!==expected.length||new Set(supplied).size!==expected.length||supplied.some((assignmentId)=>!expected.includes(assignmentId))) throw new BadRequestException('Provide every existing assignment exactly once');
      const selectedIds=command.assignments.flatMap((assignment)=>assignment.participantIds);
      distinctParticipants(selectedIds);
      const selected=new Map((await this.directory.selected(manager,selectedIds)).map((person)=>[person.id,person]));
      const previous=appointment.assignments.map((assignment)=>({assignmentId:assignment.id,participantIds:assignment.people.map((person)=>person.id)}));
      for(const assignment of appointment.assignments) {
        const requested=command.assignments.find((entry)=>entry.assignmentId===assignment.id);
        if(!requested) throw new BadRequestException('Assignment selection is incomplete');
        const people=requested.participantIds.map((personId)=>{
          const person=selected.get(personId);
          if(!person) throw new NotFoundException('Selected participant not found');
          if(!person.enabled&&!assignment.people.some((current)=>current.id===personId)) throw new ConflictException('Disabled participants cannot receive a new assignment');
          return person;
        });
        assignment.people=await this.skillCatalogue.qualify(manager,people,assignment.tasks.flatMap((task)=>task.requiredSkillsSnapshot??[]),assignment.crewName);
      }
      const previousResponsibleParticipant = appointment.responsibleParticipant;
      if (previousResponsibleParticipant && !assignedParticipant(appointment, previousResponsibleParticipant.id)) {
        delete appointment.responsibleParticipant;
        await this.store.audit(manager, principal, 'appointment.responsible_cleared', {
          appointmentId, previousResponsibleParticipant, reason: command.reason,
        }, id);
      }
      await this.resources(manager,appointment);
      await this.store.audit(manager,principal,'appointment.participants_revision',{appointmentId,previous,assignments:command.assignments,reason:command.reason},id);
      return delivery;
    });
    return this.store.detail(id);
  }
  async move(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=MoveInput.parse(input); validateInterval(command.startsAt,command.endsAt);
    await this.store.mutate(id,command.version,principal,'appointment.rescheduled',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      this.ready(delivery); const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked') throw new ConflictException('Only an unstarted visit can be rescheduled');
      if(activeTransport(appointment).length>0) throw new ConflictException('Cancel active transport with a reason before rescheduling, then allocate transport for the new interval');
      const old={startsAt:appointment.startsAt,endsAt:appointment.endsAt};
      appointment.startsAt=command.startsAt;appointment.endsAt=command.endsAt;
      await this.resources(manager,appointment);
      await manager.query('UPDATE appointment SET starts_at=$2,ends_at=$3 WHERE id=$1',[appointmentId,command.startsAt,command.endsAt]);
      await this.store.audit(manager,principal,'appointment.previous_time',old,id);
      const confirmation = appointment.customerConfirmation;
      if (confirmation && (Date.parse(old.startsAt) !== Date.parse(command.startsAt) || Date.parse(old.endsAt) !== Date.parse(command.endsAt))) {
        delete appointment.customerConfirmation;
        await this.store.audit(manager, principal, 'appointment.customer_confirmation_reset', {
          appointmentId,
          ...old,
          customerConfirmation: confirmation,
        }, id);
      }
      return delivery;
    });
    return this.store.detail(id);
  }
  async cancel(id:string,appointmentId:string,input:unknown,principal:OperatorActor) {
    const command=ReasonInput.parse(input);
    await this.store.mutate(id,command.version,principal,'appointment.cancelled',async(delivery,manager)=>{
      await assertStandaloneAppointment(manager,appointmentId);
      open(delivery);const appointment=visit(delivery,appointmentId);
      if(appointment.status!=='booked') throw new ConflictException('Only an unstarted visit can be cancelled');
      appointment.status='cancelled';appointment.cancellationReason=command.reason;
      for(const allocation of activeTransport(appointment)) this.transport.retire(appointment,allocation.id,'cancelled',command.reason,principal);
      await this.resources(manager,appointment);
      const request=delivery.returnRequests.find((entry)=>entry.id===appointment.returnRequestId);
      if(request){request.status='requested';request.appointmentId=null;}
      await manager.query('UPDATE appointment SET status=$2 WHERE id=$1',[appointmentId,'cancelled']);
      await this.store.audit(manager,principal,'appointment.cancellation_reason',{reason:command.reason},id);
      return delivery;
    });
    return this.store.detail(id);
  }
  async issue(id:string,input:unknown,principal:OperatorActor) {
    const command=VersionSchema.extend({type:IssueSchema.shape.type,description:TextSchema,itemIds:z.array(z.number().int().positive()).max(500),notes:NullableTextSchema.optional(),appointmentId:IdSchema.optional()}).strict().parse(input);
    await this.store.mutate(id,command.version,principal,'issue.opened',(delivery)=>{
      return raiseIssue(delivery,{id:randomUUID(),type:command.type,description:command.description,itemIds:command.itemIds,photoIds:[],notes:command.notes??null},principal,new Date().toISOString(),command.appointmentId);
    });
    return this.store.detail(id);
  }
  async resolveIssue(id:string,issueId:string,input:unknown,principal:OperatorActor) {
    const command=ResolveInput.parse(input);
    await this.store.mutate(id,command.version,principal,'issue.resolved',(delivery)=>{
      open(delivery);const issue=delivery.issues.find((entry)=>entry.id===issueId);
      if(!issue) throw new NotFoundException('Issue not found');
      if(issue.status!=='open') throw new ConflictException('Issue already resolved');
      issue.status='resolved';issue.resolution=command.resolution;issue.resolvedAt=new Date().toISOString();issue.resolvedBy=principal.id;return delivery;
    });
    return this.store.detail(id);
  }
  async releaseDamagedWork(id:string,sourceLineId:number,input:unknown,principal:OperatorActor) {
    const command=WorkReadinessInput.parse(input);
    await this.store.mutate(id,command.version,principal,{name:'work.readiness_confirmed',details:()=>({sourceLineId,note:command.note})},(delivery)=>
      releaseDamagedWork(delivery,sourceLineId,command.note,principal,new Date().toISOString()));
    return this.store.detail(id);
  }
  async requestReturn(id:string,input:unknown,principal:OperatorActor) {
    const command=VersionSchema.extend({appointmentId:IdSchema,reason:TextSchema,remainingWork:TextSchema,notes:NullableTextSchema.optional()}).strict().parse(input);
    await this.store.mutate(id,command.version,principal,'return.requested',(delivery)=>{
      return raiseReturnRequest(delivery,{id:randomUUID(),originAppointmentId:command.appointmentId,reason:command.reason,remainingWork:command.remainingWork,notes:command.notes??null,photoIds:[],issueIds:delivery.issues.filter((issue)=>issue.status==='open').map((issue)=>issue.id)},principal,new Date().toISOString());
    });
    return this.store.detail(id);
  }
  async issueNotes(id:string,issueId:string,input:unknown,principal:OperatorActor) {
    const command=VersionSchema.extend({notes:NullableTextSchema}).strict().parse(input);
    await this.store.mutate(id,command.version,principal,'issue.notes_updated',async(delivery,manager)=>{
      open(delivery);const issue=delivery.issues.find((entry)=>entry.id===issueId);
      if(!issue) throw new NotFoundException('Issue not found');
      const previous=issue.notes;issue.notes=command.notes;
      await this.store.audit(manager,principal,'issue.notes_revision',{issueId,previous,notes:command.notes},id);
      return delivery;
    });
    return this.store.detail(id);
  }
  async returnNotes(id:string,returnId:string,input:unknown,principal:OperatorActor) {
    const command=VersionSchema.extend({notes:NullableTextSchema,photoIds:z.array(IdSchema).max(100)}).strict().parse(input);
    if(new Set(command.photoIds).size!==command.photoIds.length) throw new BadRequestException('Duplicate photo IDs');
    await this.store.mutate(id,command.version,principal,'return.notes_updated',async(delivery,manager)=>{
      open(delivery);const request=delivery.returnRequests.find((entry)=>entry.id===returnId);
      if(!request) throw new NotFoundException('Return request not found');
      for(const photoId of command.photoIds){
        const file=await this.files.download(id,photoId);
        if(!file.file.mime.startsWith('image/')) throw new BadRequestException('Return photos must be image files');
        await validateFileContent({bytes:file.bytes,mime:file.file.mime});
      }
      const previous={notes:request.notes,photoIds:request.photoIds};
      request.notes=command.notes;request.photoIds=command.photoIds;
      await this.store.audit(manager,principal,'return.notes_revision',{returnId,previous,notes:command.notes,photoIds:command.photoIds},id);
      return delivery;
    });
    return this.store.detail(id);
  }
  async resolveReturn(id:string,returnId:string,input:unknown,principal:OperatorActor) {
    const command=ResolveInput.parse(input);
    await this.store.mutate(id,command.version,principal,'return.resolved',(delivery)=>{
      open(delivery);const request=delivery.returnRequests.find((entry)=>entry.id===returnId);
      if(!request) throw new NotFoundException('Return request not found');
      if(request.status!=='planned'||!request.appointmentId||visit(delivery,request.appointmentId).status!=='completed') throw new ConflictException('Return work must have a completed visit');
      if(request.issueIds.some((issueId)=>delivery.issues.some((issue)=>issue.id===issueId&&issue.status==='open'))) throw new ConflictException('Related problems remain open');
      const appointment=visit(delivery,request.appointmentId);
      if(hasRemainingLineWork(delivery)) throw new ConflictException('Remaining product work must be completed before resolving the return request');
      if(appointment.assignments.some((assignment)=>assignment.tasks.some((task)=>task.checklist.some((item)=>!item.done&&!item.waiver)))) throw new ConflictException('Return visit tasks remain incomplete');
      request.status='resolved';request.resolvedAt=new Date().toISOString();request.resolution=command.resolution;return delivery;
    });
    return this.store.detail(id);
  }
  async waive(id:string,appointmentId:string,checklistId:string,input:unknown,principal:OperatorActor) {
    const command=ReasonInput.parse(input);
    await this.store.mutate(id,command.version,principal,'checklist.waived',(delivery)=>waiveChecklist(delivery,appointmentId,checklistId,principal,command.reason,new Date().toISOString()));
    return this.store.detail(id);
  }
  async reviewSignatureRefusal(id: string, appointmentId: string, resultId: string, input: unknown, principal: OperatorActor) {
    const { version, requestId, ...decision } = SignatureRefusalReviewInput.parse(input);
    const details = { appointmentId, resultId, ...decision };
    await this.store.mutate(id, version, principal, { name: 'execution.signature_refusal_reviewed', details: () => details },
      async (delivery, manager) => {
        const next = reviewSignatureRefusal(delivery, appointmentId, resultId, decision, principal, new Date().toISOString());
        if (decision.decision === 'corrected') {
          const original = visit(delivery, appointmentId).results.find(({ id }) => id === resultId);
          if (!original) throw new Error('Validated signature refusal report is unavailable');
          await assertSignatureRefusalCorrectionPreservesCargo(manager, appointmentId, original.quantities, decision.quantities);
        }
        return next;
      },
      { id: requestId, input: { ...details, actorId: principal.id } });
    return this.store.detail(id);
  }
  async complete(id:string,input:unknown,principal:OperatorActor) {
    const command=VersionSchema.strict().parse(input);
    await this.store.mutate(id,command.version,principal,{name:'delivery.completed',details:(delivery)=>({
      priorWorkSnapshot:delivery.completions.at(-1)?.priorWorkSnapshot??[],
    })},async(delivery)=>{
      for(const result of effectiveResults(delivery)){
        for(const evidence of result.evidence){
          try{
            const stored=await this.files.download(id,evidence.id);
            await validateFileContent({bytes:stored.bytes,mime:stored.file.mime});
          }catch{throw new ConflictException('Referenced execution evidence is unavailable or invalid; correct it before closure');}
        }
      }
      return completeDelivery(delivery,principal,randomUUID(),new Date().toISOString());
    });
    return this.store.detail(id);
  }
  async reopen(id:string,input:unknown,principal:OperatorActor) {
    const command=ReasonInput.parse(input);
    await this.store.mutate(id,command.version,principal,'delivery.reopened',(delivery)=>reopenDelivery(delivery,principal,command.reason,new Date().toISOString()));
    return this.store.detail(id);
  }
  async calendarFilterOptions(input: unknown) {
    z.object({}).strict().parse(input);
    const [deliveries, crews] = await Promise.all([
      rows(this.store.db.source.manager, CalendarGeographyRowSchema,
        `SELECT jsonb_build_object('customer',data->'source'->'customer') AS source,data->'addressGeography' AS "addressGeography" FROM delivery ORDER BY source_id,id`),
      this.filterCrews(),
    ]);
    return { destinations: calendarDestinationOptions(deliveries.map((delivery) => ({ ...delivery, addressGeography: delivery.addressGeography ?? undefined }))), crews };
  }
  private filterCrews() {
    return rows(this.store.db.source.manager, CalendarFilterCrewSchema, 'SELECT id,name,enabled FROM crew ORDER BY lower(name),id');
  }
  async calendar(input:unknown) {
    const query=calendarRange(input);
    return (await this.store.all()).flatMap((delivery) => delivery.appointments
      .filter((appointment) => Date.parse(appointment.startsAt) < Date.parse(query.to) && Date.parse(appointment.endsAt) > Date.parse(query.from))
      .map((appointment) => ({ deliveryId: delivery.id, pickingName: delivery.source.pickingName,
        customerName: delivery.source.customer.name, geography: deliveryGeography(delivery), appointment: appointmentOverview(appointment) })));
  }
  async participantCalendar(id:string,input:unknown) {
    const query=calendarRange(input);
    const participantId=IdSchema.parse(id).toLowerCase();
    const [profile]=await this.directory.selected(this.store.db.source.manager,[participantId]);
    // This schema is an explicit public projection; credential metadata is deliberately discarded.
    const participant=ParticipantCalendarProfileSchema.strip().parse(profile);
    const entries=(await this.store.all()).flatMap((delivery)=>delivery.appointments
      .filter((appointment)=>Date.parse(appointment.startsAt)<Date.parse(query.to)&&Date.parse(appointment.endsAt)>Date.parse(query.from))
      .flatMap((appointment)=>appointment.assignments.filter((assignment)=>assignment.people.some((person)=>person.id.toLowerCase()===participantId)).map((assignment)=>({
        deliveryId:delivery.id,pickingName:delivery.source.pickingName,customerName:delivery.source.customer.name,
        appointmentId:appointment.id,startsAt:appointment.startsAt,endsAt:appointment.endsAt,status:appointment.status,
        assignment,returnVisit:appointment.returnRequestId!==null,
        ...(appointment.customerConfirmation ? { customerConfirmation: appointment.customerConfirmation } : {}),
      }))))
      .sort((left,right)=>Date.parse(left.startsAt)-Date.parse(right.startsAt)||Date.parse(left.endsAt)-Date.parse(right.endsAt)||left.appointmentId.localeCompare(right.appointmentId)||left.assignment.id.localeCompare(right.assignment.id));
    const routeReservations=await rows(this.store.db.source.manager,z.object({routeId:IdSchema,name:TextSchema,status:z.enum(['published','in_progress','returning','returned','closed']),
      startsAt:z.date(),endsAt:z.date(),bufferMinutes:z.number().int().min(0).max(240)}),
      `SELECT p.id AS "routeId",d.data->>'name' AS name,p.status,r.starts_at AS "startsAt",r.ends_at AS "endsAt",r.buffer_minutes AS "bufferMinutes"
       FROM route_reservation r JOIN route_publication p ON p.id=r.route_id JOIN route_draft d ON d.id=p.id
       WHERE r.resource=$1 AND p.status<>'cancelled' AND r.starts_at-(r.buffer_minutes*interval '1 minute')<$3::timestamptz
         AND r.ends_at+(r.buffer_minutes*interval '1 minute')>$2::timestamptz
       ORDER BY r.starts_at,p.id LIMIT 5001`,[`person:${participantId}`,query.from,query.to]);
    if(routeReservations.length>5000) throw new ConflictException('The calendar exceeds the 5000-route local limit');
    return ParticipantCalendarSchema.parse({participant,entries,...(routeReservations.length?{routeReservations:routeReservations.map((entry)=>({...entry,startsAt:entry.startsAt.toISOString(),endsAt:entry.endsAt.toISOString()}))}:{})});
  }
  async saveCrew(id:string|null,input:unknown,principal:OperatorActor) {
    return this.directory.saveCrew(id,input,principal);
  }
  async saveTemplate(id:string|null,input:unknown,principal:OperatorActor) {
    const templateId=id?IdSchema.parse(id).toLowerCase():randomUUID();
    const update=id?TaskTemplateUpdateInput.parse(input):null;
    if(update?.id&&update.id.toLowerCase()!==templateId) throw new BadRequestException('Template body ID must match its route ID');
    const candidate=update?TaskTemplateSchema.parse({...update,id:templateId}):TaskTemplateSchema.parse({...TaskTemplateSchema.omit({id:true,version:true}).parse(input),id:templateId,version:1});
    await this.store.db.source.transaction(async(manager)=>{
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const previousRow=id?(await rows(manager,DataRow,'SELECT data FROM task_template WHERE id=$1 FOR UPDATE',[templateId]))[0]:undefined;
      if(id&&!previousRow) throw new NotFoundException('Task template not found');
      const previous=previousRow?TaskTemplateSchema.parse(previousRow.data):undefined;
      if(previous&&previous.version!==candidate.version) throw new ConflictException('Template changed. Reload.');
      candidate.requiredSkillIds=await validateSkillSelection(manager,candidate.requiredSkillIds??previous?.requiredSkillIds??[],previous?.requiredSkillIds??[]);
      if(previous){
        candidate.version++;
        await manager.query('UPDATE task_template SET version=$2,data=$3::jsonb WHERE id=$1',[templateId,candidate.version,JSON.stringify(candidate)]);
      } else await manager.query('INSERT INTO task_template(id,version,data) VALUES($1,$2,$3::jsonb)',[candidate.id,candidate.version,JSON.stringify(candidate)]);
      await this.store.audit(manager,principal,'template.saved',{id:candidate.id,version:candidate.version});
    });
    return candidate;
  }
}
