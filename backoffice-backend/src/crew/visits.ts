import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Database, rows } from '../database/database';
import { AppointmentSchema, DeliverySchema, DocumentSnapshotSchema, IdSchema, InstructionsSchema, SourceSchema } from '../domain/model';
import { appointmentScopeReviewReason, crewAssignments, customerConfirmationStatus, effectiveResults, lineServiceStatuses, signatureRefusalStatus, unfinishedChecklistCount } from '../domain/rules';
import { Files } from '../evidence/files';
import { recordedActualStart } from '../execution/visit';
import { CREW_VISIT_LIST_LIMIT, type CrewProfile, type CrewVisitDetail, type CrewVisitSummary } from './contracts';
import { routeVisitStartBlocker } from '../operations/route-reservations';

const VisitRow = z.object({
  deliveryId: IdSchema,
  version: DeliverySchema.shape.version,
  appointment: AppointmentSchema,
  source: SourceSchema,
  servicePlan: DeliverySchema.shape.servicePlan.nullish().transform((plan) => plan ?? undefined),
  priorWorkRevisions: DeliverySchema.shape.priorWorkRevisions.nullish().transform((revisions) => revisions ?? undefined),
  sourceReview:z.boolean(),
  sourceImport: DeliverySchema.shape.sourceImport.nullish().transform((state) => state ?? undefined),
  instructions: InstructionsSchema,
  issues:DeliverySchema.shape.issues,
  workHolds:DeliverySchema.shape.workHolds.nullish().transform((holds)=>holds??undefined),
  appointments: z.array(AppointmentSchema),
});
type VisitRow = z.infer<typeof VisitRow>;

function visibleVisit({ appointment, source, instructions }: Pick<VisitRow, 'appointment' | 'source' | 'instructions'>, participantId: string) {
  if (appointment.status === 'cancelled') return undefined;
  const assignments = crewAssignments(appointment, participantId);
  if (!assignments.length) return undefined;
  const { address, city, country, name, contact, phones } = source.customer;
  const summary: CrewVisitSummary = {
    id: appointment.id,
    pickingName: source.pickingName,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    status: appointment.status,
    confirmationStatus: customerConfirmationStatus(appointment),
    destination: { address, city, country },
    crews: assignments.map(({ crewId, crewName }) => ({ id: crewId, name: crewName })),
    vehicles: (appointment.transportAllocations ?? [])
      .filter(({ status }) => status === 'active')
      .map(({ vehicle: { id, name, plate } }) => ({ id, name, plate })),
  };
  return { summary, assignments, items: source.items, instructions, customer: { name, contact, phones } };
}

function crewVisitDetail(row: Omit<VisitRow, 'deliveryId'>, participantId: string, actualStartedAt: string | null): CrewVisitDetail {
  const result = effectiveResults({appointments:[row.appointment]})[0];
  const source = result?.sourceSnapshot ?? row.source;
  const visit = visibleVisit({...row,source}, participantId);
  if (!visit) throw new NotFoundException('Visit not found');
  const responsibleParticipant = row.appointment.responsibleParticipant ?? null;
  const services = new Map(lineServiceStatuses({...row,source}).map((status) => [status.sourceLineId, status]));
  const orders = new Map(source.salesOrders?.map(({ id, name }) => [id, name]));
  const showOrder = row.servicePlan !== undefined || orders.size > 1;
  const scopeReviewReason=appointmentScopeReviewReason(row,row.appointment,{allowDamageHold:row.appointment.status==='in_progress'});
  const scope=result?.workScopeSnapshot??row.appointment.workScope;
  const refusalStatus = signatureRefusalStatus(row.appointment);
  return {
    ...visit.summary,
    version: row.version,
    responsibleParticipant,
    canFinish: row.appointment.status === 'in_progress' && scopeReviewReason===null && responsibleParticipant?.id.toLowerCase() === participantId.toLowerCase(),
    canStart:row.appointment.status==='booked'&&scopeReviewReason===null&&row.appointment.customerConfirmation!==undefined,
    scopeReviewReason,
    ...(refusalStatus === undefined ? {} : { signatureRefusalStatus: refusalStatus }),
    workScope:scope?{revision:scope.revision,confirmedAt:scope.confirmedAt,lines:scope.lines.map((line)=>({
      sourceLineId:line.sourceLineId,service:line.service,deliveryMilli:line.deliveryMilli,
      installationMilli:line.installationMilli,collectionMilli:line.collectionMilli,
      ...(line.customerStockConfirmed===undefined?{}:{customerStockConfirmed:line.customerStockConfirmed}),
    }))}:null,
    ...(row.appointment.failedAttempt ? { failedAttempt: row.appointment.failedAttempt } : {}),
    actualStartedAt,
    unfinishedChecklistCount: unfinishedChecklistCount(row.appointment),
    customer: visit.customer,
    instructions: visit.instructions,
    issues:row.issues.filter((issue)=>issue.status==='open'&&(issue.appointmentId===row.appointment.id||
      issue.appointmentId===undefined&&issue.itemIds.some((id)=>source.items.some(({sourceLineId})=>sourceLineId===id))))
      .map(({id,type,description,itemIds,appointmentId,status})=>({id,type,description,itemIds,appointmentId,status})),
    items: visit.items.map(({ sourceLineId, saleOrderId, name, quantity, uom, configuration, notes }) => {
      const status = services.get(sourceLineId);
      if (!status) throw new Error('Visit item is missing its service status');
      const { service, remainingDeliveryMilli, remainingInstallationMilli, remainingCollectionMilli, deliveredMilli, installedMilli } = status;
      const planned=scope?.lines.find((line)=>line.sourceLineId===sourceLineId);
      const availableInstallationMilli = service === 'delivery_installation'
        ? Math.min(remainingInstallationMilli, Math.max(0, deliveredMilli - installedMilli)) : planned?.customerStockConfirmed===true?remainingInstallationMilli:0;
      const orderName = saleOrderId === undefined ? source.saleOrderName : orders.get(saleOrderId) ?? source.saleOrderName;
      return {
        sourceLineId, name, quantity, uom, configuration, notes, remainingMilli: remainingDeliveryMilli,
        ...(showOrder ? { orderName } : {}),
        serviceWork: { service, remainingDeliveryMilli, remainingInstallationMilli, remainingCollectionMilli, availableInstallationMilli,
          plannedDeliveryMilli:planned?.deliveryMilli??0,plannedInstallationMilli:planned?.installationMilli??0,plannedCollectionMilli:planned?.collectionMilli??0 },
      };
    }),
    tasks: visit.assignments.flatMap(({ tasks }) => tasks.map(({ id, title, checklist }) => ({
      id, title, checklist: checklist.map(({ id, label, done, waiver }) => ({ id, label, done, waived: waiver !== null })),
    }))),
  };
}

@Injectable()
export class CrewVisits {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Files) private readonly files: Files) {}

  private fetch(participantId: string, appointmentId: string | null, includeQuantities = false) {
    return rows(this.db.source.manager, VisitRow, `
      SELECT d.id AS "deliveryId", d.version, v.data AS appointment, d.data->'source' AS source, d.data->'instructions' AS instructions,
        d.data->'servicePlan' AS "servicePlan", d.data->'priorWorkRevisions' AS "priorWorkRevisions", d.data->'sourceImport' AS "sourceImport", d.data->'issues' AS issues,d.data->'workHolds' AS "workHolds",
        (d.data->>'sourceReview')::boolean AS "sourceReview",
        CASE WHEN $4 THEN d.data->'appointments' ELSE '[]'::jsonb END AS appointments
      FROM appointment a JOIN delivery d ON d.id = a.delivery_id
      JOIN LATERAL jsonb_array_elements(d.data->'appointments') v(data)
        ON lower(v.data->>'id') = a.id::text
      WHERE a.status <> 'cancelled' AND v.data->>'status' <> 'cancelled'
        AND ($2::uuid IS NULL OR a.id = $2::uuid)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(v.data->'assignments') assignment(data)
          CROSS JOIN LATERAL jsonb_array_elements(assignment.data->'people') person(data)
          WHERE lower(person.data->>'id') = $1
        )
      ORDER BY (a.status IN ('completed', 'failed')),
        CASE WHEN a.status IN ('booked', 'in_progress') THEN a.starts_at END,
        CASE WHEN a.status IN ('completed', 'failed') THEN a.starts_at END DESC, a.id
      LIMIT $3`, [participantId, appointmentId, appointmentId ? 1 : CREW_VISIT_LIST_LIMIT, includeQuantities]);
  }

  async list(principal: CrewProfile) {
    const participantId = principal.id.toLowerCase();
    const matches = await this.fetch(participantId, null);
    const links = await this.routeLinks(matches.map(({ appointment }) => appointment.id));
    return { visits: matches.flatMap((row) => {
      const visit = visibleVisit(row, participantId);
      return visit ? [{ ...visit.summary, route: links.get(row.appointment.id) ?? null }] : [];
    }) };
  }

  async assignedRow(id: string, principal: CrewProfile, includeQuantities = false) {
    const appointmentId = IdSchema.parse(id).toLowerCase();
    const participantId = principal.id.toLowerCase();
    const [row] = await this.fetch(participantId, appointmentId, includeQuantities);
    if (!row) throw new NotFoundException('Visit not found');
    return row;
  }

  async detail(id: string, principal: CrewProfile): Promise<CrewVisitDetail> {
    const row = await this.assignedRow(id, principal, true);
    return this.describe(row, principal);
  }

  async describe(row: VisitRow, principal: CrewProfile): Promise<CrewVisitDetail> {
    const canReadDocuments = row.appointment.status === 'booked' || row.appointment.status === 'in_progress';
    const [actualStartedAt, documents] = await Promise.all([
      recordedActualStart(this.db.source.manager, row.deliveryId, row.appointment),
      canReadDocuments ? this.files.crewDocuments(row.deliveryId, row.appointment.id, row.source.items.map(({ sourceLineId }) => sourceLineId)) : [],
    ]);
    const detail = crewVisitDetail(row, principal.id, actualStartedAt);
    detail.route = (await this.routeLinks([row.appointment.id])).get(row.appointment.id) ?? null;
    const routeBlocker = detail.canStart ? await routeVisitStartBlocker(this.db.source.manager,row.appointment.id) : null;
    detail.routeStartBlocker = routeBlocker?.code ?? null;
    if(routeBlocker) detail.canStart=false;
    return documents.length ? {
      ...detail, documents: documents.map((document)=>DocumentSnapshotSchema.strip().parse(document)),
    } : detail;
  }

  private async routeLinks(ids: string[]) {
    const found = await rows(this.db.source.manager, z.object({ appointmentId: IdSchema, id: IdSchema, name: z.string(),
      status: z.enum(['published', 'in_progress', 'returning', 'returned', 'closed']), version: z.number().int().positive() }),
    `SELECT s.appointment_id AS "appointmentId",p.id,p.data->'draft'->>'name' AS name,p.status,p.version
      FROM route_stop s JOIN route_publication p ON p.id=s.route_id WHERE s.active AND p.status<>'cancelled' AND s.appointment_id=ANY($1::uuid[])`, [ids]);
    return new Map(found.map(({ appointmentId, ...route }) => [appointmentId, route]));
  }

  async downloadDocument(appointmentId: string, fileId: string, principal: CrewProfile) {
    const row = await this.assignedRow(appointmentId, principal);
    if (row.appointment.status !== 'booked' && row.appointment.status !== 'in_progress') throw new NotFoundException('Document not found');
    const [file] = await this.files.crewDocuments(row.deliveryId, row.appointment.id,
      row.source.items.map(({ sourceLineId }) => sourceLineId), IdSchema.parse(fileId));
    if (!file) throw new NotFoundException('Document not found');
    return this.files.readStoredFile(file);
  }
}
