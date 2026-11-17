import { z } from 'zod';
import { serviceTypeSchema } from './service-types';

const minutesPerUnit = z.number().int().min(1).max(1440).nullable();
export const workTimeRatesSchema = z.object({
  deliveryMinutesPerUnit: minutesPerUnit,
  installationMinutesPerUnit: minutesPerUnit,
  collectionMinutesPerUnit: minutesPerUnit,
});
export const workTimesInputSchema = workTimeRatesSchema.extend({
  version: z.number().int().positive(), sourceLineId: z.number().int().positive(),
}).strict();
export type WorkTimesUpdate = z.infer<typeof workTimesInputSchema>;
export const workTimeStandardSnapshotSchema = z.object({
  id: z.uuid(), version: z.number().int().positive(), name: z.string(), service: serviceTypeSchema,
  unit: z.string(), category: z.string().nullable(), rates: workTimeRatesSchema,
  basis: z.literal('elapsed_team_minutes'), assumptions: z.string(), exclusions: z.string(), examples: z.string(), sourceReference: z.string(),
});
export const savedWorkTimeSchema = workTimeRatesSchema.extend({
  sourceLineId: z.number().int().positive(),
  context: z.object({ productId: z.number().int().positive(), saleOrderId: z.number().int().positive(),
    uom: z.string(), uomId: z.number().int().positive().nullable(), addressKey: z.string().regex(/^[a-f0-9]{64}$/) }),
  updatedAt: z.iso.datetime({ offset: true }), updatedBy: z.object({ id: z.uuid(), name: z.string() }),
  timeStandard: workTimeStandardSnapshotSchema.optional(),
});
export const lineWorkTimeSchema = workTimeRatesSchema.extend({
  sourceLineId: z.number().int().positive(), stale: z.boolean(),
  missingOperations: z.array(z.enum(['delivery', 'installation', 'collection'])),
  remainingMinutes: z.number().int().min(0).max(10080).nullable(),
  basis: z.enum(['source_total_proportion', 'local', 'mixed', 'unknown']),
  canEdit: z.boolean(),
  localSavedAt: z.iso.datetime({ offset: true }).nullable(),
  localSavedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type LineWorkTime = z.infer<typeof lineWorkTimeSchema>;

const allowanceMinutes = z.number().int().min(0).max(1440).nullable();
export const workTimeAdjustmentFieldsSchema = z.object({
  factorPercent: z.number().int().min(1).max(1000).nullable(),
  visitMinutes: allowanceMinutes,
  deliveryMinutes: allowanceMinutes,
  installationMinutes: allowanceMinutes,
  collectionMinutes: allowanceMinutes,
  sourceEstimateExcludesAdjustments: z.boolean().default(false),
  sourceReference: z.string().trim().min(1).max(2000),
  assumptions: z.string().trim().min(1).max(2000),
});
export const workTimeAdjustmentsSchema = workTimeAdjustmentFieldsSchema.extend({
  version: z.number().int().positive(),
  contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.object({ id: z.uuid(), name: z.string() }),
});
export const workTimeAdjustmentsCommandSchema = workTimeAdjustmentFieldsSchema.extend({
  version: z.number().int().positive(), requestId: z.uuid(), reason: z.string().trim().min(1).max(2000),
}).strict();
export const workTimeCalculationSchema = z.object({
  algorithmVersion: z.literal('remaining_work_v2'),
  baseMinutes: z.number().int().nonnegative().safe().nullable(),
  factorPercent: z.number().int().min(1).max(1000).nullable(),
  fixedMinutes: z.number().int().min(0).max(5760).nullable(),
  adjustmentVersion: z.number().int().positive().nullable(),
  adjustmentStatus: z.enum(['not_configured', 'current', 'needs_review', 'incomplete']),
  missingFields: z.array(z.enum(['factorPercent', 'visitMinutes', 'deliveryMinutes', 'installationMinutes', 'collectionMinutes', 'sourceEstimateExcludesAdjustments'])).optional(),
});
export type WorkTimeAdjustments = z.infer<typeof workTimeAdjustmentsSchema>;
export type WorkTimeAdjustmentsCommand = z.infer<typeof workTimeAdjustmentsCommandSchema>;
export const allowanceMinutesInputSchema = z.string().trim().transform((value) => value === '' ? null : Number(value)).pipe(allowanceMinutes);
export const workTimeFactorInputSchema = z.string().trim().transform((value) => value === '' ? null : Number(value))
  .pipe(workTimeAdjustmentFieldsSchema.shape.factorPercent);

export const workTimeOperations = [
  { key: 'delivery', field: 'deliveryMinutesPerUnit', total: 'totalDeliveryMilli' },
  { key: 'installation', field: 'installationMinutesPerUnit', total: 'totalInstallationMilli' },
  { key: 'collection', field: 'collectionMinutesPerUnit', total: 'totalCollectionMilli' },
] as const;

export const workTimeRateInputSchema = z.string().trim()
  .transform((value) => value === '' ? null : Number(value)).pipe(minutesPerUnit);
