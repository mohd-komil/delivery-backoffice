import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  SourceSchema, createDelivery, type Appointment, type CrewActor, type Delivery,
  type ExecutionInput, type OperatorActor, type SourceSnapshot, type TaskTemplate,
} from '../src/domain/model';
import {
  DomainError, assignmentCoverage, closureBlockers, completeDelivery, confirmCustomerVisit, deliveredMilli,
  deriveProgress, deriveViews, instantiateTask, intervalsOverlap, quantityToMilli,
  recordExecution, reopenDelivery, startVisit, validateInterval, waiveChecklist,
  effectiveResults, raiseIssue, raiseReturnRequest, planVisitWork,
} from '../src/domain/rules';

const source: SourceSnapshot = {
  pickingId: 1, pickingName: 'DEMO/OUT/0001', saleOrderId: 1, saleOrderName: 'DEMO/SO/0001',
  sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
  customer: { id: 1, name: 'DEMO Customer', address: 'Demo Street 1', city: 'Messina', country: 'IT', phones: [], email: null, contact: null },
  serviceType: null, estimatedMinutes: null, notes: null,
  items: [{ sourceLineId: 10, productId: 2, name: 'DEMO Table', description: null, quantity: 1.125,
    uom: 'unit', configuration: 'Oak', ambient: 'Dining', notes: null, photoUrl: null }],
};
const actor: CrewActor = { kind: 'crew', id: randomUUID(), name: 'DEMO Representative' };
const operator: OperatorActor = { id: randomUUID(), name: 'DEMO Operator', role: 'operator' };
const template: TaskTemplate = {
  id: randomUUID(), version: 1, title: 'Assembly', severity: 'low', order: 2,
  checklist: ['Assemble the table', 'Remove packaging'], enabled: true,
};
const receivedAt = '2026-11-03T12:00:00Z';

const confirmationAt = '2026-11-03T07:00:00Z';

function fixture(confirmed = true): { delivery: Delivery; appointment: Appointment } {
  const delivery = createDelivery(source, randomUUID());
  delivery.servicePlan = { defaultService: 'delivery_only', overrides: [] };
  const appointment: Appointment = {
    id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T10:00:00Z',
    status: 'booked', cancellationReason: null, returnRequestId: null,
    assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO indoor',
      people: [{ id: actor.id, name: actor.name, external: false }], tasks: [instantiateTask(template)] }],
    results: [],
  };
  appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 1125, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt);
  delivery.appointments.push(appointment);
  if (!confirmed) return { delivery, appointment };

  const next = confirmCustomerVisit(delivery, appointment.id, operator, confirmationAt);
  const confirmedVisit = next.appointments[0];
  assert.ok(confirmedVisit);
  return { delivery: next, appointment: confirmedVisit };
}

function execution(appointment: Appointment, overrides: Partial<ExecutionInput> = {}): ExecutionInput {
  return {
    id: randomUUID(), appointmentId: appointment.id, actualStart: '2026-11-03T08:10:00Z', actualEnd: '2026-11-03T09:50:00Z',
    supersedesResultId: null, correctionReason: null,
    summary: 'DEMO delivered and assembled', responsiblePersonId: actor.id,
    quantities: [{ sourceLineId: 10, deliveredMilli: 1125 }],
    completedChecklistIds: appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id))),
    evidence: [],
    customerSignature: { status: 'signed', signerName: 'DEMO Customer', text: 'DEMO customer approval', at: '2026-11-03T09:50:00Z' },
    crewSignature: { status: 'signed', signerName: actor.name, text: 'DEMO crew approval', at: '2026-11-03T09:50:00Z' },
    ...overrides,
  };
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

void test('confirmation is recorded separately from execution and a scoped visit already in progress can finish', () => {
  const { delivery, appointment } = fixture(false);
  const input = execution(appointment);
  assert.throws(() => startVisit(delivery, appointment.id, actor), errorCode('CUSTOMER_CONFIRMATION_REQUIRED'));
  assert.throws(() => recordExecution(delivery, input, actor, receivedAt), errorCode('CUSTOMER_CONFIRMATION_REQUIRED'));
  assert.throws(() => startVisit(delivery, appointment.id, { ...actor, id: randomUUID() }), errorCode('CREW_NOT_ASSIGNED'));
  assert.equal(appointment.status, 'booked');
  assert.equal(appointment.customerConfirmation, undefined);

  const confirmed = confirmCustomerVisit(delivery, appointment.id, operator, confirmationAt);
  assert.deepEqual(confirmed.appointments[0]?.customerConfirmation, {
    confirmedAt: confirmationAt, confirmedBy: { id: operator.id, name: operator.name },
  });
  assert.equal(confirmed.appointments[0]?.status, 'booked');
  assert.equal(appointment.customerConfirmation, undefined);
  assert.equal(startVisit(confirmed, appointment.id, actor).appointments[0]?.status, 'in_progress');

  appointment.status = 'in_progress';
  const legacyResult = recordExecution(delivery, input, actor, receivedAt);
  assert.equal(legacyResult.appointments[0]?.status, 'completed');
  assert.equal(legacyResult.appointments[0]?.customerConfirmation, undefined);
});

void test('new source delivery is inbox, with genuinely unknown local planning values', () => {
  const delivery = createDelivery(source, randomUUID());
  assert.deepEqual(deriveViews(delivery), ['inbox']);
  assert.equal(delivery.instructions.elevator, 'unknown');
  assert.equal(delivery.instructions.floor, null);
  assert.equal(delivery.source.sourceState, 'assigned');
});

void test('source validation rejects precision loss and duplicate movement IDs', () => {
  const item = source.items[0];
  assert.ok(item);
  assert.equal(SourceSchema.safeParse({ ...source, items: [{ ...item, quantity: 1.0001 }] }).success, false);
  assert.equal(SourceSchema.safeParse({ ...source, items: [item, item] }).success, false);
});

void test('multi-order source requires unique orders and a valid owner for every picking line; legacy snapshots stay unchanged', () => {
  const item = source.items[0]; assert.ok(item);
  const multiple = { ...source, salesOrders: [{ id: 1, name: 'SO/1' }, { id: 2, name: 'SO/2' }],
    items: [{ ...item, saleOrderId: 1 }, { ...item, sourceLineId: 20, saleOrderId: 2 }] };
  assert.equal(SourceSchema.safeParse(multiple).success, true);
  assert.equal(SourceSchema.safeParse({ ...multiple, salesOrders: [multiple.salesOrders[0], multiple.salesOrders[0]] }).success, false);
  assert.equal(SourceSchema.safeParse({ ...multiple, items: [{ ...item, saleOrderId: 3 }] }).success, false);
  assert.equal(SourceSchema.safeParse({ ...multiple, items: [item] }).success, false);
  assert.deepEqual(SourceSchema.parse(source), source);
  assert.equal(Object.hasOwn(SourceSchema.parse(source), 'salesOrders'), false);
});

void test('a different crew can finish the second order of one picking without redelivering the first order', () => {
  const { delivery, appointment } = fixture();
  const item = delivery.source.items[0]; assert.ok(item);
  delivery.source = SourceSchema.parse({ ...delivery.source,
    salesOrders: [{ id: 1, name: 'SO/1' }, { id: 2, name: 'SO/2' }],
    items: [{ ...item, saleOrderId: 1 }, { ...item, sourceLineId: 20, saleOrderId: 2, quantity: 2 }],
  });
  appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 1125, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt, appointment.id);
  const first = recordExecution(delivery, execution(appointment), actor, receivedAt);
  assert.equal(deliveredMilli(first, 10), 1125);
  assert.equal(deliveredMilli(first, 20), 0);
  assert.ok(closureBlockers(first).some((reason) => reason.startsWith('Remaining quantity:')));
  const priorSigned = JSON.stringify(first.appointments[0]?.results);
  const secondActor: CrewActor = { kind: 'crew', id: randomUUID(), name: 'DEMO replacement crew representative' };
  const followUp: Appointment = { ...structuredClone(appointment), id: randomUUID(), results: [],
    assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'Another team',
      people: [{ id: secondActor.id, name: secondActor.name, external: false }], tasks: [instantiateTask(template)] }] };
  followUp.workScope = planVisitWork(first, [{ sourceLineId: 20, deliveryMilli: 2000, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt);
  first.appointments.push(followUp);
  const finished = recordExecution(first, execution(followUp, { quantities: [{ sourceLineId: 20, deliveredMilli: 2000 }],
    responsiblePersonId: secondActor.id,
    crewSignature: { status: 'signed', signerName: secondActor.name, text: 'DEMO replacement crew signature', at: '2026-11-03T09:50:00Z' },
  }), secondActor, receivedAt);
  assert.equal(deliveredMilli(finished, 10), 1125);
  assert.equal(deliveredMilli(finished, 20), 2000);
  assert.deepEqual(closureBlockers(finished), []);
  assert.equal(JSON.stringify(finished.appointments[0]?.results), priorSigned);
  assert.equal(completeDelivery(finished, operator, randomUUID(), receivedAt).completedAt, receivedAt);
});

void test('decimal quantities use integer milli-units without whole-unit truncation', () => {
  assert.equal(quantityToMilli(1.125), 1125);
  assert.equal(quantityToMilli(0.001), 1);
  assert.throws(() => quantityToMilli(0.0001), errorCode('INVALID_QUANTITY'));
  assert.throws(() => quantityToMilli(Number.NaN), errorCode('INVALID_QUANTITY'));
  assert.throws(() => quantityToMilli(-1), errorCode('INVALID_QUANTITY'));
});

void test('planning, assignment coverage, and in-progress priority are separate from source status', () => {
  const { delivery, appointment } = fixture();
  appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 500, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt, appointment.id);
  const second: Appointment = { ...structuredClone(appointment), id: randomUUID(), assignments: [] };
  second.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 625, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt);
  delivery.appointments.push(second);
  assert.deepEqual(assignmentCoverage(delivery), { assigned: 1, total: 2 });
  assert.deepEqual(deriveViews(delivery), ['assigned']);
  assert.equal(deriveProgress(startVisit(delivery, appointment.id, actor)), 'in_progress');
  delivery.appointments[0] = { ...appointment, assignments: [] };
  assert.deepEqual(deriveViews(delivery), ['planned']);
});

void test('half-open appointment intervals permit adjacent bookings', () => {
  assert.equal(intervalsOverlap('2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'), false);
  assert.equal(intervalsOverlap('2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', '2026-11-03T08:59:59Z', '2026-11-03T10:00:00Z'), true);
});

void test('explicit offsets disambiguate Rome daylight-saving transition', () => {
  validateInterval('2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00');
  assert.throws(() => validateInterval('2026-10-25T02:30:00', '2026-10-25T03:30:00'), errorCode('INVALID_INTERVAL'));
  assert.throws(() => validateInterval('2026-10-25T02:30:00+01:00', '2026-10-25T02:30:00+02:00'), errorCode('INVALID_INTERVAL'));
});

void test('task assignment snapshots independent severity, order, and checklist', () => {
  const task = instantiateTask(template);
  const changedTemplate = { ...template, title: 'Changed', severity: 'high', order: 9, checklist: ['Changed'] };
  assert.equal(task.title, 'Assembly');
  assert.equal(task.severity, 'low');
  assert.equal(task.order, 2);
  assert.deepEqual(task.checklist.map((item) => item.label), ['Assemble the table', 'Remove packaging']);
  assert.equal(changedTemplate.order, 9);
  assert.throws(() => instantiateTask({ ...template, enabled: false }), errorCode('TEMPLATE_DISABLED'));
});

void test('unassigned and external identities cannot impersonate the responsible representative', () => {
  const { delivery, appointment } = fixture();
  assert.throws(() => recordExecution(delivery, execution(appointment), { ...actor, id: randomUUID() }, receivedAt), errorCode('CREW_NOT_ASSIGNED'));
  assert.throws(() => recordExecution(delivery, execution(appointment, { responsiblePersonId: randomUUID() }), actor, receivedAt), errorCode('INVALID_RESPONSIBLE_PERSON'));
  assert.throws(() => recordExecution(delivery, execution(appointment, {
    crewSignature: { status: 'signed', signerName: 'Other person', text: 'DEMO signer', at: receivedAt },
  }), actor, receivedAt), errorCode('SIGNER_MISMATCH'));
});

void test('checklist completion never silently delivers goods', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment, { quantities: [], incompleteWork: [
    { sourceLineId: 10, operation: 'delivery', reason: 'access', note: 'Entrance was blocked.' },
  ] }), actor, receivedAt);
  assert.equal(deliveredMilli(result, 10), 0);
  assert.ok(closureBlockers(result).some((reason) => reason.startsWith('Remaining quantity:')));
  assert.equal(deriveProgress(result), 'partially_completed');
});

void test('all goods delivered while assembly remains stays partially completed even at low severity', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment, { completedChecklistIds: [] }), actor, receivedAt);
  assert.equal(deliveredMilli(result, 10), 1125);
  assert.equal(deriveProgress(result), 'partially_completed');
  assert.ok(closureBlockers(result).includes('Mandatory checklist items remain incomplete'));
});

void test('identical repeated result is idempotent and changed payload conflicts', () => {
  const { delivery, appointment } = fixture();
  const input = execution(appointment);
  const result = recordExecution(delivery, input, actor, receivedAt);
  assert.equal(recordExecution(result, input, actor, receivedAt), result);
  assert.throws(() => recordExecution(result, { ...input, summary: 'Different' }, actor, receivedAt), errorCode('RESULT_ID_CONFLICT'));
  assert.equal(deliveredMilli(result, 10), 1125);
});

void test('two crews on the same visit cannot double-count goods by duplicating a line', () => {
  const { delivery, appointment } = fixture();
  const quantities = [{ sourceLineId: 10, deliveredMilli: 1000 }, { sourceLineId: 10, deliveredMilli: 125 }];
  assert.throws(() => recordExecution(delivery, execution(appointment, { quantities }), actor, receivedAt), errorCode('DUPLICATE_QUANTITY'));
});

void test('assembly-only return reports no new goods and does not redeliver earlier quantities', () => {
  const { delivery, appointment } = fixture();
  delivery.servicePlan = { defaultService: 'delivery_installation', overrides: [] };
  appointment.workScope = planVisitWork(delivery, [{ sourceLineId: 10, deliveryMilli: 1125, installationMilli: 0, collectionMilli: 0 }], operator, confirmationAt, appointment.id);
  const first = recordExecution(delivery, execution(appointment), actor, receivedAt);
  const second = structuredClone(appointment);
  second.id = randomUUID();
  second.assignments = second.assignments.map((assignment) => ({ ...assignment, id: randomUUID(), tasks: [instantiateTask(template)] }));
  second.workScope = planVisitWork(first, [{ sourceLineId: 10, deliveryMilli: 0, installationMilli: 1125, collectionMilli: 0 }], operator, confirmationAt);
  first.appointments.push(second);
  const finished = recordExecution(first, execution(second, { quantities: [{ sourceLineId: 10, deliveredMilli: 0, installedMilli: 1125 }] }), actor, receivedAt);
  assert.equal(deliveredMilli(finished, 10), 1125);
  assert.deepEqual(closureBlockers(finished), []);
  assert.throws(() => recordExecution(first, execution(second), actor, receivedAt), errorCode('EXCESS_VISIT_WORK'));
});

void test('immutable signed snapshot survives later source and crew template changes', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment), actor, receivedAt);
  const snapshotBefore = JSON.stringify(result.appointments[0]?.results[0]);
  result.source.customer.address = 'A newly imported address';
  result.instructions.parking = 'A changed parking instruction';
  const task = result.appointments[0]?.assignments[0]?.tasks[0];
  assert.ok(task);
  task.title = 'Updated explicit live task';
  assert.equal(JSON.stringify(result.appointments[0]?.results[0]), snapshotBefore);
  assert.equal(delivery.appointments[0]?.status, 'booked');
});

void test('finished work awaits explicit closure and both mandatory signatures', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment, {
    customerSignature: { status: 'refused', signerName: 'DEMO Customer', reason: 'DEMO refusal', at: receivedAt },
  }), actor, receivedAt);
  assert.equal(deriveProgress(result), 'awaiting_closure');
  assert.ok(closureBlockers(result).some((reason) => reason.includes('customer signature')));
  assert.throws(() => completeDelivery(result, operator, randomUUID(), receivedAt), errorCode('CLOSURE_BLOCKED'));
  assert.equal(result.completedAt, null);
});

void test('completed-visit signature cannot predate the actual work it confirms', () => {
  const { delivery, appointment } = fixture();
  const input = execution(appointment, {
    customerSignature: { status: 'signed', signerName: 'DEMO Customer', text: 'DEMO premature confirmation', at: '2026-11-03T08:30:00Z' },
  });
  assert.throws(() => recordExecution(delivery, input, actor, receivedAt), errorCode('SIGNATURE_BEFORE_COMPLETION'));
});

void test('issue and return filters overlap progress; planned return remains unresolved', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment), actor, receivedAt);
  const issueId = randomUUID();
  result.issues.push({ id: issueId, type: 'damage', description: 'DEMO damage', itemIds: [10], photoIds: [], notes: null,
    status: 'open', createdAt: receivedAt, authorId: actor.id, authorName: actor.name, source: 'crew', resolution: null, resolvedAt: null, resolvedBy: null });
  result.returnRequests.push({ id: randomUUID(), originAppointmentId: appointment.id, reason: 'Repair', remainingWork: 'Assembly',
    notes: null, photoIds: [], issueIds: [issueId], status: 'planned', appointmentId: randomUUID(), createdAt: receivedAt, resolvedAt: null, resolution: null });
  assert.deepEqual(deriveViews(result), ['partially_completed', 'issues', 'return_required']);
  assert.ok(closureBlockers(result).includes('Unresolved return visit requests remain'));
  assert.throws(() => completeDelivery(result, operator, randomUUID(), receivedAt), errorCode('CLOSURE_BLOCKED'));
  const issue = result.issues[0];
  assert.ok(issue);
  issue.status = 'resolved';
  assert.equal(result.completedAt, null);
});

void test('operator waiver requires a reason and preserves signed task snapshot', () => {
  const { delivery, appointment } = fixture();
  const result = recordExecution(delivery, execution(appointment, { completedChecklistIds: [] }), actor, receivedAt);
  const ids = appointment.assignments.flatMap((assignment) => assignment.tasks.flatMap((task) => task.checklist.map((item) => item.id)));
  const firstId = ids[0];
  assert.ok(firstId);
  assert.throws(() => waiveChecklist(result, appointment.id, firstId, operator, ' ', receivedAt));
  let waived = result;
  for (const id of ids) waived = waiveChecklist(waived, appointment.id, id, operator, 'DEMO assembly contractually waived', receivedAt);
  assert.deepEqual(closureBlockers(waived), []);
  assert.equal(waived.appointments[0]?.results[0]?.assignmentsSnapshot[0]?.tasks[0]?.checklist[0]?.waiver, null);
});

void test('completion and reopen preserve prior confirmation and require explicit reason', () => {
  const { delivery, appointment } = fixture();
  const ready = recordExecution(delivery, execution(appointment), actor, receivedAt);
  const completionId = randomUUID();
  const completed = completeDelivery(ready, operator, completionId, receivedAt);
  assert.equal(deriveProgress(completed), 'completed');
  assert.equal(completeDelivery(completed, operator, completionId, receivedAt), completed);
  assert.throws(() => reopenDelivery(completed, operator, '', receivedAt));
  const reopened = reopenDelivery(completed, operator, 'New issue reported', '2026-11-03T13:00:00Z');
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.completions[0]?.at, receivedAt);
  assert.equal(reopened.completions[0]?.reopenedAt, '2026-11-03T13:00:00Z');
  assert.equal(completed.completions[0]?.reopenedAt, null);
  assert.throws(() => completeDelivery(reopened, operator, completionId, '2026-11-03T14:00:00Z'), errorCode('COMPLETION_ID_CONFLICT'));
});

void test('source review blocks closure even when previously delivered work is retained', () => {
  const { delivery, appointment } = fixture();
  const ready = recordExecution(delivery, execution(appointment), actor, receivedAt);
  ready.sourceReview = true;
  assert.equal(deliveredMilli(ready, 10), 1125);
  assert.ok(closureBlockers(ready).some((reason) => reason.includes('Source requires review')));
});

void test('explicit signed correction appends a new effective version without double-counting or changing original', () => {
  const { delivery, appointment } = fixture();
  const original = execution(appointment);
  const first = recordExecution(delivery, original, actor, receivedAt);
  const originalSnapshot = JSON.stringify(first.appointments[0]?.results[0]);
  const correction = execution(appointment, { supersedesResultId: original.id, correctionReason: 'DEMO quantity transcription corrected',
    quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], completedChecklistIds: [], incompleteWork: [
      { sourceLineId: 10, operation: 'delivery', reason: 'damage', note: 'Damaged part was not handed over.' },
    ] });
  const corrected = recordExecution(first, correction, actor, receivedAt);
  assert.equal(corrected.appointments[0]?.results.length, 2);
  assert.equal(JSON.stringify(corrected.appointments[0]?.results[0]), originalSnapshot);
  assert.equal(deliveredMilli(corrected, 10), 1000);
  assert.equal(effectiveResults(corrected)[0]?.id, correction.id);
  assert.equal(deriveProgress(corrected), 'partially_completed');
  assert.ok(closureBlockers(corrected).includes('Mandatory checklist items remain incomplete'));
  assert.throws(() => recordExecution(corrected, execution(appointment, { supersedesResultId: original.id, correctionReason: 'Outdated revision' }), actor, receivedAt), errorCode('CORRECTION_NOT_LATEST'));
});

void test('correction cannot silently overwrite a completed delivery or omit its reason', () => {
  const { delivery, appointment } = fixture();
  const original = execution(appointment);
  const first = recordExecution(delivery, original, actor, receivedAt);
  assert.throws(() => recordExecution(first, execution(appointment, { supersedesResultId: original.id }), actor, receivedAt), errorCode('CORRECTION_REASON_REQUIRED'));
  const completed = completeDelivery(first, operator, randomUUID(), receivedAt);
  const correction = execution(appointment, { supersedesResultId: original.id, correctionReason: 'DEMO valid explicit correction' });
  assert.throws(() => recordExecution(completed, correction, actor, receivedAt), errorCode('DELIVERY_CLOSED'));
  const reopened = reopenDelivery(completed, operator, 'Review correction', receivedAt);
  const corrected = recordExecution(reopened, correction, actor, receivedAt);
  assert.equal(corrected.completions[0]?.resultIds[0], original.id);
  assert.equal(corrected.appointments[0]?.results[0]?.id, original.id);
  assert.equal(corrected.appointments[0]?.results[1]?.id, correction.id);
});

void test('only effective signatures govern closure while earlier signatures remain in history', () => {
  const { delivery, appointment } = fixture();
  const original = execution(appointment, { customerSignature: null });
  const first = recordExecution(delivery, original, actor, receivedAt);
  assert.ok(closureBlockers(first).some((reason) => reason.includes('customer signature')));
  const corrected = recordExecution(first, execution(appointment, { supersedesResultId: original.id, correctionReason: 'DEMO signed replacement received' }), actor, receivedAt);
  assert.deepEqual(closureBlockers(corrected), []);
  assert.equal(corrected.appointments[0]?.results[0]?.customerSignature, null);
});

void test('crew issues use assignment policy and cannot create a new issue on a completed delivery', () => {
  const { delivery, appointment } = fixture();
  const input = { id: randomUUID(), type: 'damage' as const, description: 'DEMO damaged table', itemIds: [10], photoIds: [], notes: null };
  assert.throws(() => raiseIssue(delivery, input, actor, receivedAt), errorCode('CREW_NOT_ASSIGNED'));
  const reported = raiseIssue(delivery, input, actor, receivedAt, appointment.id);
  assert.equal(reported.issues[0]?.authorId, actor.id);
  assert.equal(reported.issues[0]?.source, 'crew');
  const completed = completeDelivery(recordExecution(delivery, execution(appointment), actor, receivedAt), operator, randomUUID(), receivedAt);
  assert.throws(() => raiseIssue(completed, input, actor, receivedAt, appointment.id), errorCode('DELIVERY_CLOSED'));
});

void test('shared return request requires reported origin work, own links, and crew membership', () => {
  const { delivery, appointment } = fixture();
  const input = { id: randomUUID(), originAppointmentId: appointment.id, reason: 'DEMO return for assembly', remainingWork: 'Assemble the remaining item',
    notes: 'DEMO explicit notes', photoIds: [randomUUID()], issueIds: [] };
  assert.throws(() => raiseReturnRequest(delivery, input, operator, receivedAt), errorCode('RETURN_WITHOUT_WORK'));
  const performed = recordExecution(delivery, execution(appointment), actor, receivedAt);
  assert.throws(() => raiseReturnRequest(performed, input, actor, receivedAt), errorCode('CREW_NOT_ASSIGNED'));
  assert.throws(() => raiseReturnRequest(performed, { ...input, issueIds: [randomUUID()] }, actor, receivedAt, appointment.id), errorCode('RETURN_ISSUE_OWNERSHIP'));
  const requested = raiseReturnRequest(performed, input, actor, receivedAt, appointment.id);
  assert.equal(requested.returnRequests[0]?.status, 'requested');
  assert.equal(requested.returnRequests[0]?.appointmentId, null);
  assert.equal(requested.returnRequests[0]?.notes, 'DEMO explicit notes');
  assert.deepEqual(requested.returnRequests[0]?.photoIds, input.photoIds);
  assert.equal(performed.returnRequests.length, 0);
  assert.throws(() => raiseReturnRequest(requested, input, operator, receivedAt), errorCode('RETURN_ID_CONFLICT'));
  assert.throws(() => raiseReturnRequest(performed, { ...input, photoIds: [...input.photoIds, ...input.photoIds] }, operator, receivedAt));
});
