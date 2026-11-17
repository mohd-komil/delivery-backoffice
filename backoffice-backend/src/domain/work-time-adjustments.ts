import { createHash } from 'node:crypto';
import { destinationAddressKey } from './destination-address';
import type { Delivery, RemainingWorkEstimate, WorkLineInput, WorkTimeAdjustmentFieldSchema, WorkTimeCalculation } from './model';
import type { z } from 'zod';

type SelectedWork = readonly Pick<WorkLineInput, 'sourceLineId' | 'deliveryMilli' | 'installationMilli' | 'collectionMilli'>[];
type ExactWorkTime = { numerator: bigint; denominator: bigint };
type AdjustmentField = z.infer<typeof WorkTimeAdjustmentFieldSchema>;

const fixedOperations = [
  { quantity: 'deliveryMilli', field: 'deliveryMinutes' },
  { quantity: 'installationMilli', field: 'installationMinutes' },
  { quantity: 'collectionMilli', field: 'collectionMinutes' },
] as const;

export function workTimeAdjustmentContext(delivery: Pick<Delivery, 'source' | 'instructions'>): string {
  return createHash('sha256').update(JSON.stringify({ addressKey: destinationAddressKey(delivery.source.customer),
    instructions: delivery.instructions })).digest('hex');
}

/** Fixed allowances describe one visit, while the factor applies before rounding selected unit work. */
export function applyWorkTimeAdjustments(delivery: Delivery, work: SelectedWork, base: RemainingWorkEstimate,
  exact?: ExactWorkTime): RemainingWorkEstimate {
  const adjustments = delivery.workTimeAdjustments;
  const selected = work.filter((line) => line.deliveryMilli + line.installationMilli + line.collectionMilli > 0);
  const fields: ('visitMinutes' | 'deliveryMinutes' | 'installationMinutes' | 'collectionMinutes')[] = selected.length
    ? ['visitMinutes', ...fixedOperations.filter(({ quantity }) => selected.some((line) => line[quantity] > 0)).map(({ field }) => field)] : [];
  const missingFields: AdjustmentField[] = [];
  let fixedMinutes: number | null = selected.length === 0 || adjustments ? 0 : null;
  if (adjustments && selected.length) {
    if (adjustments.factorPercent === null) missingFields.push('factorPercent');
    for (const field of fields) {
      const value = adjustments[field];
      if (value === null) missingFields.push(field);
      else if (fixedMinutes !== null) fixedMinutes += value;
    }
    if (missingFields.some((field) => field !== 'factorPercent')) fixedMinutes = null;
    const usesSource = base.basis === 'proportional_remaining_operations' || base.basis === 'mixed_operation_rates';
    const changesSourceTime = adjustments.factorPercent !== null && adjustments.factorPercent !== 100
      || fields.some((field) => (adjustments[field] ?? 0) > 0);
    if (usesSource && changesSourceTime && !adjustments.sourceEstimateExcludesAdjustments) {
      missingFields.push('sourceEstimateExcludesAdjustments');
    }
  }
  const calculation: WorkTimeCalculation = {
    algorithmVersion: 'remaining_work_v2', baseMinutes: base.minutes,
    factorPercent: adjustments?.factorPercent ?? null, fixedMinutes,
    adjustmentVersion: adjustments?.version ?? null,
    adjustmentStatus: !adjustments ? 'not_configured'
      : adjustments.contextFingerprint !== workTimeAdjustmentContext(delivery) ? 'needs_review'
        : missingFields.length ? 'incomplete' : 'current',
    ...(missingFields.length ? { missingFields } : {}),
  };
  if (base.minutes === null) return { ...base, calculation };
  if (selected.length === 0) return { ...base, calculation };
  if (!adjustments) return base.minutes > 10080
    ? { minutes: null, basis: 'unknown', sourceMinutes: base.sourceMinutes, exceedsLimit: true, calculation }
    : { ...base, calculation };
  if (calculation.adjustmentStatus !== 'current' || adjustments.factorPercent === null || fixedMinutes === null || !exact) {
    return { ...base, minutes: null, basis: 'unknown', calculation };
  }
  const denominator = exact.denominator * 100n;
  const numerator = exact.numerator * BigInt(adjustments.factorPercent) + BigInt(fixedMinutes) * denominator;
  const minutes = Number((numerator + denominator - 1n) / denominator);
  if (minutes > 10080) return { minutes: null, basis: 'unknown', sourceMinutes: base.sourceMinutes, exceedsLimit: true, calculation };
  return { ...base, minutes, calculation };
}
