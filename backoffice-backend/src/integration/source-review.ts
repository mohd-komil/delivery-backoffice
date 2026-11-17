import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EntityManager } from 'typeorm';
import { rows } from '../database/database';
import { IdSchema, InstantSchema, SourceSchema, TextSchema, type Delivery, type OperatorActor, type SourceCandidate, type SourceSnapshot } from '../domain/model';
import { acceptSourceSnapshot, acknowledgeSourceReview, requiredWorkSourceConflicts, revisionCoverage, sourceChanges, sourceHash, sourceRevisionRegresses } from '../domain/source-import';
import { DomainError, effectiveResults, lineServiceStatuses, priorWorkReviewReasons } from '../domain/rules';
import { DeliveryStore } from '../operations/store';
import { destinationAddressKey } from '../domain/destination-address';

const CoverageSchema = z.enum(['complete', 'partial', 'unavailable']);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const BlockerSchema = z.object({ code: z.string(), message: z.string(), sourceLineId: z.number().int().positive().nullable(),
  appointmentId: IdSchema.nullable(), routeId: IdSchema.nullable() }).strict();
type Blocker = z.infer<typeof BlockerSchema>;
export const SourceReviewInputSchema = z.object({ version: z.number().int().positive(), requestId: IdSchema,
  candidateId: IdSchema, candidateHash: HashSchema, action: z.enum(['accept', 'keep_accepted']), reason: TextSchema }).strict();
export const SourceReviewSchema = z.object({
  deliveryVersion: z.number().int().positive(), status: z.enum(['current', 'needs_reconciliation']),
  revisionCoverage: CoverageSchema, documentCoverage: z.literal('not_mapped'), acceptedHash: HashSchema,
  candidate: z.object({ id: IdSchema, hash: HashSchema, firstSeenAt: InstantSchema, source: SourceSchema.nullable(), qualifies: z.boolean(),
    readComplete: z.boolean(), revisionCoverage: CoverageSchema, reasons: z.array(z.string()),
    changes: z.array(z.object({ kind: z.string(), sourceLineId: z.number().int().positive().nullable(), before: z.string().nullable(), after: z.string().nullable() }).strict()),
  }).strict().nullable(),
  canAccept: z.boolean(), canKeepAccepted: z.boolean(), blockers: z.array(BlockerSchema),
}).strict();

@Injectable()
export class SourceReview {
  constructor(@Inject(DeliveryStore) private readonly store: DeliveryStore) {}

  async get(id: string) {
    return this.store.db.source.transaction('REPEATABLE READ', async (manager) => this.describe(await this.store.get(id, manager), manager));
  }

  async decide(id: string, input: unknown, actor: OperatorActor) {
    const command = SourceReviewInputSchema.parse(input);
    let decision: Record<string, unknown> = {};
    await this.store.mutate(id, command.version, actor, { name: command.action === 'accept' ? 'source.candidate_accepted' : 'source.candidate_kept', details: () => decision },
      async (delivery, manager) => {
        const state = delivery.sourceImport;
        const candidate = state?.pending;
        if (!state || !candidate || candidate.id !== command.candidateId || candidate.hash !== command.candidateHash) {
          throw new DomainError('SOURCE_CANDIDATE_CHANGED', 'The source update changed. Reload its differences before deciding.');
        }
        const review = await this.describe(delivery, manager);
        if (command.action === 'accept' ? !review.canAccept : !review.canKeepAccepted) {
          throw new DomainError('SOURCE_RECONCILIATION_BLOCKED', 'Resolve the source review blockers before this decision', 409, review.blockers.map(({ message }) => message));
        }
        decision = { reason: command.reason, candidateId: candidate.id, candidateHash: candidate.hash,
          revisionCoverage: revisionCoverage(candidate.evidence), sourceEvidence: candidate.evidence,
          previousSource: delivery.source, proposedSource: candidate.source, previousServices: delivery.servicePlan ?? null,
          previousDestination: { customerId: delivery.source.customer.id, addressKey: destinationAddressKey(delivery.source.customer) },
          changes: sourceChanges(delivery.source, candidate.source) };
        if (command.action === 'accept') {
          if (!candidate.source) throw new DomainError('SOURCE_UNAVAILABLE', 'The proposed source is unavailable');
          acceptSourceSnapshot(delivery, candidate.source);
          decision['retainedServices'] = delivery.servicePlan ?? null;
          state.acceptedHash = sourceHash(candidate.source); state.acceptedEvidence = candidate.evidence;
          state.acceptedEligible = true;
          state.keptHash = null; state.keptEvidence = null;
        } else {
          state.keptHash = candidate.hash; state.keptEvidence = candidate.evidence;
        }
        state.pending = null;
        state.eligible = candidate.qualifies && candidate.source !== null;
        acknowledgeSourceReview(delivery);
        return delivery;
      }, { id: command.requestId, input: { ...command, actorId: actor.id } });
    return this.store.detail(id);
  }

  private async blockers(delivery: Delivery, candidate: SourceCandidate, manager: EntityManager): Promise<Blocker[]> {
    const found: Blocker[] = [];
    const add = (code: string, message: string, sourceLineId: number | null = null, appointmentId: string | null = null, routeId: string | null = null) => {
      found.push({ code, message, sourceLineId, appointmentId, routeId });
    };
    if (!candidate.source) add('SOURCE_UNAVAILABLE', 'The source record is missing or invalid; retry a complete import.');
    if (!candidate.qualifies) add('SOURCE_INELIGIBLE', 'The source does not satisfy the approved picking filters.');
    if (!candidate.evidence.readComplete) add('SOURCE_INCOMPLETE', 'The source read was incomplete. Retry it before accepting changes.');
    if (delivery.sourceImport && sourceRevisionRegresses(delivery.sourceImport.acceptedEvidence, candidate.evidence)) {
      add('SOURCE_REVISION_REGRESSION', 'Some source rows are older than the accepted revision; obtain a consistent current snapshot.');
    }
    if (delivery.completedAt !== null) add('DELIVERY_CLOSED', 'Reopen this delivery with a reason before accepting a different source.');
    for (const visit of delivery.appointments.filter(({ status }) => status === 'in_progress')) {
      add('VISIT_IN_PROGRESS', 'Finish the started visit against its accepted plan before changing the source.', null, visit.id);
    }
    const routes = await rows(manager, z.object({ id: IdSchema, appointmentId: IdSchema }), `SELECT p.id,s.appointment_id AS "appointmentId"
      FROM route_stop s JOIN route_publication p ON p.id=s.route_id
      WHERE s.delivery_id=$1 AND s.active AND p.status IN ('published','in_progress','returning') ORDER BY p.id,s.id`, [delivery.id]);
    for (const route of routes) add('ROUTE_CHANGE_REQUIRED', 'Cancel and replan an unstarted route, or record its actual return before accepting this source.', null, route.appointmentId, route.id);
    if (!candidate.source) return found;
    for (const sourceLineId of requiredWorkSourceConflicts(delivery, candidate.source)) {
      add('REQUIRED_WORK_SOURCE_CONFLICT',
        'The proposed source changes a product, order or unit with customized required quantities, or reduces its quantity below them. Review the required quantities first.', sourceLineId);
    }
    const projected = structuredClone(delivery);
    acceptSourceSnapshot(projected, candidate.source);
    for (const sourceLineId of priorWorkReviewReasons(projected)) {
      add('PRIOR_WORK_CONFLICT', 'The source would invalidate confirmed prior work. Keep the accepted scope or resolve the source identity first.', sourceLineId);
    }
    const proposed = candidate.source;
    const checkIdentity = (source: SourceSnapshot, ids: ReadonlySet<number>, appointmentId: string | null) => {
      for (const sourceLineId of ids) {
        const before = source.items.find((item) => item.sourceLineId === sourceLineId);
        const after = proposed.items.find((item) => item.sourceLineId === sourceLineId);
        if (!before || !after || before.productId !== after.productId || before.uom !== after.uom || (before.uomId ?? null) !== (after.uomId ?? null)
          || (before.saleOrderId ?? source.saleOrderId) !== (after.saleOrderId ?? proposed.saleOrderId)
          || (before.saleOrderLineId ?? null) !== (after.saleOrderLineId ?? null)) {
          add('RECORDED_WORK_IDENTITY_CONFLICT', 'The proposed source changes the exact product/order/unit referenced by reports or unresolved work.', sourceLineId, appointmentId);
        }
      }
    };
    for (const result of effectiveResults(delivery)) {
      const ids = new Set([
        ...result.quantities.map(({ sourceLineId }) => sourceLineId), ...(result.itemChecks ?? []).map(({ sourceLineId }) => sourceLineId),
        ...(result.incompleteWork ?? []).map(({ sourceLineId }) => sourceLineId), ...result.evidence.flatMap(({ itemIds }) => itemIds),
        ...(result.documentSnapshot ?? []).flatMap(({ itemId }) => itemId === null ? [] : [itemId]),
        ...(result.workScopeSnapshot?.lines ?? []).map(({ sourceLineId }) => sourceLineId),
      ]);
      checkIdentity(result.sourceSnapshot, ids, result.appointmentId);
    }
    checkIdentity(delivery.source, new Set([...delivery.issues.filter(({ status }) => status === 'open').flatMap(({ itemIds }) => itemIds),
      ...(delivery.workHolds ?? []).filter(({ release }) => release === undefined).map(({ sourceLineId }) => sourceLineId)]), null);
    for (const line of lineServiceStatuses(projected)) {
      if (line.deliveredMilli > line.totalDeliveryMilli || line.installedMilli > line.totalInstallationMilli || line.collectedMilli > line.totalCollectionMilli) {
        add('SOURCE_BELOW_RECORDED_WORK', 'Source demand is lower than confirmed prior work and Crew results.', line.sourceLineId);
      }
    }
    return found;
  }

  private async describe(delivery: Delivery, manager: EntityManager) {
    const state = delivery.sourceImport;
    const candidate = state?.pending ?? null;
    const blockers = candidate ? await this.blockers(delivery, candidate, manager) : [];
    return SourceReviewSchema.parse({ deliveryVersion: delivery.version, status: candidate ? 'needs_reconciliation' : 'current',
      revisionCoverage: state ? revisionCoverage(state.acceptedEvidence) : 'unavailable', documentCoverage: 'not_mapped',
      acceptedHash: state?.acceptedHash ?? sourceHash(delivery.source),
      candidate: candidate ? { id: candidate.id, hash: candidate.hash, firstSeenAt: candidate.firstSeenAt,
        source: candidate.source, qualifies: candidate.qualifies, readComplete: candidate.evidence.readComplete,
        revisionCoverage: revisionCoverage(candidate.evidence), reasons: candidate.reasons, changes: sourceChanges(delivery.source, candidate.source) } : null,
      canAccept: candidate !== null && blockers.length === 0,
      canKeepAccepted: state?.acceptedEligible === true && candidate !== null && candidate.source !== null && candidate.qualifies && candidate.evidence.readComplete,
      blockers });
  }
}
