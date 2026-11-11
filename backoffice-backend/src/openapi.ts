import { z } from 'zod';
import { UploadSchema } from './evidence/files';
import { AppointmentSchema, DeliverySchema, LineServiceStatusSchema, MAX_VISIT_EVIDENCE, ResponsibleParticipantSchema, ScopeReviewReasonSchema, SkillIdsSchema, SourceSchema, TaskTemplateSchema, ViewSchema } from './domain/model';
import { CREW_FINISH_JSON_MAX_BYTES, CREW_FINISH_PHOTOS_MAX_BYTES, CREW_VISIT_LIST_LIMIT, CrewAttemptFailureInput, CrewChecklistInput, CrewFinishInput, CrewIssueInput, CrewLoginInput, CrewLogoutInput, CrewLogoutResult, CrewProfileSchema, CrewStartInput, CrewVisitDetailSchema, CrewVisitListSchema } from './crew/contracts';
import { CREW_SESSION_COOKIE } from './identity/crew-identity';
import { AssignInput, AuditSchema, AvailabilitySchema, BookInput, CALENDAR_MAX_DAYS, ChangeServiceInput, CreateParticipantInput, CrewCreateInput, CrewSchema, CrewUpdateInput, FileSchema, ImportSchema, InstructionsInput, MoveInput, ParticipantCalendarSchema, ParticipantSchema, ParticipantSkillsInput, ReasonInput, ResolveInput, ResponsibleParticipantInput, SkillCreateInput, SkillSchema, SkillUpdateInput, StaffingInput, TaskTemplateUpdateInput, TRANSPORT_MAX_DAYS, TransportAvailabilitySchema, TransportCancelInput, TransportCreateInput, TransportReplaceInput, UpdateParticipantInput, VehicleCreateInput, VehicleSchema, VehicleUpdateInput, VersionSchema } from './operations/contracts';
import { RouteCreateInputSchema, RoutePreviewInputSchema, RouteSuggestInputSchema, RouteUpdateInputSchema } from './routing/contracts';
import { PublicationDetailSchema, PublicationReviewInputSchema, PublicationReviewSchema, PublicationSummarySchema, PublishInputSchema } from './routing/publication-contracts';
import { RouteActionInputSchema, RouteAmendInputSchema, RouteAmendReviewInputSchema, RouteAmendReviewSchema, RouteCancelInputSchema, RouteCloseInputSchema, RouteOperationsSchema, RouteReasonInputSchema, RouteReconcileInputSchema, RouteReturnInputSchema, RouteRevisionSchema, RouteWarehouseReceiptInputSchema } from './routing/lifecycle-contracts';
import { AddressSuggestionInputSchema, AddressSuggestionResponseSchema } from './routing/address-suggestion';
import { ConfirmEntranceInputSchema, EntranceResponseSchema } from './routing/entrances';
import { RouteDetailSchema, RouteDraftListSchema, RouteJobsSchema, RoutePreviewSchema, RouteSuggestionSchema } from './routing/http-contracts';
import { DeliveryListQuerySchema, DeliveryListSchema, DeliveryMapQuerySchema } from './operations/delivery-list';
import { DeliveryMapSchema } from './routing/delivery-map';
import { DirectoryDeletionSchema, WorkReadinessInput, WorkScopeInput } from './operations/contracts';

const User=z.object({id:z.string().uuid(),name:z.string(),role:z.enum(['admin','operator'])});
const Detail=z.object({delivery:DeliverySchema,views:z.array(ViewSchema),progress:z.enum([...ViewSchema.options,'awaiting_closure']),coverage:z.object({assigned:z.number(),total:z.number()}),deliveredQuantities:z.array(z.object({sourceLineId:z.number(),deliveredMilli:z.number()})),lineServices:z.array(LineServiceStatusSchema),appointmentPlanning:z.array(z.object({appointmentId:z.string().uuid(),reviewReason:ScopeReviewReasonSchema,canEdit:z.boolean()})),closureBlockers:z.array(z.string()),files:z.array(FileSchema),history:z.array(AuditSchema)});
const List=DeliveryListSchema;
const Calendar=z.array(z.object({deliveryId:z.string().uuid(),pickingName:z.string(),customerName:z.string(),appointment:AppointmentSchema}));
const TaskTemplateHttp=TaskTemplateSchema.extend({requiredSkillIds:SkillIdsSchema});
const routeLifecycleResponses: Record<string, z.ZodType> = {
  '/routes/reconciliation-owners': z.array(ResponsibleParticipantSchema),
  '/routes/{id}/operations': RouteOperationsSchema,
  '/routes/{id}/revisions/{version}': RouteRevisionSchema,
  '/routes/{id}/depart': RouteOperationsSchema,
  '/routes/{id}/amend-review': RouteAmendReviewSchema,
  '/routes/{id}/amend': RouteOperationsSchema,
  '/routes/{id}/cancel': RouteOperationsSchema,
  '/routes/{id}/abort': RouteOperationsSchema,
  '/routes/{id}/returning': RouteOperationsSchema,
  '/routes/{id}/return': RouteOperationsSchema,
  '/routes/{id}/reconcile': RouteOperationsSchema,
  '/routes/{id}/warehouse-receipts': RouteOperationsSchema,
  '/routes/{id}/close': RouteOperationsSchema,
  '/routes/{id}/stops/{appointmentId}/skip': RouteOperationsSchema,
  '/crew/routes': z.object({ routes: z.array(RouteOperationsSchema) }),
  '/crew/routes/{id}': RouteOperationsSchema,
  '/crew/routes/{id}/depart': RouteOperationsSchema,
  '/crew/routes/{id}/returning': RouteOperationsSchema,
  '/crew/routes/{id}/return': RouteOperationsSchema,
};
const routeDescriptions: Record<string, string> = {
  '/routes/reconciliation-owners': 'Admin/operator directory of dispatcher IDs and names for explicit remaining-work ownership. No credentials or participant logins are returned.',
  '/routes/{id}/operations': 'Current published-route projection: version, stop sequence, exact order-line actuals and remaining work, resource snapshots, permission/readiness capabilities, actual return, manual reconciliation, warehouse receipts and revision history. Missing source or packaging information stays explicit. Travel remains labelled as estimated.',
  '/routes/{id}/revisions/{version}': 'Read an immutable published-route revision and its captured runtime, preserving the author and reason in route history. The version path parameter is a positive integer, not an appointment or delivery version.',
  '/routes/{id}/depart': 'Admin/operator records actual route departure with a required reason. Requires a ready confirmed next stop and people/vehicle returned from prior trips including their turnaround buffer. Later unconfirmed stops do not prevent departure; each Start still enforces its own confirmation.',
  '/routes/{id}/amend-review': 'Read-only review of an unstarted, unloaded published route. Explicitly confirms no departure or loading, rechecks exact remaining work, resources and full trip feasibility, and returns a fingerprint plus visits requiring renewed customer confirmation. Does not reserve or modify anything.',
  '/routes/{id}/amend': 'Atomically apply the reviewed route version, reason, fingerprint and estimate acknowledgement. Rechecks future stops, responsible participants, vehicle/driver and availability including return. Records old and new revisions, updates reservations and resets affected customer confirmations. Replaced participants lose current access. Started work or loaded cargo requires the exception workflow instead.',
  '/routes/{id}/cancel': 'Cancel an unstarted route only after explicit no-departure and no-loading confirmations. Visits created by publication are cancelled. Attached visits retain their standalone booking by default; cancelAttachedAppointmentIds explicitly opts them into cancellation. Restoration and reservation release are atomic. Existing reports and history are preserved.',
  '/routes/{id}/abort': 'Admin/operator interrupts a loaded or departed route with a reason and moves it to returning. Preserves the actual stop states, reports and cargo uncertainty; it does not invent a departure or free resources before actual return.',
  '/routes/{id}/stops/{appointmentId}/skip': 'Admin/operator skips one unstarted stop with a reason. Releases that future work without inventing delivered quantities. Started or reported work remains protected; route transport and people remain occupied until actual return.',
  '/routes/{id}/returning': 'Admin/operator records the return journey with a reason, including exceptions with unfinished stops. This is distinct from physical return and does not release the people or vehicle.',
  '/routes/{id}/return': 'Record actual physical return with an explicit timestamp and optional note, even when reports are late or missing. Preserves real stop states, releases route resources using the actual time plus declared turnaround buffer, and leaves reconciliation pending. Does not confirm warehouse receipt or close a Picking.',
  '/routes/{id}/reconcile': 'Admin/operator records a manual declaration for every exact visit/source line, with an owner and next action for each remaining operation. Captures cargo location or explicit unknown, and validates readiness and existing repeat bookings. Does not credit work, bypass damage holds, create repeat bookings or receive goods at the warehouse.',
  '/routes/{id}/warehouse-receipts': 'Record a separate, versioned warehouse receipt for exact visit/source-line cargo quantities. Actual return is required. Collection at the customer and warehouse acceptance remain distinct facts; quantities cannot be received twice beyond the declared available cargo.',
  '/routes/{id}/close': 'Admin/operator closes a returned route after reconciliation and its checks. Any permitted exception requires an explicit exceptionReason and remains in history. Unfinished obligations stay on their original Pickings; closing a route does not finish deliveries or silently mark goods received.',
  '/crew/routes': 'Up to 200 recent published routes for the currently enabled actual participant. Draft and cancelled routes are excluded. Current assignments and file access are enforced by the backend; removed participants lose access.',
  '/crew/routes/{id}': 'Authorized assigned-route queue with current version, exact work scope, saved unloading entrances, customer windows, estimated ETA, vehicle, responsible participant and action capabilities. Existing protected visit cards expose scoped instructions, drawings and reports.',
  '/crew/routes/{id}/depart': 'Only the route responsible participant or assigned participant-driver records departure. The next stop must be ready and customer-confirmed; prior trips and return buffers must permit it. Linked visit Start remains blocked before departure and outside the current stop order.',
  '/crew/routes/{id}/returning': 'Only the route responsible participant or assigned participant-driver starts the return journey after all stops are terminal. An unfinished stop needs a dispatcher decision. Resources remain occupied until actual return.',
  '/crew/routes/{id}/return': 'Only the route responsible participant or assigned participant-driver records physical return. An actual timestamp and optional note may be sent even with missing reports. Return and warehouse acceptance are separate; missing reports remain visible for dispatcher reconciliation.',
  '/routes/publication-capability': 'Reports the default-off rollout gate. Publication review is read-only and remains available. Enable publication only after departure, cancellation and actual-return controls have passed acceptance on the intended stand.',
  '/routes/{id}/publication-review': 'Review every saved route stop as an exact new scope or explicit booked appointment. Includes tasks, actual participants, responsibility, approximate timeline and live feasibility. Does not reserve or mutate anything; returns a fingerprint for Publish.',
  '/routes/{id}/publish': 'Admin/operator atomic publication under the shared scheduling lock. Requires a saved draft version, exact reviewed work/appointment selections, fresh fingerprint, stable request ID and estimate acknowledgement. Creates all visits, memberships and full-trip reservations or none. Customer confirmation remains separate; same successful command retries without duplicated effects. The default-off rollout flag must be explicitly enabled after route execution acceptance.',
  '/routes/{id}/publication': 'Read the immutable publication identity, current status and exact linked visit IDs, or null when still a draft.',
  '/routes': 'List recent draft routes and teaching depots. Creating a draft does not book visits or reserve resources. Repeating the original request ID and input returns the current draft.',
  '/routes/jobs': 'Open delivery, installation and collection by source line. With an anchor, returns geocoded jobs in straight-line radius order. remainingWorkEstimate shares the list estimator: source minutes scaled by equally weighted remaining unit-operations, rounded up. suggestedWorkMinutes is null for unknown, zero or over-1440-minute work; the full estimate is retained.',
  '/routes/preview': 'Recalculate ETA, selected-work duration and return. Explicit per-stop window semantics distinguish arrival from work completion; missing semantics remain unknown. Feasibility checks actual participants, task skills, date-specific declared shifts/breaks/absences, external confirmations and live resource reservations through the return, plus an explicit transfer buffer. Legacy drafts remain readable but missing data never means feasible. workFingerprint identifies the current selected work. remaining_estimate recomputes a provisional proportional estimate; manual preserves the entered duration. This preview never books resources.',
  '/routes/suggest-order': 'Read-only bounded comparison of stop orders with the same directed travel matrix and live feasibility inputs. Keeps all selected work, people, vehicle, depots and windows. The configured objective is explicit; initial UI uses travel_minutes. Manual estimates require comparable reviewed directions. No Google provider, booking, save or automatic apply. Results are estimates, not a proof of optimality; compare fingerprint and recheck after resource or work changes.',
  '/routes/{id}': 'Read a saved draft with current remaining work or update it using its current version.',
  '/deliveries': 'The list redacts drawn signatures as null. planning derives operational status, current booked/in-progress visits and their crew snapshots, plus a provisional estimate of remaining line operations. Geographic filters combine before pagination. Missing flags cannot accompany a value for the same field. Optional north/south/east/west require all four bounded coordinates, south<north and west<east, and view=inbox. Inclusive area selection uses confirmed entrances before references; area.excludedMissingCoordinates counts otherwise matching jobs without usable points. Facets are area-scoped: geographyFacets cities cover the selected view, provinces respect city/cityMissing, postal codes also respect province/provinceMissing. matchingGeographyFacets respects all geographic filters. Both groups ignore search and pagination; null stays explicit. Sidebar counts remain global. Synthetic province/postal metadata requires its current source customer and address.',
  '/deliveries/map': 'All matching Inbox jobs in the existing 5000-record local dataset limit, without list pagination. Uses the same geographic/search/area filters as the list. Current confirmed entrances override reference coordinates. Without area bounds, unusable coordinates remain in missingCoordinates. With bounds, they are excluded and reported in area.excludedMissingCoordinates; total is the number inside the area. Overlapping points retain separate delivery IDs. No geocoding, map tiles, external routing or Google calls are performed.',
  '/deliveries/{id}/entrance': 'Read or explicitly confirm an independently verified unloading point for the current source customer and address. Confirmation requires the current delivery and entrance versions and is reused by route planning for matching destinations.',
  '/deliveries/{id}/entrance/suggestion': 'Get a transient address reference point. The server resolves the current address from the authorized delivery, and rejects an outdated address key. The suggested point is never persisted by this operation.',
  '/calendar': 'Calendar results redact drawn signatures as null. Authorized delivery details retain the original signatures.',
  '/crew/visits': `Up to ${CREW_VISIT_LIST_LIMIT} assigned visits. Booked and in-progress visits come first, earliest start first. Completed and failed visits then appear most recent first. Cancelled visits are hidden.`,
  '/crew/visits/{id}': 'Only actual participants can open this visit. Tasks and crew names are scoped to their assignment. Current transport uses active allocations. The confirmation status is derived from the current visit window; legacy started/completed visits may have no confirmation record. The version is the current delivery version for mutations. A finish result must explain every planned source-line operation whose actual quantity is below the visit plan; omitted actual quantities count as zero.',
  '/crew/visits/{id}/start': 'Starts a booked visit after recorded customer confirmation and current work-scope review. A linked route must have departed and this must be its next unfinished stop. Occupied resources and actual-return buffers also block standalone starts. Installation requires stock already at the customer plus delivery planned on this same visit; other future visits do not count as delivered stock.',
  '/crew/visits/{id}/checklist/{checklistId}': 'Sets one item on the participant’s own assignment during an in-progress visit. Items waived by an operator are locked.',
  '/crew/visits/{id}/issues': 'Reports a problem during an in-progress visit with one required JPEG or PNG photo, encoded as bare base64 and limited to 5 MiB decoded. The attachment is available only through the existing private Backoffice file route.',
  '/crew/visits/{id}/attempt-failure': 'The selected responsible participant closes a started visit because the customer was absent and no goods or work were handed over. A reason is required. The failure credits zero goods, needs no signatures or completion photos, and stays in delivery history. Any linked return request becomes eligible for booking again.',
  '/crew/visits/{id}/documents/{fileId}': 'Downloads a private document for a booked or in-progress visit. Requires a current assignment and scope covering the delivery, visit and linked product line.',
  '/deliveries/{id}/services': 'Sets the default service or overrides one unprocessed product line. A null line override inherits the default. Recorded line work preserves its service. The plan is locked while a visit is in progress.',
  '/deliveries/{id}/work-readiness/{sourceLineId}': 'An authenticated backoffice operator explicitly releases all current damage holds on this source line with a required explanation. Preserves the report and issue history; resolving an issue does not release the hold. Booking and starting affected work remain blocked until this confirmation. New damage creates a new hold.',
  '/crew/visits/{id}/finish': `Only the selected responsible participant can report and finish a started visit. Send actual work amounts in thousandths of a source-line unit, a named customer drawing and a distinct responsible participant drawing. Optional product checks record an outcome and an optional note of up to 500 characters for each checked source line. Include one to ${MAX_VISIT_EVIDENCE} completion photos as bare base64 JPEG or PNG, up to 5 MiB per file and ${CREW_FINISH_PHOTOS_MAX_BYTES / (1024 * 1024)} MiB decoded in total. A photo may specify its sourceLineId. The JSON body is limited to ${CREW_FINISH_JSON_MAX_BYTES / (1024 * 1024)} MiB. The server saves checks and private photos with the result. It records both signatures at the reported end and derives the crew signer from the current designation. A legacy started visit with no recorded start requires an explicit UTC/offset actual start. The server captures the checklist across all crews. Partial work can be signed and delivery closure still requires its own checks. Raw drawings and photo contents are omitted from the crew response.`,
  '/deliveries/{id}/appointments/{appointmentId}/responsible': 'Backoffice administrators and operators explicitly choose one enabled participant from the actual staffing for a booked or in-progress visit. Removing that participant through a staffing change clears the designation.',
  '/deliveries/{id}/appointments': 'Book an explicit nonempty list of source-line operations and quantities in thousandths of a source-line unit. The atomic booking reserves available remaining work; simultaneous visits cannot reserve the same quantity twice. Installation-only work requires an explicit customer-stock confirmation. Future installation may be planned before delivery, but starting it requires available goods. Existing unreviewed legacy visits block guessing their reserved work.',
  '/deliveries/{id}/appointments/{appointmentId}/work-scope': 'Review or change a booked visit using the current delivery version, a stable request ID and a reason. An unscoped legacy in-progress visit with no results may be explicitly reviewed; existing started scopes are immutable. Revalidates remaining work, stores source/service snapshots, and invalidates prior customer confirmation. Completed history is never assigned an invented plan.',
};

const routes=[
  ['get','/auth/me',null],['post','/auth/login',z.object({email:z.string().email(),password:z.string()}).strict()],['post','/auth/logout',z.object({}).strict()],
  ['get','/crew/auth/me',null],['post','/crew/auth/login',CrewLoginInput],['post','/crew/auth/logout',CrewLogoutInput],
  ['get','/crew/visits',null],['get','/crew/visits/{id}',null],
  ['get','/crew/visits/{id}/documents/{fileId}',null],
  ['post','/crew/visits/{id}/start',CrewStartInput],['patch','/crew/visits/{id}/checklist/{checklistId}',CrewChecklistInput],
  ['post','/crew/visits/{id}/issues',CrewIssueInput],
  ['post','/crew/visits/{id}/finish',CrewFinishInput],
  ['post','/crew/visits/{id}/attempt-failure',CrewAttemptFailureInput],
  ['get','/crew/routes',null],['get','/crew/routes/{id}',null],
  ['post','/crew/routes/{id}/depart',RouteActionInputSchema],['post','/crew/routes/{id}/returning',RouteActionInputSchema],
  ['post','/crew/routes/{id}/return',RouteReturnInputSchema],
  ['get','/deliveries',null],['get','/deliveries/map',null],['get','/deliveries/{id}',null],['patch','/deliveries/{id}/instructions',InstructionsInput],
  ['get','/deliveries/{id}/entrance',null],['patch','/deliveries/{id}/entrance',ConfirmEntranceInputSchema],
  ['post','/deliveries/{id}/entrance/suggestion',AddressSuggestionInputSchema],
  ['patch','/deliveries/{id}/services',ChangeServiceInput],
  ['post','/deliveries/{id}/appointments',BookInput],['patch','/deliveries/{id}/appointments/{appointmentId}',MoveInput],
  ['patch','/deliveries/{id}/appointments/{appointmentId}/work-scope',WorkScopeInput],
  ['post','/deliveries/{id}/appointments/{appointmentId}/assign',AssignInput],['post','/deliveries/{id}/appointments/{appointmentId}/cancel',ReasonInput],
  ['post','/deliveries/{id}/appointments/{appointmentId}/confirm-customer',VersionSchema.strict()],
  ['patch','/deliveries/{id}/appointments/{appointmentId}/responsible',ResponsibleParticipantInput],
  ['get','/deliveries/{id}/appointments/{appointmentId}/transport/availability',null],
  ['post','/deliveries/{id}/appointments/{appointmentId}/transport',TransportCreateInput],
  ['post','/deliveries/{id}/appointments/{appointmentId}/transport/{allocationId}/replace',TransportReplaceInput],
  ['post','/deliveries/{id}/appointments/{appointmentId}/transport/{allocationId}/cancel',TransportCancelInput],
  ['get','/deliveries/{id}/appointments/{appointmentId}/participants',null],['patch','/deliveries/{id}/appointments/{appointmentId}/participants',StaffingInput],
  ['post','/deliveries/{id}/appointments/{appointmentId}/checklist/{checklistId}/waive',ReasonInput],
  ['post','/deliveries/{id}/issues',VersionSchema.extend({type:z.enum(['damage','missing_parts','access','other']),description:z.string(),itemIds:z.array(z.number().int()),notes:z.string().nullable().optional(),appointmentId:z.string().uuid().optional()}).strict()],
  ['patch','/deliveries/{id}/work-readiness/{sourceLineId}',WorkReadinessInput],
  ['patch','/deliveries/{id}/issues/{issueId}/notes',VersionSchema.extend({notes:z.string().nullable()}).strict()],
  ['post','/deliveries/{id}/issues/{issueId}/resolve',ResolveInput],['post','/deliveries/{id}/returns',VersionSchema.extend({appointmentId:z.string().uuid(),reason:z.string(),remainingWork:z.string(),notes:z.string().nullable().optional()}).strict()],
  ['patch','/deliveries/{id}/returns/{returnId}/notes',VersionSchema.extend({notes:z.string().nullable(),photoIds:z.array(z.string().uuid())}).strict()],
  ['post','/deliveries/{id}/returns/{returnId}/resolve',ResolveInput],['post','/deliveries/{id}/complete',VersionSchema.strict()],['post','/deliveries/{id}/reopen',ReasonInput],
  ['get','/crews',null],['post','/crews',CrewCreateInput],['patch','/crews/{id}',CrewUpdateInput],
  ['get','/crews/{id}',null],['delete','/crews/{id}',VersionSchema.strict()],
  ['get','/participants',null],['post','/participants',CreateParticipantInput],['patch','/participants/{id}',UpdateParticipantInput],
  ['get','/participants/{id}',null],['delete','/participants/{id}',VersionSchema.strict()],
  ['patch','/participants/{id}/skills',ParticipantSkillsInput],
  ['get','/skills',null],['post','/skills',SkillCreateInput],['patch','/skills/{id}',SkillUpdateInput],
  ['get','/vehicles',null],['post','/vehicles',VehicleCreateInput],['patch','/vehicles/{id}',VehicleUpdateInput],
  ['get','/participants/{id}/calendar',null],
  ['get','/templates',null],['post','/templates',TaskTemplateSchema.omit({id:true,version:true})],['patch','/templates/{id}',TaskTemplateUpdateInput],
  ['get','/templates/{id}',null],['delete','/templates/{id}',VersionSchema.strict()],
  ['get','/calendar',null],['get','/imports',null],['post','/imports',z.object({}).strict()],
  ['post','/deliveries/{id}/files',UploadSchema],
  ['get','/deliveries/{id}/files/{fileId}',null],
  ['get','/routes',null],['get','/routes/jobs',null],['post','/routes/preview',RoutePreviewInputSchema],['post','/routes/suggest-order',RouteSuggestInputSchema],
  ['get','/routes/{id}',null],['post','/routes',RouteCreateInputSchema],['patch','/routes/{id}',RouteUpdateInputSchema],
  ['get','/routes/publication-capability',null],['get','/routes/{id}/publication',null],
  ['post','/routes/{id}/publication-review',PublicationReviewInputSchema],['post','/routes/{id}/publish',PublishInputSchema],
  ['get','/routes/reconciliation-owners',null],['get','/routes/{id}/operations',null],['get','/routes/{id}/revisions/{version}',null],
  ['post','/routes/{id}/depart',RouteReasonInputSchema],['post','/routes/{id}/amend-review',RouteAmendReviewInputSchema],
  ['post','/routes/{id}/amend',RouteAmendInputSchema],['post','/routes/{id}/cancel',RouteCancelInputSchema],
  ['post','/routes/{id}/abort',RouteReasonInputSchema],['post','/routes/{id}/stops/{appointmentId}/skip',RouteReasonInputSchema],
  ['post','/routes/{id}/returning',RouteReasonInputSchema],['post','/routes/{id}/return',RouteReturnInputSchema],
  ['post','/routes/{id}/reconcile',RouteReconcileInputSchema],['post','/routes/{id}/warehouse-receipts',RouteWarehouseReceiptInputSchema],
  ['post','/routes/{id}/close',RouteCloseInputSchema],
] as const;
export function apiDocument() {
  const paths:Record<string,Record<string,unknown>>={};
  for(const [method,path,body] of routes){
    const parameters:unknown[]=[...path.matchAll(/\{(\w+)\}/g)].map((match)=>({name:match[1],in:'path',required:true,schema:match[1]==='version'?{type:'integer',minimum:1}:{type:'string',format:'uuid'}}));
    if(path==='/deliveries') for(const [name,schema] of Object.entries(DeliveryListQuerySchema.shape)) parameters.push({name,in:'query',schema:z.toJSONSchema(schema)});
    if(path==='/deliveries/map') for(const [name,schema] of Object.entries(DeliveryMapQuerySchema.shape)) parameters.push({name,in:'query',schema:z.toJSONSchema(schema)});
    if(path==='/routes/jobs') parameters.push({name:'search',in:'query',schema:{type:'string',maxLength:100}},
      {name:'anchorId',in:'query',schema:{type:'string',format:'uuid'}},
      {name:'radiusKm',in:'query',schema:{type:'number',minimum:1,maximum:50,default:10},description:'Requires an anchor; measured in a straight line.'});
    if(path==='/calendar'||path==='/participants/{id}/calendar') for(const name of ['from','to']) parameters.push({name,in:'query',required:true,schema:{type:'string',format:'date-time'},description:`Explicit offset; half-open range at most ${CALENDAR_MAX_DAYS} days`});
    if(path.endsWith('/transport/availability')) for(const name of ['from','to']) parameters.push({name,in:'query',required:true,schema:{type:'string',format:'date-time'},description:`Explicit offset; half-open transport interval at most ${TRANSPORT_MAX_DAYS} days, covering the complete visit. Current appointment is excluded from conflicts.`});
    const crew=path.startsWith('/crew/');
    const lifecycleResponse=routeLifecycleResponses[path];
    const response=lifecycleResponse??(method==='delete'?DirectoryDeletionSchema:path.startsWith('/auth/')?(path==='/auth/logout'?z.object({ok:z.literal(true)}):User)
      :path.startsWith('/crew/auth/')?(path==='/crew/auth/logout'?CrewLogoutResult:CrewProfileSchema)
      :path==='/crew/visits'?CrewVisitListSchema:path.startsWith('/crew/visits/')?CrewVisitDetailSchema
      :path==='/deliveries'?List:path==='/deliveries/map'?DeliveryMapSchema:path==='/calendar'?Calendar:path==='/participants/{id}/calendar'?ParticipantCalendarSchema
      :path==='/deliveries/{id}/entrance'?EntranceResponseSchema:path==='/deliveries/{id}/entrance/suggestion'?AddressSuggestionResponseSchema
      :path==='/crews'||path==='/crews/{id}'?(method==='get'&&path==='/crews'?z.array(CrewSchema):CrewSchema)
      :path==='/participants'||path==='/participants/{id}'?(method==='get'&&path==='/participants'?z.array(ParticipantSchema).max(5000):ParticipantSchema)
      :path==='/participants/{id}/skills'?ParticipantSchema
      :path==='/skills'||path==='/skills/{id}'?(method==='get'?z.array(SkillSchema).max(5000):SkillSchema)
      :path==='/vehicles'||path==='/vehicles/{id}'?(method==='get'?z.array(VehicleSchema).max(5000):VehicleSchema)
      :path.endsWith('/transport/availability')?TransportAvailabilitySchema
      :path==='/deliveries/{id}/appointments/{appointmentId}/participants'&&method==='get'?AvailabilitySchema
      :path==='/templates'||path==='/templates/{id}'?(method==='get'&&path==='/templates'?z.array(TaskTemplateHttp):TaskTemplateHttp)
      :path==='/routes/publication-capability'?z.object({enabled:z.boolean(),reason:z.string().nullable()}).strict()
      :path==='/routes/{id}/publication-review'?PublicationReviewSchema
      :path==='/routes/{id}/publish'?PublicationSummarySchema:path==='/routes/{id}/publication'?PublicationDetailSchema.nullable()
      :path==='/routes/jobs'?RouteJobsSchema:path==='/routes/preview'?RoutePreviewSchema:path==='/routes/suggest-order'?RouteSuggestionSchema
      :path==='/routes'&&method==='get'?RouteDraftListSchema:path.startsWith('/routes')?RouteDetailSchema
      :path==='/imports'?(method==='get'?z.array(ImportSchema):ImportSchema):Detail);
    const responseSchema=response===Detail?{$ref:'#/components/schemas/DeliveryDetail'}:response===List?{$ref:'#/components/schemas/DeliveryList'}:z.toJSONSchema(response);
    const success={description:'Successful operation',content:{'application/json':{schema:responseSchema}}};
    const crewMutation = crew && method!=='get' && path.startsWith('/crew/visits/');
    const description = lifecycleResponse && method!=='get' && path!=='/routes/{id}/amend-review'
      ? `${routeDescriptions[path]} Retrying the identical command with its original request ID, version and timestamp returns the current route without duplicating effects. Changed input requires a new request ID. A stale route version returns a conflict.`
      : crewMutation
      ? `${routeDescriptions[path]} Retrying the same request ID and command returns the current visit without applying the command again. The version may be refreshed on a retry.`
      : routeDescriptions[path];
    const operation={summary:method.toUpperCase()+' '+path,description:method==='delete'?'Administrator only. Deletes an unused directory record with its current version. References in delivery history, route drafts or resource reservations block deletion; disable the record instead. Participants must first leave their default crew. Deleting an unused crew detaches its roster without deleting people. Historical snapshots are never rewritten.':description,security:path.endsWith('/auth/login')?[]:crew?[{crewSession:[]}]:[{session:[]}],parameters,
      ...(body?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(body,{io:'input'})}}}}:{}),
      responses:{[method==='post'&&!lifecycleResponse&&!['/routes/preview','/routes/suggest-order','/routes/{id}/publication-review','/routes/{id}/publish','/deliveries/{id}/entrance/suggestion'].includes(path)?'201':'200']:path.endsWith('/{fileId}')?{description:'Private attachment',content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}}:success,'400':{description:'Invalid input'},'401':{description:'Login required'},'403':{description:'Forbidden role or origin'},'404':{description:'Missing record'},'409':{description:path==='/crews'||path==='/crews/{id}'?'Stale version or participant already belongs to another default crew; the message identifies the participant and crew':'Version, resource or domain conflict'},...(path==='/crew/auth/login'?{'429':{description:'Too many simultaneous login attempts'}}:{}),...(path==='/crew/visits/{id}/finish'?{'413':{description:'Request body exceeds the allowed size'}}:{})}};
    const entry=paths[path]??{};entry[method]=operation;paths[path]=entry;
  }
  return {openapi:'3.1.0',info:{title:'Delivery Backoffice local demo',version:'0.7.0',description:'Synthetic Odoo. Cookies require exact configured Origin for mutations. Crew uses a separate host-only session through the same-origin crew frontend proxy. Actual visit participants can start confirmed appointments, update their own checklist and report a problem with a private photo. The selected responsible participant reports the work with two drawn signatures and at least one private completion photo. Authorized Backoffice delivery details retain the immutable drawings and earlier signature history. Backoffice admin and operator access the single demo workspace and public participant profiles; only admin edits crews, participants, skills, vehicles and templates. Participant passwords are write-only; hashes never leave the server. Skills belong to participants. Every actual selected person must cover all required enabled skills when assigned or when booked staffing changes; saved task requirements and qualification snapshots preserve history. Disabled required skills block new planning. Visit staffing is atomic and checks current resource availability. Transport uses known physical company or external vehicles and optional independent drivers. Only unstarted booked visits may change transport, using versioned idempotent commands; replacement/cancellation preserves snapshots and reasons. Transport windows cover the visit and remain reserved through the planned return even after service completion. Cancel active transport explicitly before rescheduling. Vehicle maintenance/disable does not cancel existing reservations.'},servers:[{url:'http://127.0.0.1:3001/api'}],paths,components:{securitySchemes:{session:{type:'apiKey',in:'cookie',name:'backoffice_session'},crewSession:{type:'apiKey',in:'cookie',name:CREW_SESSION_COOKIE}},schemas:{Delivery:z.toJSONSchema(DeliverySchema),DeliveryDetail:z.toJSONSchema(Detail),DeliveryList:z.toJSONSchema(List),Source:z.toJSONSchema(SourceSchema),Crew:z.toJSONSchema(CrewSchema),Participant:z.toJSONSchema(ParticipantSchema),Skill:z.toJSONSchema(SkillSchema),Vehicle:z.toJSONSchema(VehicleSchema),TransportAvailability:z.toJSONSchema(TransportAvailabilitySchema),Availability:z.toJSONSchema(AvailabilitySchema),TaskTemplate:z.toJSONSchema(TaskTemplateHttp),File:z.toJSONSchema(FileSchema),Import:z.toJSONSchema(ImportSchema)}}};
}
