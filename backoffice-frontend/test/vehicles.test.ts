import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { mutate } from '../src/lib/api';
import { appointmentSchema, detailSchema, transportAllocationSchema, vehicleSchema, type Vehicle } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, user, waitFor } from './refresh-fixtures';

const vehicleId = '87000000-0000-4000-8000-000000000001';
const replacementId = '87000000-0000-4000-8000-000000000002';
const driverId = '87000000-0000-4000-8000-000000000010';
const visitId = '87000000-0000-4000-8000-000000000020';
const allocationId = '87000000-0000-4000-8000-000000000030';
const conflict = { appointmentId: '87000000-0000-4000-8000-000000000021', pickingName: 'DEMO occupied picking', startsAt: '2026-11-10T07:00:00Z', endsAt: '2026-11-10T11:00:00Z' };
const admin = { ...user, role: 'admin' as const };

function vehicle(id = vehicleId, name = 'DEMO van'): Vehicle {
  return vehicleSchema.parse({ id, version: 1, name, plate: id === vehicleId ? 'AB-123 CD' : 'EF 456-GH', ownership: 'company', providerName: null, providerContact: null, enabled: true, operationalStatus: 'available', notes: null });
}

function fixture() {
  const api = new ApiFixture();
  api.vehicles = [vehicle(), vehicle(replacementId, 'DEMO replacement')];
  api.transportAvailability = { vehicles: api.vehicles.map((entry) => ({ ...entry, busy: false, conflicts: [] })), people: [{ id: driverId, name: 'DEMO independent driver', external: false, enabled: true, busy: false, conflicts: [] }] };
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: visitId, startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, results: [], assignments: [{ id: '87000000-0000-4000-8000-000000000040', crewId: '87000000-0000-4000-8000-000000000041', crewName: 'DEMO visit crew', people: [{ id: '87000000-0000-4000-8000-000000000011', name: 'DEMO crew worker', external: false }], tasks: [] }] })];
  return api;
}

function allocation() {
  return transportAllocationSchema.parse({ id: allocationId, vehicle: vehicle(), driver: { kind: 'none' }, reserveFrom: '2026-11-10T07:00:00Z', reserveTo: '2026-11-10T11:00:00Z', status: 'active', createdAt: '2026-11-04T12:00:00Z', createdBy: { id: user.id, name: user.name }, replacesAllocationId: null, retiredAt: null, retiredBy: null, retirementReason: null });
}

function input(scope: ParentNode, selector: string): HTMLInputElement { const found = scope.querySelector(selector); assert.ok(found instanceof HTMLInputElement, selector); return found; }
function form(scope: ParentNode): HTMLFormElement { const found = scope.querySelector('form'); assert.ok(found instanceof HTMLFormElement); return found; }
async function submit(scope: ParentNode) { await act(async () => { form(scope).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function choose(scope: ParentNode, name: string, value: string) { const select = Array.from(scope.querySelectorAll('select')).find((entry) => entry.name === name || entry.closest('label')?.querySelector('span')?.textContent === name); assert.ok(select); await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function selectRadio(scope: ParentNode, value: string) { const radio = input(scope, `input[type="radio"][value="${value}"]`); assert.equal(radio.disabled, false); await act(async () => { radio.click(); }); }

async function renderTransport(api: ApiFixture) {
  const page = await domHarness(api); const { VisitTransport } = await import('../src/components/visit-transport');
  const candidate = api.detail.delivery.appointments[0]; assert.ok(candidate); const appointment = candidate;
  const command = async (path: string, body: unknown) => (await mutate(`/deliveries/${deliveryId}${path}`, detailSchema, body)).delivery.version;
  async function render(refreshKey = 0) { await page.render(createElement(VisitTransport, { deliveryId, version: api.detail.delivery.version, appointment, vehicles: api.vehicles, closed: false, refreshKey, command })); }
  await render(); return { ...page, renderTransport: render, appointment };
}

void test('vehicle catalog admin creates real normalized payloads, keeps drafts during refresh, and operators only read', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { VehiclesDirectory } = await import('../src/components/vehicles-directory'); await page.render(createElement(VehiclesDirectory, { user: admin })); const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.vehicles-table') !== null, 'vehicles'); await click(button(doc, '+ New vehicle')); const dialog = doc.querySelector('.dialog'); assert.ok(dialog);
    input(dialog, '[name="name"]').value = 'DEMO external van'; input(dialog, '[name="plate"]').value = ' ab-123 cd '; await choose(dialog, 'Ownership', 'external'); input(dialog, '[name="providerName"]').value = 'DEMO carrier'; input(dialog, '[name="providerContact"]').value = '+390000000000';
    const sameInput = input(dialog, '[name="name"]'); const refresh = api.defer('/vehicles'); await click(button(doc, '↻ Refresh vehicles')); assert.strictEqual(input(dialog, '[name="name"]'), sameInput); assert.equal(sameInput.value, 'DEMO external van'); await act(async () => { refresh.reply(api.vehicles); }); await settle();
    const post = api.defer('/vehicles', 'POST'); await submit(dialog); assert.equal(post.called, true);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call); const body = z.object({ name: z.string(), plate: z.string(), ownership: z.literal('external'), providerName: z.string(), providerContact: z.string(), enabled: z.boolean(), operationalStatus: z.string(), notes: z.null() }).strict().parse(call.body);
    assert.deepEqual(body, { name: 'DEMO external van', plate: 'AB-123 CD', ownership: 'external', providerName: 'DEMO carrier', providerContact: '+390000000000', enabled: true, operationalStatus: 'available', notes: null });
    await act(async () => { post.reply({ ...vehicle('87000000-0000-4000-8000-000000000003'), ...body }); }); await waitFor(() => doc.querySelector('.dialog') === null, 'create saved');
    await page.render(createElement(VehiclesDirectory, { key: 'operator', user })); await waitFor(() => doc.querySelector('.vehicles-table') !== null, 'operator vehicles'); assert.doesNotMatch(doc.body.textContent ?? '', /New vehicle|Edit vehicle/);
  } finally { await page.close(); }
});

void test('vehicle edits retain captured version and require provider details only for external physical vehicles', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { VehiclesDirectory } = await import('../src/components/vehicles-directory'); await page.render(createElement(VehiclesDirectory, { user: admin })); const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.vehicles-table') !== null, 'vehicles'); await click(button(doc, 'Edit vehicle')); const dialog = doc.querySelector('.dialog'); assert.ok(dialog);
    await choose(dialog, 'Ownership', 'external'); await submit(dialog); await waitFor(() => dialog.textContent?.includes('Provide the external transport provider name.') === true, 'provider validation'); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await choose(dialog, 'Ownership', 'company'); input(dialog, '[name="name"]').value = 'DEMO renamed van'; api.vehicles[0] = { ...vehicle(), version: 2 }; await click(button(doc, '↻ Refresh vehicles')); await settle(); assert.match(dialog.textContent ?? '', /newer vehicle revision/);
    const patch = api.defer(`/vehicles/${vehicleId}`, 'PATCH'); await submit(dialog); assert.equal(patch.called, true); const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call); assert.deepEqual(z.object({ version: z.literal(1), providerName: z.null(), providerContact: z.null() }).passthrough().parse(call.body).version, 1);
    await act(async () => { patch.reply({ message: 'Vehicle changed. Refresh before saving.', code: 'CONFLICT' }, 409); }); await waitFor(() => dialog.textContent?.includes('Vehicle changed.') === true, 'version conflict'); assert.equal(input(dialog, '[name="name"]').value, 'DEMO renamed van');
    assert.match(dialog.textContent ?? '', /existing reservations/);
  } finally { await page.close(); }
});

void test('transport allocates an independent participant driver and preserves request ID for an uncertain retry', { concurrency: false }, async () => {
  const api = fixture(); const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; await click(button(doc, '+ Allocate vehicle')); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'availability'); await selectRadio(doc, vehicleId); await choose(doc, 'Driver', 'participant'); await selectRadio(doc, driverId);
    const path = `/deliveries/${deliveryId}/appointments/${visitId}/transport`; const first = api.defer(path, 'POST'); await submit(doc); assert.equal(first.called, true); const firstCall = api.calls.find((call) => call.method === 'POST'); assert.ok(firstCall);
    const schema = z.object({ version: z.literal(1), requestId: z.uuid(), vehicleId: z.literal(vehicleId), reserveFrom: z.literal('2026-11-10T08:00:00.000Z'), reserveTo: z.literal('2026-11-10T10:00:00.000Z'), driver: z.object({ kind: z.literal('participant'), participantId: z.literal(driverId) }).strict() }).strict(); const firstBody = schema.parse(firstCall.body);
    await act(async () => { first.reply({ message: 'Uncertain transport response. Retry the same request.', code: 'UNAVAILABLE' }, 503); }); await waitFor(() => button(doc, 'Allocate vehicle').disabled === false, 'retry allowed');
    const retry = api.defer(path, 'POST'); await submit(doc); assert.equal(retry.called, true); const calls = api.calls.filter((call) => call.method === 'POST'); assert.deepEqual(schema.parse(calls[1]?.body), firstBody);
    const saved = detailSchema.parse({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); await act(async () => { retry.reply(saved); }); await waitFor(() => doc.querySelector('.dialog') === null, 'allocation saved');
  } finally { await page.close(); }
});

void test('transport blocks occupied, disabled, unavailable and already allocated resources with interval reasons', { concurrency: false }, async () => {
  const api = fixture(); const current = allocation(); const visit = api.detail.delivery.appointments[0]; assert.ok(visit); visit.transportAllocations = [current];
  api.transportAvailability.vehicles[1] = { ...vehicle(replacementId, 'DEMO busy van'), busy: true, conflicts: [conflict] };
  api.transportAvailability.vehicles.push({ ...vehicle('87000000-0000-4000-8000-000000000003', 'DEMO disabled van'), enabled: false, busy: false, conflicts: [] }, { ...vehicle('87000000-0000-4000-8000-000000000004', 'DEMO maintenance van'), operationalStatus: 'maintenance', busy: false, conflicts: [] });
  api.transportAvailability.people[0] = { id: driverId, name: 'DEMO occupied driver', external: false, enabled: true, busy: true, conflicts: [conflict] };
  const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; await click(button(doc, '+ Allocate vehicle')); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'availability'); for (const radio of doc.querySelectorAll<HTMLInputElement>('input[name="vehicleId"]')) assert.equal(radio.disabled, true);
    assert.match(doc.body.textContent ?? '', /Already allocated to this visit/); assert.match(doc.body.textContent ?? '', /DEMO occupied picking/); assert.match(doc.body.textContent ?? '', /10 Nov 2026/); assert.match(doc.body.textContent ?? '', /maintenance/);
    await choose(doc, 'Driver', 'participant'); assert.equal(input(doc, `input[value="${driverId}"]`).disabled, true); assert.match(doc.body.textContent ?? '', /Occupied:/);
    await submit(doc); assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});

void test('transport verifies a manual window, rejects noncovering dates, and retains all draft controls through refresh/races', { concurrency: false }, async () => {
  const api = fixture(); const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; await click(button(doc, '+ Allocate vehicle')); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'availability'); await selectRadio(doc, replacementId); await choose(doc, 'Driver', 'external'); input(doc, '[name="driverName"]').value = 'DEMO hired driver'; input(doc, '[name="driverPhone"]').value = '+390000000000';
    const from = input(doc, '[data-booking-field="reserveFrom"]'); const until = input(doc, '[data-booking-field="reserveTo"]'); await editInput(from, '2026-11-10T10:00'); await click(button(doc, 'Check availability')); assert.match(doc.body.textContent ?? '', /cover the entire visit/); assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    await editInput(from, '2026-11-10T08:00'); await editInput(until, '2026-11-10T13:00'); await click(button(doc, 'Check availability')); await settle(); const request = api.calls.filter((call) => call.pathname.endsWith('/transport/availability')).at(-1); assert.ok(request); const query = new URLSearchParams(request.search); assert.equal(query.get('from'), '2026-11-10T07:00:00.000Z'); assert.equal(query.get('to'), '2026-11-10T12:00:00.000Z');
    const oldest = api.defer(request.pathname); await page.renderTransport(1); assert.equal(oldest.called, true); const newest = api.defer(request.pathname); await page.renderTransport(2); assert.equal(newest.called, true);
    await act(async () => { newest.reply(api.transportAvailability); }); await settle(); await act(async () => { oldest.reply({ message: 'Old failure', code: 'UNAVAILABLE' }, 503); }); await settle();
    assert.strictEqual(input(doc, '[data-booking-field="reserveFrom"]'), from); assert.equal(from.value, '2026-11-10T08:00'); assert.equal(until.value, '2026-11-10T13:00'); assert.equal(input(doc, '[name="driverName"]').value, 'DEMO hired driver'); assert.equal(input(doc, `input[value="${replacementId}"]`).checked, true); assert.doesNotMatch(doc.body.textContent ?? '', /Old failure/);
    const path = `/deliveries/${deliveryId}/appointments/${visitId}/transport`; const post = api.defer(path, 'POST'); await submit(doc); assert.equal(post.called, true); const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call); const body = z.object({ reserveFrom: z.literal('2026-11-10T07:00:00.000Z'), reserveTo: z.literal('2026-11-10T12:00:00.000Z'), driver: z.object({ kind: z.literal('external'), name: z.literal('DEMO hired driver'), phone: z.literal('+390000000000') }) }).passthrough().parse(call.body); assert.equal(body.driver.kind, 'external'); await act(async () => { post.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); }); await settle();
  } finally { await page.close(); }
});

void test('transport replacement and cancellation require reasons, preserve old records and become read-only after completion', { concurrency: false }, async () => {
  const api = fixture(); const visit = api.detail.delivery.appointments[0]; assert.ok(visit); visit.transportAllocations = [allocation()]; const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; const replaceButton = doc.querySelector('button[aria-label="Replace DEMO van"]'); assert.ok(replaceButton instanceof HTMLButtonElement); await click(replaceButton); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'replacement availability'); await selectRadio(doc, replacementId); await submit(doc); assert.match(doc.body.textContent ?? '', /Provide a reason/); assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    const reason = doc.querySelector('textarea[name="reason"]'); assert.ok(reason instanceof HTMLTextAreaElement); reason.value = 'DEMO breakdown'; const path = `/deliveries/${deliveryId}/appointments/${visitId}/transport/${allocationId}/replace`; const post = api.defer(path, 'POST'); await submit(doc); assert.equal(post.called, true); const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call); assert.equal(z.object({ reason: z.literal('DEMO breakdown'), vehicleId: z.literal(replacementId), requestId: z.uuid(), version: z.literal(1) }).passthrough().parse(call.body).reason, 'DEMO breakdown');
    await act(async () => { post.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); }); await waitFor(() => doc.querySelector('.dialog') === null, 'replacement saved');
    const cancelButton = doc.querySelector('button[aria-label="Cancel transport DEMO van"]'); assert.ok(cancelButton instanceof HTMLButtonElement); await click(cancelButton); const cancelReason = doc.querySelector('textarea[name="reason"]'); assert.ok(cancelReason instanceof HTMLTextAreaElement); cancelReason.value = 'DEMO route changed'; const cancelPath = `/deliveries/${deliveryId}/appointments/${visitId}/transport/${allocationId}/cancel`; const cancel = api.defer(cancelPath, 'POST'); await submit(doc); assert.equal(cancel.called, true); const cancelCall = api.calls.find((entry) => entry.pathname === cancelPath); assert.ok(cancelCall); assert.equal(z.object({ version: z.literal(1), requestId: z.uuid(), reason: z.literal('DEMO route changed') }).strict().parse(cancelCall.body).reason, 'DEMO route changed'); await act(async () => { cancel.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); }); await settle();
    visit.status = 'completed'; const saved = visit.transportAllocations[0]; assert.ok(saved); saved.status = 'replaced'; saved.retirementReason = 'DEMO breakdown'; saved.retiredAt = '2026-11-04T13:00:00Z'; saved.retiredBy = { id: user.id, name: user.name }; await page.renderTransport(1);
    assert.doesNotMatch(doc.body.textContent ?? '', /Allocate vehicle|Replace AB|Cancel AB|DEMO van|DEMO breakdown|08:00.*12:00/s); assert.match(doc.body.textContent ?? '', /No active transport/); assert.equal(visit.transportAllocations.length, 1); assert.equal(saved.retirementReason, 'DEMO breakdown', 'Filtering keeps the retired allocation unchanged for History');
  } finally { await page.close(); }
});

void test('existing transport on an unstaffed booked visit can be cancelled without first assigning a crew', { concurrency: false }, async () => {
  const api = fixture(); const visit = api.detail.delivery.appointments[0]; assert.ok(visit); visit.assignments = []; visit.transportAllocations = [allocation()]; const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; assert.equal(Array.from(doc.querySelectorAll('button')).some((entry) => entry.textContent === '+ Allocate vehicle'), false);
    const cancelButton = doc.querySelector('button[aria-label="Cancel transport DEMO van"]'); assert.ok(cancelButton instanceof HTMLButtonElement); await click(cancelButton); const reason = doc.querySelector('textarea[name="reason"]'); assert.ok(reason instanceof HTMLTextAreaElement); reason.value = 'DEMO explicit release'; const path = `/deliveries/${deliveryId}/appointments/${visitId}/transport/${allocationId}/cancel`; const cancel = api.defer(path, 'POST'); await submit(doc); assert.equal(cancel.called, true); await act(async () => { cancel.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); }); await waitFor(() => doc.querySelector('.dialog') === null, 'unstaffed cancellation');
  } finally { await page.close(); }
});

void test('delivery refresh warns about active fleet maintenance while preserving recorded vehicle labels and the open transport draft', { concurrency: false }, async () => {
  const api = fixture(); const visit = api.detail.delivery.appointments[0]; assert.ok(visit); visit.transportAllocations = [allocation()]; const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel'); await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined })); const doc = page.dom.window.document;
    await waitFor(() => doc.querySelector('.panel-meta') !== null, 'delivery'); await click(button(doc, 'Visits & tasks')); const replaceButton = doc.querySelector('button[aria-label="Replace DEMO van"]'); assert.ok(replaceButton instanceof HTMLButtonElement); await click(replaceButton); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'replacement availability'); await selectRadio(doc, replacementId);
    const reason = doc.querySelector('textarea[name="reason"]'); assert.ok(reason instanceof HTMLTextAreaElement); reason.value = 'DEMO unsaved breakdown note'; const dialog = reason.closest('.dialog'); assert.ok(dialog instanceof HTMLElement); dialog.scrollTop = 140;
    api.vehicles[0] = { ...vehicle(), name: 'DEMO current renamed vehicle', operationalStatus: 'maintenance', version: 2 }; const readsBefore = api.calls.filter((call) => call.pathname === '/vehicles').length; await click(button(doc, '↻ Refresh')); await waitFor(() => doc.body.textContent?.includes('is currently marked maintenance') === true, 'fleet warning');
    assert.equal(api.calls.filter((call) => call.pathname === '/vehicles').length, readsBefore + 1, 'One catalog read per delivery refresh'); assert.strictEqual(doc.querySelector('textarea[name="reason"]'), reason); assert.equal(reason.value, 'DEMO unsaved breakdown note'); assert.equal(dialog.scrollTop, 140); assert.equal(input(doc, `input[value="${replacementId}"]`).checked, true);
    const readout = doc.querySelector('[data-visit-transport]'); assert.match(readout?.textContent ?? '', /DEMO van · AB-123 CD/); assert.doesNotMatch(readout?.textContent ?? '', /DEMO current renamed vehicle/); assert.ok(doc.querySelector('button[aria-label="Replace DEMO van"]'));
  } finally { await page.close(); }
});

void test('transport changed reserve windows and windows longer than 45 days cannot post without valid availability', { concurrency: false }, async () => {
  const api = fixture(); const page = await renderTransport(api);
  try {
    const doc = page.dom.window.document; await click(button(doc, '+ Allocate vehicle')); await waitFor(() => doc.querySelector('input[name="vehicleId"]') !== null, 'availability'); await selectRadio(doc, vehicleId);
    await editInput(input(doc, '[data-booking-field="reserveFrom"]'), '2026-11-10T08:00'); await submit(doc); assert.match(doc.body.textContent ?? '', /Check availability for the updated reservation window/); assert.equal(api.calls.some((call) => call.method === 'POST'), false);
    await editInput(input(doc, '[data-booking-field="reserveTo"]'), '2027-01-10T12:00'); await click(button(doc, 'Check availability')); assert.match(doc.body.textContent ?? '', /cannot exceed 45 days/); assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});
