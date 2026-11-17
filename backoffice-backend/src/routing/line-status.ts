import type { z } from 'zod';
import type { Appointment, Delivery } from '../domain/model';
import { effectiveResults, lineServiceStatuses } from '../domain/rules';
import { RouteLineStatusSchema, type RouteRuntime } from './lifecycle-contracts';

export type RouteLineStop = { appointmentId: string; deliveryId: string; appointment: Appointment; delivery: Delivery };
export type RouteLineStatus = z.infer<typeof RouteLineStatusSchema>;

/** The route screen, warehouse receipt and dispatcher queue share exact visit/line facts. */
export function routeLineStatuses(stops: readonly RouteLineStop[], runtime: RouteRuntime): RouteLineStatus[] {
  return stops.flatMap((stop) => {
    const statuses = new Map(lineServiceStatuses(stop.delivery).map((line) => [line.sourceLineId, line]));
    const results = effectiveResults(stop.delivery).filter(({ appointmentId }) => appointmentId === stop.appointment.id);
    return (stop.appointment.workScope?.lines ?? []).map((line) => {
      const status = statuses.get(line.sourceLineId);
      const quantities = results.flatMap(({ quantities }) => quantities).filter(({ sourceLineId }) => sourceLineId === line.sourceLineId);
      const actual = (key: 'deliveredMilli' | 'installedMilli' | 'collectedMilli') => quantities.reduce((sum, quantity) => sum + (quantity[key] ?? 0), 0);
      const receipt = (kind: 'collection' | 'undelivered') => runtime.warehouseReceipts.flatMap(({ items }) => items)
        .filter((item) => item.appointmentId === stop.appointmentId && item.sourceLineId === line.sourceLineId && item.kind === kind).reduce((sum, item) => sum + item.quantityMilli, 0);
      const orderId = line.sourceItem.saleOrderId ?? stop.delivery.source.saleOrderId;
      const orderName = stop.delivery.source.salesOrders?.find(({ id }) => id === orderId)?.name
        ?? (orderId === stop.delivery.source.saleOrderId ? stop.delivery.source.saleOrderName : `#${orderId}`);
      return RouteLineStatusSchema.parse({ deliveryId: stop.deliveryId, appointmentId: stop.appointmentId, sourceLineId: line.sourceLineId,
        orderName, productName: line.sourceItem.name, uom: line.sourceItem.uom,
        plannedDeliveryMilli: line.deliveryMilli, plannedInstallationMilli: line.installationMilli, plannedCollectionMilli: line.collectionMilli,
        deliveredMilli: actual('deliveredMilli'), installedMilli: actual('installedMilli'), collectedMilli: actual('collectedMilli'),
        remainingDeliveryMilli: status?.remainingDeliveryMilli ?? Math.max(0, line.deliveryMilli - actual('deliveredMilli')),
        remainingInstallationMilli: status?.remainingInstallationMilli ?? Math.max(0, line.installationMilli - actual('installedMilli')),
        remainingCollectionMilli: status?.remainingCollectionMilli ?? Math.max(0, line.collectionMilli - actual('collectedMilli')),
        remainingBasis: status ? 'current_delivery' : 'visit_snapshot_source_missing',
        availableDeliveryMilli: status?.availableDeliveryMilli ?? 0, availableInstallationMilli: status?.availableInstallationMilli ?? 0, availableCollectionMilli: status?.availableCollectionMilli ?? 0,
        planningBlockedReason: status?.planningBlockedReason ?? (status ? null : 'source_line_missing'),
        reportMissing: !['completed', 'failed', 'cancelled'].includes(stop.appointment.status),
        incompleteWork: results.flatMap(({ incompleteWork }) => incompleteWork ?? []).filter(({ sourceLineId }) => sourceLineId === line.sourceLineId).map(({ operation, reason, note }) => ({ operation, reason, note: note ?? null })),
        warehouseReceivedCollectionMilli: receipt('collection'), warehouseReceivedUndeliveredMilli: receipt('undelivered'),
        declaration: runtime.reconciliation?.lines.find((entry) => entry.appointmentId === stop.appointmentId && entry.sourceLineId === line.sourceLineId) ?? null,
        packagingStatus: 'unknown',
      });
    });
  });
}

/** Unknown undelivered custody is never converted into an invented warehouse receipt. */
export function cargoReceiptBalance(line: RouteLineStatus, kind: 'collection' | 'undelivered'): number {
  if (kind === 'collection') return Math.max(0, line.collectedMilli - line.warehouseReceivedCollectionMilli);
  const cargo = line.declaration?.cargo.find((entry) => entry.kind === kind);
  return cargo?.quantityMilli !== null && cargo?.quantityMilli !== undefined && ['vehicle', 'awaiting_receipt'].includes(cargo.location)
    ? Math.max(0, cargo.quantityMilli - line.warehouseReceivedUndeliveredMilli) : 0;
}
