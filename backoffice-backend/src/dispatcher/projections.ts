import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, type Delivery } from '../domain/model';
import { appointmentScopeReviewReason, effectiveResults, hasRemainingLineWork, priorWorkReviewReasons } from '../domain/rules';
import { sourcePlanningBlocked } from '../domain/source-import';
import { destinationAddressKey } from '../domain/destination-address';
import { cargoReceiptBalance, type RouteLineStatus } from '../routing/line-status';
import { DispatcherFactsSchema, type DispatcherFacts } from './contracts';

export const EvidenceFileSchema = z.object({ id: IdSchema, deliveryId: IdSchema, appointmentId: IdSchema.nullable(), itemId: z.number().int().nullable(),
  kind: z.string(), status: z.string(), mime: z.string() });
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;
export type DeliveryCaseProjection = DispatcherFacts & { status?: 'resolved' };
type Owner = { id: string; name: string };
const noOrigin = { deliveryId: null, routeId: null, appointmentId: null, sourceLineId: null, issueId: null, resultId: null, cargoKind: null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const brief = (value: string) => value.slice(0, 1900);
function lineSummary(ids: readonly number[]) {
  const text = ids.join(', ');
  return text.length <= 3900 ? text : `${text.slice(0, 3800)}… (${ids.length} product lines)`;
}

function makeCase(identity: readonly (string | number)[], input: Omit<DispatcherFacts, 'key' | 'fingerprint'>, dependencies: unknown): DispatcherFacts {
  const key = digest(identity);
  return DispatcherFactsSchema.parse({ ...input, key, fingerprint: digest({ key, input, dependencies }) });
}

export function deliveryDispatcherCases(delivery: Delivery, hasPoint: boolean, files: ReadonlyMap<string, EvidenceFile>): DeliveryCaseProjection[] {
  const cases: DeliveryCaseProjection[] = [];
  const base = { pickingName: delivery.source.pickingName, customerName: delivery.source.customer.name,
    orderName: null, productName: null, quantityMilli: null, uom: null, sourceOwner: null, sourceAction: null };
  const origin = { ...noOrigin, deliveryId: delivery.id };
  const target = { section: 'deliveries' as const, deliveryId: delivery.id, routeId: null, tab: 'overview' as const };
  const prior = priorWorkReviewReasons(delivery);
  const staleVisits = delivery.appointments.flatMap((appointment) => {
    const reason = appointmentScopeReviewReason(delivery, appointment);
    return reason === 'source_changed' || reason === 'source_review' ? [{ id: appointment.id, reason }] : [];
  });
  if (delivery.sourceReview || sourcePlanningBlocked(delivery) || prior.length || staleVisits.length) {
    const reasons = [...(delivery.sourceReview ? ['source_review_required'] : []), ...(delivery.sourceImport?.pending ? ['source_update_pending'] : []),
      ...(delivery.sourceImport?.eligible === false ? ['source_ineligible'] : []), ...(prior.length ? ['prior_work_conflict'] : []),
      ...(staleVisits.length ? ['visit_source_scope_changed'] : [])];
    cases.push(makeCase(['source_review', delivery.id], { ...base, origin, target, kind: 'source_review',
      title: 'Review source and accepted work', description: 'Compare the source update with the accepted plan and recorded work before continuing.', reasons,
      facts: [{ label: 'source_status', value: delivery.source.sourceState },
        ...(prior.length ? [{ label: 'prior_work_lines', value: lineSummary(prior) }] : []),
        ...staleVisits.slice(0, 20).map(({ id, reason }) => ({ label: 'visit_review', value: `${id}: ${reason}` }))],
    }, { pending: delivery.sourceImport?.pending?.hash ?? null, accepted: delivery.sourceImport?.acceptedHash ?? null,
      prior, staleVisits, warnings: delivery.sourceWarnings }));
  }
  if (delivery.completedAt === null && hasRemainingLineWork(delivery) && !hasPoint) {
    const { address, city, country } = delivery.source.customer;
    cases.push(makeCase(['address_review', delivery.id], { ...base, origin, target, kind: 'address_review', title: 'Locate the delivery address',
      description: 'Confirm the destination and unloading entrance before planning the remaining work on a map.', reasons: ['address_point_missing'],
      facts: [{ label: 'address', value: address ?? '' }, { label: 'city', value: city ?? '' }, { label: 'country', value: country ?? '' }],
    }, { customerId: delivery.source.customer.id, addressKey: destinationAddressKey(delivery.source.customer) }));
  }
  const activeHolds = (delivery.workHolds ?? []).filter(({ release }) => !release);
  for (const issue of delivery.issues) {
    const holds = activeHolds.filter(({ issueId }) => issueId === issue.id);
    if (issue.status !== 'open' && holds.length === 0) continue;
    const items = delivery.source.items.filter(({ sourceLineId }) => issue.itemIds.includes(sourceLineId));
    const first = items.length === 1 ? items[0] : undefined;
    cases.push(makeCase(['issue', delivery.id, issue.id], { ...base, kind: 'issue', title: holds.length ? 'Review problem and repeat readiness' : 'Resolve the reported problem',
      description: brief(issue.description), origin: { ...origin, issueId: issue.id, appointmentId: issue.appointmentId ?? null, sourceLineId: first?.sourceLineId ?? null },
      target: { ...target, tab: 'issues' }, productName: first?.name ?? null,
      orderName: first ? delivery.source.salesOrders?.find(({ id }) => id === first.saleOrderId)?.name ?? delivery.source.saleOrderName : null,
      reasons: [`issue_${issue.type}`, ...(holds.length ? ['damaged_work_on_hold'] : [])],
      facts: [{ label: 'issue_status', value: issue.status }, { label: 'product_lines', value: lineSummary(issue.itemIds) },
        ...(issue.notes ? [{ label: 'issue_note', value: issue.notes }] : [])],
    }, { issue, holds }));
  }
  for (const hold of activeHolds.filter(({ issueId }) => !issueId || !delivery.issues.some(({ id }) => id === issueId))) {
    const item = delivery.source.items.find(({ sourceLineId }) => sourceLineId === hold.sourceLineId);
    cases.push(makeCase(['issue', delivery.id, 'hold', hold.id], { ...base, origin: { ...origin, sourceLineId: hold.sourceLineId, appointmentId: hold.appointmentId ?? null },
      target: { ...target, tab: 'issues' }, kind: 'issue', title: 'Confirm readiness for another visit',
      description: 'The damaged product remains blocked until the dispatcher records readiness in its original workflow.',
      productName: item?.name ?? null, reasons: ['damaged_work_on_hold'], facts: [{ label: 'product_lines', value: String(hold.sourceLineId) }],
    }, hold));
  }
  const effective = effectiveResults(delivery);
  for (const appointment of delivery.appointments.filter(({ status }) => status === 'completed')) {
    const results = effective.filter(({ appointmentId }) => appointmentId === appointment.id);
    const reasons = new Set<string>();
    const references: { id: string; valid: boolean; mime: string | null }[] = [];
    if (results.length === 0) reasons.add('report_missing');
    for (const result of results) {
      const refusal = result.signatureRefusal;
      if (refusal) {
        const review = appointment.signatureRefusalReview?.resultId === result.id ? appointment.signatureRefusalReview : undefined;
        const facts = makeCase(['signature_refusal', delivery.id, result.id], {
          ...base, kind: 'signature_refusal', origin: { ...origin, appointmentId: appointment.id, resultId: result.id },
          target: { ...target, tab: 'history' }, title: 'Review customer signature refusal',
          description: 'Review the report and evidence in History before closing the delivery.',
          reasons: ['customer_signature_refused', ...(refusal.noPhotoReason ? ['customer_photo_prohibited'] : [])],
          facts: [{ label: 'report_summary', value: result.summary }, { label: 'signature_refusal_reason', value: refusal.reason },
            ...(refusal.noPhotoReason ? [{ label: 'no_photo_reason', value: refusal.noPhotoReason }] : []),
            ...(review ? [
              { label: 'review_decision', value: review.decision }, { label: 'review_reason', value: review.reason },
              { label: 'reviewed_by', value: review.reviewedBy.name }, { label: 'reviewed_at', value: review.reviewedAt },
            ] : [])],
        }, { quantities: result.quantities, evidence: result.evidence, review });
        cases.push(review ? { ...facts, status: 'resolved' } : facts);
      }
      if (!refusal && result.customerSignature?.status !== 'signed') reasons.add('customer_signature_unconfirmed');
      if (result.crewSignature?.status !== 'signed') reasons.add('crew_signature_unconfirmed');
      let photo = false;
      for (const reference of result.evidence) {
        const file = files.get(reference.id);
        const valid = !!file && file.deliveryId === delivery.id && file.appointmentId === appointment.id && file.kind === 'evidence' && file.status === 'ready'
          && (file.itemId === null ? reference.itemIds.length === 0 : reference.itemIds.length === 1 && reference.itemIds[0] === file.itemId);
        references.push({ id: reference.id, valid, mime: file?.mime ?? null });
        if (!valid) reasons.add('evidence_reference_unavailable');
        if (valid && (file.mime === 'image/jpeg' || file.mime === 'image/png')) photo = true;
      }
      if (!photo && !refusal?.noPhotoReason) reasons.add('completion_photo_missing');
    }
    if (reasons.size === 0) continue;
    cases.push(makeCase(['evidence', delivery.id, appointment.id], { ...base,
      origin: { ...origin, appointmentId: appointment.id, resultId: results.length === 1 ? results[0]?.id ?? null : null }, target: { ...target, tab: 'history' }, kind: 'evidence',
      title: 'Review completion evidence', description: 'Review the effective report and its signatures or photos in History. A queue note does not approve missing evidence.',
      reasons: [...reasons].sort(), facts: results.flatMap((result) => [{ label: 'report_summary', value: result.summary },
        { label: 'customer_signature', value: result.customerSignature?.status ?? 'missing' }, { label: 'crew_signature', value: result.crewSignature?.status ?? 'missing' }]).slice(0, 90),
    }, { reports: results.map(({ id, customerSignature, crewSignature, evidence }) => ({ id,
      customerSignature: customerSignature?.status ?? null, crewSignature: crewSignature?.status ?? null, evidence })), references }));
  }
  return cases;
}

export function cargoDispatcherCases(route: { id: string; name: string }, lines: readonly RouteLineStatus[],
  deliveries: ReadonlyMap<string, Delivery>, owners: ReadonlyMap<string, Owner>): DispatcherFacts[] {
  return lines.flatMap((line) => (['collection', 'undelivered'] as const).flatMap((kind): DispatcherFacts[] => {
    const expected = kind === 'collection' ? line.collectedMilli : Math.max(0, line.plannedDeliveryMilli - line.deliveredMilli);
    const received = kind === 'collection' ? line.warehouseReceivedCollectionMilli : line.warehouseReceivedUndeliveredMilli;
    const declaration = line.declaration?.cargo.find((entry) => entry.kind === kind);
    const needed = expected > 0 || received > 0 || kind === 'collection' && line.reportMissing && line.plannedCollectionMilli > 0;
    if (!needed) return [];
    const balance = cargoReceiptBalance(line, kind);
    const mismatch = received > expected || declaration?.quantityMilli !== undefined && declaration.quantityMilli !== null && declaration.quantityMilli !== expected;
    const unknown = !declaration || declaration.quantityMilli === null || declaration.location === 'unknown';
    if (balance === 0 && !mismatch && !unknown) return [];
    // Complete verified collection receipts resolve custody even if a previous declaration still says vehicle.
    if (kind === 'collection' && received === expected && !line.reportMissing && !mismatch) return [];
    const delivery = deliveries.get(line.deliveryId);
    const sourceOwner = line.declaration ? owners.get(line.declaration.ownerUserId) ?? null : null;
    const sourceAction = line.declaration?.nextActions.map(({ operation, action }) => `${operation}: ${action}`).join('; ') || null;
    const reasons = [...(balance > 0 ? [kind === 'collection' ? 'collection_receipt_required' : 'undelivered_receipt_required'] : []),
      ...(unknown && balance === 0 ? ['cargo_unknown'] : []), ...(mismatch ? ['cargo_quantity_unresolved'] : [])];
    return [makeCase(['cargo', route.id, line.appointmentId, line.sourceLineId, kind], { kind: 'cargo',
      origin: { ...noOrigin, deliveryId: line.deliveryId, routeId: route.id, appointmentId: line.appointmentId, sourceLineId: line.sourceLineId, cargoKind: kind },
      title: balance > 0 ? 'Record warehouse receipt' : 'Review returned cargo',
      description: balance > 0 ? 'Verified cargo remains to be received through the route warehouse workflow.' : 'Confirm the cargo quantity and custody in the route reconciliation.',
      pickingName: delivery?.source.pickingName ?? null, customerName: delivery?.source.customer.name ?? null,
      orderName: line.orderName, productName: line.productName, quantityMilli: balance > 0 ? balance : null, uom: line.uom,
      reasons, sourceOwner, sourceAction, facts: [{ label: 'route', value: route.name }, { label: 'cargo_location', value: declaration?.location ?? 'unknown' },
        { label: 'expected_quantity', value: String(expected / 1000) }, { label: 'received_quantity', value: String(received / 1000) },
        ...(declaration ? [{ label: 'cargo_note', value: declaration.note }] : [])],
      target: { section: 'routes', deliveryId: line.deliveryId, routeId: route.id, tab: null },
    }, { expected, received, declaration, reportMissing: line.reportMissing, sourceOwner, sourceAction })];
  }));
}
