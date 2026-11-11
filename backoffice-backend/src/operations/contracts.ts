import { z } from 'zod';
import { AppointmentSchema, AssignmentSchema, DocumentSnapshotSchema, IdSchema, InstantSchema, InstructionsSchema, PersonSnapshotSchema, ServiceTypeSchema, SkillIdsSchema, SkillNameSchema, SourceItemSchema, TaskTemplateSchema, TextSchema, VehicleNameSchema, VehicleOperationalStatusSchema, VehicleOwnershipSchema, VehiclePlateSchema, WorkLinesInputSchema } from '../domain/model';
export const VersionSchema = z.object({version:z.number().int().positive()});
export const DirectoryDeletionSchema = z.object({id:IdSchema,deleted:z.literal(true)}).strict();
export const ChangeServiceInput = z.union([
  VersionSchema.extend({ defaultService: ServiceTypeSchema }).strict(),
  VersionSchema.extend({ sourceLineId: SourceItemSchema.shape.sourceLineId, service: ServiceTypeSchema.nullable() }).strict(),
]);
const VehicleFields={
  ownership:VehicleOwnershipSchema,name:VehicleNameSchema,plate:VehiclePlateSchema,
  providerName:VehicleNameSchema.nullable(),providerContact:z.string().trim().min(1).max(500).nullable(),
  operationalStatus:VehicleOperationalStatusSchema,enabled:z.boolean(),notes:z.string().trim().max(4000).nullable(),
};
function validVehicleProvider(value:{ownership:'company'|'external';providerName:string|null;providerContact:string|null}):boolean {
  return value.ownership==='external'?value.providerName!==null:value.providerName===null&&value.providerContact===null;
}
export const VehicleSchema=z.object({id:IdSchema,version:z.number().int().positive(),...VehicleFields}).strict().refine(validVehicleProvider,'External vehicles require a provider name; company vehicles must not have provider fields');
export type Vehicle=z.infer<typeof VehicleSchema>;
export const VehicleCreateInput=z.object(VehicleFields).strict().refine(validVehicleProvider,'External vehicles require a provider name; company vehicles must not have provider fields');
export const VehicleUpdateInput=z.object({version:z.number().int().positive(),...VehicleFields}).strict().refine(validVehicleProvider,'External vehicles require a provider name; company vehicles must not have provider fields');
export const TransportDriverInput=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('none')}).strict(),
  z.object({kind:z.literal('participant'),participantId:IdSchema}).strict(),
  z.object({kind:z.literal('external'),name:VehicleNameSchema,phone:z.string().trim().min(1).max(200)}).strict(),
]);
export const TransportPlanInput=z.object({vehicleId:IdSchema,reserveFrom:InstantSchema,reserveTo:InstantSchema,driver:TransportDriverInput}).strict();
export type TransportPlan=z.infer<typeof TransportPlanInput>;
export const TransportCreateInput=TransportPlanInput.extend({version:z.number().int().positive(),requestId:IdSchema}).strict();
export const TransportReplaceInput=TransportCreateInput.extend({reason:TextSchema}).strict();
export const TransportCancelInput=VersionSchema.extend({requestId:IdSchema,reason:TextSchema}).strict();
export const TRANSPORT_MAX_DAYS=45;
const ResourceConflictSchema=z.object({appointmentId:IdSchema,pickingName:TextSchema,startsAt:InstantSchema,endsAt:InstantSchema}).strict();
export const TransportAvailabilitySchema=z.object({
  vehicles:z.array(VehicleSchema.safeExtend({busy:z.boolean(),conflicts:z.array(ResourceConflictSchema).max(5000)})).max(5000),
  people:z.array(z.object({id:IdSchema,name:TextSchema,external:z.boolean(),enabled:z.boolean(),busy:z.boolean(),conflicts:z.array(ResourceConflictSchema).max(5000)}).strict()).max(5000),
}).strict();
export const CrewSchema = z.object({
  id:IdSchema,version:z.number().int().positive(),name:TextSchema,classification:z.enum(['indoor','outdoor']),
  area:TextSchema,enabled:z.boolean(),people:z.array(PersonSnapshotSchema).max(100),
}).strict().refine((crew)=>new Set(crew.people.map((person)=>person.id)).size===crew.people.length,'Duplicate participant');
export type Crew = z.infer<typeof CrewSchema>;
const SkillDescriptionSchema=z.string().trim().max(2000).nullable();
export const SkillSchema=z.object({id:IdSchema,version:z.number().int().positive(),name:SkillNameSchema,description:SkillDescriptionSchema,enabled:z.boolean()}).strict();
export type Skill=z.infer<typeof SkillSchema>;
export const SkillCreateInput=z.object({name:SkillNameSchema,description:SkillDescriptionSchema.optional(),enabled:z.boolean().default(true)}).strict();
export const SkillUpdateInput=SkillCreateInput.extend({version:z.number().int().positive(),enabled:z.boolean()}).strict();
export const ParticipantSkillsInput=VersionSchema.extend({skillIds:SkillIdsSchema}).strict();
export const TaskTemplateUpdateInput=TaskTemplateSchema.omit({id:true}).extend({
  id:IdSchema.optional().meta({readOnly:true,description:'Optional read-only ID for existing clients; must match the route ID. The route remains authoritative.'}),
}).strict();
const ProfileName=z.string().trim().min(1).max(2000);
const OptionalProfileText=z.string().trim().min(1).max(4000).nullable();
const LoginSchema=z.string().trim().min(3).max(200).regex(/^[^\s\u0000-\u001f]+$/u,'Login cannot contain whitespace or control characters').nullable();
export const ParticipantSchema=z.object({
  id:IdSchema,version:z.number().int().positive(),name:TextSchema,
  firstName:ProfileName.nullable(),lastName:ProfileName.nullable(),preferredName:ProfileName.nullable(),
  phoneNumber:OptionalProfileText,address:OptionalProfileText,login:LoginSchema,
  external:z.boolean(),enabled:z.boolean(),hasPassword:z.boolean(),skillIds:SkillIdsSchema,
}).strict();
export type Participant=z.infer<typeof ParticipantSchema>;
export const CALENDAR_MAX_DAYS=45;
export const CalendarQuerySchema=z.object({from:InstantSchema,to:InstantSchema}).strict();
export const ParticipantCalendarProfileSchema=ParticipantSchema.omit({login:true,hasPassword:true,skillIds:true});
export const ParticipantCalendarEntrySchema=z.object({
  deliveryId:IdSchema,pickingName:TextSchema,customerName:TextSchema,appointmentId:IdSchema,
  startsAt:InstantSchema,endsAt:InstantSchema,status:AppointmentSchema.shape.status,
  assignment:AssignmentSchema,returnVisit:z.boolean(),
  customerConfirmation:AppointmentSchema.shape.customerConfirmation,
}).strict();
export const ParticipantCalendarSchema=z.object({
  participant:ParticipantCalendarProfileSchema,entries:z.array(ParticipantCalendarEntrySchema),
  routeReservations:z.array(z.object({routeId:IdSchema,name:TextSchema,status:z.enum(['published','in_progress','returning','returned','closed']),
    startsAt:InstantSchema,endsAt:InstantSchema,bufferMinutes:z.number().int().min(0).max(240)}).strict()).max(5000).optional(),
}).strict();
export const CreateParticipantInput=z.object({
  firstName:ProfileName,lastName:ProfileName,preferredName:ProfileName.nullable().default(null),
  phoneNumber:OptionalProfileText.default(null),address:OptionalProfileText.default(null),login:LoginSchema.default(null),
  external:z.boolean().default(false),enabled:z.boolean().default(true),password:z.string().min(15).max(256).optional(),
  skillIds:SkillIdsSchema.optional(),
}).strict();
export const UpdateParticipantInput=CreateParticipantInput.extend({
  version:z.number().int().positive(),firstName:ProfileName.nullable(),lastName:ProfileName.nullable(),
  preferredName:ProfileName.nullable(),phoneNumber:OptionalProfileText,address:OptionalProfileText,login:LoginSchema,external:z.boolean(),enabled:z.boolean(),
}).strict();
export const CrewCreateInput=z.object({
  name:TextSchema,classification:z.enum(['indoor','outdoor']),area:TextSchema,enabled:z.boolean(),participantIds:z.array(IdSchema).max(100),
}).strict();
export const CrewUpdateInput=CrewCreateInput.extend({version:z.number().int().positive()}).strict();
export const StaffingInput=VersionSchema.extend({assignments:z.array(z.object({assignmentId:IdSchema,participantIds:z.array(IdSchema).min(1).max(100)}).strict()).max(30),reason:TextSchema}).strict();
export const ResponsibleParticipantInput = VersionSchema.extend({ participantId: IdSchema }).strict();
export const AvailabilitySchema=z.object({people:z.array(z.object({
  id:IdSchema,name:TextSchema,external:z.boolean(),enabled:z.boolean(),busy:z.boolean(),skillIds:SkillIdsSchema,
  conflicts:z.array(z.object({appointmentId:IdSchema,pickingName:TextSchema,startsAt:InstantSchema,endsAt:InstantSchema}).strict()).max(5000),
}).strict()).max(5000)}).strict();
export const InstructionsInput = InstructionsSchema.extend({version:z.number().int().positive()}).strict();
export const BookInput = VersionSchema.extend({requestId:IdSchema,startsAt:InstantSchema,endsAt:InstantSchema,returnRequestId:IdSchema.optional(),workLines:WorkLinesInputSchema}).strict();
export const WorkScopeInput = VersionSchema.extend({requestId:IdSchema,reason:TextSchema,workLines:WorkLinesInputSchema}).strict();
export const AssignInput = VersionSchema.extend({requestId:IdSchema,crewIds:z.array(IdSchema).min(1).max(30),templateIds:z.array(IdSchema).min(1).max(30),staffing:z.array(z.object({crewId:IdSchema,participantIds:z.array(IdSchema).min(1).max(100)}).strict()).min(1).max(30).optional(),transport:z.array(TransportPlanInput).max(20).optional()}).strict();
export const MoveInput = VersionSchema.extend({startsAt:InstantSchema,endsAt:InstantSchema}).strict();
export const ReasonInput = VersionSchema.extend({reason:TextSchema}).strict();
export const ResolveInput = VersionSchema.extend({resolution:TextSchema}).strict();
export const WorkReadinessInput = VersionSchema.extend({ note: TextSchema }).strict();
export const FileSchema = DocumentSnapshotSchema.strip().extend({
  deliveryId:IdSchema,size:z.number(),kind:z.enum(['document','photo','evidence']),
  appointmentId:IdSchema.nullable(),issueId:IdSchema.nullable(),status:z.enum(['pending','ready','failed']),
});
export const AuditSchema = z.object({id:IdSchema,actorId:IdSchema,actorName:z.string(),action:z.string(),at:z.string(),details:z.unknown()});
export const ImportSchema = z.object({id:IdSchema,status:z.string(),startedAt:z.string(),finishedAt:z.string().nullable(),processed:z.number(),error:z.string().nullable(),details:z.array(z.string())});
