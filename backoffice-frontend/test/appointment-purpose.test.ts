import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { z } from 'zod';
import { workLineSchema, appointmentSchema, type Delivery } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, user, waitFor } from './refresh-fixtures';

const originId = '54000000-0000-4000-8000-000000000001';
const returnId = '54000000-0000-4000-8000-000000000002';
const otherReturnId = '54000000-0000-4000-8000-000000000003';
const plannedReturnId = '54000000-0000-4000-8000-000000000004';
const resolvedReturnId = '54000000-0000-4000-8000-000000000005';
const bookingBody = z.object({ version: z.number().int().positive(), requestId: z.uuid(), startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }), returnRequestId: z.uuid().optional(), workLines: z.array(workLineSchema).min(1) }).strict();

function request(id: string, status: Delivery['returnRequests'][number]['status'], reason: string): Delivery['returnRequests'][number] {
  return { id, status, reason, originAppointmentId: originId, remainingWork: `DEMO remaining work for ${reason}`,
    notes: `DEMO notes for ${reason}`, photoIds: [], issueIds: [], appointmentId: null,
    createdAt: '2026-11-10T10:00:00.000Z', resolvedAt: null, resolution: null };
}

function setupApi(requests: Delivery['returnRequests']): ApiFixture {
  const api = new ApiFixture();
  api.detail.delivery.returnRequests = requests;
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: originId, startsAt: '2026-11-09T08:00:00.000Z', endsAt: '2026-11-09T09:00:00.000Z',
    status: 'completed', cancellationReason: null, returnRequestId: null, assignments: [], results: [] })];
  return api;
}

async function openBooking(api: ApiFixture) {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const panel = page.dom.window.document.querySelector('.delivery-panel');
    assert.ok(panel);
    await waitFor(() => panel.querySelector('textarea[name="notes"]') !== null, 'loaded delivery');
    await click(button(panel, 'Visits & tasks'));
    const form = button(panel, 'Book appointment').closest('form');
    assert.ok(form instanceof HTMLFormElement);
    return { page, panel, form };
  } catch (error: unknown) { await page.close(); throw error; }
}

function input(scope: ParentNode, selector: string): HTMLInputElement {
  const element = scope.querySelector(selector);
  assert.ok(element instanceof HTMLInputElement);
  return element;
}

function returnSelect(form: HTMLFormElement): HTMLSelectElement {
  const element = form.querySelector('select[name="returnRequestId"]');
  assert.ok(element instanceof HTMLSelectElement);
  return element;
}

async function chooseReturn(form: HTMLFormElement): Promise<void> {
  const radio = input(form, 'input[type="radio"][value="return"]');
  assert.equal(radio.disabled, false);
  await act(async () => { radio.click(); });
  assert.equal(radio.checked, true);
}

async function fillTime(form: HTMLFormElement): Promise<void> {
  await editInput(input(form, 'input[data-booking-field="startsAt"]'), '2026-11-11T10:00');
  await editInput(input(form, 'input[data-booking-field="endsAt"]'), '2026-11-11T11:00');
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

void test('regular bookings omit a return link and planned or resolved requests cannot be reused', { concurrency: false }, async () => {
  const api = setupApi([request(plannedReturnId, 'planned', 'Already planned'), request(resolvedReturnId, 'resolved', 'Already resolved')]);
  const { page, form } = await openBooking(api);
  try {
    assert.equal(input(form, 'input[type="radio"][value="regular"]').checked, true);
    assert.equal(input(form, 'input[type="radio"][value="return"]').disabled, true);
    assert.equal(form.querySelector('select[name="returnRequestId"]'), null);
    assert.match(form.textContent ?? '', /Create a request in Issues & returns first/);
    await fillTime(form);
    const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await click(button(form, 'Book appointment'));
    assert.equal(response.called, true);
    const call = api.calls.find((candidate) => candidate.method === 'POST');
    assert.ok(call);
    const body = bookingBody.parse(call.body);
    assert.equal(body.returnRequestId, undefined);
    assert.equal(body.startsAt, '2026-11-11T09:00:00.000Z');
    await act(async () => { response.reply({ message: 'DEMO temporary failure' }, 503); });
  } finally { await page.close(); }
});

void test('a single pending return is selected automatically and shows its remaining work before linking the booking', { concurrency: false }, async () => {
  const api = setupApi([request(returnId, 'requested', 'Install the delivered chair'), request(plannedReturnId, 'planned', 'Already planned'), request(resolvedReturnId, 'resolved', 'Already resolved')]);
  const { page, form } = await openBooking(api);
  try {
    await fillTime(form);
    await chooseReturn(form);
    const select = returnSelect(form);
    assert.equal(select.value, returnId);
    assert.deepEqual(Array.from(select.options).map((option) => option.value), ['', returnId]);
    const preview = form.querySelector('.booking-return-preview');
    assert.ok(preview);
    assert.match(preview.textContent ?? '', /DEMO remaining work for Install the delivered chair/);
    assert.match(preview.textContent ?? '', /DEMO notes for Install the delivered chair/);
    assert.match(preview.textContent ?? '', /Previous visit:/);
    assert.equal(input(form, 'input[data-booking-field="startsAt"]').value, '2026-11-11T10:00', 'Changing purpose preserves the entered schedule');
    const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await click(button(form, 'Book appointment'));
    assert.equal(response.called, true);
    const call = api.calls.find((candidate) => candidate.method === 'POST');
    assert.ok(call);
    assert.equal(bookingBody.parse(call.body).returnRequestId, returnId);
    await act(async () => { response.reply({ message: 'DEMO temporary failure' }, 503); });
    await act(async () => { input(form, 'input[type="radio"][value="regular"]').click(); });
    assert.equal(new FormData(form).get('returnRequestId'), '', 'A regular visit never submits a previously selected return link');
    assert.equal(form.querySelector('.booking-return-preview'), null);
  } finally { await page.close(); }
});

void test('multiple returns require an explicit choice and refreshing preserves the draft while blocking a stale booking', { concurrency: false }, async () => {
  const api = setupApi([request(returnId, 'requested', 'Install the delivered chair'), request(otherReturnId, 'requested', 'Collect packaging')]);
  const { page, panel, form } = await openBooking(api);
  try {
    await fillTime(form);
    await chooseReturn(form);
    const select = returnSelect(form);
    assert.equal(select.value, '');
    assert.equal(form.checkValidity(), false);
    await submit(form);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    assert.match(form.textContent ?? '', /Choose a return request/);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => { setter.call(select, otherReturnId); select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(form.checkValidity(), true);
    assert.match(form.querySelector('.booking-return-preview')?.textContent ?? '', /DEMO remaining work for Collect packaging/);
    const start = input(form, 'input[data-booking-field="startsAt"]');
    const refresh = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    await act(async () => { refresh.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); });
    await waitFor(() => form.textContent?.includes('Use latest data') === true, 'new version notice');
    assert.equal(returnSelect(form), select, 'Refreshing does not replace the return selector');
    assert.equal(select.value, otherReturnId);
    assert.equal(input(form, 'input[data-booking-field="startsAt"]'), start, 'Refreshing does not replace the date picker');
    assert.equal(start.value, '2026-11-11T10:00');
    await submit(form);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false, 'The preserved draft cannot overwrite a newer delivery version');
    await click(button(form, 'Use latest data'));
    assert.equal(input(form, 'input[type="radio"][value="regular"]').checked, true);
    assert.equal(input(form, 'input[data-booking-field="startsAt"]').value, '');
  } finally { await page.close(); }
});
