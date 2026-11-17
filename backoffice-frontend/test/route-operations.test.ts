import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { cargoQuantityMilli, routeAmendInputSchema, routeAmendReviewInputSchema, routeCancelInputSchema, routeCloseInputSchema, routeReconcileInputSchema, routeReturnInputSchema, routeWarehouseReceiptInputSchema, validateRouteCommand } from '../src/lib/route-operations';
import { ApiFixture, button, click, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';
import { appointmentIds, catalogs, deliveryIds, operationsFixture, routeId } from './route-operations-fixtures';

const endpoint = `/routes/${routeId}`;
function form(scope: ParentNode, submitLabel: string) { const found = button(scope, submitLabel).closest('form'); assert.ok(found); return found; }
function input(scope: ParentNode, selector: string) { const found = scope.querySelector(selector); assert.ok(found instanceof HTMLInputElement, selector); return found; }
function check(scope: ParentNode, text: string) { const found = Array.from(scope.querySelectorAll('label')).find((entry) => entry.textContent?.includes(text))?.querySelector('input[type=checkbox]'); assert.ok(found instanceof HTMLInputElement, text); return found; }
async function toggle(control: HTMLInputElement) { await act(async () => control.click()); }
async function select(control: HTMLSelectElement, value: string) { await act(async () => { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); }); }
function choose(scope: ParentNode, label: string) { const found = Array.from(scope.querySelectorAll('label')).find((entry) => entry.textContent?.includes(label))?.querySelector('select'); assert.ok(found instanceof HTMLSelectElement, label); return found; }

void test('live route confirmation is separate from its frozen snapshot; Refresh preserves input and History tab', async () => {
  const api = new ApiFixture(); const data = operationsFixture();
  api.defer(`${endpoint}/operations`).reply(data);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs, fallbackReview: data.review }));
    await waitFor(() => page.container.textContent?.includes('Current revision 1') === true, 'live route');
    assert.match(page.container.textContent ?? '', /Customer confirmed/);
    const cancel = form(page.container, 'Cancel reviewed route');
    const reason = input(cancel, '[name=reason]'); await editInput(reason, 'Customer requests new date');
    await toggle(check(cancel, 'route has not departed'));
    await click(button(page.container, 'History'));
    const reply = api.defer(`${endpoint}/operations`); await click(button(page.container, 'Refresh route')); reply.reply(data);
    await waitFor(() => api.calls.filter((entry) => entry.pathname === `${endpoint}/operations`).length === 2, 'refreshed operations');
    assert.equal(button(page.container, 'History').getAttribute('aria-pressed'), 'true');
    assert.equal(input(cancel, '[name=reason]'), reason); assert.equal(reason.value, 'Customer requests new date');
    assert.equal(check(cancel, 'route has not departed').checked, true);
    assert.match(page.container.textContent ?? '', /Customer confirmation in this saved revision/);
    assert.match(page.container.textContent ?? '', /Awaiting customer confirmation/);
  } finally { await page.close(); }
});

void test('cancellation requires explicit attestations and detaches attached visits by default', async () => {
  const api = new ApiFixture(); const data = operationsFixture(); api.defer(`${endpoint}/operations`).reply(data);
  const cancelled = operationsFixture('cancelled'); cancelled.version = 2;
  api.defer(`${endpoint}/cancel`, 'POST').reply(cancelled);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Cancel reviewed route') === true, 'cancel form');
    const cancel = form(page.container, 'Cancel reviewed route'); await editInput(input(cancel, '[name=reason]'), 'New customer window');
    assert.equal(check(cancel, 'Also cancel').checked, false);
    await click(button(cancel, 'Cancel reviewed route')); assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/cancel')), false);
    await toggle(check(cancel, 'route has not departed')); await toggle(check(cancel, 'cargo has not been loaded'));
    await click(button(cancel, 'Cancel reviewed route'));
    await waitFor(() => hasToast(page.dom.window.document, 'Route updated'), 'cancel toast');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/cancel')); assert.ok(call);
    const body = routeCancelInputSchema.parse(call.body);
    assert.deepEqual(body.cancelAttachedAppointmentIds, []); assert.equal(body.confirmNotLoaded, true); assert.equal(body.reason, 'New customer window');
    assert.equal(Array.from(page.container.querySelectorAll('button')).some((entry) => entry.textContent === 'Record departure'), false);
  } finally { await page.close(); }
});

void test('actual return stays available with missing reports and retains its entered local time through Refresh', async () => {
  const api = new ApiFixture(); const data = operationsFixture('returning'); api.defer(`${endpoint}/operations`).reply(data);
  const returned = operationsFixture('returned'); returned.version = 2; api.defer(`${endpoint}/return`, 'POST').reply(returned);
  api.defer('/routes/reconciliation-owners').reply([{ id: user.id, name: user.name }]);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.querySelector('[data-booking-field=actualReturnedAt]') !== null, 'actual return');
    const returnedForm = form(page.container, 'Record actual return'); const control = input(returnedForm, '[data-booking-field=actualReturnedAt]');
    await editInput(control, '2026-11-16T12:30'); await editInput(input(returnedForm, '[name=note]'), 'Returned; report upload pending');
    api.defer(`${endpoint}/operations`).reply(data); await click(button(page.container, 'Refresh route'));
    await waitFor(() => button(returnedForm, 'Record actual return').disabled === false, 'refresh complete');
    assert.equal(input(returnedForm, '[data-booking-field=actualReturnedAt]'), control); assert.equal(control.value, '2026-11-16T12:30');
    await click(button(returnedForm, 'Record actual return'));
    await waitFor(() => page.container.textContent?.includes('Returned · reconciliation') === true, 'returned state');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/return')); assert.ok(call);
    assert.equal(routeReturnInputSchema.parse(call.body).actualReturnedAt, '2026-11-16T11:30:00.000Z');
    assert.match(page.container.textContent ?? '', /Report missing/);
  } finally { await page.close(); }
});

void test('same-SKU lines keep separate owners, amounts and unknown cargo; receipt is independent from reconciliation', async () => {
  const api = new ApiFixture(); const data = operationsFixture('returned'); api.defer(`${endpoint}/operations`).reply(data);
  api.defer('/routes/reconciliation-owners').reply([{ id: user.id, name: user.name }]);
  const reconciled = operationsFixture('returned'); reconciled.version = 2; api.defer(`${endpoint}/reconcile`, 'POST').reply(reconciled);
  const receipt = operationsFixture('returned'); receipt.version = 3; const firstLine = receipt.lines[0]; assert.ok(firstLine); firstLine.warehouseReceivedUndeliveredMilli = 500;
  api.defer(`${endpoint}/warehouse-receipts`, 'POST').reply(receipt);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.querySelectorAll('[data-reconciliation-line]').length === 2 && button(page.container, 'Save reconciliation').disabled === false, 'two exact rows');
    const rows = Array.from(page.container.querySelectorAll('[data-reconciliation-line]'));
    for (const [index, row] of rows.entries()) {
      await select(choose(row, 'Action owner'), user.id);
      const note = Array.from(row.querySelectorAll('label')).find((entry) => entry.textContent?.includes('Line review note'))?.querySelector('input'); assert.ok(note instanceof HTMLInputElement); await editInput(note, `Order ${index + 1} reviewed`);
      for (const owner of Array.from(row.querySelectorAll('select')).filter((control) => Array.from(control.options).some((option) => option.value === user.id))) assert.equal(owner.value, user.id, 'line owner pre-fills next actions');
    }
    const reconcile = form(page.container, 'Save reconciliation'); await editInput(input(reconcile, '[name=reason]'), 'Same SKU, separate orders');
    await click(button(reconcile, 'Save reconciliation')); await waitFor(() => page.container.textContent?.includes('Current revision 2') === true, 'reconciled');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/reconcile')); assert.ok(call); const body = routeReconcileInputSchema.parse(call.body);
    assert.deepEqual(body.lines.map((line) => [line.appointmentId, line.sourceLineId]), [[appointmentIds[0], 10], [appointmentIds[1], 11]]);
    assert.ok(body.lines.every((line) => line.ownerUserId === user.id && line.cargo[0]?.quantityMilli === null && line.cargo[0]?.location === 'unknown'));
    const receiptForm = form(page.container, 'Record warehouse acceptance');
    await click(button(receiptForm, 'Use latest data'));
    const amount = input(receiptForm, 'input[type=number]'); await editInput(amount, '0.5'); await editInput(input(receiptForm, '[name=reason]'), 'Warehouse accepted first order only');
    await click(button(receiptForm, 'Record warehouse acceptance')); await waitFor(() => page.container.textContent?.includes('Current revision 3') === true, 'receipt');
    const receiptCall = api.calls.find((entry) => entry.pathname.endsWith('/warehouse-receipts')); assert.ok(receiptCall); const items = routeWarehouseReceiptInputSchema.parse(receiptCall.body).items;
    assert.equal(items.length, 1); assert.equal(items[0]?.quantityMilli, 500); assert.equal(items[0]?.sourceLineId, 10); assert.equal(amount.value, '');
    assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/close')), false);
  } finally { await page.close(); }
});

void test('amendment review preserves exact visits, shows confirmation reset and requires a fresh acknowledgement after edits', async () => {
  const api = new ApiFixture(); const data = operationsFixture(); api.defer(`${endpoint}/operations`).reply(data);
  const result = { fingerprint: 'c'.repeat(64), review: data.review, confirmationResetAppointmentIds: [appointmentIds[0]] };
  api.defer(`${endpoint}/amend-review`, 'POST').reply(result);
  api.defer(`${endpoint}/amend-review`, 'POST').reply(result);
  const amended = operationsFixture(); amended.version = 2; api.defer(`${endpoint}/amend`, 'POST').reply(amended);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Review changes') === true, 'amendment');
    const detail = button(page.container, 'Review changes').closest('details'); assert.ok(detail);
    assert.doesNotMatch(detail.textContent ?? '', /driver/i);
    const reason = input(detail, 'input[maxlength="2000"]'); await editInput(reason, 'Change order of stops');
    await toggle(check(detail, 'route has not departed')); await toggle(check(detail, 'cargo has not been loaded'));
    await click(button(detail, 'Review changes'));
    await waitFor(() => detail.textContent?.includes('Customer confirmation will be reset') === true, 'amend review');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/amend-review')); assert.ok(call);
    const command = routeAmendReviewInputSchema.parse(call.body);
    assert.deepEqual(command.plan.stops.map((stop) => stop.appointmentId), appointmentIds);
    assert.deepEqual(command.plan.planning?.driver, { kind: 'none' });
    assert.equal(command.externalDriverPhone, undefined);
    const accept = check(detail, 'I reviewed the complete schedule'); await toggle(accept);
    await editInput(reason, 'Corrected reason'); assert.equal(accept.checked, false); assert.equal(button(detail, 'Apply reviewed changes').disabled, true);
    await click(button(detail, 'Review changes')); await waitFor(() => check(detail, 'I reviewed the complete schedule').disabled === false, 'new review');
    await toggle(accept); await click(button(detail, 'Apply reviewed changes')); await waitFor(() => page.container.textContent?.includes('Current revision 2') === true, 'amended');
    const applied = api.calls.find((entry) => entry.pathname.endsWith('/amend')); assert.ok(applied); assert.equal(routeAmendInputSchema.parse(applied.body).reason, 'Corrected reason');
  } finally { await page.close(); }
});

void test('closure exception requires explicit selection and explanation; unknown amounts never become zero', async () => {
  assert.equal(cargoQuantityMilli(''), null); assert.equal(cargoQuantityMilli('0'), 0); assert.equal(cargoQuantityMilli('0.001'), 1); assert.equal(cargoQuantityMilli('0.0001'), undefined);
  assert.throws(() => validateRouteCommand('cancel', { version: 1, requestId: routeId, reason: 'No departure', confirmNotDeparted: true, confirmNotLoaded: false, cancelAttachedAppointmentIds: [] }));
  const api = new ApiFixture(); const data = operationsFixture('returned'); api.defer(`${endpoint}/operations`).reply(data); api.defer('/routes/reconciliation-owners').reply([{ id: user.id, name: user.name }]);
  const closed = operationsFixture('closed'); closed.version = 2; api.defer(`${endpoint}/close`, 'POST').reply(closed);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Close route') === true, 'closure form');
    const close = form(page.container, 'Close route'); assert.equal(button(close, 'Close route').disabled, true);
    await editInput(input(close, '[name=reason]'), 'Dispatcher reviewed outstanding work'); await toggle(check(close, 'Document a reconciliation exception'));
    await click(button(close, 'Close route')); assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/close')), false);
    await editInput(input(close, '[name=exceptionReason]'), 'Crew report still pending, Francesca owns follow-up'); await click(button(close, 'Close route'));
    await waitFor(() => page.container.textContent?.includes('Current revision 2') === true, 'closed');
    const call = api.calls.find((entry) => entry.pathname.endsWith('/close')); assert.ok(call); assert.equal(routeCloseInputSchema.parse(call.body).exceptionReason, 'Crew report still pending, Francesca owns follow-up');
  } finally { await page.close(); }
});

void test('a lost departure response retries the same command and an older concurrent Refresh cannot regress its new version', async () => {
  const api = new ApiFixture(); const data = operationsFixture(); api.defer(`${endpoint}/operations`).reply(data);
  api.defer(`${endpoint}/depart`, 'POST').reply({ message: 'Temporary connection failure' }, 503);
  const departure = api.defer(`${endpoint}/depart`, 'POST');
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Record departure') === true, 'departure form');
    const depart = form(page.container, 'Record departure'); await editInput(input(depart, '[name=reason]'), 'Dispatch approved');
    await click(button(depart, 'Record departure')); await waitFor(() => hasToast(page.dom.window.document, 'Temporary connection failure', 'error'), 'lost response');
    await click(button(depart, 'Record departure'));
    const refresh = api.defer(`${endpoint}/operations`);
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 1, catalogs }));
    const running = operationsFixture('in_progress'); running.version = 2; departure.reply(running);
    await waitFor(() => page.container.textContent?.includes('Current revision 2') === true, 'departure saved');
    refresh.reply(data); await waitFor(() => button(page.container, 'Refresh route').disabled === false, 'old refresh completed');
    const calls = api.calls.filter((entry) => entry.pathname.endsWith('/depart')); assert.equal(calls.length, 2); assert.deepEqual(calls[0]?.body, calls[1]?.body);
    assert.match(page.container.textContent ?? '', /Current revision 2/); assert.match(page.container.textContent ?? '', /The trip has departed/);
  } finally { await page.close(); }
});

void test('History fetches and displays the selected immutable revision including receipts and closure exception', async () => {
  const api = new ApiFixture(); const data = operationsFixture('closed'); api.defer(`${endpoint}/operations`).reply(data);
  api.defer('/routes/reconciliation-owners').reply([{ id: user.id, name: user.name }]);
  const runtime = structuredClone(data.runtime); runtime.closureException = 'Historic report remains missing';
  runtime.warehouseReceipts.push({ id: routeId, at: data.review.timeline.departAt, actor: { id: user.id, name: user.name }, reason: 'Historic warehouse acceptance', items: [{ appointmentId: appointmentIds[0] ?? '', sourceLineId: 10, kind: 'undelivered', quantityMilli: 500, note: 'Checked first order' }] });
  api.defer(`${endpoint}/revisions/1`).reply({ version: 1, status: 'returned', data: { draft: data.draft, review: data.review, publishedAt: data.review.timeline.departAt, publishedBy: { id: user.id, name: user.name } }, runtime });
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Current revision 1') === true, 'closed route');
    await click(button(page.container, 'History')); await click(button(page.container, 'View saved revision'));
    await waitFor(() => page.container.textContent?.includes('Historic warehouse acceptance') === true, 'saved facts');
    assert.match(page.container.textContent ?? '', /Historic report remains missing/); assert.match(page.container.textContent ?? '', /Undelivered cargo: 0.5/);
    assert.equal(api.calls.some((entry) => entry.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('an unstarted stop can be explicitly skipped after actual return and prevents even exception closure beforehand', async () => {
  const api = new ApiFixture(); const data = operationsFixture('returned'); const stop = data.stops[1]; assert.ok(stop); stop.status = 'booked'; stop.reported = false;
  api.defer(`${endpoint}/operations`).reply(data); api.defer('/routes/reconciliation-owners').reply([{ id: user.id, name: user.name }]);
  const skipped = structuredClone(data); skipped.version = 2; const changed = skipped.stops[1]; assert.ok(changed); changed.status = 'cancelled'; changed.skipped = true;
  api.defer(`${endpoint}/stops/${stop.appointmentId}/skip`, 'POST').reply(skipped);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Skip this stop') === true, 'returned skip');
    const close = form(page.container, 'Close route'); await toggle(check(close, 'Document a reconciliation exception')); assert.equal(button(close, 'Close route').disabled, true);
    const skip = form(page.container, 'Skip this stop'); await editInput(input(skip, '[name=reason]'), 'No visit attempted before vehicle returned'); await click(button(skip, 'Skip this stop'));
    await waitFor(() => page.container.textContent?.includes('Current revision 2') === true, 'skip saved');
    assert.match(page.container.textContent ?? '', /Skipped/); assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/close')), false);
  } finally { await page.close(); }
});

void test('Plan vs actual loads on demand and keeps skipped and unrecorded data distinct through refresh', async () => {
  const api = new ApiFixture();
  const data = operationsFixture('in_progress');
  data.version = 3;
  api.defer(`${endpoint}/operations`).reply(data);
  const [appointmentId] = appointmentIds;
  const [deliveryId] = deliveryIds;
  assert.ok(appointmentId && deliveryId);
  const plannedAt = '2026-11-16T08:00:00.000Z';
  const recordedAt = '2026-11-16T08:12:00.000Z';
  const unknown = { planned: null, actual: null, deltaMinutes: null };
  const plannedOnly = { planned: 30, actual: null, deltaMinutes: null };
  const timing = {
    id: routeId,
    status: 'in_progress',
    plan: { version: 2, at: plannedAt },
    route: {
      departAt: { planned: plannedAt, actual: recordedAt, deltaMinutes: 12 },
      returnDepartAt: unknown, returnAt: unknown,
      travelMinutes: plannedOnly, waitingMinutes: unknown, workMinutes: plannedOnly,
      totalMinutes: plannedOnly, returnTravelMinutes: unknown,
    },
    stops: [{
      deliveryId, appointmentId, sequence: 1, pickingName: 'DEMO/OUT/TIMING', status: 'cancelled',
      arrivalAt: { planned: plannedAt, actual: null, deltaMinutes: null }, workStartAt: unknown, workEndAt: unknown,
      travelMinutes: plannedOnly, waitingMinutes: unknown, workMinutes: plannedOnly,
      reason: { kind: 'skipped', note: 'Road closed by police' },
    }],
  };
  const initial = api.defer(`${endpoint}/timing`);
  const page = await domHarness(api);
  try {
    const { RouteOperationsPanel } = await import('../src/components/route-operations');
    await page.render(createElement(RouteOperationsPanel, { routeId, revision: 0, catalogs }));
    await waitFor(() => page.container.textContent?.includes('Current revision 3') === true, 'current route');
    assert.equal(initial.called, false);
    await click(button(page.container, 'Plan vs actual'));
    assert.equal(initial.called, true);
    assert.match(page.container.textContent ?? '', /Loading time comparison/);
    initial.reply(timing);
    const comparison = page.container.querySelector('[aria-label="Plan vs actual"]');
    assert.ok(comparison);
    await waitFor(() => comparison.textContent?.includes('+12 min') === true, 'departure delay');
    assert.match(comparison.textContent ?? '', /Published plan · revision 2/);
    assert.ok(comparison.querySelector(`time[datetime="${recordedAt}"]`));
    const stop = comparison.querySelector('details');
    assert.ok(stop);
    const summary = stop.querySelector('summary');
    assert.ok(summary instanceof HTMLElement);
    await act(async () => summary.click());
    assert.match(summary.textContent ?? '', /DEMO\/OUT\/TIMING · Skipped/);
    assert.match(stop.textContent ?? '', /Road closed by police/);
    const arrival = Array.from(stop.querySelectorAll('tr')).find((row) => row.querySelector('th[scope=row]')?.textContent === 'Arrival');
    assert.ok(arrival);
    assert.deepEqual(Array.from(arrival.querySelectorAll('td'), (cell) => cell.querySelector('time')?.dateTime ?? cell.textContent), [plannedAt, '—No value', '—No value']);

    api.defer(`${endpoint}/operations`).reply(data);
    const refreshed = api.defer(`${endpoint}/timing`);
    await click(button(page.container, 'Refresh route'));
    refreshed.reply({ ...timing, route: { ...timing.route, totalMinutes: { planned: 75, actual: 65, deltaMinutes: -10 } } });
    await waitFor(() => comparison.textContent?.includes('-10 min') === true, 'refreshed route duration');
    assert.equal(button(page.container, 'Plan vs actual').getAttribute('aria-pressed'), 'true');
    assert.equal(stop.open, true);

    api.defer(`${endpoint}/operations`).reply(data);
    api.defer(`${endpoint}/timing`).reply({ message: 'Timing service temporarily unavailable' }, 503);
    await click(button(page.container, 'Refresh route'));
    await waitFor(() => comparison.textContent?.includes('last loaded comparison') === true, 'transient refresh failure');
    assert.match(comparison.textContent ?? '', /-10 min/);
    assert.equal(comparison.querySelector('details'), stop, 'transient refresh preserves the same expanded stop');
    assert.equal(stop.open, true);

    api.defer(`${endpoint}/operations`).reply(data);
    api.defer(`${endpoint}/timing`).reply(timing);
    await click(button(page.container, 'Refresh route'));
    await waitFor(() => comparison.getAttribute('aria-busy') === 'false' && comparison.querySelector('[role=alert]') === null, 'refresh recovered');
    assert.equal(comparison.querySelector('details'), stop);
    assert.equal(stop.open, true);

    api.defer(`${endpoint}/operations`).reply(data);
    api.defer(`${endpoint}/timing`).reply({ message: 'Operator access required' }, 403);
    await click(button(page.container, 'Refresh route'));
    await waitFor(() => comparison.querySelector('[role=alert]') !== null, 'permission error');
    assert.match(comparison.textContent ?? '', /Operator access required/);
    assert.equal(comparison.querySelector('table'), null, 'a rejected refresh clears the previous report');

    api.defer(`${endpoint}/operations`).reply(data);
    api.defer(`${endpoint}/timing`).reply({ ...timing, id: deliveryId });
    await click(button(page.container, 'Refresh route'));
    await waitFor(() => comparison.textContent?.includes('unexpected response') === true, 'mismatched route rejected');
    assert.equal(comparison.querySelector('table'), null, 'another route payload must never render');
    assert.ok(api.calls.every((call) => call.method === 'GET'));
  } finally { await page.close(); }
});
