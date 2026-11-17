import { ConflictException } from '@nestjs/common';
import { mappedSourceService, type Delivery } from '../domain/model';
import { priorWorkReviewReasons } from '../domain/rules';
import { sourcePlanningBlocked } from '../domain/source-import';

/** Shared prerequisites for standalone booking and atomic route publication. */
export function assertPlanningReady(delivery: Delivery): void {
  if (delivery.completedAt) throw new ConflictException('Reopen the delivery with a reason before changing work');
  if (delivery.sourceReview) throw new ConflictException('Source requires review; new planning is blocked');
  if (sourcePlanningBlocked(delivery)) throw new ConflictException('Review the pending source update before planning new work');
  if (priorWorkReviewReasons(delivery).length > 0) throw new ConflictException('Confirmed prior work requires review; new planning is blocked');
  if (!delivery.source.customer.address || !delivery.source.customer.city || delivery.source.customer.phones.length === 0) {
    throw new ConflictException('Address, city and a contact phone are required for planning');
  }
}

export function retainWorkServiceDefault(delivery: Delivery): void {
  if (delivery.servicePlan || delivery.appointments.some((appointment) => appointment.results.length > 0)) return;
  const defaultService = mappedSourceService(delivery.source.serviceType);
  if (defaultService !== null) delivery.servicePlan = { defaultService, defaultOrigin: 'source', overrides: [] };
}
