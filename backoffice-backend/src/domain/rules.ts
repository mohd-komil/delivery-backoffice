import { createHash, randomUUID } from 'node:crypto';
import {
  CustomerConfirmationSchema, DeliverySchema, ExecutionInputSchema, FailedAttemptSchema, IdSchema, InstantSchema, IssueInputSchema, mappedSourceService, PriorWorkRevisionSchema, PriorWorkStatusSchema, RequiredWorkInputSchema, ReturnInputSchema, SignatureRefusalReviewDecisionSchema, SignatureRefusalReviewSchema, SignatureRefusalSchema, TextSchema, VisitWorkScopeSchema, WorkLinesInputSchema,
  type Appointment, type CrewActor, type CrewDrawingInput, type CustomerDrawingInput, type Delivery, type DeliveryView,
  type ExecutionInput, type Issue, type IssueInput, type LineWorkTime, type OperatorActor, type RemainingWorkEstimate, type RequiredWorkInput, type ReturnInput, type ServiceType, type SignatureRefusalReviewDecision, type SkillSnapshot, type SourceItem, type Task, type TaskTemplate, type VisitResult, type WorkLineInput, type WorkTimeRates,
} from './model';
import { sameSignatureDrawing } from './signature-strokes';
import { destinationAddressKey, destinationAreaIdentity } from './destination-address';
import { latestPriorWork, priorWorkMatches, validPriorWork, type PriorWorkScope } from './prior-work';
import { sourcePlanningBlocked } from './source-import';

/** Commands return a new aggregate. The caller persists it and its audit in one transaction. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 403 | 404 | 409 = 409,
    public readonly details: string[] = [],
  ) { super(message); this.name = 'DomainError'; }
}

export function quantityToMilli(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000 ||
    Math.abs(value * 1000 - Math.round(value * 1000)) >= 0.000001) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be nonnegative with at most three decimal places', 400);
  }
  return Math.round(value * 1000);
}

/** Offset-bearing instants avoid silently interpreting ambiguous Rome wall-clock input. Intervals are half-open. */
export function validateInterval(startsAt: string, endsAt: string): void {
  const start = InstantSchema.safeParse(startsAt);
  const end = InstantSchema.safeParse(endsAt);
  if (!start.success || !end.success || Date.parse(startsAt) >= Date.parse(endsAt)) {
    throw new DomainError('INVALID_INTERVAL', 'Use explicit UTC/offset timestamps and an end after the start', 400);
  }
}

export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  validateInterval(aStart, aEnd);
  validateInterval(bStart, bEnd);
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

type ResultVersion = Pick<VisitResult, 'id' | 'supersedesResultId'>;
type ResultQuantities = ResultVersion & Pick<VisitResult, 'quantities'>;
type VisitResultsScope<Result> = {
  appointments: readonly { results: readonly Result[]; signatureRefusalReview?: Appointment['signatureRefusalReview'] }[];
};

export function effectiveResults<Result extends ResultQuantities>(delivery: VisitResultsScope<Result>): (Omit<Result, 'quantities'> & Pick<VisitResult, 'quantities'>)[] {
  const results = delivery.appointments.flatMap(({ results, signatureRefusalReview }) => results.map((result) => {
    if (signatureRefusalReview?.decision !== 'corrected' || signatureRefusalReview.resultId !== result.id) return result;
    return { ...result, quantities: signatureRefusalReview.quantities };
  }));
  const superseded = new Set(results.flatMap((result) => result.supersedesResultId === null ? [] : [result.supersedesResultId]));
  return results.filter((result) => !superseded.has(result.id));
}

export function signatureRefusalStatus(appointment: Pick<Appointment, 'results' | 'signatureRefusalReview'>) {
  const report = appointment.results.find(({ signatureRefusal }) => signatureRefusal !== undefined);
  if (!report) return undefined;
  return appointment.signatureRefusalReview?.resultId === report.id ? appointment.signatureRefusalReview.decision : 'pending';
}

type LineWorkScope = Pick<Delivery, 'source' | 'servicePlan' | 'workHolds' | 'priorWorkRevisions' | 'sourceImport'> & {
  completedAt?: Delivery['completedAt'];
  sourceReview?: boolean;
  appointments: readonly { id?: string; status?: Appointment['status']; workScope?: Appointment['workScope']; results: readonly ResultQuantities[];
    signatureRefusalReview?: Appointment['signatureRefusalReview'] }[];
};
type WorkAmounts = { deliveredMilli: number; installedMilli: number; collectedMilli: number };
const emptyWork: WorkAmounts = { deliveredMilli: 0, installedMilli: 0, collectedMilli: 0 };
function sourceService(delivery: LineWorkScope): ServiceType | null {
  // A newly supported source code must not reinterpret older recorded work without an operator's decision.
  if (delivery.appointments.some((appointment) => appointment.results.length > 0)) return null;
  return mappedSourceService(delivery.source.serviceType);
}

/** Only material source identity, quantities and destination invalidate an agreed visit plan. */
export function workSourceFingerprint(delivery: Pick<Delivery, 'source'>): string {
  const { source } = delivery;
  return createHash('sha256').update(JSON.stringify({
    pickingId: source.pickingId,
    destination: [source.customer.id, source.customer.address, source.customer.city, source.customer.country, ...destinationAreaIdentity(source.customer)],
    orders: (source.salesOrders ?? [{ id: source.saleOrderId }]).map(({ id }) => id).sort((a, b) => a - b),
    items: [...source.items].sort((a, b) => a.sourceLineId - b.sourceLineId)
      .map((item) => [item.sourceLineId, item.saleOrderId ?? source.saleOrderId, item.productId, item.quantity, item.uom,
        ...(item.uomId === undefined ? [] : [item.uomId])]),
  })).digest('hex');
}

function activeWork(appointment: { status?: Appointment['status'] }) {
  return appointment.status === 'booked' || appointment.status === 'in_progress';
}

function reservedCustomerStock(delivery: LineWorkScope, sourceLineId: number, excludeAppointmentId?: string) {
  return delivery.appointments.filter((appointment) => appointment.status === 'in_progress' && appointment.id !== excludeAppointmentId)
    .reduce((sum, appointment) => {
      const line = appointment.workScope?.lines.find((line) => line.sourceLineId === sourceLineId);
      return sum + (line?.service === 'delivery_installation' ? Math.max(0, line.installationMilli - line.deliveryMilli) : 0);
    }, 0);
}

function workAmounts(results: readonly ResultQuantities[], delivery?: PriorWorkScope) {
  const totals = new Map<number, WorkAmounts>();
  for (const revision of delivery === undefined ? [] : validPriorWork(delivery)) {
    totals.set(revision.sourceLineId, { deliveredMilli: revision.deliveredMilli,
      installedMilli: revision.installedMilli, collectedMilli: revision.collectedMilli });
  }
  for (const result of results) {
    for (const quantity of result.quantities) {
      const previous = totals.get(quantity.sourceLineId) ?? emptyWork;
      totals.set(quantity.sourceLineId, {
        deliveredMilli: previous.deliveredMilli + quantity.deliveredMilli,
        installedMilli: previous.installedMilli + (quantity.installedMilli ?? 0),
        collectedMilli: previous.collectedMilli + (quantity.collectedMilli ?? 0),
      });
    }
  }
  return totals;
}

export function deliveredMilli(delivery: VisitResultsScope<ResultQuantities> & PriorWorkScope, sourceLineId: number): number {
  return workAmounts(effectiveResults(delivery), delivery).get(sourceLineId)?.deliveredMilli ?? 0;
}

export function requiredWork(service: ServiceType | null, quantity: number): WorkAmounts {
  return {
    deliveredMilli: service === 'delivery_only' || service === 'delivery_installation' ? quantity : 0,
    installedMilli: service === 'installation_only' || service === 'delivery_installation' ? quantity : 0,
    collectedMilli: service === 'collection_only' ? quantity : 0,
  };
}

function hasWorkAmounts(amounts: WorkAmounts) {
  return amounts.deliveredMilli > 0 || amounts.installedMilli > 0 || amounts.collectedMilli > 0;
}

function workAmountsFromOperations(quantities: NonNullable<RequiredWorkInput['quantities']>): WorkAmounts {
  return { deliveredMilli: quantities.deliveryMilli, installedMilli: quantities.installationMilli, collectedMilli: quantities.collectionMilli };
}

function lineWork(delivery: LineWorkScope) {
  const totals = workAmounts(effectiveResults(delivery), delivery);
  const recorded = workAmounts(delivery.appointments.flatMap((appointment) => appointment.results));
  const overrides = new Map(delivery.servicePlan?.overrides.map((entry) => [entry.sourceLineId, entry]));
  const requiredQuantities = new Map(delivery.servicePlan?.requiredQuantities?.map((entry) => [entry.sourceLineId, entry.quantities]));
  const prior = latestPriorWork(delivery);
  return delivery.source.items.map((item) => {
    const override = overrides.get(item.sourceLineId);
    const service = override?.service ?? (delivery.servicePlan ? delivery.servicePlan.defaultService : sourceService(delivery));
    const serviceOrigin = service === null ? 'unknown' as const : override ? override.origin ?? 'unknown' as const
      : delivery.servicePlan ? delivery.servicePlan.defaultOrigin ?? 'unknown' as const : 'source' as const;
    const quantities = requiredQuantities.get(item.sourceLineId);
    const defaultWork = requiredWork(service, quantityToMilli(item.quantity));
    return {
      item, service, serviceOrigin, inherited: override === undefined, customized: quantities !== undefined, defaultWork,
      locked: hasWorkAmounts(prior.get(item.sourceLineId) ?? emptyWork) || hasWorkAmounts(recorded.get(item.sourceLineId) ?? emptyWork) || delivery.appointments.some((appointment) =>
        activeWork(appointment) && appointment.workScope?.lines.some((line) => line.sourceLineId === item.sourceLineId)),
      actual: totals.get(item.sourceLineId) ?? emptyWork,
      expected: quantities === undefined ? defaultWork : workAmountsFromOperations(quantities),
    };
  });
}

/** Opening balances remain visible but cannot silently follow a replaced physical source line. */
export function priorWorkReviewReasons(delivery: LineWorkScope): number[] {
  const lines = new Map(lineWork(delivery).map((line) => [line.item.sourceLineId, line]));
  return [...latestPriorWork(delivery).values()].filter((revision) => {
    const line = lines.get(revision.sourceLineId);
    return !line || !priorWorkMatches(delivery, revision, line.item) || line.service !== revision.service
      || line.actual.deliveredMilli > line.expected.deliveredMilli || line.actual.installedMilli > line.expected.installedMilli
      || line.actual.collectedMilli > line.expected.collectedMilli;
  }).map(({ sourceLineId }) => sourceLineId);
}

function priorWorkEditBlocker(delivery: Delivery, sourceLineId: number, service: ServiceType | null | undefined) {
  if (delivery.completedAt !== null) return 'delivery_closed' as const;
  if (delivery.sourceReview || sourcePlanningBlocked(delivery)) return 'source_review' as const;
  if (!delivery.source.items.some((item) => item.sourceLineId === sourceLineId)) return 'line_removed' as const;
  if (!service) return 'unknown_service' as const;
  if (delivery.appointments.some((appointment) => appointment.results.some((result) =>
    result.quantities.some((line) => line.sourceLineId === sourceLineId)
      || result.workScopeSnapshot?.lines.some((line) => line.sourceLineId === sourceLineId)))) return 'recorded_work' as const;
  if (delivery.appointments.some((appointment) => activeWork(appointment)
    && (!appointment.workScope || appointment.workScope.lines.some((line) => line.sourceLineId === sourceLineId)))) return 'planned_work' as const;
  return null;
}

export function priorWorkStatus(delivery: Delivery) {
  const latest = latestPriorWork(delivery);
  const lines = new Map(lineWork(delivery).map((line) => [line.item.sourceLineId, line]));
  const review = new Set(priorWorkReviewReasons(delivery));
  const crew = workAmounts(effectiveResults(delivery));
  const lineIds = new Set([...lines.keys(), ...latest.keys()]);
  return PriorWorkStatusSchema.parse({ reviewRequired: review.size > 0, lines: [...lineIds].map((sourceLineId) => {
    const current = latest.get(sourceLineId) ?? null;
    const actual = crew.get(sourceLineId) ?? emptyWork;
    const blockedReason = priorWorkEditBlocker(delivery, sourceLineId, lines.get(sourceLineId)?.service);
    return { sourceLineId, status: review.has(sourceLineId) ? 'needs_review' : current ? 'confirmed' : 'unknown',
      canEdit: blockedReason === null, blockedReason, current,
      priorDeliveredMilli: current?.deliveredMilli ?? 0, priorInstalledMilli: current?.installedMilli ?? 0, priorCollectedMilli: current?.collectedMilli ?? 0,
      crewDeliveredMilli: actual.deliveredMilli, crewInstalledMilli: actual.installedMilli, crewCollectedMilli: actual.collectedMilli };
  }) });
}

export function confirmPriorWork(delivery: Delivery, input: {
  requestId: string; sourceLineId: number; deliveredMilli: number; installedMilli: number; collectedMilli: number;
  sourceReference: string; reason: string; acknowledgeCurrentPicking: true;
}, actor: OperatorActor, at: string): Delivery {
  const line = lineWork(delivery).find(({ item }) => item.sourceLineId === input.sourceLineId);
  if (!line) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Product line not found', 404);
  const blocker = priorWorkEditBlocker(delivery, input.sourceLineId, line.service);
  if (blocker) throw new DomainError('PRIOR_WORK_LOCKED', 'Prior work must be confirmed before planning or recording this product line', 409, [blocker]);
  if (line.service === null) throw new DomainError('SERVICE_REQUIRED', 'Select the service before confirming prior work');
  if (input.deliveredMilli > line.expected.deliveredMilli || input.installedMilli > line.expected.installedMilli || input.collectedMilli > line.expected.collectedMilli) {
    throw new DomainError('EXCESS_PRIOR_WORK', 'Prior work cannot exceed the current picking line and its selected operations');
  }
  if (line.service === 'delivery_installation' && input.installedMilli > input.deliveredMilli) {
    throw new DomainError('INSTALLATION_REQUIRES_DELIVERY', 'Prior installed quantity cannot exceed prior delivered quantity');
  }
  const previous = latestPriorWork(delivery).get(input.sourceLineId);
  const saleOrderId = line.item.saleOrderId ?? delivery.source.saleOrderId;
  const { requestId, ...confirmed } = input;
  const revision = PriorWorkRevisionSchema.parse({ ...confirmed, id: requestId,
    revision: (previous?.revision ?? 0) + 1, pickingId: delivery.source.pickingId, pickingName: delivery.source.pickingName,
    saleOrderId, saleOrderName: delivery.source.salesOrders?.find(({ id }) => id === saleOrderId)?.name ?? delivery.source.saleOrderName,
    sourceItem: structuredClone(line.item), service: line.service, confirmedAt: at, confirmedBy: { id: actor.id, name: actor.name } });
  const servicePlan = delivery.servicePlan ?? { defaultService: line.service, defaultOrigin: 'local' as const, overrides: [] };
  return DeliverySchema.parse({ ...delivery, servicePlan, priorWorkRevisions: [...(delivery.priorWorkRevisions ?? []), revision] });
}

export function lineServiceStatuses(delivery: LineWorkScope, excludeAppointmentId?: string) {
  const priorReview = priorWorkReviewReasons(delivery).length > 0;
  const active = delivery.appointments.filter((appointment) => activeWork(appointment) && appointment.id !== excludeAppointmentId);
  const reserved = new Map<number, WorkAmounts>();
  for (const appointment of active) {
    for (const line of appointment.workScope?.lines ?? []) {
      const previous = reserved.get(line.sourceLineId) ?? emptyWork;
      reserved.set(line.sourceLineId, { deliveredMilli: previous.deliveredMilli + line.deliveryMilli,
        installedMilli: previous.installedMilli + line.installationMilli, collectedMilli: previous.collectedMilli + line.collectionMilli });
    }
  }
  const legacy = active.some((appointment) => !appointment.workScope);
  const fingerprint = workSourceFingerprint(delivery);
  const stale = active.some((appointment) => appointment.workScope && appointment.workScope.sourceFingerprint !== fingerprint);
  return lineWork(delivery).map(({ item, service, serviceOrigin, inherited, locked, customized, actual, expected }) => {
    const booked = reserved.get(item.sourceLineId) ?? emptyWork;
    const remainingDeliveryMilli = Math.max(0, expected.deliveredMilli - actual.deliveredMilli);
    const remainingInstallationMilli = Math.max(0, expected.installedMilli - actual.installedMilli);
    const remainingCollectionMilli = Math.max(0, expected.collectedMilli - actual.collectedMilli);
    const overReserved = booked.deliveredMilli > remainingDeliveryMilli || booked.installedMilli > remainingInstallationMilli || booked.collectedMilli > remainingCollectionMilli;
    const held = delivery.workHolds?.some((hold) => hold.sourceLineId === item.sourceLineId && hold.release === undefined) ?? false;
    const planningBlockedReason = delivery.sourceReview || sourcePlanningBlocked(delivery) ? 'source_review' as const : priorReview ? 'prior_work_review' as const : service === null ? 'unknown_service' as const
      : held ? 'damage_hold' as const : legacy ? 'legacy_scope_review' as const : stale ? 'scope_outdated' as const : overReserved ? 'over_reserved' as const : null;
    return {
      sourceLineId: item.sourceLineId, service, serviceOrigin, inherited, locked, ...actual,
      requiredQuantitiesCustomized: customized,
      canEditRequiredQuantities: delivery.completedAt == null && !legacy && service !== null && item.quantity > 0,
      remainingDeliveryMilli, remainingInstallationMilli, remainingCollectionMilli,
      totalDeliveryMilli: expected.deliveredMilli, totalInstallationMilli: expected.installedMilli, totalCollectionMilli: expected.collectedMilli,
      reservedDeliveryMilli: booked.deliveredMilli, reservedInstallationMilli: booked.installedMilli, reservedCollectionMilli: booked.collectedMilli,
      availableDeliveryMilli: Math.max(0, remainingDeliveryMilli - booked.deliveredMilli),
      availableInstallationMilli: Math.max(0, remainingInstallationMilli - booked.installedMilli),
      availableCollectionMilli: Math.max(0, remainingCollectionMilli - booked.collectedMilli),
      planningBlockedReason,
    };
  });
}

/** Whole-delivery work must not hide lines whose required operations are still unknown. */
export function remainingWorkEstimate(delivery: Delivery): RemainingWorkEstimate {
  const lines = lineServiceStatuses(delivery);
  if (lines.some(({ service }) => service === null)) return { minutes: null, basis: 'unknown', sourceMinutes: delivery.source.estimatedMinutes };
  return estimateWorkMinutes(delivery, lines.map((line) => ({ sourceLineId: line.sourceLineId,
    deliveryMilli: line.remainingDeliveryMilli, installationMilli: line.remainingInstallationMilli, collectionMilli: line.remainingCollectionMilli })));
}

export function estimateWorkMinutes(delivery: Delivery, work: readonly Pick<WorkLineInput, 'sourceLineId' | 'deliveryMilli' | 'installationMilli' | 'collectionMilli'>[]): RemainingWorkEstimate {
  return estimateSelectedWork(delivery, work, lineWork(delivery));
}

const workOperations = [
  { name: 'delivery', quantity: 'deliveryMilli', rate: 'deliveryMinutesPerUnit', expected: 'deliveredMilli', remaining: 'remainingDeliveryMilli' },
  { name: 'installation', quantity: 'installationMilli', rate: 'installationMinutesPerUnit', expected: 'installedMilli', remaining: 'remainingInstallationMilli' },
  { name: 'collection', quantity: 'collectionMilli', rate: 'collectionMinutesPerUnit', expected: 'collectedMilli', remaining: 'remainingCollectionMilli' },
] as const;
const emptyRates: WorkTimeRates = { deliveryMinutesPerUnit: null, installationMinutesPerUnit: null, collectionMinutesPerUnit: null };

function workTimeContext(delivery: Delivery, item: SourceItem): LineWorkTime['context'] {
  return { productId: item.productId, saleOrderId: item.saleOrderId ?? delivery.source.saleOrderId,
    uom: item.uom, uomId: item.uomId ?? null, addressKey: destinationAddressKey(delivery.source.customer) };
}

function staleWorkTime(delivery: Delivery, item: SourceItem, entry: LineWorkTime | undefined): boolean {
  if (!entry) return false;
  const current = workTimeContext(delivery, item);
  return entry.context.productId !== current.productId || entry.context.saleOrderId !== current.saleOrderId
    || entry.context.uom !== current.uom || entry.context.uomId !== current.uomId || entry.context.addressKey !== current.addressKey;
}

function sourceTimeBasis(delivery: Delivery, lines: ReturnType<typeof lineWork>) {
  // The imported total describes full-line work. Apply its rate to the smaller selected volume.
  const total = lines.reduce((sum, { defaultWork }) => sum + defaultWork.deliveredMilli + defaultWork.installedMilli + defaultWork.collectedMilli, 0);
  const units = new Set(lines.filter(({ defaultWork }) => hasWorkAmounts(defaultWork)).map(({ item }) => `${item.uomId ?? ''}:${item.uom.trim().toLowerCase()}`));
  const available = !delivery.sourceReview && lines.every(({ service }) => service !== null) && total > 0 && units.size === 1 && delivery.source.estimatedMinutes !== null;
  return { total, available };
}

function estimateSelectedWork(delivery: Delivery, work: readonly Pick<WorkLineInput, 'sourceLineId' | 'deliveryMilli' | 'installationMilli' | 'collectionMilli'>[],
  lines: ReturnType<typeof lineWork>): RemainingWorkEstimate {
  const sourceMinutes = delivery.source.estimatedMinutes;
  if (delivery.sourceReview || lines.length === 0) return { minutes: null, basis: 'unknown', sourceMinutes };
  const selected = work.filter((entry) => entry.deliveryMilli + entry.installationMilli + entry.collectionMilli > 0);
  if (!selected.length) return lines.some(({ service }) => service === null)
    ? { minutes: null, basis: 'unknown', sourceMinutes } : { minutes: 0, basis: 'no_remaining_work', sourceMinutes };
  const source = sourceTimeBasis(delivery, lines);
  const byId = new Map(lines.map((line) => [line.item.sourceLineId, line]));
  const local = new Map(delivery.servicePlan?.timeEstimates?.map((entry) => [entry.sourceLineId, entry]));
  let localNumerator = 0n;
  let sourceNumerator = 0n;
  let usedLocal = false; let usedSource = false;
  const missing = new Set<number>(); const stale = new Set<number>();
  for (const entry of selected) {
    const line = byId.get(entry.sourceLineId);
    if (!line || line.service === null) { missing.add(entry.sourceLineId); continue; }
    const rates = local.get(entry.sourceLineId);
    if (staleWorkTime(delivery, line.item, rates)) { stale.add(entry.sourceLineId); continue; }
    for (const operation of workOperations) {
      const quantity = entry[operation.quantity];
      if (quantity <= 0) continue;
      if (line.expected[operation.expected] === 0) { missing.add(entry.sourceLineId); continue; }
      const rate = rates?.[operation.rate];
      if (rate !== null && rate !== undefined) { localNumerator += BigInt(rate) * BigInt(quantity); usedLocal = true; }
      else if (source.available && sourceMinutes !== null) { sourceNumerator += BigInt(sourceMinutes) * BigInt(quantity); usedSource = true; }
      else missing.add(entry.sourceLineId);
    }
  }
  if (missing.size || stale.size) return { minutes: null, basis: 'unknown', sourceMinutes,
    ...(missing.size ? { missingSourceLineIds: [...missing] } : {}), ...(stale.size ? { staleSourceLineIds: [...stale] } : {}) };
  const sourceDenominator = BigInt(source.total || 1);
  const denominator = 1000n * sourceDenominator;
  const numerator = localNumerator * sourceDenominator + sourceNumerator * 1000n;
  const minutes = Number((numerator + denominator - 1n) / denominator);
  if (minutes > 10080) return { minutes: null, basis: 'unknown', sourceMinutes, exceedsLimit: true };
  return { minutes, basis: usedLocal ? usedSource ? 'mixed_operation_rates' : 'local_operation_rates' : 'proportional_remaining_operations', sourceMinutes };
}

function workTimeEditable(delivery: Delivery, sourceLineId: number): boolean {
  return delivery.completedAt === null && !delivery.sourceReview && !delivery.appointments.some((appointment) =>
    appointment.status === 'in_progress' && (!appointment.workScope || appointment.workScope.lines.some((line) => line.sourceLineId === sourceLineId)));
}

export function lineWorkTimes(delivery: Delivery) {
  const lines = lineWork(delivery);
  const source = sourceTimeBasis(delivery, lines);
  const local = new Map(delivery.servicePlan?.timeEstimates?.map((entry) => [entry.sourceLineId, entry]));
  const byId = new Map(lines.map((line) => [line.item.sourceLineId, line]));
  return lineServiceStatuses(delivery).map((status) => {
    const line = byId.get(status.sourceLineId);
    if (!line) throw new Error('Source work line is unavailable');
    const entry = local.get(status.sourceLineId);
    const stale = staleWorkTime(delivery, line.item, entry);
    const estimate = estimateSelectedWork(delivery, [{ sourceLineId: status.sourceLineId, deliveryMilli: status.remainingDeliveryMilli,
      installationMilli: status.remainingInstallationMilli, collectionMilli: status.remainingCollectionMilli }], lines);
    const rates = entry ?? emptyRates;
    return { sourceLineId: status.sourceLineId, deliveryMinutesPerUnit: rates.deliveryMinutesPerUnit,
      installationMinutesPerUnit: rates.installationMinutesPerUnit, collectionMinutesPerUnit: rates.collectionMinutesPerUnit,
      stale, missingOperations: workOperations.filter((operation) => status[operation.remaining] > 0
        && (stale || rates[operation.rate] === null && !source.available)).map(({ name }) => name),
      remainingMinutes: estimate.minutes,
      basis: estimate.basis === 'local_operation_rates' ? 'local' as const : estimate.basis === 'mixed_operation_rates' ? 'mixed' as const
        : estimate.basis === 'proportional_remaining_operations' ? 'source_total_proportion' as const : 'unknown' as const,
      localSavedAt: entry?.updatedAt ?? null, localSavedBy: entry?.updatedBy ?? null, canEdit: workTimeEditable(delivery, status.sourceLineId) };
  });
}

export function changeWorkTimes(delivery: Delivery, input: WorkTimeRates & { sourceLineId: number }, actor: OperatorActor, at: string): Delivery {
  assertOpen(delivery);
  if (delivery.sourceReview) throw new DomainError('SOURCE_REVIEW_REQUIRED', 'Review the source before changing work times');
  const line = lineWork(delivery).find(({ item }) => item.sourceLineId === input.sourceLineId);
  if (!line) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Product line not found', 404);
  if (!workTimeEditable(delivery, input.sourceLineId)) throw new DomainError('WORK_TIME_LOCKED', 'Work times cannot change while this product is being worked on');
  const clear = workOperations.every(({ rate }) => input[rate] === null);
  if (!clear && line.service === null) throw new DomainError('SERVICE_REQUIRED', 'Select the service before entering work times');
  if (workOperations.some(({ rate, expected }) => input[rate] !== null && line.defaultWork[expected] === 0)) {
    throw new DomainError('WORK_TIME_OPERATION_UNAVAILABLE', 'Enter work times only for operations required by this product service');
  }
  const plan = delivery.servicePlan ?? { defaultService: sourceService(delivery), defaultOrigin: 'source' as const, overrides: [] };
  const entries = (plan.timeEstimates ?? []).filter(({ sourceLineId }) => sourceLineId !== input.sourceLineId);
  if (!clear) entries.push({ ...input, context: workTimeContext(delivery, line.item), updatedAt: at, updatedBy: { id: actor.id, name: actor.name } });
  return { ...delivery, servicePlan: { ...plan, timeEstimates: entries } };
}

export function changeServicePlan(delivery: Delivery, change: { defaultService: ServiceType } | { sourceLineId: number; service: ServiceType | null }) {
  assertOpen(delivery);
  const plan = delivery.servicePlan ?? { defaultService: sourceService(delivery), defaultOrigin: 'source' as const, overrides: [] };
  const lines = lineWork(delivery);
  const overrides = new Map(plan.overrides.map((entry) => [entry.sourceLineId, entry]));
  let defaultService = plan.defaultService;
  if ('defaultService' in change) {
    defaultService = change.defaultService;
    if (defaultService !== plan.defaultService) {
      for (const { item, service, serviceOrigin, locked, inherited, customized } of lines) {
        if ((locked || customized) && inherited && service !== null) overrides.set(item.sourceLineId, { sourceLineId: item.sourceLineId, service,
          ...(serviceOrigin !== 'unknown' ? { origin: serviceOrigin } : {}) });
      }
    }
  } else {
    const line = lines.find(({ item }) => item.sourceLineId === change.sourceLineId);
    if (!line) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Product line not found', 404);
    if (line.locked && line.service !== null) throw new DomainError('LINE_WORK_RECORDED', 'This product already has recorded or planned work');
    if (line.customized && (change.service ?? defaultService) !== line.service) {
      throw new DomainError('RESET_REQUIRED_WORK_FIRST', 'Restore full quantities before changing the service for this product');
    }
    if (change.service === null) overrides.delete(change.sourceLineId);
    else overrides.set(change.sourceLineId, { sourceLineId: change.sourceLineId, service: change.service, origin: 'local' });
  }
  const next = { ...delivery, servicePlan: { ...plan, defaultService, ...('defaultService' in change ? { defaultOrigin: 'local' as const } : {}), overrides: [...overrides.values()] } };
  for (const { actual, expected, service } of lineWork(next)) {
    if (service === null) continue;
    if (actual.deliveredMilli > expected.deliveredMilli || actual.installedMilli > expected.installedMilli || actual.collectedMilli > expected.collectedMilli) {
      throw new DomainError('SERVICE_CONFLICTS_WITH_WORK', 'The selected service must preserve the work already recorded');
    }
  }
  return next;
}

export function changeRequiredWork(delivery: Delivery, change: RequiredWorkInput, actor: OperatorActor, at: string): Delivery {
  assertOpen(delivery);
  const input = RequiredWorkInputSchema.parse(change);
  const item = delivery.source.items.find(({ sourceLineId }) => sourceLineId === input.sourceLineId);
  const status = lineServiceStatuses(delivery).find(({ sourceLineId }) => sourceLineId === input.sourceLineId);
  if (!item || !status) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Product line not found', 404);
  if (!status.service) throw new DomainError('SERVICE_REQUIRED', 'Select the service before changing required quantities');
  if (delivery.appointments.some((visit) => activeWork(visit) && !visit.workScope)) {
    throw new DomainError('WORK_QUANTITIES_REVIEW_REQUIRED', 'Review older visit scopes before changing required quantities');
  }
  const defaults = requiredWork(status.service, quantityToMilli(item.quantity));
  const required = input.quantities === null ? defaults : workAmountsFromOperations(input.quantities);
  if (!hasWorkAmounts(required) || workOperations.some(({ expected }) => required[expected] > defaults[expected])) {
    throw new DomainError('INVALID_REQUIRED_WORK', 'Enter positive work for the selected service within the source line quantity', 400);
  }
  if (status.service === 'delivery_installation' && required.installedMilli > required.deliveredMilli) {
    throw new DomainError('INSTALLATION_REQUIRES_DELIVERY', 'Required installation cannot exceed required delivery', 400);
  }
  if (required.deliveredMilli < status.deliveredMilli + status.reservedDeliveryMilli
      || required.installedMilli < status.installedMilli + status.reservedInstallationMilli
      || required.collectedMilli < status.collectedMilli + status.reservedCollectionMilli) {
    throw new DomainError('REQUIRED_WORK_BELOW_COMMITTED', 'Required quantities must cover completed and booked work. Adjust affected visits first.');
  }
  const plan = delivery.servicePlan ?? { defaultService: sourceService(delivery), defaultOrigin: 'source' as const, overrides: [] };
  const entries = (plan.requiredQuantities ?? []).filter(({ sourceLineId }) => sourceLineId !== input.sourceLineId);
  if (input.quantities !== null && workOperations.some(({ expected }) => required[expected] !== defaults[expected])) {
    entries.push({ sourceLineId: input.sourceLineId, quantities: input.quantities, reason: input.reason,
      updatedAt: at, updatedBy: { id: actor.id, name: actor.name } });
  }
  return DeliverySchema.parse({ ...delivery, servicePlan: { ...plan, requiredQuantities: entries } });
}

export function planVisitWork(delivery: Delivery, workLines: readonly WorkLineInput[], actor: OperatorActor, at: string, appointmentId?: string) {
  assertOpen(delivery);
  if (sourcePlanningBlocked(delivery)) throw new DomainError('SOURCE_UPDATE_REVIEW_REQUIRED', 'Review the pending source update before planning work');
  if (delivery.sourceReview) throw new DomainError('SOURCE_REVIEW_REQUIRED', 'Review the source before planning work');
  if (priorWorkReviewReasons(delivery).length > 0) throw new DomainError('PRIOR_WORK_REVIEW_REQUIRED', 'Reconcile confirmed prior work with the current source before planning');
  const input = WorkLinesInputSchema.parse(workLines);
  const existing = appointmentId === undefined ? undefined : requireVisit(delivery, appointmentId);
  if (existing && !(existing.status === 'booked' || existing.status === 'in_progress' && !existing.workScope && existing.results.length === 0)) {
    throw new DomainError('WORK_SCOPE_LOCKED', 'Work can change only before a visit starts, or during explicit review of an unscoped legacy visit');
  }
  const statuses = new Map(lineServiceStatuses(delivery, appointmentId).map((line) => [line.sourceLineId, line]));
  const lines = input.map((line) => {
    const status = statuses.get(line.sourceLineId);
    const item = delivery.source.items.find((item) => item.sourceLineId === line.sourceLineId);
    if (!status || !item) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Planned work references a line outside this picking', 400);
    if (status.service === null) throw new DomainError('SERVICE_REQUIRED', 'Select the service for each planned product line');
    if (status.planningBlockedReason === 'damage_hold') throw new DomainError('DAMAGED_WORK_NOT_READY', 'The dispatcher must confirm that this damaged product is ready for another visit');
    if (!existing && status.planningBlockedReason) throw new DomainError('WORK_PLANNING_BLOCKED', 'Review existing visit scopes before booking more work');
    if (line.deliveryMilli > status.availableDeliveryMilli || line.installationMilli > status.availableInstallationMilli || line.collectionMilli > status.availableCollectionMilli) {
      throw new DomainError('WORK_ALREADY_RESERVED', 'Planned quantities exceed the remaining work available after other visits');
    }
    if (status.service === 'installation_only' && line.installationMilli > 0 && line.customerStockConfirmed !== true) {
      throw new DomainError('CUSTOMER_STOCK_CONFIRMATION_REQUIRED', 'Confirm that the product is already at the customer before planning installation only');
    }
    return { ...line, service: status.service, sourceItem: structuredClone(item) };
  });
  return VisitWorkScopeSchema.parse({ revision: (existing?.workScope?.revision ?? 0) + 1, sourceFingerprint: workSourceFingerprint(delivery),
    confirmedAt: at, confirmedBy: { id: actor.id, name: actor.name }, lines });
}

export function appointmentScopeReviewReason(delivery: LineWorkScope, appointment: Appointment, options?: { allowDamageHold: boolean }): 'missing_scope' | 'source_review' | 'source_changed' | 'work_changed' | 'stock_pending' | 'damage_hold' | null {
  if (!activeWork(appointment)) return null;
  const scope = appointment.workScope;
  if (!scope) return 'missing_scope';
  if (delivery.sourceReview) return 'source_review';
  if (appointment.status !== 'in_progress' && sourcePlanningBlocked(delivery)) return 'source_review';
  if (priorWorkReviewReasons(delivery).length > 0) return 'source_review';
  if (scope.sourceFingerprint !== workSourceFingerprint(delivery)) return 'source_changed';
  const statuses = new Map(lineServiceStatuses(delivery, appointment.id).map((line) => [line.sourceLineId, line]));
  for (const line of scope.lines) {
    const status = statuses.get(line.sourceLineId);
    if (status?.planningBlockedReason === 'damage_hold' && !options?.allowDamageHold) return 'damage_hold';
    if (!status || status.service !== line.service || status.planningBlockedReason === 'legacy_scope_review'
      || line.deliveryMilli > status.availableDeliveryMilli || line.installationMilli > status.availableInstallationMilli || line.collectionMilli > status.availableCollectionMilli) return 'work_changed';
    if (line.service === 'delivery_installation' && line.installationMilli > Math.max(0, status.deliveredMilli - status.installedMilli - reservedCustomerStock(delivery, line.sourceLineId, appointment.id)) + line.deliveryMilli) return 'stock_pending';
    if (line.service === 'installation_only' && line.installationMilli > 0 && line.customerStockConfirmed !== true) return 'work_changed';
  }
  return null;
}

export function requireReviewedVisitScope(delivery: LineWorkScope, appointment: Appointment, options?: { allowDamageHold: boolean }) {
  // A crew must still be able to report an issue discovered during work; the hold blocks subsequent planning/start.
  const reason = appointmentScopeReviewReason(delivery, appointment, options);
  if (reason) throw new DomainError('VISIT_WORK_SCOPE_REVIEW_REQUIRED', 'Ask the dispatcher to review the planned product lines before recording work', 409, [reason]);
}

export function hasRemainingLineWork(delivery: Delivery) {
  return lineServiceStatuses(delivery).some(({ service, remainingDeliveryMilli, remainingInstallationMilli, remainingCollectionMilli }) =>
    service === null || remainingDeliveryMilli > 0 || remainingInstallationMilli > 0 || remainingCollectionMilli > 0);
}

function hasWork(delivery: Delivery): boolean {
  return validPriorWork(delivery).some(hasWorkAmounts) || delivery.appointments.some((appointment) => appointment.status !== 'failed' && (
    appointment.results.length > 0 || visitChecklist(appointment).some((item) => item.done)));
}

function visitChecklist(appointment: Appointment) {
  return appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist));
}

export function unfinishedChecklistCount(appointment: Appointment) {
  return visitChecklist(appointment).filter((item) => !item.done && item.waiver === null).length;
}

function incompleteTasks(delivery: Delivery): boolean {
  return delivery.appointments.some((appointment) => appointment.status !== 'cancelled' &&
    appointment.status !== 'failed' && unfinishedChecklistCount(appointment) > 0);
}

export function assignmentCoverage(delivery: Delivery): { assigned: number; total: number } {
  const active = delivery.appointments.filter((appointment) => appointment.status !== 'cancelled' && appointment.status !== 'failed');
  return { assigned: active.filter((appointment) => appointment.assignments.length > 0).length, total: active.length };
}

export function closureBlockers(delivery: Delivery): string[] {
  const blockers: string[] = [];
  if (sourcePlanningBlocked(delivery)) blockers.push('A source update requires explicit reconciliation');
  if (delivery.sourceReview) blockers.push('Source requires review; delivery scope is not confirmed');
  if (priorWorkReviewReasons(delivery).length > 0) blockers.push('Confirmed prior work requires review against the current source');
  if (delivery.source.items.length === 0) blockers.push('Delivery has no confirmed item scope');
  for (const { item, actual, expected, service } of lineWork(delivery)) {
    if (service === null) { blockers.push(`Service requires review: ${item.name}`); continue; }
    if (actual.deliveredMilli < expected.deliveredMilli) blockers.push(`Remaining quantity: ${item.name} (${(expected.deliveredMilli - actual.deliveredMilli) / 1000} ${item.uom})`);
    if (actual.installedMilli < expected.installedMilli) blockers.push(`Remaining installation: ${item.name} (${(expected.installedMilli - actual.installedMilli) / 1000} ${item.uom})`);
    if (actual.collectedMilli < expected.collectedMilli) blockers.push(`Remaining collection: ${item.name} (${(expected.collectedMilli - actual.collectedMilli) / 1000} ${item.uom})`);
    if (actual.deliveredMilli > expected.deliveredMilli) blockers.push(`Delivered quantity exceeds current source scope: ${item.name}`);
    if (actual.installedMilli > expected.installedMilli) blockers.push(`Installed quantity exceeds current service scope: ${item.name}`);
    if (actual.collectedMilli > expected.collectedMilli) blockers.push(`Collected quantity exceeds current service scope: ${item.name}`);
  }
  if (incompleteTasks(delivery)) blockers.push('Mandatory checklist items remain incomplete');
  if (delivery.issues.some((issue) => issue.status === 'open')) blockers.push('Open issues remain');
  if (delivery.workHolds?.some((hold) => hold.release === undefined)) blockers.push('Damaged products await dispatcher readiness confirmation');
  if (delivery.returnRequests.some((request) => request.status !== 'resolved')) blockers.push('Unresolved return visit requests remain');
  if (delivery.appointments.some((appointment) => appointment.status === 'booked' || appointment.status === 'in_progress')) {
    blockers.push('Unfinished appointments remain');
  }
  const completedVisits = delivery.appointments.filter((appointment) => appointment.status === 'completed');
  const priorComplete = delivery.source.items.length > 0 && priorWorkReviewReasons(delivery).length === 0
    && lineWork(delivery).every(({ item, service, expected }) => {
      const prior = latestPriorWork(delivery).get(item.sourceLineId);
      return service !== null && prior !== undefined && prior.deliveredMilli === expected.deliveredMilli
        && prior.installedMilli === expected.installedMilli && prior.collectedMilli === expected.collectedMilli;
    });
  if (completedVisits.length === 0 && !priorComplete) blockers.push('At least one completed visit is required');
  for (const appointment of completedVisits) {
    if (appointment.results.length === 0) blockers.push(`Visit ${appointment.id} has no result`);
    for (const result of effectiveResults(delivery).filter((entry) => entry.appointmentId === appointment.id)) {
      if (result.signatureRefusal && appointment.signatureRefusalReview?.resultId !== result.id) {
        blockers.push(`Visit ${appointment.id} requires review of the customer's refusal to sign`);
      } else if (!result.signatureRefusal && result.customerSignature?.status !== 'signed') {
        blockers.push(`Visit ${appointment.id} requires the customer signature`);
      }
      if (result.crewSignature?.status !== 'signed') blockers.push(`Visit ${appointment.id} requires the responsible crew signature`);
    }
  }
  return blockers;
}

export function deriveProgress(delivery: Delivery): Exclude<DeliveryView, 'issues' | 'return_required'> | 'awaiting_closure' {
  if (delivery.completedAt !== null) return 'completed';
  if (delivery.appointments.some((appointment) => appointment.status === 'in_progress')) return 'in_progress';
  if (hasWork(delivery)) {
    const remainingWork = lineWork(delivery).some(({ actual, expected, service }) => service === null || actual.deliveredMilli !== expected.deliveredMilli ||
      actual.installedMilli !== expected.installedMilli || actual.collectedMilli !== expected.collectedMilli);
    const remainingVisits = delivery.appointments.some((appointment) => appointment.status === 'booked');
    if (!remainingWork && !incompleteTasks(delivery) && !remainingVisits) return 'awaiting_closure';
    return 'partially_completed';
  }
  const active = delivery.appointments.filter((appointment) => appointment.status === 'booked');
  if (active.some((appointment) => appointment.assignments.length > 0)) return 'assigned';
  return active.length > 0 ? 'planned' : 'inbox';
}

/** Issues and returns deliberately overlap progress views; their counts are not additive. */
export function deriveViews(delivery: Delivery): DeliveryView[] {
  const progress = deriveProgress(delivery);
  const views: DeliveryView[] = [progress === 'awaiting_closure' ? 'partially_completed' : progress];
  if (delivery.issues.some((issue) => issue.status === 'open')) views.push('issues');
  if (delivery.returnRequests.some((request) => request.status !== 'resolved')) views.push('return_required');
  return views;
}

function assertOpen(delivery: Delivery): void {
  if (delivery.completedAt !== null) throw new DomainError('DELIVERY_CLOSED', 'Reopen the delivery with a reason before recording new work');
}

function requireVisit(delivery: Delivery, appointmentId: string): Appointment {
  const appointment = delivery.appointments.find((entry) => entry.id === appointmentId);
  if (!appointment) throw new DomainError('APPOINTMENT_NOT_FOUND', 'Appointment not found', 404);
  return appointment;
}

export function crewAssignments(appointment: Appointment, personId: string) {
  const id = personId.toLowerCase();
  return appointment.assignments.filter((assignment) => assignment.people.some((person) => person.id.toLowerCase() === id));
}

export function assignedParticipant(appointment: Appointment, personId: string) {
  const id = personId.toLowerCase();
  return crewAssignments(appointment, id).flatMap((assignment) => assignment.people)
    .find((person) => person.id.toLowerCase() === id);
}

function assertCrewParticipant(appointment: Appointment, actor: CrewActor): void {
  if (actor.kind !== 'crew' || !crewAssignments(appointment, actor.id).some((assignment) =>
    assignment.people.some((person) => person.id === actor.id && person.name === actor.name))) {
    throw new DomainError('CREW_NOT_ASSIGNED', 'Execution actor is not a snapshotted participant of this visit', 403);
  }
}

export function instantiateTask(template: TaskTemplate, taskId: string = randomUUID(), checklistIds?: string[], requiredSkillsSnapshot: SkillSnapshot[] = []): Task {
  if (!template.enabled) throw new DomainError('TEMPLATE_DISABLED', 'Disabled templates cannot be assigned');
  if (checklistIds !== undefined && checklistIds.length !== template.checklist.length) {
    throw new DomainError('INVALID_CHECKLIST_IDS', 'Each checklist item requires its own ID', 400);
  }
  return {
    id: IdSchema.parse(taskId), templateId: template.id, title: template.title,
    severity: template.severity, order: template.order,
    requiredSkillsSnapshot: requiredSkillsSnapshot.map((skill) => ({ ...skill })),
    checklist: template.checklist.map((label, index) => ({
      id: IdSchema.parse(checklistIds?.[index] ?? randomUUID()), label, done: false, waiver: null,
    })),
  };
}

export function confirmCustomerVisit(delivery: Delivery, appointmentId: string, actor: OperatorActor, confirmedAt: string): Delivery {
  assertOpen(delivery);
  const appointment = requireVisit(delivery, appointmentId);
  if (appointment.status !== 'booked') throw new DomainError('VISIT_NOT_BOOKED', 'Only a booked visit can be confirmed');
  if (appointment.assignments.length === 0) throw new DomainError('VISIT_UNASSIGNED', 'Assign a crew before recording customer confirmation');
  if (appointment.customerConfirmation) throw new DomainError('CUSTOMER_CONFIRMATION_EXISTS', 'Customer confirmation is already recorded for this visit');

  const confirmation = CustomerConfirmationSchema.parse({
    confirmedAt,
    confirmedBy: { id: actor.id, name: actor.name },
  });
  const next = structuredClone(delivery);
  requireVisit(next, appointmentId).customerConfirmation = confirmation;
  return next;
}

export function customerConfirmationStatus(appointment: Appointment) {
  if (appointment.status === 'cancelled') return null;
  if (appointment.customerConfirmation) return 'customer_confirmed';
  return appointment.status === 'booked' ? 'awaiting_customer_confirmation' : null;
}

function assertCustomerConfirmed(appointment: Appointment): void {
  if (customerConfirmationStatus(appointment) === 'awaiting_customer_confirmation') {
    throw new DomainError('CUSTOMER_CONFIRMATION_REQUIRED', 'Record customer confirmation before starting this visit');
  }
}

export function startVisit(delivery: Delivery, appointmentId: string, actor: CrewActor, startedAt?: string): Delivery {
  assertOpen(delivery);
  const appointment = requireVisit(delivery, appointmentId);
  assertCrewParticipant(appointment, actor);
  if (appointment.status !== 'booked') throw new DomainError('VISIT_NOT_BOOKED', 'Only a booked visit can start');
  assertCustomerConfirmed(appointment);
  requireReviewedVisitScope(delivery, appointment);
  const next = structuredClone(delivery);
  const updated = requireVisit(next, appointmentId);
  updated.status = 'in_progress';
  if (startedAt !== undefined) updated.actualStartedAt = InstantSchema.parse(startedAt);
  return next;
}

export function requireInProgressCrewVisit(delivery: Delivery, appointmentId: string, actor: CrewActor) {
  assertOpen(delivery);
  const appointment = requireVisit(delivery, appointmentId);
  assertCrewParticipant(appointment, actor);
  if (appointment.status !== 'in_progress') throw new DomainError('VISIT_NOT_IN_PROGRESS', 'Start this visit before recording work');
  return appointment;
}

export function requireCrewChecklistItem(appointment: Appointment, checklistId: string, personId: string) {
  const item = crewAssignments(appointment, personId)
    .flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist))
    .find((entry) => entry.id.toLowerCase() === checklistId.toLowerCase());
  if (!item) throw new DomainError('CHECKLIST_NOT_FOUND', 'Checklist item not found', 404);
  return item;
}

export function updateCrewChecklist(delivery: Delivery, appointmentId: string, checklistId: string, done: boolean, actor: CrewActor) {
  const next = structuredClone(delivery);
  const appointment = requireInProgressCrewVisit(next, appointmentId, actor);
  const item = requireCrewChecklistItem(appointment, checklistId, actor.id);
  if (item.waiver) throw new DomainError('CHECKLIST_WAIVED', 'An operator waived this checklist item');
  item.done = done;
  return next;
}

export function raiseIssue(delivery: Delivery, input: IssueInput, author: CrewActor | OperatorActor, at: string, appointmentId?: string): Delivery {
  const command = IssueInputSchema.parse(input);
  InstantSchema.parse(at);
  assertOpen(delivery);
  if (appointmentId !== undefined) requireVisit(delivery, appointmentId);
  if ('kind' in author) {
    if (!appointmentId) throw new DomainError('CREW_NOT_ASSIGNED', 'Crew issue requires its assigned visit', 403);
    assertCrewParticipant(requireVisit(delivery, appointmentId), author);
  }
  if (command.itemIds.some((id) => !delivery.source.items.some((item) => item.sourceLineId === id))) {
    throw new DomainError('UNKNOWN_SOURCE_LINE', 'Issue references an item outside the delivery', 400);
  }
  if (command.type === 'damage' && command.itemIds.length === 0) {
    throw new DomainError('DAMAGE_LINE_REQUIRED', 'Select the damaged product lines so their remaining work can be held', 400);
  }
  if (delivery.issues.some((issue) => issue.id === command.id)) throw new DomainError('ISSUE_ID_CONFLICT', 'Issue ID already exists');
  const next = structuredClone(delivery);
  next.issues.push(newIssue(command, author, at, appointmentId));
  if (command.type === 'damage') {
    for (const sourceLineId of command.itemIds) addDamageHold(next, { sourceLineId, issueId: command.id, appointmentId, actor: author, at });
  }
  return DeliverySchema.parse(next);
}

function newIssue(command: IssueInput, author: CrewActor | OperatorActor, at: string, appointmentId?: string): Issue {
  return { ...command, status: 'open', createdAt: at, authorId: author.id, authorName: author.name,
    source: 'kind' in author ? 'crew' : 'operator', resolution: null, resolvedAt: null, resolvedBy: null,
    ...(appointmentId === undefined ? {} : { appointmentId }) };
}

function addDamageHold(delivery: Delivery, origin: { sourceLineId: number; appointmentId?: string; resultId?: string; issueId?: string;
  actor: CrewActor | OperatorActor; at: string; superseded?: VisitResult }) {
  const previousResultIds = new Set<string>();
  let previous = origin.superseded;
  const results = delivery.appointments.flatMap((appointment) => appointment.results);
  while (previous && !previousResultIds.has(previous.id)) {
    previousResultIds.add(previous.id);
    previous = results.find((result) => result.id === previous?.supersedesResultId);
  }
  const existing = delivery.workHolds?.find((hold) => hold.sourceLineId === origin.sourceLineId && (
    (origin.resultId !== undefined && hold.resultId === origin.resultId) ||
    (hold.resultId !== undefined && previousResultIds.has(hold.resultId)) ||
    (origin.issueId !== undefined && hold.issueId === origin.issueId &&
      (hold.appointmentId === undefined || hold.appointmentId === origin.appointmentId) &&
      (hold.release === undefined || origin.superseded?.issueLinks?.some((link) => link.issueId === hold.issueId && link.sourceLineId === origin.sourceLineId)))
  ));
  if (existing) {
    // A manual issue can precede its signed report; retain the first report association for later corrections.
    if (existing.resultId === undefined && origin.resultId !== undefined) existing.resultId = origin.resultId;
    return;
  }
  delivery.workHolds ??= [];
  delivery.workHolds.push({ id: randomUUID(), sourceLineId: origin.sourceLineId, reason: 'damage',
    ...(origin.appointmentId === undefined ? {} : { appointmentId: origin.appointmentId }),
    ...(origin.resultId === undefined ? {} : { resultId: origin.resultId }),
    ...(origin.issueId === undefined ? {} : { issueId: origin.issueId }),
    createdAt: origin.at, createdBy: { id: origin.actor.id, name: origin.actor.name } });
}

export function releaseDamagedWork(delivery: Delivery, sourceLineId: number, note: string, actor: OperatorActor, at: string): Delivery {
  assertOpen(delivery);
  const explanation = TextSchema.parse(note);
  InstantSchema.parse(at);
  if (!delivery.source.items.some((line) => line.sourceLineId === sourceLineId)) throw new DomainError('UNKNOWN_SOURCE_LINE', 'Product line not found', 404);
  const next = structuredClone(delivery);
  const holds = next.workHolds?.filter((hold) => hold.sourceLineId === sourceLineId && hold.release === undefined) ?? [];
  if (holds.length === 0) throw new DomainError('WORK_ALREADY_READY', 'This product has no open damage readiness hold');
  for (const hold of holds) hold.release = { at, by: { id: actor.id, name: actor.name }, note: explanation };
  return DeliverySchema.parse(next);
}

/** A quality problem is an operational issue; incomplete quantities and their reasons are separate facts. */
function linkProductProblems(delivery: Delivery, command: ExecutionInput, actor: CrewActor, at: string, superseded?: VisitResult) {
  const links: NonNullable<VisitResult['issueLinks']> = [];
  for (const check of command.itemChecks ?? []) {
    if (check.status !== 'problem') continue;
    const priorLink = superseded?.issueLinks?.find(({ sourceLineId }) => sourceLineId === check.sourceLineId);
    const selectedId = check.linkedIssueId ?? priorLink?.issueId;
    let issue: Issue | undefined;
    if (selectedId !== undefined) {
      issue = delivery.issues.find(({ id }) => id.toLowerCase() === selectedId.toLowerCase());
      if (!issue || !issue.itemIds.includes(check.sourceLineId) ||
        (issue.appointmentId !== undefined && issue.appointmentId !== command.appointmentId) ||
        (issue.status !== 'open' && issue.id !== priorLink?.issueId)) {
        throw new DomainError('INVALID_REPORT_ISSUE', 'Choose an open issue for this product line and visit', 400);
      }
    } else {
      const matching = delivery.issues.filter((entry) => entry.status === 'open' && entry.appointmentId === command.appointmentId &&
        entry.itemIds.includes(check.sourceLineId));
      if (matching.length > 1) {
        throw new DomainError('REPORT_ISSUE_SELECTION_REQUIRED', 'Choose the existing issue for this product problem', 400);
      }
      issue = matching[0];
    }
    const photoIds = [...new Set(command.evidence.filter((entry) => entry.itemIds.includes(check.sourceLineId) && entry.type === 'photo').map(({ id }) => id))];
    if (issue === undefined) {
      issue = { ...newIssue({ id: randomUUID(), type: check.problemType ?? 'other', description: check.note ?? 'Crew reported a product problem. Dispatcher review is required.',
        itemIds: [check.sourceLineId], photoIds, notes: null }, actor, at, command.appointmentId), originResultId: command.id };
      delivery.issues.push(issue);
    } else {
      const combined = [...new Set([...issue.photoIds, ...photoIds])];
      if (combined.length > 100) throw new DomainError('ISSUE_PHOTO_LIMIT', 'This issue already has the maximum number of linked photos', 400);
      issue.photoIds = combined;
    }
    links.push({ sourceLineId: check.sourceLineId, issueId: issue.id });
  }
  const damagedLineIds = new Set([
    ...(command.incompleteWork ?? []).filter(({ reason }) => reason === 'damage').map(({ sourceLineId }) => sourceLineId),
    ...(command.itemChecks ?? []).filter(({ status, problemType }) => status === 'problem' && problemType === 'damage').map(({ sourceLineId }) => sourceLineId),
    ...links.filter(({ issueId }) => delivery.issues.some((issue) => issue.id === issueId && issue.type === 'damage')).map(({ sourceLineId }) => sourceLineId),
  ]);
  for (const sourceLineId of damagedLineIds) addDamageHold(delivery, { sourceLineId, resultId: command.id,
    appointmentId: command.appointmentId, issueId: links.find((link) => link.sourceLineId === sourceLineId)?.issueId,
    actor, at, superseded });
  return links;
}

export function raiseReturnRequest(delivery: Delivery, input: ReturnInput, author: CrewActor | OperatorActor, at: string, appointmentId?: string): Delivery {
  const command = ReturnInputSchema.parse(input);
  InstantSchema.parse(at);
  assertOpen(delivery);
  const origin = requireVisit(delivery, command.originAppointmentId);
  if ('kind' in author) {
    if (appointmentId !== origin.id) throw new DomainError('CREW_NOT_ASSIGNED', 'Crew return request requires its assigned origin visit', 403);
    assertCrewParticipant(origin, author);
  }
  if (origin.status !== 'completed' || origin.results.length === 0) {
    throw new DomainError('RETURN_WITHOUT_WORK', 'A return request must refer to a visit with reported work');
  }
  if (delivery.returnRequests.some((request) => request.id === command.id)) throw new DomainError('RETURN_ID_CONFLICT', 'Return request ID already exists');
  if (new Set(command.photoIds).size !== command.photoIds.length || new Set(command.issueIds).size !== command.issueIds.length) {
    throw new DomainError('DUPLICATE_RETURN_LINK', 'Return photo and issue links must be distinct', 400);
  }
  if (command.issueIds.some((id) => !delivery.issues.some((issue) => issue.id === id))) {
    throw new DomainError('RETURN_ISSUE_OWNERSHIP', 'Return request references an issue outside this delivery', 400);
  }
  const next = structuredClone(delivery);
  next.returnRequests.push({ ...command, status: 'requested', appointmentId: null, createdAt: at, resolvedAt: null, resolution: null });
  return DeliverySchema.parse(next);
}

function resultPayload(input: ExecutionInput): string {
  return JSON.stringify({
    id: input.id, appointmentId: input.appointmentId, actualStart: input.actualStart, actualEnd: input.actualEnd,
    supersedesResultId: input.supersedesResultId, correctionReason: input.correctionReason,
    summary: input.summary, responsiblePersonId: input.responsiblePersonId, quantities: input.quantities, itemChecks: input.itemChecks,
    incompleteWork: input.incompleteWork ?? [],
    completedChecklistIds: input.completedChecklistIds, evidence: input.evidence,
    customerSignature: input.customerSignature, crewSignature: input.crewSignature,
  });
}

export function requireVisitResponsible(appointment: Appointment, actor: CrewActor) {
  const responsible = appointment.responsibleParticipant;
  if (!responsible) throw new DomainError('VISIT_RESPONSIBLE_REQUIRED', 'Choose a responsible participant before reporting the visit');
  if (responsible.id.toLowerCase() !== actor.id.toLowerCase()) {
    throw new DomainError('NOT_VISIT_RESPONSIBLE', 'Only the responsible participant can report the visit', 403);
  }
  return responsible;
}

export function recordCustomerAbsent(delivery: Delivery, appointmentId: string, actor: CrewActor, reason: string, at: string): Delivery {
  const appointment = requireInProgressCrewVisit(delivery, appointmentId, actor);
  requireVisitResponsible(appointment, actor);
  if (appointment.results.length > 0) {
    throw new DomainError('VISIT_HAS_REPORTED_WORK', 'A visit with reported work cannot be marked as a failed attempt');
  }
  const failedAttempt = FailedAttemptSchema.parse({ reason, at, actor: { id: actor.id, name: actor.name } });
  const next = structuredClone(delivery);
  const updated = requireVisit(next, appointmentId);
  updated.status = 'failed';
  updated.failedAttempt = failedAttempt;
  // Keep the historical link on the failed visit, but allow this return request to be booked again.
  const request = next.returnRequests.find((entry) => entry.id === updated.returnRequestId &&
    entry.status === 'planned' && entry.appointmentId === updated.id);
  if (request) {
    request.status = 'requested';
    request.appointmentId = null;
  }
  return next;
}

export function finishCrewVisit(
  delivery: Delivery, appointmentId: string, actor: CrewActor,
  report: Pick<ExecutionInput, 'id' | 'summary' | 'quantities' | 'itemChecks' | 'incompleteWork' | 'documentSnapshot'> & {
    customerSignature?: CustomerDrawingInput;
    signatureRefusal?: VisitResult['signatureRefusal'];
    crewSignature: CrewDrawingInput;
    photos: readonly { id: string; sourceLineId?: number }[];
  },
  actualStart: string, receivedAt: string,
): Delivery {
  const appointment = requireInProgressCrewVisit(delivery, appointmentId, actor);
  const responsible = requireVisitResponsible(appointment, actor);
  const { customerSignature, signatureRefusal: unvalidatedRefusal, crewSignature, photos, ...work } = report;
  const signatureRefusal = unvalidatedRefusal === undefined ? undefined : SignatureRefusalSchema.parse(unvalidatedRefusal);
  if (signatureRefusal && customerSignature) {
    throw new DomainError('SIGNATURE_REFUSAL_CONFLICT', 'A refused signature cannot also be submitted as signed', 400);
  }
  if (!signatureRefusal && !customerSignature) {
    throw new DomainError('CUSTOMER_SIGNATURE_REQUIRED', 'Capture the customer signature or report the reason for refusal', 400);
  }
  if (signatureRefusal && !work.quantities.some((line) => line.deliveredMilli > 0 || (line.installedMilli ?? 0) > 0 || (line.collectedMilli ?? 0) > 0)) {
    throw new DomainError('SIGNATURE_REFUSAL_REQUIRES_WORK', 'Record performed work before reporting a signature refusal', 400);
  }
  if (signatureRefusal?.noPhotoReason && photos.length > 0) {
    throw new DomainError('SIGNATURE_REFUSAL_PHOTO_CONFLICT', 'Remove completion photos when reporting that the customer prohibited photography', 400);
  }
  if (!signatureRefusal?.noPhotoReason && photos.length === 0) {
    throw new DomainError('COMPLETION_PHOTO_REQUIRED', 'Add at least one photo of the completed work', 400);
  }
  if (customerSignature && sameSignatureDrawing(customerSignature.strokes, crewSignature.strokes)) {
    throw new DomainError('SIGNATURES_NOT_DISTINCT', 'The customer and the responsible participant must draw their own signatures', 400);
  }
  const completedChecklistIds = visitChecklist(appointment).filter((item) => item.done).map((item) => item.id);
  const next = recordExecution(delivery, {
    ...work, appointmentId, actualStart, actualEnd: receivedAt, responsiblePersonId: actor.id, completedChecklistIds,
    supersedesResultId: null, correctionReason: null,
    evidence: photos.map(({ id, sourceLineId }) => ({ id, type: 'photo', itemIds: sourceLineId === undefined ? [] : [sourceLineId] })),
    customerSignature: customerSignature ? { status: 'signed', capture: 'drawn', signerName: customerSignature.signerName, strokes: customerSignature.strokes, at: receivedAt } : null,
    crewSignature: { status: 'signed', capture: 'drawn', signerName: responsible.name, strokes: crewSignature.strokes, at: receivedAt },
  }, actor, receivedAt, 'crew_frontoffice', signatureRefusal);
  requireVisit(next, appointmentId).actualStartedAt ??= actualStart;
  return next;
}

export function recordExecution(delivery: Delivery, input: ExecutionInput, actor: CrewActor, receivedAt: string,
  source?: VisitResult['source'], signatureRefusal?: VisitResult['signatureRefusal']): Delivery {
  const command = ExecutionInputSchema.parse(input);
  InstantSchema.parse(receivedAt);
  const appointment = requireVisit(delivery, command.appointmentId);
  assertCrewParticipant(appointment, actor);
  const responsible = appointment.responsibleParticipant || source === 'crew_frontoffice'
    ? requireVisitResponsible(appointment, actor)
    : undefined;
  const existing = delivery.appointments.flatMap((visit) => visit.results).find((result) => result.id === command.id);
  if (existing) {
    if (existing.actor.id === actor.id && resultPayload(existing) === resultPayload(command)) return delivery;
    throw new DomainError('RESULT_ID_CONFLICT', 'This result ID has already been used for different data');
  }
  assertOpen(delivery);
  const superseded = command.supersedesResultId === null ? undefined :
    effectiveResults(delivery).find((result) => result.id === command.supersedesResultId && result.appointmentId === appointment.id);
  if (command.supersedesResultId !== null) {
    if (!superseded) throw new DomainError('CORRECTION_NOT_LATEST', 'Correction must reference the latest effective result of this visit');
    if (superseded.signatureRefusal) throw new DomainError('SIGNATURE_REFUSAL_REVIEW_REQUIRED', "Review this customer's signature refusal in Backoffice");
    if (superseded.actor.id !== actor.id) throw new DomainError('CORRECTION_ACTOR_MISMATCH', 'Correction must come from the same responsible representative', 403);
    if (!TextSchema.safeParse(command.correctionReason).success) throw new DomainError('CORRECTION_REASON_REQUIRED', 'Signed result corrections require an explicit reason', 400);
    if (appointment.status !== 'completed') throw new DomainError('CORRECTION_VISIT_NOT_COMPLETED', 'Only a completed visit result can be corrected');
  } else if (command.correctionReason !== null) {
    throw new DomainError('CORRECTION_RESULT_REQUIRED', 'A correction reason requires the result being superseded', 400);
  }
  if (appointment.status !== 'booked' && appointment.status !== 'in_progress' && superseded === undefined) {
    throw new DomainError('VISIT_NOT_ACTIVE', 'Only an active visit can receive a result; use a new visit for later work');
  }
  if (command.responsiblePersonId !== actor.id) throw new DomainError('INVALID_RESPONSIBLE_PERSON', 'Responsible representative must be the authenticated execution actor', 403);
  assertCustomerConfirmed(appointment);
  if (!superseded) requireReviewedVisitScope(delivery, appointment, { allowDamageHold: appointment.status === 'in_progress' });
  validateInterval(command.actualStart, command.actualEnd);
  if (Date.parse(command.actualEnd) > Date.parse(receivedAt)) throw new DomainError('FUTURE_EXECUTION', 'Actual work cannot finish in the future', 400);
  if (new Set(command.quantities.map((quantity) => quantity.sourceLineId)).size !== command.quantities.length) {
    throw new DomainError('DUPLICATE_QUANTITY', 'Report each source line once per result', 400);
  }
  validateReportedWork(delivery, command, superseded);
  validateIncompleteWork(delivery, command, superseded);
  const sourceLineIds = new Set((appointment.workScope?.lines ?? delivery.source.items).map(({ sourceLineId }) => sourceLineId));
  if (command.itemChecks?.some(({ sourceLineId }) => !sourceLineIds.has(sourceLineId))) {
    throw new DomainError('UNKNOWN_CHECKED_PRODUCT', 'Product check references a line outside the delivery', 400);
  }
  const checklist = visitChecklist(appointment);
  if (new Set(command.completedChecklistIds).size !== command.completedChecklistIds.length ||
    command.completedChecklistIds.some((id) => !checklist.some((item) => item.id === id))) {
    throw new DomainError('UNKNOWN_CHECKLIST_ITEM', 'Checklist results must reference distinct items assigned to this visit', 400);
  }
  for (const evidence of command.evidence) {
    if (evidence.itemIds.some((id) => !sourceLineIds.has(id))) {
      throw new DomainError('UNKNOWN_EVIDENCE_ITEM', 'Evidence references an item outside the delivery', 400);
    }
  }
  const crewSignerName = source === 'crew_frontoffice' && responsible ? responsible.name : actor.name;
  if (command.crewSignature?.status === 'signed' && command.crewSignature.signerName !== crewSignerName) {
    throw new DomainError('SIGNER_MISMATCH', 'Crew signature must name the responsible representative', 403);
  }
  for (const signature of [command.customerSignature, command.crewSignature]) {
    if (signature && (Date.parse(signature.at) < Date.parse(command.actualStart) || Date.parse(signature.at) > Date.parse(receivedAt))) {
      throw new DomainError('INVALID_SIGNATURE_TIME', 'Signature time must fall between actual start and receipt', 400);
    }
    if (signature?.status === 'signed' && Date.parse(signature.at) < Date.parse(command.actualEnd)) {
      throw new DomainError('SIGNATURE_BEFORE_COMPLETION', 'A visit confirmation must be signed after the reported work finishes', 400);
    }
  }
  const next = structuredClone(delivery);
  const issueLinks = linkProductProblems(next, command, actor, receivedAt, superseded);
  const updatedAppointment = requireVisit(next, command.appointmentId);
  for (const item of visitChecklist(updatedAppointment)) {
    item.done = command.completedChecklistIds.includes(item.id);
  }
  updatedAppointment.status = 'completed';
  const workScopeSnapshot = superseded?.workScopeSnapshot ?? updatedAppointment.workScope;
  updatedAppointment.results.push({
    ...command, receivedAt, actor: { kind: 'crew', id: actor.id, name: actor.name },
    ...(source === undefined ? {} : { source }),
    ...(signatureRefusal === undefined ? {} : { signatureRefusal }),
    ...(command.itemChecks === undefined ? {} : { issueLinks }),
    sourceSnapshot: structuredClone(delivery.source), instructionsSnapshot: structuredClone(delivery.instructions),
    assignmentsSnapshot: structuredClone(updatedAppointment.assignments),
    ...(delivery.servicePlan ? { servicePlanSnapshot: structuredClone(delivery.servicePlan) } : {}),
    ...(workScopeSnapshot ? { workScopeSnapshot: structuredClone(workScopeSnapshot), incompleteWork: command.incompleteWork ?? [] } : {}),
    ...(updatedAppointment.transportAllocations===undefined?{}:{transportSnapshot:structuredClone(updatedAppointment.transportAllocations.filter((allocation)=>allocation.status==='active'))}),
  });
  if (superseded) validateCorrectionPlanning(delivery, next);
  return DeliverySchema.parse(next);
}

function validateCorrectionPlanning(delivery: Delivery, next: Delivery): void {
  for (const active of next.appointments.filter((visit) => activeWork(visit) && visit.workScope)) {
    const previous = delivery.appointments.find((visit) => visit.id === active.id);
    const afterReason = appointmentScopeReviewReason(next, active);
    if (afterReason && afterReason !== 'damage_hold' && previous && appointmentScopeReviewReason(delivery, previous) !== afterReason) {
      throw new DomainError('CORRECTION_CONFLICTS_WITH_PLANNING', 'The correction conflicts with work reserved on another visit; review that visit first');
    }
  }
}

export function reviewSignatureRefusal(delivery: Delivery, appointmentId: string, resultId: string,
  input: SignatureRefusalReviewDecision, actor: OperatorActor, at: string): Delivery {
  assertOpen(delivery);
  const decision = SignatureRefusalReviewDecisionSchema.parse(input);
  const appointment = requireVisit(delivery, appointmentId);
  const report = effectiveResults({ appointments: [appointment] }).find(({ id }) => id === resultId);
  if (appointment.status !== 'completed' || !report?.signatureRefusal) {
    throw new DomainError('SIGNATURE_REFUSAL_NOT_FOUND', 'Signature refusal report not found for this visit', 404);
  }
  if (appointment.signatureRefusalReview) {
    throw new DomainError('SIGNATURE_REFUSAL_ALREADY_REVIEWED', 'This signature refusal has already been reviewed');
  }
  if (decision.decision === 'corrected') {
    const original = new Map(report.quantities.map((line) => [line.sourceLineId, line]));
    const keys = new Set(decision.quantities.map(({ sourceLineId }) => sourceLineId));
    const operations = ['deliveredMilli', 'installedMilli', 'collectedMilli'] as const;
    let reduced = false;
    for (const quantity of decision.quantities) {
      const previous = original.get(quantity.sourceLineId);
      if (!previous || operations.some((operation) => (quantity[operation] ?? 0) > (previous[operation] ?? 0))) {
        throw new DomainError('SIGNATURE_REFUSAL_CORRECTION_INVALID', 'A review can only reduce quantities on the original reported lines', 400);
      }
      reduced ||= operations.some((operation) => (quantity[operation] ?? 0) < (previous[operation] ?? 0));
    }
    if (!reduced || keys.size !== original.size || keys.size !== decision.quantities.length) {
      throw new DomainError('SIGNATURE_REFUSAL_CORRECTION_INVALID', 'Provide each original reported line once and reduce at least one quantity', 400);
    }
    validateReportedWork(delivery, { ...report, quantities: decision.quantities }, report);
  }
  const next = structuredClone(delivery);
  // The Crew report, drawings and evidence remain the original submission.
  requireVisit(next, appointmentId).signatureRefusalReview = SignatureRefusalReviewSchema.parse({
    ...decision, resultId, reviewedAt: at, reviewedBy: { id: actor.id, name: actor.name },
  });
  if (decision.decision === 'corrected') validateCorrectionPlanning(delivery, next);
  return DeliverySchema.parse(next);
}

function validateIncompleteWork(delivery: Delivery, command: ExecutionInput, superseded: VisitResult | undefined) {
  const scope = superseded?.workScopeSnapshot ?? requireVisit(delivery, command.appointmentId).workScope;
  const reasons = new Map((command.incompleteWork ?? []).map((entry) => [`${entry.sourceLineId}:${entry.operation}`, entry]));
  const actual = new Map(command.quantities.map((quantity) => [quantity.sourceLineId, quantity]));
  for (const planned of scope?.lines ?? []) {
    const quantity = actual.get(planned.sourceLineId);
    const operations = [
      { operation: 'delivery', planned: planned.deliveryMilli, actual: quantity?.deliveredMilli ?? 0 },
      { operation: 'installation', planned: planned.installationMilli, actual: quantity?.installedMilli ?? 0 },
      { operation: 'collection', planned: planned.collectionMilli, actual: quantity?.collectedMilli ?? 0 },
    ];
    for (const operation of operations) {
      if (operation.actual >= operation.planned) continue;
      const key = `${planned.sourceLineId}:${operation.operation}`;
      if (!reasons.delete(key)) {
        throw new DomainError('INCOMPLETE_WORK_REASON_REQUIRED', 'Explain each planned operation that was not fully completed', 400,
          [`Source line ${planned.sourceLineId}: ${operation.operation}`]);
      }
    }
  }
  if (reasons.size > 0) {
    throw new DomainError('UNEXPECTED_INCOMPLETE_WORK_REASON', 'Reasons must refer only to incomplete operations planned for this visit', 400);
  }
}

function validateReportedWork(delivery: Delivery, command: ExecutionInput, superseded: VisitResult | undefined) {
  const appointment = requireVisit(delivery, command.appointmentId);
  const scope = superseded?.workScopeSnapshot ?? appointment.workScope;
  if (scope) {
    for (const quantity of command.quantities) {
      const planned = scope.lines.find((line) => line.sourceLineId === quantity.sourceLineId);
      if (!planned) throw new DomainError('UNPLANNED_WORK', 'Report only product lines planned for this visit', 400);
      if (quantity.deliveredMilli > planned.deliveryMilli || (quantity.installedMilli ?? 0) > planned.installationMilli || (quantity.collectedMilli ?? 0) > planned.collectionMilli) {
        throw new DomainError('EXCESS_VISIT_WORK', 'Reported work exceeds the operations and quantities planned for this visit');
      }
    }
  }
  const sourceIds = new Set(delivery.source.items.map(({ sourceLineId }) => sourceLineId));
  if (command.quantities.some(({ sourceLineId }) => !sourceIds.has(sourceLineId))) {
    throw new DomainError('UNKNOWN_SOURCE_LINE', 'Result references an item outside the delivery', 400);
  }
  const touched = new Set([...command.quantities, ...(superseded?.quantities ?? [])].map(({ sourceLineId }) => sourceLineId));
  const otherResults = effectiveResults(delivery).filter(({ id }) => id !== superseded?.id);
  const totals = workAmounts([...otherResults, command], delivery);
  const reservations = new Map(lineServiceStatuses(delivery, appointment.id).map((line) => [line.sourceLineId, line]));
  for (const { item, service, expected } of lineWork(delivery)) {
    if (!touched.has(item.sourceLineId)) continue;
    const actual = totals.get(item.sourceLineId) ?? emptyWork;
    if (actual.deliveredMilli > expected.deliveredMilli) {
      throw new DomainError('EXCESS_DELIVERY', 'Result would deliver the same quantity more than once or exceed scope');
    }
    if (actual.installedMilli > expected.installedMilli) {
      throw new DomainError('EXCESS_INSTALLATION', 'Installed quantity exceeds the planned installation');
    }
    if (actual.collectedMilli > expected.collectedMilli) {
      throw new DomainError('EXCESS_COLLECTION', 'Collected quantity exceeds the planned collection');
    }
    if (service === 'delivery_installation' && actual.installedMilli > actual.deliveredMilli) {
      throw new DomainError('INSTALLATION_REQUIRES_DELIVERY', 'Installed quantity cannot exceed the quantity already delivered');
    }
    if (service === 'delivery_installation' && actual.installedMilli + reservedCustomerStock(delivery, item.sourceLineId, appointment.id) > actual.deliveredMilli) {
      throw new DomainError('CUSTOMER_STOCK_RESERVED', 'This installation would consume products reserved by another visit already in progress');
    }
    const reserved = reservations.get(item.sourceLineId);
    if (reserved && (actual.deliveredMilli + reserved.reservedDeliveryMilli > expected.deliveredMilli
      || actual.installedMilli + reserved.reservedInstallationMilli > expected.installedMilli
      || actual.collectedMilli + reserved.reservedCollectionMilli > expected.collectedMilli)) {
      throw new DomainError('WORK_ALREADY_RESERVED', 'This result conflicts with quantities reserved on another visit');
    }
  }
}

export function waiveChecklist(
  delivery: Delivery, appointmentId: string, checklistId: string, actor: OperatorActor, reason: string, at: string,
): Delivery {
  assertOpen(delivery);
  const validatedReason = TextSchema.parse(reason);
  InstantSchema.parse(at);
  if (actor.role !== 'admin' && actor.role !== 'operator') throw new DomainError('FORBIDDEN_WAIVER', 'Only an operator may waive a checklist item', 403);
  const next = structuredClone(delivery);
  const appointment = requireVisit(next, appointmentId);
  const item = visitChecklist(appointment).find((entry) => entry.id === checklistId);
  if (!item) throw new DomainError('CHECKLIST_NOT_FOUND', 'Checklist item not found', 404);
  if (item.done || item.waiver !== null) throw new DomainError('CHECKLIST_ALREADY_RESOLVED', 'Checklist item is already resolved');
  item.waiver = { actorId: actor.id, reason: validatedReason, at };
  return DeliverySchema.parse(next);
}

export function completeDelivery(delivery: Delivery, actor: OperatorActor, completionId: string, at: string): Delivery {
  IdSchema.parse(completionId);
  InstantSchema.parse(at);
  const existing = delivery.completions.find((completion) => completion.id === completionId);
  if (existing && delivery.completedAt === existing.at && existing.actorId === actor.id) return delivery;
  if (existing) throw new DomainError('COMPLETION_ID_CONFLICT', 'This completion ID already belongs to an earlier confirmation');
  assertOpen(delivery);
  const blockers = closureBlockers(delivery);
  if (blockers.length > 0) throw new DomainError('CLOSURE_BLOCKED', 'Delivery does not meet closure requirements', 409, blockers);
  const next = structuredClone(delivery);
  next.completedAt = at;
  next.completions.push({
    id: completionId, at, actorId: actor.id, actorName: actor.name,
    sourceSnapshot: structuredClone(delivery.source),
    resultIds: effectiveResults(delivery).map((result) => result.id),
    ...(delivery.priorWorkRevisions?.length ? { priorWorkSnapshot: structuredClone([...latestPriorWork(delivery).values()]) } : {}),
    reopenedAt: null, reopenReason: null,
  });
  return DeliverySchema.parse(next);
}

export function reopenDelivery(delivery: Delivery, actor: OperatorActor, reason: string, at: string): Delivery {
  TextSchema.parse(reason);
  InstantSchema.parse(at);
  IdSchema.parse(actor.id);
  if (delivery.completedAt === null) throw new DomainError('DELIVERY_NOT_CLOSED', 'Only a completed delivery can be reopened');
  const next = structuredClone(delivery);
  const completion = next.completions.slice().reverse().find((entry) => entry.reopenedAt === null);
  if (!completion) throw new DomainError('COMPLETION_MISSING', 'Completion history is missing');
  completion.reopenedAt = at;
  completion.reopenReason = `${actor.name}: ${reason}`;
  next.completedAt = null;
  return DeliverySchema.parse(next);
}
