import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { appointmentSchema, detailSchema, lineServiceSchema, workLineSchema, workScopeSchema, type DeliveryDetail, type LineService } from '../src/lib/contracts';
import { initialWorkDrafts, validateWorkDrafts, workCapacity, workOperations } from '../src/lib/visit-work';
import { ApiError, errorMessage } from '../src/lib/api';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';

const appointmentId = '57000000-0000-4000-8000-000000000001';
const bookingBody = z.object({ version: z.number().int().positive(), requestId: z.uuid(), startsAt: z.string(), endsAt: z.string(), workLines: z.array(workLineSchema), returnRequestId: z.uuid().optional() }).strict();
const scopeBody = z.object({ version: z.number().int().positive(), requestId: z.uuid(), workLines: z.array(workLineSchema), reason: z.string() }).strict();

void test('work-scope and route conflicts explain the recovery in the selected language', () => {
  const error = new ApiError(409, 'Planned quantities exceed the remaining work available after other visits');
  for (const [locale, expected] of [['it', 'Una quantità supera'], ['ru', 'Выбранное количество превышает'], ['uz', 'Tanlangan miqdor']] as const) {
    assert.ok(errorMessage(error, locale).startsWith(expected));
    assert.notEqual(errorMessage(new ApiError(409, 'Review the selected appointment work before planning this route stop'), locale), 'Review the selected appointment work before planning this route stop');
  }
});

function status(sourceLineId: number, overrides: Partial<LineService> = {}): LineService {
  return lineServiceSchema.parse({ sourceLineId, service: 'delivery_installation', inherited: true, locked: false,
    deliveredMilli: 0, installedMilli: 0, collectedMilli: 0,
    totalDeliveryMilli: 2000, totalInstallationMilli: 2000, totalCollectionMilli: 0,
    remainingDeliveryMilli: 2000, remainingInstallationMilli: 2000, remainingCollectionMilli: 0,
    reservedDeliveryMilli: 0, reservedInstallationMilli: 0, reservedCollectionMilli: 0,
    availableDeliveryMilli: 2000, availableInstallationMilli: 2000, availableCollectionMilli: 0,
    planningBlockedReason: null, ...overrides });
}

function twoOrderDetail(): DeliveryDetail {
  const detail = detailFixture();
  const item = detail.delivery.source.items[0];
  assert.ok(item);
  detail.delivery.source = { ...detail.delivery.source, salesOrders: [{ id: 1, name: 'DEMO/SO/FIRST' }, { id: 2, name: 'DEMO/SO/SECOND' }],
    items: [{ ...item, quantity: 2, saleOrderId: 1, name: 'DEMO identical chair' }, { ...item, quantity: 2, sourceLineId: 20, saleOrderId: 2, name: 'DEMO identical chair' }] };
  detail.delivery.servicePlan = { defaultService: 'delivery_installation', overrides: [] };
  detail.lineServices = [
    status(10, { locked: true, deliveredMilli: 2000, remainingDeliveryMilli: 0, availableDeliveryMilli: 0, installedMilli: 1000, remainingInstallationMilli: 1000, reservedInstallationMilli: 500, availableInstallationMilli: 500 }),
    status(20, { service: 'collection_only', inherited: false, totalDeliveryMilli: 0, totalInstallationMilli: 0, totalCollectionMilli: 2000, remainingDeliveryMilli: 0, remainingInstallationMilli: 0, remainingCollectionMilli: 2000, availableDeliveryMilli: 0, availableInstallationMilli: 0, availableCollectionMilli: 2000 }),
  ];
  return detail;
}

function input(scope: ParentNode, selector: string): HTMLInputElement {
  const result = scope.querySelector(selector); assert.ok(result instanceof HTMLInputElement, selector); return result;
}
function operation(scope: ParentNode, lineId: number, name: string): HTMLInputElement {
  return input(scope, `tr[data-work-line="${lineId}"] input[aria-label^="${name} ·"]`);
}
async function fillDates(form: HTMLFormElement) {
  await editInput(input(form, 'input[data-booking-field="startsAt"]'), '2026-11-12T09:00');
  await editInput(input(form, 'input[data-booking-field="endsAt"]'), '2026-11-12T11:00');
}
async function submit(form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function openPanel(api: ApiFixture, tab = 'Visits & tasks') {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.product-row') !== null, 'delivery details');
    if (tab !== 'Overview') await click(button(document, tab));
    return { page, document };
  } catch (error: unknown) { await page.close(); throw error; }
}
function bookingForm(document: Document): HTMLFormElement {
  const form = button(document, 'Book appointment').closest('form'); assert.ok(form instanceof HTMLFormElement); return form;
}

void test('work selection keeps same-SKU order lines separate and uses only unreserved residual operations', () => {
  const detail = twoOrderDetail(); const lines = detail.lineServices; assert.ok(lines);
  const drafts = initialWorkDrafts(lines);
  assert.deepEqual(validateWorkDrafts(drafts, lines), { error: null, lines: [
    { sourceLineId: 10, deliveryMilli: 0, installationMilli: 500, collectionMilli: 0 },
    { sourceLineId: 20, deliveryMilli: 0, installationMilli: 0, collectionMilli: 2000 },
  ] });
  assert.equal(validateWorkDrafts(drafts.map((draft) => draft.sourceLineId === 10 ? { ...draft, installationMilli: '1' } : draft), lines).error, 'exceedsAvailable');
  assert.equal(validateWorkDrafts(drafts.map((draft) => ({ ...draft, installationMilli: '0.0001' })), lines).error, 'invalidQuantity');
  const installation = [status(30, { service: 'installation_only', totalDeliveryMilli: 0, remainingDeliveryMilli: 0, availableDeliveryMilli: 0 })];
  const installationDraft = initialWorkDrafts(installation);
  assert.equal(validateWorkDrafts(installationDraft, installation).error, 'stockRequired');
  assert.deepEqual(validateWorkDrafts(installationDraft.map((draft) => ({ ...draft, customerStockConfirmed: true })), installation).lines,
    [{ sourceLineId: 30, deliveryMilli: 0, installationMilli: 2000, collectionMilli: 0, customerStockConfirmed: true }]);
  const future = [status(40)];
  assert.equal(validateWorkDrafts(initialWorkDrafts(future).map((draft) => ({ ...draft, deliveryMilli: '0' })), future).error, null, 'Future installation is bookable; physical stock is checked at start');
});

void test('availability does not present legacy-blocked residual as free work and preserves the actual remainder', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.detail = twoOrderDetail();
  api.detail.lineServices = api.detail.lineServices?.map((line) => ({ ...line, planningBlockedReason: 'legacy_scope_review' }));
  const { page, document } = await openPanel(api, 'Overview');
  try {
    const table = Array.from(document.querySelectorAll('table')).find((entry) => entry.caption?.textContent === 'Product-line work and availability');
    assert.ok(table);
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      const available = cells[5]; assert.ok(available);
      assert.match(available.textContent ?? '', /Review required/);
      assert.match(available.textContent ?? '', /Review the work of existing visits before booking more work/);
    }
    assert.equal(rows[1]?.querySelectorAll('td')[4]?.textContent, '0.5', 'The existing reservation remains visible');
    assert.equal(rows[1]?.querySelectorAll('td')[3]?.textContent, '1', 'The physical remaining installation is not hidden');
  } finally { await page.close(); }
});

void test('booking shows order identities and posts installation residual plus collection without changing the service plan', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.detail = twoOrderDetail();
  const { page, document } = await openPanel(api);
  try {
    const form = bookingForm(document);
    assert.match(form.querySelector('tr[data-work-line="10"]')?.textContent ?? '', /DEMO\/SO\/FIRST.*line 10/s);
    assert.match(form.querySelector('tr[data-work-line="20"]')?.textContent ?? '', /DEMO\/SO\/SECOND.*line 20/s);
    assert.equal(operation(form, 10, 'Delivery').value, '0');
    assert.equal(operation(form, 10, 'Delivery').disabled, true);
    assert.equal(operation(form, 10, 'Installation').value, '0.5');
    await fillDates(form);
    const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await submit(form); assert.equal(response.called, true);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call);
    assert.deepEqual(bookingBody.parse(call.body).workLines, [
      { sourceLineId: 10, deliveryMilli: 0, installationMilli: 500, collectionMilli: 0 },
      { sourceLineId: 20, deliveryMilli: 0, installationMilli: 0, collectionMilli: 2000 },
    ]);
    assert.equal(api.calls.some((entry) => entry.pathname.endsWith('/services')), false);
    await act(async () => { response.reply({ message: 'DEMO unavailable' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO unavailable', 'error'), 'retained failed booking');
    assert.equal(operation(form, 10, 'Installation').value, '0.5');
  } finally { await page.close(); }
});

void test('booking retains quantities on every table page and preserves a stale draft until explicit reload', { concurrency: false }, async () => {
  const api = new ApiFixture(); const item = api.detail.delivery.source.items[0]; assert.ok(item);
  api.detail.delivery.source.items = Array.from({ length: 11 }, (_, index) => ({ ...item, sourceLineId: index + 1, name: `DEMO chair ${index + 1}`, quantity: 2 }));
  api.detail.lineServices = api.detail.delivery.source.items.map((entry) => status(entry.sourceLineId));
  const { page, document } = await openPanel(api);
  try {
    const form = bookingForm(document);
    await click(button(form, 'Next'));
    const lastInput = operation(form, 11, 'Delivery'); await editInput(lastInput, '0.5');
    await click(button(form, 'Previous')); await editInput(operation(form, 1, 'Delivery'), '1');
    await fillDates(form);
    const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST'); await submit(form);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call);
    const body = bookingBody.parse(call.body); assert.equal(body.workLines.length, 11);
    assert.equal(body.workLines.find((line) => line.sourceLineId === 11)?.deliveryMilli, 500);
    assert.equal(body.workLines.find((line) => line.sourceLineId === 1)?.deliveryMilli, 1000);
    await act(async () => { response.reply({ message: 'DEMO timeout' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO timeout', 'error'), 'booking retry');
    await click(button(form, 'Next')); const preservedInput = operation(form, 11, 'Delivery');
    const refresh = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh'));
    const nextDetail = detailSchema.parse({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } });
    nextDetail.lineServices = nextDetail.lineServices?.map((line) => ({ ...line, reservedDeliveryMilli: 1500, availableDeliveryMilli: 500 }));
    await act(async () => { refresh.reply(nextDetail); });
    await waitFor(() => form.textContent?.includes('Use latest data') === true, 'stale work guard');
    assert.equal(operation(form, 11, 'Delivery'), preservedInput); assert.equal(preservedInput.value, '0.5');
    await submit(form); assert.equal(api.calls.filter((entry) => entry.method === 'POST').length, 1);
    await click(button(form, 'Use latest data'));
    assert.equal(operation(form, 1, 'Delivery').value, '0.5', 'Explicit reset takes the new available work');
  } finally { await page.close(); }
});

void test('legacy visit review uses available work, records reason and keeps request receipt on uncertain retry', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.detail = twoOrderDetail();
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: '2026-11-12T08:00:00Z', endsAt: '2026-11-12T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, assignments: [], results: [] })];
  api.detail.appointmentPlanning = [{ appointmentId, reviewReason: 'missing_scope', canEdit: true }];
  api.detail.lineServices = api.detail.lineServices?.map((line) => ({ ...line, planningBlockedReason: 'legacy_scope_review' }));
  const { page, document } = await openPanel(api);
  try {
    assert.match(document.body.textContent ?? '', /no confirmed work list/);
    await click(button(document, 'Review and confirm work'));
    const form = button(document, 'Confirm visit work').closest('form'); assert.ok(form instanceof HTMLFormElement);
    await editInput(input(form, 'input[name="reason"]'), 'Confirm only remaining installation and collection');
    const path = `/deliveries/${deliveryId}/appointments/${appointmentId}/work-scope`;
    const response = api.defer(path, 'PATCH'); await submit(form); assert.equal(response.called, true);
    const first = api.calls.find((entry) => entry.pathname === path); assert.ok(first);
    const body = scopeBody.parse(first.body);
    assert.equal(body.reason, 'Confirm only remaining installation and collection'); assert.equal(body.workLines.length, 2);
    await act(async () => { response.reply({ message: 'DEMO uncertain review' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO uncertain review', 'error'), 'review failure');
    const retry = api.defer(path, 'PATCH'); await submit(form); assert.equal(retry.called, true);
    assert.deepEqual(api.calls.filter((entry) => entry.pathname === path).at(-1)?.body, body);
    await act(async () => { retry.reply({ message: 'DEMO conflict; refresh' }, 409); });
    await waitFor(() => form.textContent?.includes('DEMO conflict; refresh') === true, 'review conflict preserved');
    assert.equal(input(form, 'input[name="reason"]').value, body.reason);
  } finally { await page.close(); }
});

void test('default-service preview protects explicit overrides and recorded work before sending the chosen default', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.detail = twoOrderDetail();
  const item = api.detail.delivery.source.items[0]; assert.ok(item);
  api.detail.delivery.source.items.push({ ...item, sourceLineId: 30 });
  api.detail.lineServices?.push(status(30));
  api.detail.delivery.source.items.push({ ...item, sourceLineId: 40 });
  api.detail.lineServices?.push(status(40, { service: null, locked: true, planningBlockedReason: 'unknown_service' }));
  const { page, document } = await openPanel(api, 'Overview');
  try {
    await click(button(document, 'Edit default service'));
    const form = button(document, 'Save service').closest('form'); assert.ok(form instanceof HTMLFormElement);
    const select = form.querySelector('select'); assert.ok(select);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set; assert.ok(setter);
    await act(async () => { setter.call(select, 'delivery_only'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.match(form.textContent ?? '', /Will change \(2\).*line 30.*line 40.*Will be kept \(2\).*line 10.*line 20/s);
    assert.equal(api.calls.some((entry) => entry.method !== 'GET'), false, 'Preview never mutates');
    const response = api.defer(`/deliveries/${deliveryId}/services`, 'PATCH'); await submit(form);
    assert.deepEqual(api.calls.find((entry) => entry.method === 'PATCH')?.body, { version: 1, defaultService: 'delivery_only' });
    await act(async () => { response.reply({ message: 'DEMO review again' }, 409); });
    await waitFor(() => form.textContent?.includes('DEMO review again') === true, 'preview retained');
  } finally { await page.close(); }
});

void test('an unconfirmed legacy service can be decided explicitly even when actual work and an active visit exist', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.detail.delivery.servicePlan = { defaultService: null, overrides: [] };
  api.detail.lineServices = [status(10, { service: null, locked: true, deliveredMilli: 500, planningBlockedReason: 'unknown_service' })];
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: '2026-11-12T08:00:00Z', endsAt: '2026-11-12T10:00:00Z', status: 'in_progress', cancellationReason: null, returnRequestId: null, assignments: [], results: [] })];
  const { page, document } = await openPanel(api, 'Overview');
  try {
    const editor = Array.from(document.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label')?.startsWith('Edit line service ·'));
    assert.ok(editor); assert.equal(editor.disabled, false); await click(editor);
    const form = button(document, 'Save service').closest('form'); assert.ok(form instanceof HTMLFormElement);
    const select = form.querySelector('select'); assert.ok(select);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set; assert.ok(setter);
    await act(async () => { setter.call(select, 'delivery_installation'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    const response = api.defer(`/deliveries/${deliveryId}/services`, 'PATCH'); await submit(form);
    assert.deepEqual(api.calls.find((entry) => entry.method === 'PATCH')?.body, { version: 1, sourceLineId: 10, service: 'delivery_installation' });
    await act(async () => { response.reply({ message: 'The selected service must preserve the work already recorded' }, 409); });
    await waitFor(() => form.textContent?.includes('The selected service must preserve the work already recorded') === true, 'service conflict remains actionable');
    assert.equal(select.value, 'delivery_installation');
  } finally { await page.close(); }
});

void test('work snapshots retain order-line identity and reject duplicate or mismatched line snapshots', () => {
  const detail = twoOrderDetail(); const first = detail.delivery.source.items[0]; const second = detail.delivery.source.items[1]; assert.ok(first && second);
  const scope = { revision: 1, sourceFingerprint: 'a'.repeat(64), confirmedAt: '2026-11-10T09:00:00Z', confirmedBy: { id: user.id, name: user.name }, lines: [
    { sourceLineId: first.sourceLineId, service: 'delivery_installation', sourceItem: first, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 },
    { sourceLineId: second.sourceLineId, service: 'collection_only', sourceItem: second, deliveryMilli: 0, installationMilli: 0, collectionMilli: 2000 },
  ] };
  assert.equal(workScopeSchema.parse(scope).lines.length, 2);
  const line = scope.lines[0]; assert.ok(line);
  assert.equal(workScopeSchema.safeParse({ ...scope, lines: [line, line] }).success, false);
  assert.equal(workScopeSchema.safeParse({ ...scope, lines: [{ ...line, sourceLineId: 99 }] }).success, false);
  const confirmed = workScopeSchema.parse({ ...scope, lines: [{ ...line, deliveryMilli: 4000 }] });
  assert.equal(workCapacity(status(10, { remainingDeliveryMilli: 5000, reservedDeliveryMilli: 8000, availableDeliveryMilli: 0, planningBlockedReason: 'over_reserved' }), workOperations[0], confirmed), 1000, 'Editing releases only its own reservation even when source reduction caused over-reservation');
});

void test('a scoped visit can reuse its own reservation while a legacy visit in progress exposes explicit review', { concurrency: false }, async () => {
  const api = new ApiFixture(); const item = api.detail.delivery.source.items[0]; assert.ok(item);
  const scope = workScopeSchema.parse({ revision: 1, sourceFingerprint: 'b'.repeat(64), confirmedAt: '2026-11-10T08:00:00Z', confirmedBy: { id: user.id, name: user.name },
    lines: [{ sourceLineId: 10, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0, service: 'delivery_only', sourceItem: item }] });
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: '2026-11-12T08:00:00Z', endsAt: '2026-11-12T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, assignments: [], results: [], workScope: scope })];
  api.detail.appointmentPlanning = [{ appointmentId, reviewReason: null, canEdit: true }];
  api.detail.lineServices = [status(10, { service: 'delivery_only', totalDeliveryMilli: 1000, remainingDeliveryMilli: 1000, totalInstallationMilli: 0, remainingInstallationMilli: 0, availableInstallationMilli: 0, reservedDeliveryMilli: 1000, availableDeliveryMilli: 0 })];
  const { page, document } = await openPanel(api);
  try {
    await click(button(document, 'Edit visit work'));
    const form = button(document, 'Confirm visit work').closest('form'); assert.ok(form instanceof HTMLFormElement);
    assert.equal(operation(form, 10, 'Delivery').value, '1'); assert.equal(operation(form, 10, 'Delivery').max, '1');
    assert.equal(operation(bookingForm(document), 10, 'Delivery').value, '0', 'New booking cannot reuse the reservation');
    await editInput(input(form, 'input[name="reason"]'), 'Keep the confirmed delivery quantity');
    const response = api.defer(`/deliveries/${deliveryId}/appointments/${appointmentId}/work-scope`, 'PATCH'); await submit(form);
    assert.equal(response.called, true);
    await act(async () => { response.reply({ message: 'DEMO retry' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO retry', 'error'), 'review retained');
  } finally { await page.close(); }
  const legacy = new ApiFixture();
  legacy.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: '2026-11-12T08:00:00Z', endsAt: '2026-11-12T10:00:00Z', status: 'in_progress', cancellationReason: null, returnRequestId: null, assignments: [], results: [] })];
  legacy.detail.appointmentPlanning = [{ appointmentId, reviewReason: 'missing_scope', canEdit: true }];
  const active = await openPanel(legacy, 'Overview');
  try { assert.equal(button(active.document, 'Review and confirm work').disabled, false); }
  finally { await active.page.close(); }
});

void test('History shows the recorded work snapshot with original product names and services after current edits', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.detail = twoOrderDetail();
  const original = structuredClone(api.detail.delivery.source);
  const first = original.items[0]; const second = original.items[1]; assert.ok(first && second);
  const at = '2026-11-10T09:00:00Z';
  const scope = workScopeSchema.parse({ revision: 2, sourceFingerprint: 'c'.repeat(64), confirmedAt: at, confirmedBy: { id: user.id, name: user.name }, lines: [
    { sourceLineId: 10, deliveryMilli: 0, installationMilli: 500, collectionMilli: 0, service: 'delivery_installation', sourceItem: first },
    { sourceLineId: 20, deliveryMilli: 0, installationMilli: 0, collectionMilli: 2000, service: 'collection_only', sourceItem: second },
  ] });
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: at, endsAt: '2026-11-10T10:00:00Z', status: 'completed', cancellationReason: null, returnRequestId: null, assignments: [], workScope: scope,
    results: [{ id: '57000000-0000-4000-8000-000000000002', appointmentId, receivedAt: at, actualStart: at, actualEnd: at, summary: 'DEMO original visit', supersedesResultId: null, correctionReason: null,
      actor: { kind: 'crew', id: user.id, name: 'DEMO participant' }, responsiblePersonId: user.id, quantities: [], evidence: [], customerSignature: null, crewSignature: null,
      sourceSnapshot: original, instructionsSnapshot: api.detail.delivery.instructions, assignmentsSnapshot: [], workScopeSnapshot: scope }] })];
  api.detail.delivery.source.items = api.detail.delivery.source.items.map((item) => ({ ...item, name: 'DEMO renamed current product' }));
  api.detail.delivery.servicePlan = { defaultService: 'delivery_only', overrides: [] };
  const { page, document } = await openPanel(api, 'History');
  try {
    const snapshot = document.querySelector('.result-card .visit-work-snapshot'); assert.ok(snapshot);
    assert.match(snapshot.textContent ?? '', /DEMO identical chair.*DEMO\/SO\/FIRST.*line 10.*Delivery.*installation.*0\.5.*DEMO identical chair.*DEMO\/SO\/SECOND.*line 20.*Collection/s);
    assert.doesNotMatch(snapshot.textContent ?? '', /DEMO renamed current product/);
    assert.equal(snapshot.querySelectorAll('tbody tr').length, 2);
  } finally { await page.close(); }
});
