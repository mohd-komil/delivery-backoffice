import assert from 'node:assert/strict';
import { participantSchema, workScopeSchema } from '../src/lib/contracts';
import { routeDraftInputSchema } from '../src/lib/route-drafts';
import { publicationReviewSchema } from '../src/lib/route-publication';
import { routeOperationsSchema, type RouteOperations } from '../src/lib/route-operations';
import { detailFixture, user } from './refresh-fixtures';

export const routeId = '92000000-0000-4000-8000-000000000001';
export const personId = '92000000-0000-4000-8000-000000000002';
export const crewId = '92000000-0000-4000-8000-000000000003';
export const vehicleId = '92000000-0000-4000-8000-000000000004';
export const appointmentIds = ['92000000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000006'];
export const deliveryIds = ['92000000-0000-4000-8000-000000000007', '92000000-0000-4000-8000-000000000008'];
export const at = '2026-11-16T08:00:00.000Z';
export const later = '2026-11-16T10:00:00.000Z';
export const person = participantSchema.parse({ id: personId, version: 1, name: 'Marco Rossi', firstName: 'Marco', lastName: 'Rossi', preferredName: null, phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds: [] });
export const catalogs = { participants: [person], crews: [], vehicles: [], points: [] };
const actor = { id: user.id, name: user.name };
const product = detailFixture().delivery.source.items[0]; assert.ok(product);
const scopes = [0, 1].map((index) => workScopeSchema.parse({ revision: 1, sourceFingerprint: 'a'.repeat(64), confirmedAt: at, confirmedBy: actor,
  lines: [{ sourceLineId: 10 + index, deliveryMilli: 1000, installationMilli: 1000, collectionMilli: 0, service: 'delivery_installation', sourceItem: { ...product, sourceLineId: 10 + index, saleOrderId: index + 1 } }] }));
const plan = routeDraftInputSchema.parse({ name: 'DEMO route lifecycle', departAt: at, crewId, vehicleId, startPointId: 'depot', endPointId: 'depot', useLocalEstimates: true,
  stops: deliveryIds.map((deliveryId, index) => ({ deliveryId, appointmentId: appointmentIds[index], workMinutes: 30, customerWindow: { kind: 'unrestricted' } })), manualEstimates: [],
  planning: { participantIds: [personId], participantAvailability: [{ participantId: personId, workingIntervals: [{ startsAt: at, endsAt: later }], unavailableIntervals: [] }], vehicleAvailability: { startsAt: at, endsAt: later }, driver: { kind: 'participant', participantId: personId }, transferBufferMinutes: 10 } });
const review = publicationReviewSchema.parse({ routeId, draftVersion: 1, fingerprint: 'a'.repeat(64), publicationEnabled: true,
  timeline: { departAt: at, startPointId: 'depot', endPointId: 'depot', returnDepartAt: at, returnAt: later, stops: [], returnTravelMinutes: 10, returnTravelSource: 'local_demo', travelMinutes: 30, workMinutes: 60, waitingMinutes: 0, totalMinutes: 90 },
  feasibility: { status: 'feasible_estimate', checkedAt: at, fingerprint: 'b'.repeat(64), findings: [], workDurations: [] },
  stops: deliveryIds.map((deliveryId, index) => ({ deliveryId, pickingName: `DEMO/OUT/${index + 1}`, mode: index === 0 ? 'attach' : 'create', appointmentId: appointmentIds[index], startsAt: at, endsAt: later, workScope: scopes[index], assignments: [], responsibleParticipant: person, customerConfirmationStatus: 'awaiting_customer_confirmation' })) });

export function operationsFixture(status: RouteOperations['status'] = 'published'): RouteOperations {
  const underway = ['in_progress', 'returning', 'returned', 'closed'].includes(status);
  const returned = status === 'returned' || status === 'closed';
  return routeOperationsSchema.parse({ id: routeId, version: 1, status, name: plan.name, draft: plan, review, externalDriverPhone: null,
    resources: { crew: { id: crewId, name: 'Catania Uno' }, vehicle: { id: vehicleId, version: 1, name: 'DEMO van', plate: 'DEMO01', ownership: 'company', providerName: null, providerContact: null }, driver: { kind: 'participant', person }, participants: [person], start: { id: 'depot', name: 'Warehouse' }, end: { id: 'depot', name: 'Warehouse' } },
    runtime: { departed: underway ? { at, actor, note: 'Departed' } : null, returning: null, returned: returned ? { at: later, actualReturnedAt: later, actor, note: null } : null, aborted: null, cancelled: null, closed: null, skipped: [], reconciliation: null, warehouseReceipts: [], closureException: null }, routeResponsible: person, nextAppointmentId: returned ? null : appointmentIds[0],
    stops: deliveryIds.map((deliveryId, index) => ({ deliveryId, appointmentId: appointmentIds[index], sequence: index + 1, source: index === 0 ? 'attached' : 'created', pickingName: `DEMO/OUT/${index + 1}`, customerName: `Customer ${index + 1}`, address: 'Via Roma', city: 'Catania', entrance: null, customerWindow: { kind: 'unrestricted' }, eta: at, workStartAt: at, workEndAt: later, status: returned ? 'completed' : 'booked', confirmationStatus: index === 0 ? 'customer_confirmed' : 'awaiting_customer_confirmation', responsibleParticipant: person, workScope: scopes[index], canStart: underway && !returned && index === 0, startBlocker: null, skipped: false, reported: returned && index === 0 })),
    lines: deliveryIds.map((deliveryId, index) => ({ deliveryId, appointmentId: appointmentIds[index], sourceLineId: 10 + index, orderName: `DEMO/SO/${index + 1}`, productName: 'Same SKU table', uom: 'unit', plannedDeliveryMilli: 1000, plannedInstallationMilli: 1000, plannedCollectionMilli: 0, deliveredMilli: returned && index === 0 ? 500 : 0, installedMilli: 0, collectedMilli: 0, remainingDeliveryMilli: returned && index === 0 ? 500 : 1000, remainingInstallationMilli: 1000, remainingCollectionMilli: 0, availableDeliveryMilli: returned ? (index === 0 ? 500 : 1000) : 0, availableInstallationMilli: returned ? 1000 : 0, availableCollectionMilli: 0, planningBlockedReason: null, reportMissing: !returned || index === 1, incompleteWork: [], warehouseReceivedCollectionMilli: 0, warehouseReceivedUndeliveredMilli: 0, declaration: null, packagingStatus: 'unknown' })),
    capabilities: { canDepart: status === 'published', canAmend: status === 'published', canCancel: status === 'published', canReturn: false, canMarkReturned: underway && !returned, canReconcile: status === 'returned', canClose: false, departBlocker: null, returnBlocker: null, closureBlockers: ['Report and reconciliation are incomplete'] },
    history: [{ version: 1, action: 'route.published', actor, at, reason: null, status: 'published' }],
  });
}
