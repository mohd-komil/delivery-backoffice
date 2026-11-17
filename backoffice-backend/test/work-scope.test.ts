import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDelivery, DeliverySchema, IncompleteWorkSchema, mappedSourceService, type Appointment, type Delivery, type ExecutionInput, type OperatorActor, type WorkLineInput } from '../src/domain/model';
import { appointmentScopeReviewReason, changeRequiredWork, changeServicePlan, changeWorkTimes, closureBlockers, DomainError, lineServiceStatuses, lineWorkTimes, planVisitWork, raiseIssue, recordExecution, releaseDamagedWork, remainingWorkEstimate, startVisit } from '../src/domain/rules';
import { acceptSourceSnapshot, requiredWorkSourceConflicts } from '../src/domain/source-import';

const operator: OperatorActor = { id: randomUUID(), name: 'DEMO Planner', role: 'operator' };
const actor = { kind: 'crew' as const, id: randomUUID(), name: 'DEMO Responsible' };
const start = '2031-01-01T08:00:00Z';
const end = '2031-01-01T09:00:00Z';

function fixture(): Delivery {
  const item = { productId: 5, name: 'DEMO Same SKU chair', description: null, quantity: 2, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null };
  return { ...createDelivery({ pickingId: 1, pickingName: 'SCOPE/DEMO/1', saleOrderId: 1, saleOrderName: 'SO/1',
    salesOrders: [{ id: 1, name: 'SO/1' }, { id: 2, name: 'SO/2' }], sourceState: 'assigned', salesTeam: 'DEMO',
    customer: { id: 1, name: 'DEMO Customer', address: 'DEMO Street 1', city: 'Catania', country: 'IT', phones: ['+39000000001'], email: null, contact: null },
    items: [{ ...item, sourceLineId: 11, saleOrderId: 1 }, { ...item, sourceLineId: 22, saleOrderId: 2 }], serviceType: null, estimatedMinutes: 120, notes: null,
  }, randomUUID()), servicePlan: { defaultService: 'delivery_installation', overrides: [] } };
}

function line(sourceLineId: number, deliveryMilli = 0, installationMilli = 0, collectionMilli = 0): WorkLineInput {
  return { sourceLineId, deliveryMilli, installationMilli, collectionMilli };
}

function book(delivery: Delivery, workLines: WorkLineInput[]): Appointment {
  const workScope = planVisitWork(delivery, workLines, operator, start);
  const appointment: Appointment = { id: randomUUID(), startsAt: start, endsAt: end, status: 'booked', cancellationReason: null,
    returnRequestId: null, workScope, assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO Team',
      people: [{ id: actor.id, name: actor.name, external: false }], tasks: [{ id: randomUUID(), templateId: randomUUID(),
        title: 'DEMO Check', severity: 'low', order: 1, checklist: [{ id: randomUUID(), label: 'DEMO Check', done: true, waiver: null }] }] }],
    responsibleParticipant: { id: actor.id, name: actor.name }, customerConfirmation: { confirmedAt: start, confirmedBy: { id: operator.id, name: operator.name } }, results: [] };
  delivery.appointments.push(appointment);
  return appointment;
}

function command(appointment: Appointment, quantities: ExecutionInput['quantities'], incompleteWork?: ExecutionInput['incompleteWork']): ExecutionInput {
  return { id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null, actualStart: start, actualEnd: end,
    summary: 'DEMO product work', responsiblePersonId: actor.id, quantities, incompleteWork,
    completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))),
    evidence: [], customerSignature: { status: 'signed', signerName: 'DEMO Customer', text: 'DEMO approval', at: end },
    crewSignature: { status: 'signed', signerName: actor.name, text: 'DEMO responsible approval', at: end } };
}

function status(delivery: Delivery, id = 11) {
  const found = lineServiceStatuses(delivery).find((line) => line.sourceLineId === id);
  assert.ok(found);
  return found;
}

function fails(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

void test('a local quantity exception stays with its order line, scales the estimate and survives a compatible source refresh', () => {
  const initial = fixture();
  assert.equal(remainingWorkEstimate(initial).minutes, 120);
  const adjusted = changeRequiredWork(initial, { sourceLineId: 11,
    quantities: { deliveryMilli: 2000, installationMilli: 1000, collectionMilli: 0 },
    reason: 'Only one of these two chairs needs assembly.' }, operator, start);
  assert.equal(status(initial).totalInstallationMilli, 2000);
  assert.equal(status(adjusted).totalInstallationMilli, 1000);
  assert.equal(status(adjusted, 22).totalInstallationMilli, 2000);
  assert.equal(remainingWorkEstimate(adjusted).minutes, 105);

  const refreshed = structuredClone(adjusted.source);
  refreshed.notes = 'Updated source notes';
  assert.deepEqual(requiredWorkSourceConflicts(adjusted, refreshed), []);
  acceptSourceSnapshot(adjusted, refreshed);
  assert.equal(status(adjusted).totalInstallationMilli, 1000);

  const replaced = { ...refreshed, items: refreshed.items.map((item) => item.sourceLineId === 11
    ? { ...item, saleOrderLineId: 51 } : item) };
  const reduced = { ...refreshed, items: refreshed.items.map((item) => item.sourceLineId === 11
    ? { ...item, quantity: 1 } : item) };
  assert.deepEqual(requiredWorkSourceConflicts(adjusted, replaced), [11]);
  assert.deepEqual(requiredWorkSourceConflicts(adjusted, reduced), [11]);

  const newDefault = changeServicePlan(adjusted, { defaultService: 'delivery_only' });
  assert.equal(status(newDefault).service, 'delivery_installation');
  assert.equal(status(newDefault, 22).service, 'delivery_only');
  assert.throws(() => changeServicePlan(newDefault, { sourceLineId: 11, service: null }), fails('RESET_REQUIRED_WORK_FIRST'));
  const reset = changeRequiredWork(newDefault, { sourceLineId: 11, quantities: null, reason: 'Restore full assembly.' }, operator, end);
  assert.equal(status(reset).totalInstallationMilli, 2000);
  assert.equal(status(reset).requiredQuantitiesCustomized, false);

  const deliveryOnlyWork = changeRequiredWork(reset, { sourceLineId: 11,
    quantities: { deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 },
    reason: 'The customer cancelled installation.' }, operator, end);
  const withRates = changeWorkTimes(deliveryOnlyWork, { sourceLineId: 11,
    deliveryMinutesPerUnit: 5, installationMinutesPerUnit: 45, collectionMinutesPerUnit: null }, operator, end);
  const estimate = lineWorkTimes(withRates).find(({ sourceLineId }) => sourceLineId === 11);
  assert.equal(estimate?.installationMinutesPerUnit, 45);
  assert.equal(estimate?.remainingMinutes, 10, 'The estimate counts the two deliveries and zero installations');
});

void test('product problems create distinct order-line issues, link only matching photos and replay without duplication', () => {
  const delivery = fixture();
  const visit = book(delivery, [line(11, 1000), line(22, 1000)]);
  const photoA = randomUUID(); const photoB = randomUUID(); const generalPhoto = randomUUID();
  const report: ExecutionInput = { ...command(visit, [{ sourceLineId: 11, deliveredMilli: 1000 }, { sourceLineId: 22, deliveredMilli: 1000 }]),
    itemChecks: [{ sourceLineId: 11, status: 'problem', note: 'First order: scratch.' }, { sourceLineId: 22, status: 'problem', note: 'Second order: loose hinge.' }],
    evidence: [{ id: photoA, type: 'photo', itemIds: [11] }, { id: photoB, type: 'photo', itemIds: [22] }, { id: generalPhoto, type: 'photo', itemIds: [] }] };
  const reported = recordExecution(delivery, report, actor, end);
  assert.equal(reported.issues.length, 2);
  const first = reported.issues.find(({ itemIds }) => itemIds.includes(11));
  const second = reported.issues.find(({ itemIds }) => itemIds.includes(22));
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.photoIds, [photoA]); assert.deepEqual(second.photoIds, [photoB]);
  assert.equal(first.appointmentId, visit.id); assert.equal(first.originResultId, report.id);
  assert.deepEqual(reported.appointments[0]?.results[0]?.issueLinks, [{ sourceLineId: 11, issueId: first.id }, { sourceLineId: 22, issueId: second.id }]);
  assert.deepEqual(recordExecution(reported, report, actor, end), reported);
  assert.equal(delivery.issues.length, 0, 'Validation and creation never mutate the input aggregate');
});

void test('known manual issues require the correct source line and visit; ambiguous matching requires an explicit choice', () => {
  const delivery = fixture(); const visit = book(delivery, [line(11, 1000)]);
  const issue = { id: randomUUID(), type: 'other' as const, description: 'Known first-order problem', itemIds: [11], photoIds: [], notes: null };
  const known = raiseIssue(delivery, issue, operator, start, visit.id);
  assert.throws(() => raiseIssue(delivery, { ...issue, type: 'damage', itemIds: [] }, operator, start, visit.id), fails('DAMAGE_LINE_REQUIRED'));
  const report: ExecutionInput = { ...command(visit, [{ sourceLineId: 11, deliveredMilli: 1000 }]),
    itemChecks: [{ sourceLineId: 11, status: 'problem', note: 'Same incident' }] };
  assert.equal(recordExecution(known, report, actor, end).issues.length, 1);
  const duplicate = raiseIssue(known, { ...issue, id: randomUUID(), description: 'Another incident on the same product' }, operator, start, visit.id);
  assert.throws(() => recordExecution(duplicate, report, actor, end), fails('REPORT_ISSUE_SELECTION_REQUIRED'));
  const selected = recordExecution(duplicate, { ...report, itemChecks: [{ sourceLineId: 11, status: 'problem', note: null, linkedIssueId: issue.id }] }, actor, end);
  assert.equal(selected.issues.length, 2);
  assert.deepEqual(selected.appointments[0]?.results[0]?.issueLinks, [{ sourceLineId: 11, issueId: issue.id }]);
  const wrongLine = raiseIssue(delivery, { ...issue, itemIds: [22] }, operator, start, visit.id);
  assert.throws(() => recordExecution(wrongLine, { ...report, itemChecks: [{ sourceLineId: 11, status: 'problem', note: null, linkedIssueId: issue.id }] }, actor, end), fails('INVALID_REPORT_ISSUE'));
  const legacy = raiseIssue(delivery, issue, operator, start);
  assert.equal(recordExecution(legacy, { ...report, itemChecks: [{ sourceLineId: 11, status: 'problem', note: null, linkedIssueId: issue.id }] }, actor, end).issues.length, 1);
  const otherVisit = book(delivery, [line(22, 1000)]);
  const elsewhere = raiseIssue(delivery, issue, operator, start, otherVisit.id);
  assert.throws(() => recordExecution(elsewhere, { ...report, itemChecks: [{ sourceLineId: 11, status: 'problem', note: null, linkedIssueId: issue.id }] }, actor, end), fails('INVALID_REPORT_ISSUE'));
});

void test('incomplete damage blocks remaining work without creating an Issue and only an explained dispatcher release restores planning', () => {
  const delivery = fixture(); const visit = book(delivery, [line(11, 1000)]);
  const report = command(visit, [], [{ sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'Chair leg damaged.' }]);
  const damaged = recordExecution(delivery, report, actor, end);
  assert.equal(damaged.issues.length, 0);
  assert.equal(damaged.workHolds?.length, 1);
  assert.equal(status(damaged).planningBlockedReason, 'damage_hold');
  assert.equal(status(damaged, 22).planningBlockedReason, null, 'The same SKU in another order remains independent');
  assert.throws(() => book(damaged, [line(11, 1000)]), fails('DAMAGED_WORK_NOT_READY'));
  assert.throws(() => releaseDamagedWork(damaged, 11, ' ', operator, end));
  const ready = releaseDamagedWork(damaged, 11, 'Replacement inspected and ready at the warehouse.', operator, end);
  assert.deepEqual(ready.appointments, damaged.appointments);
  assert.equal(ready.workHolds?.[0]?.release?.by.id, operator.id);
  assert.equal(status(ready).planningBlockedReason, null);
  assert.throws(() => releaseDamagedWork(ready, 11, 'Repeat click', operator, end), fails('WORK_ALREADY_READY'));
  assert.ok(book(ready, [line(11, 1000)]));
});

void test('damage discovered during a visit does not prevent its report; issue resolution and corrections never silently release holds', () => {
  const delivery = fixture(); const visit = book(delivery, [line(11, 1000)]); visit.status = 'in_progress';
  const issue = { id: randomUUID(), type: 'damage' as const, description: 'Damage discovered during unloading', itemIds: [11], photoIds: [], notes: null };
  const known = raiseIssue(delivery, issue, actor, start, visit.id);
  const report: ExecutionInput = { ...command(visit, [], [{ sourceLineId: 11, operation: 'delivery', reason: 'damage', note: null }]),
    itemChecks: [{ sourceLineId: 11, status: 'problem', problemType: 'damage', note: null }] };
  const reported = recordExecution(known, report, actor, end);
  assert.equal(reported.workHolds?.length, 1, 'The known issue and its report share the damage hold');
  const resolvedIssue = reported.issues[0]; assert.ok(resolvedIssue);
  resolvedIssue.status = 'resolved'; resolvedIssue.resolvedAt = end; resolvedIssue.resolvedBy = operator.id; resolvedIssue.resolution = 'Issue administratively resolved';
  assert.equal(status(reported).planningBlockedReason, 'damage_hold');
  const historical = structuredClone(reported.appointments[0]?.results[0]);
  const correction: ExecutionInput = { ...report, id: randomUUID(), supersedesResultId: report.id, correctionReason: 'Clarified inspection note',
    itemChecks: [{ sourceLineId: 11, status: 'problem', problemType: 'damage', note: 'Same physical damage.' }] };
  const corrected = recordExecution(reported, correction, actor, end);
  assert.equal(corrected.issues.length, 1); assert.equal(corrected.workHolds?.length, 1);
  assert.equal(status(corrected).planningBlockedReason, 'damage_hold');
  assert.deepEqual(corrected.appointments[0]?.results[0], historical);
  const noProblem = recordExecution(corrected, { ...correction, id: randomUUID(), supersedesResultId: correction.id, itemChecks: [{ sourceLineId: 11, status: 'ok', note: null }] }, actor, end);
  assert.equal(noProblem.workHolds?.length, 1); assert.equal(status(noProblem).planningBlockedReason, 'damage_hold');
});

void test('a hold flags already booked work without cancelling it, and genuine later damage creates a new hold after release', () => {
  const delivery = fixture(); const first = book(delivery, [line(11, 1000)]); const later = book(delivery, [line(11, 1000)]);
  const report = command(first, [], [{ sourceLineId: 11, operation: 'delivery', reason: 'damage', note: null }]);
  const damaged = recordExecution(delivery, report, actor, end);
  const booked = damaged.appointments.find(({ id }) => id === later.id); assert.ok(booked);
  assert.equal(booked.status, 'booked'); assert.equal(appointmentScopeReviewReason(damaged, booked), 'damage_hold');
  assert.throws(() => startVisit(damaged, booked.id, actor), fails('VISIT_WORK_SCOPE_REVIEW_REQUIRED'));
  const ready = releaseDamagedWork(damaged, 11, 'Replacement received.', operator, end);
  const corrected = recordExecution(ready, { ...report, id: randomUUID(), supersedesResultId: report.id, correctionReason: 'Clarified original reason' }, actor, end);
  assert.equal(corrected.workHolds?.length, 1); assert.ok(corrected.workHolds?.[0]?.release);
  const started = startVisit(corrected, booked.id, actor);
  const damagedAgain = recordExecution(started, command(booked, [], [{ sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'Replacement damaged in transit.' }]), actor, end);
  assert.equal(damagedAgain.workHolds?.length, 2);
  assert.equal(damagedAgain.workHolds?.filter((hold) => hold.release === undefined).length, 1);
  assert.equal(status(damagedAgain).planningBlockedReason, 'damage_hold');
});

void test('known teaching-source codes initialize services exactly and later source labels do not overwrite local choices', () => {
  assert.equal(mappedSourceService('delivery'), 'delivery_only');
  assert.equal(mappedSourceService('delivery_and_assembly'), 'delivery_installation');
  assert.equal(mappedSourceService('installation_only'), 'installation_only');
  for (const unknown of [null, 'Delivery', 'Delivery & assembly', 'delivery with optional installation', 'delivery_and_assembly ']) {
    assert.equal(mappedSourceService(unknown), null);
  }
  const fresh = createDelivery({ ...fixture().source, serviceType: 'delivery_and_assembly' }, randomUUID());
  assert.deepEqual(fresh.servicePlan, { defaultService: 'delivery_installation', defaultOrigin: 'source', overrides: [] });
  assert.equal(status(fresh).remainingInstallationMilli, 2000);
  const selected = changeServicePlan(fresh, { sourceLineId: 22, service: 'collection_only' });
  selected.source.serviceType = 'delivery';
  assert.equal(status(selected).service, 'delivery_installation');
  assert.equal(status(selected, 22).service, 'collection_only');
});

void test('a newly mapped source code cannot silently reinterpret legacy work without a local service decision', () => {
  const initial = fixture();
  const first = book(initial, [line(11, 1000)]);
  const worked = recordExecution(initial, command(first, [{ sourceLineId: 11, deliveredMilli: 1000 }]), actor, end);
  delete worked.servicePlan;
  worked.source.serviceType = 'delivery_and_assembly';
  const history = structuredClone(worked.appointments);
  assert.equal(status(worked).service, null);
  assert.equal(status(worked).planningBlockedReason, 'unknown_service');
  assert.equal(status(worked).deliveredMilli, 1000);
  const reviewed = changeServicePlan(worked, { sourceLineId: 11, service: 'delivery_installation' });
  assert.equal(status(reviewed).remainingDeliveryMilli, 1000);
  assert.equal(status(reviewed).remainingInstallationMilli, 2000);
  assert.deepEqual(reviewed.appointments, history);
});

void test('unknown service is never inferred; explicit known lines can be planned independently', () => {
  const delivery = fixture();
  delete delivery.servicePlan;
  assert.equal(status(delivery).service, null);
  assert.equal(status(delivery).planningBlockedReason, 'unknown_service');
  assert.ok(closureBlockers(delivery).some((blocker) => blocker.startsWith('Service requires review:')));
  assert.throws(() => book(delivery, [line(11, 1000)]), fails('SERVICE_REQUIRED'));
  const selected = changeServicePlan(delivery, { sourceLineId: 11, service: 'delivery_only' });
  assert.equal(selected.servicePlan.defaultService, null);
  assert.equal(book(selected, [line(11, 1000)]).workScope?.lines[0]?.sourceItem.saleOrderId, 1);
  assert.equal(status(selected, 22).service, null);
});

void test('reservations are by source line and operation; cancellation releases only unperformed work', () => {
  const delivery = fixture();
  const first = book(delivery, [line(11, 1000)]);
  assert.equal(status(delivery).reservedDeliveryMilli, 1000);
  assert.equal(status(delivery).availableDeliveryMilli, 1000);
  assert.equal(status(delivery, 22).availableDeliveryMilli, 2000, 'Identical SKU in another order is independent');
  assert.throws(() => book(delivery, [line(11, 1001)]), fails('WORK_ALREADY_RESERVED'));
  const next = book(delivery, [line(11, 1000)]);
  first.status = 'cancelled';
  assert.equal(status(delivery).availableDeliveryMilli, 1000);
  assert.equal(status(delivery).reservedDeliveryMilli, 1000);
  assert.equal(status(delivery).deliveredMilli, 0);
  assert.equal(next.workScope?.lines[0]?.deliveryMilli, 1000);
});

void test('default service changes preserve individual, planned and reported lines and immutable snapshots', () => {
  const delivery = fixture();
  const visit = book(delivery, [line(11, 2000)]);
  const originalScope = structuredClone(visit.workScope);
  const changed = changeServicePlan(delivery, { defaultService: 'collection_only' });
  assert.equal(status(changed).service, 'delivery_installation');
  assert.equal(status(changed, 22).service, 'collection_only');
  assert.deepEqual(changed.appointments[0]?.workScope, originalScope);
  assert.throws(() => changeServicePlan(changed, { sourceLineId: 11, service: 'delivery_only' }), fails('LINE_WORK_RECORDED'));
  const worked = recordExecution(changed, command(visit, [{ sourceLineId: 11, deliveredMilli: 1000 }], [
    { sourceLineId: 11, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'One chair was left at the warehouse.' },
  ]), actor, end);
  const result = worked.appointments[0]?.results[0];
  assert.ok(result);
  assert.deepEqual(result.workScopeSnapshot, originalScope);
  const resultBefore = structuredClone(result);
  const later = changeServicePlan(worked, { defaultService: 'installation_only' });
  assert.deepEqual(later.appointments[0]?.results[0], resultBefore);
  assert.equal(status(later).remainingDeliveryMilli, 1000);
  assert.equal(status(later).remainingInstallationMilli, 2000);
});

void test('partial delivery releases its unperformed reservation and repeat visits plan only remaining operations', () => {
  const initial = fixture();
  const first = book(initial, [line(11, 2000, 2000)]);
  const partial = recordExecution(initial, command(first, [{ sourceLineId: 11, deliveredMilli: 1000 }], [
    { sourceLineId: 11, operation: 'delivery', reason: 'missing_goods_or_parts', note: 'One chair was not loaded.' },
    { sourceLineId: 11, operation: 'installation', reason: 'time_shortage', note: 'Installation requires a repeat visit.' },
  ]), actor, end);
  assert.equal(partial.appointments[0]?.status, 'completed');
  assert.equal(status(partial).reservedDeliveryMilli, 0);
  assert.equal(status(partial).availableDeliveryMilli, 1000);
  assert.equal(status(partial).availableInstallationMilli, 2000);
  assert.throws(() => book(partial, [line(11, 2000)]), fails('WORK_ALREADY_RESERVED'));
  const installation = book(partial, [line(11, 0, 1000)]);
  assert.equal(installation.workScope?.lines[0]?.deliveryMilli, 0);
  const installed = recordExecution(partial, command(installation, [{ sourceLineId: 11, deliveredMilli: 0, installedMilli: 1000 }]), actor, end);
  assert.equal(status(installed).deliveredMilli, 1000);
  assert.equal(status(installed).installedMilli, 1000);
  assert.equal(status(installed).remainingInstallationMilli, 1000);
});

void test('finish rejects unplanned products and over-plan operations even when global remaining allows them', () => {
  const delivery = fixture();
  const visit = book(delivery, [line(11, 1000)]);
  assert.throws(() => recordExecution(delivery, command(visit, [{ sourceLineId: 22, deliveredMilli: 1000 }]), actor, end), fails('UNPLANNED_WORK'));
  assert.throws(() => recordExecution(delivery, command(visit, [{ sourceLineId: 11, deliveredMilli: 1001 }]), actor, end), fails('EXCESS_VISIT_WORK'));
  assert.throws(() => recordExecution(delivery, command(visit, [{ sourceLineId: 11, deliveredMilli: 1000, installedMilli: 1 }]), actor, end), fails('EXCESS_VISIT_WORK'));
  const simultaneous = fixture();
  const both = book(simultaneous, [line(11, 1000, 1000)]);
  assert.throws(() => recordExecution(simultaneous, command(both, [{ sourceLineId: 11, deliveredMilli: 0, installedMilli: 1000 }]), actor, end), fails('INSTALLATION_REQUIRES_DELIVERY'));
});

void test('future installation can be planned but cannot start by counting another booked delivery as stock', () => {
  const delivery = fixture();
  const outbound = book(delivery, [line(11, 2000)]);
  const installation = book(delivery, [line(11, 0, 2000)]);
  assert.equal(appointmentScopeReviewReason(delivery, installation), 'stock_pending');
  assert.throws(() => startVisit(delivery, installation.id, actor, start), fails('VISIT_WORK_SCOPE_REVIEW_REQUIRED'));
  const delivered = recordExecution(delivery, command(outbound, [{ sourceLineId: 11, deliveredMilli: 2000 }]), actor, end);
  assert.equal(appointmentScopeReviewReason(delivered, installation), null);
  assert.equal(startVisit(delivered, installation.id, actor, start).appointments.find((visit) => visit.id === installation.id)?.status, 'in_progress');
});

void test('simultaneous installation visits cannot both use the same physical units already at the customer', () => {
  const delivery = fixture();
  const outbound = book(delivery, [line(11, 1000)]);
  const delivered = recordExecution(delivery, command(outbound, [{ sourceLineId: 11, deliveredMilli: 1000 }]), actor, end);
  const first = book(delivered, [line(11, 0, 1000)]);
  const second = book(delivered, [line(11, 0, 1000)]);
  const started = startVisit(delivered, first.id, actor, start);
  assert.equal(appointmentScopeReviewReason(started, second), 'stock_pending');
  assert.throws(() => startVisit(started, second.id, actor, start), fails('VISIT_WORK_SCOPE_REVIEW_REQUIRED'));
});

void test('finish cannot substitute stock reserved by another started visit for its own failed delivery', () => {
  const initial = fixture();
  const outbound = book(initial, [line(11, 1000)]);
  const delivered = recordExecution(initial, command(outbound, [{ sourceLineId: 11, deliveredMilli: 1000 }]), actor, end);
  const combined = book(delivered, [line(11, 1000, 1000)]);
  const installation = book(delivered, [line(11, 0, 1000)]);
  const installationStarted = startVisit(delivered, installation.id, actor, start);
  const bothStarted = startVisit(installationStarted, combined.id, actor, start);
  const before = structuredClone(bothStarted);
  assert.throws(() => recordExecution(bothStarted, command(combined, [{ sourceLineId: 11, deliveredMilli: 0, installedMilli: 1000 }]), actor, end), fails('CUSTOMER_STOCK_RESERVED'));
  assert.deepEqual(bothStarted, before);
  const worked = recordExecution(bothStarted, command(combined, [{ sourceLineId: 11, deliveredMilli: 1000, installedMilli: 1000 }]), actor, end);
  assert.equal(appointmentScopeReviewReason(worked, installation), null);
  assert.equal(status(worked).deliveredMilli, 2000);
  assert.equal(status(worked).installedMilli, 1000);
});

void test('installation-only requires explicit customer stock confirmation without creating fictional delivered quantities', () => {
  const delivery = changeServicePlan(fixture(), { defaultService: 'installation_only' });
  assert.throws(() => book(delivery, [line(11, 0, 2000)]), fails('CUSTOMER_STOCK_CONFIRMATION_REQUIRED'));
  const visit = book(delivery, [{ ...line(11, 0, 2000), customerStockConfirmed: true }]);
  const worked = recordExecution(delivery, command(visit, [{ sourceLineId: 11, deliveredMilli: 0, installedMilli: 2000 }]), actor, end);
  assert.equal(status(worked).deliveredMilli, 0);
  assert.equal(status(worked).installedMilli, 2000);
  assert.equal(worked.appointments[0]?.results[0]?.workScopeSnapshot?.lines[0]?.customerStockConfirmed, true);
});

void test('material source changes require scope review, while harmless note changes do not rewrite the plan', () => {
  const delivery = fixture();
  const visit = book(delivery, [line(11, 1000)]);
  const before = structuredClone(visit.workScope);
  delivery.source.notes = 'DEMO updated note';
  assert.equal(appointmentScopeReviewReason(delivery, visit), null);
  delivery.source.customer.address = 'DEMO New Street 2';
  assert.equal(appointmentScopeReviewReason(delivery, visit), 'source_changed');
  assert.throws(() => startVisit(delivery, visit.id, actor, start), fails('VISIT_WORK_SCOPE_REVIEW_REQUIRED'));
  visit.workScope = planVisitWork(delivery, [line(11, 1000)], operator, end, visit.id);
  assert.equal(visit.workScope.revision, 2);
  assert.notEqual(visit.workScope.sourceFingerprint, before?.sourceFingerprint);
  assert.equal(appointmentScopeReviewReason(delivery, visit), null);
});

void test('legacy visits need explicit review; started review is bounded to absent scope and no results', () => {
  const delivery = fixture();
  const visit = book(delivery, [line(11, 1000)]);
  delete visit.workScope;
  assert.equal(appointmentScopeReviewReason(delivery, visit), 'missing_scope');
  assert.equal(status(delivery).planningBlockedReason, 'legacy_scope_review');
  assert.throws(() => startVisit(delivery, visit.id, actor, start), fails('VISIT_WORK_SCOPE_REVIEW_REQUIRED'));
  assert.throws(() => book(delivery, [line(22, 1000)]), fails('WORK_PLANNING_BLOCKED'));
  visit.status = 'in_progress';
  visit.actualStartedAt = start;
  const before = structuredClone(visit.assignments);
  visit.workScope = planVisitWork(delivery, [line(11, 1000)], operator, end, visit.id);
  assert.equal(visit.actualStartedAt, start);
  assert.deepEqual(visit.assignments, before);
  assert.throws(() => planVisitWork(delivery, [line(11, 500)], operator, end, visit.id), fails('WORK_SCOPE_LOCKED'));
});

void test('a correction cannot consume work already reserved by the repeat visit', () => {
  const delivery = fixture();
  const original = book(delivery, [line(11, 2000)]);
  const damaged = recordExecution(delivery, command(original, [{ sourceLineId: 11, deliveredMilli: 1000 }], [
    { sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'Second chair remained on the vehicle.' },
  ]), actor, end);
  const partial = releaseDamagedWork(damaged, 11, 'Replacement checked before reserving the repeat.', operator, end);
  const result = partial.appointments[0]?.results[0];
  assert.ok(result);
  book(partial, [line(11, 1000)]);
  const correction = { ...command(original, [{ sourceLineId: 11, deliveredMilli: 1500 }]), supersedesResultId: result.id, correctionReason: 'DEMO corrected count' };
  const before = structuredClone(partial);
  assert.throws(() => recordExecution(partial, correction, actor, end), fails('WORK_ALREADY_RESERVED'));
  assert.deepEqual(partial, before);
});

void test('incomplete reasons belong to each planned operation and source line, even for the same SKU in two orders', () => {
  const initial = fixture();
  const visit = book(initial, [line(11, 2000, 2000), line(22, 2000)]);
  const quantities = [{ sourceLineId: 11, deliveredMilli: 1000, installedMilli: 1000 }];
  const reasons: ExecutionInput['incompleteWork'] = [
    { sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'First order: one chair damaged.' },
    { sourceLineId: 11, operation: 'installation', reason: 'missing_goods_or_parts', note: 'First order: missing second chair.' },
    { sourceLineId: 22, operation: 'delivery', reason: 'customer_refused', note: 'Second order refused.' },
  ];
  const before = structuredClone(initial);
  assert.throws(() => recordExecution(initial, command(visit, quantities), actor, end), fails('INCOMPLETE_WORK_REASON_REQUIRED'));
  assert.throws(() => recordExecution(initial, command(visit, quantities, reasons.slice(0, 2)), actor, end), fails('INCOMPLETE_WORK_REASON_REQUIRED'));
  assert.deepEqual(initial, before);
  const input = command(visit, quantities, reasons);
  const worked = recordExecution(initial, input, actor, end);
  const result = worked.appointments[0]?.results[0];
  assert.ok(result);
  assert.deepEqual(result.incompleteWork, reasons);
  assert.deepEqual(result.workScopeSnapshot?.lines.map(({ sourceItem }) => [sourceItem.sourceLineId, sourceItem.saleOrderId, sourceItem.productId]), [[11, 1, 5], [22, 2, 5]]);
  assert.deepEqual([status(worked).remainingDeliveryMilli, status(worked).remainingInstallationMilli, status(worked, 22).remainingDeliveryMilli], [1000, 1000, 2000]);
  assert.equal(recordExecution(worked, input, actor, end), worked);
  assert.throws(() => recordExecution(worked, { ...input, incompleteWork: reasons.map((entry) => ({ ...entry, note: 'Changed explanation' })) }, actor, end), fails('RESULT_ID_CONFLICT'));
  assert.throws(() => book(worked, [line(11, 1000, 1000), line(22, 2000)]), fails('DAMAGED_WORK_NOT_READY'));
  const ready = releaseDamagedWork(worked, 11, 'First order replacement ready.', operator, end);
  const repeat = book(ready, [line(11, 1000, 1000), line(22, 2000)]);
  assert.deepEqual(repeat.workScope?.lines.map(({ sourceLineId, deliveryMilli, installationMilli }) => [sourceLineId, deliveryMilli, installationMilli]), [[11, 1000, 1000], [22, 2000, 0]]);
});

void test('full planned work has no reason even when other operations and lines remain outside the visit plan', () => {
  const initial = fixture();
  const visit = book(initial, [line(11, 1000)]);
  const input = command(visit, [{ sourceLineId: 11, deliveredMilli: 1000 }]);
  for (const extra of [
    { sourceLineId: 11, operation: 'delivery' as const, reason: 'damage' as const, note: null },
    { sourceLineId: 11, operation: 'installation' as const, reason: 'time_shortage' as const, note: null },
    { sourceLineId: 22, operation: 'delivery' as const, reason: 'access' as const, note: null },
    { sourceLineId: 999, operation: 'delivery' as const, reason: 'access' as const, note: null },
  ]) {
    assert.throws(() => recordExecution(initial, { ...input, incompleteWork: [extra] }, actor, end), fails('UNEXPECTED_INCOMPLETE_WORK_REASON'));
  }
  const worked = recordExecution(initial, input, actor, end);
  assert.deepEqual(worked.appointments[0]?.results[0]?.incompleteWork, []);
  assert.equal(recordExecution(worked, input, actor, end), worked, 'Omitted and explicit empty reasons replay consistently');
  assert.equal(status(worked).remainingInstallationMilli, 2000);
  assert.equal(status(worked, 22).remainingDeliveryMilli, 2000);
});

void test('zero quantities require reasons for every planned operation including collection', () => {
  const initial = changeServicePlan(fixture(), { sourceLineId: 22, service: 'collection_only' });
  const visit = book(initial, [line(11, 1000, 1000), line(22, 0, 0, 2000)]);
  const input = command(visit, [], [
    { sourceLineId: 11, operation: 'delivery', reason: 'access', note: 'Elevator inaccessible.' },
    { sourceLineId: 11, operation: 'installation', reason: 'access', note: null },
    { sourceLineId: 22, operation: 'collection', reason: 'customer_refused', note: null },
  ]);
  const worked = recordExecution(initial, input, actor, end);
  assert.equal(worked.appointments[0]?.status, 'completed');
  assert.deepEqual([status(worked).availableDeliveryMilli, status(worked).availableInstallationMilli, status(worked, 22).availableCollectionMilli], [2000, 2000, 2000]);
});

void test('incomplete reason input rejects duplicates, unknown enum fields and missing other explanation', () => {
  const entry = { sourceLineId: 11, operation: 'delivery', reason: 'other', note: '  Unexpected obstruction  ' };
  assert.equal(IncompleteWorkSchema.parse([entry])[0]?.note, 'Unexpected obstruction');
  for (const input of [
    [entry, entry], [{ ...entry, note: '   ' }], [{ ...entry, note: null }], [{ ...entry, note: 'x'.repeat(501) }],
    [{ ...entry, operation: 'unknown' }], [{ ...entry, reason: 'unknown' }], [{ ...entry, sku: 5 }],
    Array.from({ length: 1501 }, (_, index) => ({ ...entry, sourceLineId: index + 1 })),
  ]) assert.equal(IncompleteWorkSchema.safeParse(input).success, false);
});

void test('corrections validate reasons against the signed plan and preserve original reasons and legacy absence', () => {
  const initial = fixture();
  const visit = book(initial, [line(11, 2000)]);
  const first = recordExecution(initial, command(visit, [{ sourceLineId: 11, deliveredMilli: 1000 }], [
    { sourceLineId: 11, operation: 'delivery', reason: 'damage', note: 'Original observation.' },
  ]), actor, end);
  const original = first.appointments[0]?.results[0];
  assert.ok(original);
  const historical = structuredClone(original);
  const correction = { ...command(visit, [{ sourceLineId: 11, deliveredMilli: 1500 }]), supersedesResultId: original.id, correctionReason: 'Corrected handover count.' };
  assert.throws(() => recordExecution(first, correction, actor, end), fails('INCOMPLETE_WORK_REASON_REQUIRED'));
  const corrected = recordExecution(first, { ...correction, incompleteWork: [
    { sourceLineId: 11, operation: 'delivery', reason: 'other', note: '  Half a unit remained due to changed access.  ' },
  ] }, actor, end);
  assert.deepEqual(corrected.appointments[0]?.results[0], historical);
  assert.deepEqual(corrected.appointments[0]?.results[1]?.incompleteWork, [
    { sourceLineId: 11, operation: 'delivery', reason: 'other', note: 'Half a unit remained due to changed access.' },
  ]);
  assert.equal(status(corrected).remainingDeliveryMilli, 500);
  const legacy = structuredClone(first);
  const legacyResult = legacy.appointments[0]?.results[0];
  assert.ok(legacyResult);
  delete legacyResult.incompleteWork;
  assert.equal(Object.hasOwn(DeliverySchema.parse(legacy).appointments[0]?.results[0] ?? {}, 'incompleteWork'), false);
});
