import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { z } from 'zod';
import { appointmentSchema, workLineSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';

const bookingBody = z.object({ version: z.number().int().positive(), requestId: z.uuid(), startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }), returnRequestId: z.uuid().optional(), workLines: z.array(workLineSchema).min(1) }).strict();
const appointmentId = '50000000-0000-4000-8000-000000000050';

function picker(form: HTMLFormElement, name: 'startsAt' | 'endsAt'): HTMLInputElement {
  const field = form.querySelector(`input[data-booking-field="${name}"]`);
  assert.ok(field instanceof HTMLInputElement);
  assert.equal(field.type, 'datetime-local');
  assert.equal(field.name, '', 'Only the resolved instant belongs in FormData');
  return field;
}

function resolvedValue(form: HTMLFormElement, name: 'startsAt' | 'endsAt'): string {
  const value = new FormData(form).get(name);
  assert.ok(typeof value === 'string');
  return value;
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

async function chooseOccurrence(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => { setter.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); });
}

async function openBooking(api: ApiFixture) {
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea[name="notes"]') !== null, 'loaded delivery');
    const panel = document.querySelector('.delivery-panel');
    assert.ok(panel);
    await click(button(panel, 'Visits & tasks'));
    const form = pickerForm(panel, 'Book appointment');
    return { page, panel, form };
  } catch (error: unknown) { await page.close(); throw error; }
}

function pickerForm(scope: ParentNode, submitLabel: string): HTMLFormElement {
  const form = button(scope, submitLabel).closest('form');
  assert.ok(form instanceof HTMLFormElement);
  return form;
}

function savedAppointment(startsAt: string, endsAt: string) {
  return appointmentSchema.parse({ id: appointmentId, startsAt, endsAt, status: 'booked', cancellationReason: null,
    returnRequestId: null, assignments: [], results: [] });
}

void test('native booking controls submit Rome winter and summer instants without a typed UTC offset', { concurrency: false }, async () => {
  for (const scenario of [
    { day: '2026-01-15', start: '2026-01-15T08:15:00.000Z', end: '2026-01-15T09:45:00.000Z' },
    { day: '2026-07-15', start: '2026-07-15T07:15:00.000Z', end: '2026-07-15T08:45:00.000Z' },
  ]) {
    const api = new ApiFixture();
    const { page, form } = await openBooking(api);
    try {
      await editInput(picker(form, 'startsAt'), `${scenario.day}T09:15`);
      await editInput(picker(form, 'endsAt'), `${scenario.day}T10:45`);
      assert.equal(form.querySelector('select[aria-label$=" occurrence"]'), null);
      assert.equal(resolvedValue(form, 'startsAt'), scenario.start);
      assert.equal(resolvedValue(form, 'endsAt'), scenario.end);
      assert.equal(form.checkValidity(), true);
      const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
      await click(button(form, 'Book appointment'));
      assert.equal(response.called, true);
      const call = api.calls.find((candidate) => candidate.method === 'POST');
      assert.ok(call);
      const body = bookingBody.parse(call.body);
      assert.equal(body.version, 1);
      assert.equal(body.startsAt, scenario.start);
      assert.equal(body.endsAt, scenario.end);
      const saved = detailFixture(2);
      saved.delivery.appointments = [savedAppointment(body.startsAt, body.endsAt)];
      saved.views = ['planned']; saved.progress = 'planned'; saved.coverage = { assigned: 0, total: 1 };
      await act(async () => { response.reply(saved); });
      await waitFor(() => hasToast(form.ownerDocument, 'Saved'), 'confirmed booking');
    } finally { await page.close(); }
  }
});

void test('missing spring hour and impossible calendar dates never issue a booking request', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const { page, form } = await openBooking(api);
  try {
    const start = picker(form, 'startsAt');
    await editInput(start, '2026-03-29T02:30');
    await editInput(picker(form, 'endsAt'), '2026-03-29T03:30');
    assert.equal(start.value, '2026-03-29T02:30');
    assert.equal(resolvedValue(form, 'startsAt'), '');
    assert.equal(start.validity.valid, false);
    assert.match(form.textContent ?? '', /This time does not exist in Europe\/Rome/);
    await click(button(form, 'Book appointment'));
    await submit(form);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    assert.match(form.textContent ?? '', /Choose a valid date and time in Europe\/Rome/);

    await editInput(start, '2026-02-30T09:00');
    assert.equal(start.value, '', 'The native picker rejects an impossible date');
    assert.equal(resolvedValue(form, 'startsAt'), '');
    await submit(form);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);

    await editInput(start, '2026-03-29T04:00');
    assert.equal(start.validity.valid, true, 'Choosing a real time clears the gap error');
    await submit(form);
    assert.match(form.textContent ?? '', /End time must be after start time/);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});

void test('new repeated-hour bookings require an explicit occurrence and send the selected instant', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const { page, form } = await openBooking(api);
  try {
    await editInput(picker(form, 'startsAt'), '2026-10-25T02:30');
    await editInput(picker(form, 'endsAt'), '2026-10-25T03:30');
    const occurrence = form.querySelector('select[aria-label="Starts at occurrence"]');
    assert.ok(occurrence instanceof HTMLSelectElement);
    assert.equal(occurrence.value, '', 'A new ambiguous wall time must not silently pick the first occurrence');
    assert.deepEqual(Array.from(occurrence.options).map((option) => ({ value: option.value, text: option.text })), [
      { value: '', text: 'Choose occurrence' },
      { value: '2026-10-25T00:30:00.000Z', text: 'First occurrence · UTC+02:00' },
      { value: '2026-10-25T01:30:00.000Z', text: 'Second occurrence · UTC+01:00' },
    ]);
    assert.equal(resolvedValue(form, 'startsAt'), '');
    await act(async () => { assert.equal(form.checkValidity(), false); });
    await submit(form);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    await chooseOccurrence(occurrence, '2026-10-25T01:30:00.000Z');
    assert.equal(resolvedValue(form, 'startsAt'), '2026-10-25T01:30:00.000Z');
    assert.equal(form.checkValidity(), true);
    const response = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await submit(form);
    assert.equal(response.called, true);
    const call = api.calls.find((candidate) => candidate.method === 'POST');
    assert.ok(call);
    const body = bookingBody.parse(call.body);
    assert.equal(body.startsAt, '2026-10-25T01:30:00.000Z');
    assert.equal(body.endsAt, '2026-10-25T02:30:00.000Z');
    await act(async () => { response.reply({ message: 'DEMO booking response' }, 503); });
  } finally { await page.close(); }
});

void test('rescheduling prefills the stored repeated-hour occurrence and retains subminute precision unchanged', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const appointment = savedAppointment('2026-10-25T01:30:45.123Z', '2026-10-25T02:15:37.456Z');
  api.detail.delivery.appointments = [appointment];
  api.detail.progress = 'planned'; api.detail.views = ['planned']; api.detail.coverage = { assigned: 0, total: 1 };
  const { page, panel } = await openBooking(api);
  try {
    await click(button(panel, 'Manage assignment, reschedule or cancel ↓'));
    const scheduling = panel.ownerDocument.querySelector('.visit-scheduling-dialog');
    assert.ok(scheduling instanceof page.dom.window.HTMLElement);
    assert.equal(scheduling.getAttribute('role'), 'dialog');
    const form = pickerForm(scheduling, 'Save new time');
    const details = form.closest('details');
    assert.ok(details);
    await act(async () => { details.open = true; });
    const start = picker(form, 'startsAt');
    const end = picker(form, 'endsAt');
    assert.equal(start.value, '2026-10-25T02:30:45.123');
    assert.equal(end.value, '2026-10-25T03:15:37.456');
    assert.equal(start.validity.stepMismatch, false);
    assert.equal(end.validity.stepMismatch, false);
    const occurrence = form.querySelector('select[aria-label="Starts at occurrence"]');
    assert.ok(occurrence instanceof HTMLSelectElement);
    assert.equal(occurrence.value, appointment.startsAt);
    assert.equal(resolvedValue(form, 'startsAt'), appointment.startsAt);
    assert.equal(resolvedValue(form, 'endsAt'), appointment.endsAt);
    assert.equal(form.checkValidity(), true);
    const response = api.defer(`/deliveries/${deliveryId}/appointments/${appointmentId}`, 'PATCH');
    await click(button(form, 'Save new time'));
    assert.equal(response.called, true);
    const call = api.calls.find((candidate) => candidate.method === 'PATCH');
    assert.ok(call);
    const body = z.object({ version: z.literal(1), startsAt: z.string(), endsAt: z.string() }).strict().parse(call.body);
    assert.equal(body.startsAt, appointment.startsAt);
    assert.equal(body.endsAt, appointment.endsAt);
    const saved = detailFixture(2);
    saved.delivery.appointments = [appointment];
    await act(async () => { response.reply(saved); });
    await waitFor(() => hasToast(form.ownerDocument, 'Saved'), 'confirmed unchanged reschedule');
  } finally { await page.close(); }
});
