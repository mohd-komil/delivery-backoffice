import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { appointmentSchema, crewSchema, participantSchema, templateSchema, type Participant } from '../src/lib/contracts';
import { calendarDay } from '../src/lib/time';
import { ApiFixture, button, click, deliveryId, domHarness, hasToast, settle, user, waitFor } from './refresh-fixtures';

const personA = '60000000-0000-4000-8000-000000000001';
const personB = '60000000-0000-4000-8000-000000000002';
const personC = '60000000-0000-4000-8000-000000000003';
const personBusy = '60000000-0000-4000-8000-000000000004';
const crewA = '60000000-0000-4000-8000-000000000010';
const crewB = '60000000-0000-4000-8000-000000000011';
const assignmentA = '60000000-0000-4000-8000-000000000020';
const assignmentB = '60000000-0000-4000-8000-000000000021';
const appointmentId = '60000000-0000-4000-8000-000000000030';
const templateId = '60000000-0000-4000-8000-000000000040';
const availabilityPath = `/deliveries/${deliveryId}/appointments/${appointmentId}/participants`;
const admin = { ...user, role: 'admin' as const };

function person(id: string, name: string): Participant {
  return participantSchema.parse({ id, version: 1, name, firstName: 'DEMO', lastName: name, preferredName: null,
    phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds: [] });
}

function staffingFixture() {
  const api = new ApiFixture();
  api.participants = [person(personA, 'DEMO original A'), person(personB, 'DEMO original B'), person(personC, 'DEMO replacement'), person(personBusy, 'DEMO busy')];
  api.availableParticipants = api.participants.map((profile) => ({ id: profile.id, name: profile.name, external: profile.external, enabled: profile.enabled, busy: profile.id === personBusy, skillIds: profile.skillIds,
    conflicts: profile.id === personBusy ? [{ appointmentId: '60000000-0000-4000-8000-000000000099', pickingName: 'DEMO/OUT/BUSY', startsAt: '2026-11-05T08:30:00Z', endsAt: '2026-11-05T10:30:00Z' }] : [] }));
  api.crews = [crewSchema.parse({ id: crewA, version: 1, name: 'DEMO crew A', classification: 'indoor', area: 'Messina', enabled: true, people: [{ id: personA, name: 'DEMO original A', external: false }] }),
    crewSchema.parse({ id: crewB, version: 1, name: 'DEMO crew B', classification: 'outdoor', area: 'Messina', enabled: true, people: [{ id: personB, name: 'DEMO original B', external: false }] })];
  api.detail.delivery.appointments = [appointmentSchema.parse({ id: appointmentId, startsAt: '2026-11-05T08:00:00Z', endsAt: '2026-11-05T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
    assignments: [{ id: assignmentA, crewId: crewA, crewName: 'DEMO crew A', people: api.crews[0]?.people, tasks: [] }, { id: assignmentB, crewId: crewB, crewName: 'DEMO crew B', people: api.crews[1]?.people, tasks: [] }], results: [] })];
  return api;
}

async function submit(form: HTMLFormElement, page: Awaited<ReturnType<typeof domHarness>>) {
  await act(async () => { form.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })); });
}

void test('successful crew assignment collapses scheduling actions only after confirmation and preserves the draft on pending, conflict and refresh', { concurrency: false }, async () => {
  const api = staffingFixture(); const appointment = api.detail.delivery.appointments[0]; assert.ok(appointment); appointment.assignments = [];
  const template = templateSchema.parse({ id: templateId, version: 1, title: 'DEMO collapse task', severity: 'low', order: 1, checklist: ['DEMO collapse check'], enabled: true, requiredSkillIds: [] }); api.templates = [template];
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document; await waitFor(() => document.querySelector('.panel-meta') !== null, 'delivery');
    const overviewTab = button(document, 'Overview'); const visitsTab = button(document, 'Visits & tasks');
    assert.equal(overviewTab.getAttribute('aria-pressed'), 'true'); assert.equal(visitsTab.getAttribute('aria-pressed'), 'false');
    await click(visitsTab); assert.equal(overviewTab.getAttribute('aria-pressed'), 'false'); assert.equal(visitsTab.getAttribute('aria-pressed'), 'true');
    const manageLabel = 'Manage assignment, reschedule or cancel ↓'; const schedulingTrigger = button(document, manageLabel);
    assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'false'); await click(schedulingTrigger);
    const editor = document.querySelector('.visit-editor'); assert.ok(editor);
    assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'true'); const editorId = schedulingTrigger.getAttribute('aria-controls'); assert.ok(editorId); assert.equal(editor.id, editorId); assert.strictEqual(document.getElementById(editorId), editor);
    await waitFor(() => editor.textContent?.includes('Availability checked') === true, 'visit availability');
    function checkbox(selector: string): HTMLInputElement { const input = editor?.querySelector(selector); assert.ok(input instanceof page.dom.window.HTMLInputElement); return input; }
    const crew = checkbox(`input[name="crewIds"][value="${crewA}"]`); await act(async () => { crew.click(); });
    const task = checkbox(`input[name="templateIds"][value="${templateId}"]`); await act(async () => { task.click(); });
    const original = checkbox(`input[data-participant-id="${personA}"]`); const replacement = checkbox(`input[data-participant-id="${personC}"]`);
    await act(async () => { original.click(); replacement.click(); });
    const assignmentForm = button(editor, 'Assign selected crews').closest('form'); assert.ok(assignmentForm instanceof page.dom.window.HTMLFormElement);
    const path = `/deliveries/${deliveryId}/appointments/${appointmentId}/assign`; const pending = api.defer(path, 'POST'); await submit(assignmentForm, page); assert.equal(pending.called, true);
    assert.strictEqual(document.querySelector('.visit-editor'), editor); assert.equal(crew.checked, true); assert.equal(task.checked, true); assert.equal(replacement.checked, true); assert.ok(button(document, 'Hide scheduling actions ↑')); assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'true');
    await act(async () => { pending.reply({ message: 'DEMO assignment conflict; review and retry.', code: 'CONFLICT' }, 409); });
    await waitFor(() => assignmentForm.textContent?.includes('DEMO assignment conflict') === true, 'visible assignment conflict');
    assert.strictEqual(document.querySelector('.visit-editor'), editor); assert.equal(crew.checked, true); assert.equal(task.checked, true); assert.equal(replacement.checked, true); assert.equal(original.checked, false); assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'true');
    await click(button(document, '↻ Refresh')); await waitFor(() => !button(document, '↻ Refresh').disabled, 'background delivery refresh');
    assert.strictEqual(document.querySelector('.visit-editor'), editor); assert.equal(crew.checked, true); assert.equal(task.checked, true); assert.equal(replacement.checked, true); assert.ok(button(document, 'Hide scheduling actions ↑')); assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'true'); assert.strictEqual(document.getElementById(editorId), editor);
    const retry = api.defer(path, 'POST'); await submit(assignmentForm, page); assert.equal(retry.called, true); assert.strictEqual(document.querySelector('.visit-editor'), editor, 'Retry stays open while its request is pending');
    const request = api.calls.filter((call) => call.pathname === path && call.method === 'POST').at(-1); assert.ok(request);
    assert.deepEqual(z.object({ crewIds: z.array(z.uuid()), templateIds: z.array(z.uuid()), staffing: z.array(z.object({ crewId: z.uuid(), participantIds: z.array(z.uuid()) })) }).passthrough().parse(request.body).staffing, [{ crewId: crewA, participantIds: [personC] }]);
    const assigned = appointmentSchema.parse({ ...appointment, assignments: [{ id: assignmentA, crewId: crewA, crewName: 'DEMO crew A', people: [{ id: personC, name: 'DEMO replacement', external: false }], tasks: [{ id: '60000000-0000-4000-8000-000000000041', templateId, title: template.title, severity: template.severity, order: template.order, checklist: [{ id: '60000000-0000-4000-8000-000000000042', label: 'DEMO collapse check', done: false, waiver: null }] }] }] });
    await act(async () => { retry.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2, appointments: [assigned] }, progress: 'assigned', coverage: { assigned: 1, total: 1 } }); });
    await waitFor(() => document.querySelector('.visit-editor') === null, 'confirmed assignment collapses scheduling actions');
    assert.equal(schedulingTrigger.getAttribute('aria-expanded'), 'false'); assert.equal(visitsTab.getAttribute('aria-pressed'), 'true'); assert.strictEqual(document.activeElement, button(document, manageLabel), 'Successful assignment returns focus to the scheduling trigger'); const summary = document.querySelector('.visit-card .assignment'); assert.ok(summary); assert.match(summary.textContent ?? '', /DEMO crew A/); assert.match(summary.textContent ?? '', /DEMO replacement/); assert.match(summary.textContent ?? '', /DEMO collapse task/);
  } finally { await page.close(); }
});

void test('participant creation sends full profile and synthetic credentials; legacy edits preserve unknown names and omit empty password', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { ParticipantForm } = await import('../src/components/participant-form');
    let saved: Participant | undefined;
    await page.render(createElement(ParticipantForm, { onSaved: (profile) => { saved = profile; } }));
    const document = page.dom.window.document;
    const form = document.querySelector('form'); assert.ok(form);
    function input(name: string) { const node = form?.querySelector(`[name="${name}"]`); assert.ok(node instanceof page.dom.window.HTMLInputElement || node instanceof page.dom.window.HTMLTextAreaElement); return node; }
    input('firstName').value = 'DEMO Ada'; input('lastName').value = 'Synthetic'; input('preferredName').value = 'DEMO specialist'; input('phoneNumber').value = '+390000000100'; input('address').value = 'Synthetic Address'; input('login').value = 'demo-specialist';
    const password = input('password'); assert.ok(password instanceof page.dom.window.HTMLInputElement);
    assert.equal(password.value, ''); assert.equal(password.minLength, 15); assert.equal(password.autocomplete, 'new-password');
    await submit(form, page);
    assert.match(form.textContent ?? '', /Set a new password/);
    assert.equal(api.calls.filter((call) => call.method !== 'GET').length, 0);
    password.value = 'DEMO too short'; await submit(form, page); assert.match(form.textContent ?? '', /15 and 256/);
    password.value = 'DEMO-synthetic-only-password';
    const pending = api.defer('/participants', 'POST'); await submit(form, page); assert.equal(pending.called, true);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call);
    const body = z.object({ firstName: z.string(), lastName: z.string(), preferredName: z.string(), phoneNumber: z.string(), address: z.string(), login: z.string(), password: z.string().min(15), skillIds: z.array(z.uuid()), external: z.boolean(), enabled: z.boolean() }).strict().parse(call.body);
    assert.equal(body.firstName, 'DEMO Ada'); assert.equal(body.phoneNumber, '+390000000100'); assert.equal(body.enabled, true);
    await act(async () => { pending.reply({ ...person(personA, 'DEMO specialist'), ...body, hasPassword: true }); });
    await waitFor(() => saved !== undefined, 'participant save');
    assert.ok(saved);
    assert.equal(Object.hasOwn(saved, 'password'), false, 'Decoded participant records must not retain a password even if a faulty response includes one');

    const legacy = { ...person(personB, 'DEMO migrated unsplit name'), firstName: null, lastName: null, login: 'demo-legacy', hasPassword: true };
    await page.render(createElement(ParticipantForm, { key: 'legacy', participant: legacy, onSaved: () => undefined }));
    const legacyForm = document.querySelector('form'); assert.ok(legacyForm);
    const first = legacyForm.querySelector('input[name="firstName"]'); const last = legacyForm.querySelector('input[name="lastName"]'); const secret = legacyForm.querySelector('input[name="password"]');
    assert.ok(first instanceof page.dom.window.HTMLInputElement); assert.ok(last instanceof page.dom.window.HTMLInputElement); assert.ok(secret instanceof page.dom.window.HTMLInputElement);
    assert.equal(first.value, ''); assert.equal(last.value, ''); assert.equal(secret.value, ''); assert.match(legacyForm.textContent ?? '', /no confirmed first or last name/);
    const patch = api.defer(`/participants/${personB}`, 'PATCH'); await submit(legacyForm, page); assert.equal(patch.called, true);
    const edit = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(edit);
    const editBody = z.object({ firstName: z.null(), lastName: z.null(), login: z.literal('demo-legacy'), version: z.literal(1) }).passthrough().parse(edit.body);
    assert.equal(Object.hasOwn(editBody, 'password'), false);
    await act(async () => { patch.reply({ ...legacy, version: 2 }); });
    await page.render(createElement(ParticipantForm, { key: 'new-login', participant: { ...legacy, login: null }, onSaved: () => undefined }));
    const newLoginForm = document.querySelector('form'); assert.ok(newLoginForm);
    const login = newLoginForm.querySelector('input[name="login"]'); assert.ok(login instanceof page.dom.window.HTMLInputElement); login.value = 'demo-reconfigured';
    const beforeNewLogin = api.calls.length; await submit(newLoginForm, page);
    assert.match(newLoginForm.textContent ?? '', /Set a new password/); assert.equal(api.calls.length, beforeNewLogin, 'A newly configured login needs a new password even when an old password hash is retained');
  } finally { await page.close(); }
});

void test('operator participant table shows missing profile data without credential UI or mutation actions', { concurrency: false }, async () => {
  const api = new ApiFixture(); api.participants = [{ ...person(personA, 'DEMO legacy display'), firstName: null, lastName: null, login: 'demo-private-login', hasPassword: true }];
  const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory'); await page.render(createElement(Directory, { user }));
    const document = page.dom.window.document;
    await waitFor(() => api.calls.some((call) => call.pathname === '/participants'), 'participant catalogue'); await settle();
    const tab = Array.from(document.querySelectorAll('.tabbar button')).find((node) => node.textContent?.startsWith('Participants')); assert.ok(tab instanceof page.dom.window.HTMLButtonElement); await click(tab);
    const table = document.querySelector('.participants-table'); assert.ok(table); assert.match(table.textContent ?? '', /First: Not provided · Last: Not provided/);
    assert.doesNotMatch(document.body.textContent ?? '', /demo-private-login|Password configured|Future credentials|Edit participant|New participant/);
  } finally { await page.close(); }
});

void test('crew defaults select global participant IDs including same-name people and preserve the captured version', { concurrency: false }, async () => {
  const api = staffingFixture(); api.participants = [person(personA, 'DEMO same name'), person(personB, 'DEMO same name')];
  api.crews = api.crews.map((crew) => crew.id === crewB ? { ...crew, people: [] } : crew);
  const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory'); await page.render(createElement(Directory, { user: admin }));
    const document = page.dom.window.document; await waitFor(() => document.querySelector('.crews-table tbody tr') !== null, 'crew table');
    await click(button(document, 'Manage crew')); const dialog = document.querySelector('.dialog'); assert.ok(dialog);
    const choices = dialog.querySelectorAll('.choice-list input[type="checkbox"]'); assert.equal(choices.length, 2);
    const second = choices[1]; assert.ok(second instanceof page.dom.window.HTMLInputElement); await act(async () => { second.click(); });
    const pending = api.defer(`/crews/${crewA}`, 'PATCH'); const form = dialog.querySelector('form'); assert.ok(form); await submit(form, page);
    assert.equal(pending.called, true); const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call);
    const body = z.object({ version: z.literal(1), name: z.string(), classification: z.enum(['indoor', 'outdoor']), area: z.string(), enabled: z.boolean(), participantIds: z.array(z.uuid()) }).strict().parse(call.body);
    assert.deepEqual(body.participantIds, [personA, personB]); assert.match(dialog.textContent ?? '', /empty default roster is allowed/);
    const existing = api.crews[0]; assert.ok(existing); await act(async () => { pending.reply({ ...existing, version: 2 }); });
  } finally { await page.close(); }
});

void test('initial crew assignment uses non-default available staffing and blocks occupied people with interval reasons', { concurrency: false }, async () => {
  const api = staffingFixture(); const appointment = api.detail.delivery.appointments[0]; assert.ok(appointment); appointment.assignments = [];
  const template = templateSchema.parse({ id: templateId, version: 1, title: 'DEMO task', severity: 'low', order: 1, checklist: ['DEMO check'], enabled: true, requiredSkillIds: [] });
  const commands: unknown[] = [];
  const page = await domHarness(api);
  try {
    const { InitialAssignmentForm } = await import('../src/components/initial-assignment-form');
    await page.render(createElement(InitialAssignmentForm, { deliveryId, version: 1, appointment, crews: api.crews, templates: [template], command: async (_path, body) => { commands.push(body); return 2; } }));
    const document = page.dom.window.document; await waitFor(() => document.body.textContent?.includes('Availability checked') === true, 'availability');
    const crew = document.querySelector(`input[name="crewIds"][value="${crewA}"]`); assert.ok(crew instanceof page.dom.window.HTMLInputElement); await act(async () => { crew.click(); });
    assert.equal(document.querySelector(`input[data-participant-id="${personBusy}"]`), null);
    const all = document.querySelector('[data-participant-filter="all"]'); assert.ok(all instanceof page.dom.window.HTMLButtonElement); await click(all);
    const selected = document.querySelector(`input[data-participant-id="${personA}"]`); const replacement = document.querySelector(`input[data-participant-id="${personC}"]`); const busy = document.querySelector(`input[data-participant-id="${personBusy}"]`);
    assert.ok(selected instanceof page.dom.window.HTMLInputElement); assert.ok(replacement instanceof page.dom.window.HTMLInputElement); assert.ok(busy instanceof page.dom.window.HTMLInputElement);
    assert.equal(selected.checked, true); assert.equal(busy.disabled, true); assert.match(busy.closest('label')?.textContent ?? '', /DEMO\/OUT\/BUSY.*UTC\+01:00/);
    await act(async () => { selected.click(); }); assert.equal(button(document, 'Assign selected crews').disabled, true); assert.equal(replacement.disabled, false);
    await act(async () => { replacement.click(); });
    const task = document.querySelector('input[name="templateIds"]'); assert.ok(task instanceof page.dom.window.HTMLInputElement); await act(async () => { task.click(); });
    const form = document.querySelector('form'); assert.ok(form); await submit(form, page);
    assert.equal(commands.length, 1); const body = z.object({ version: z.literal(1), requestId: z.uuid(), crewIds: z.array(z.uuid()), templateIds: z.array(z.uuid()), staffing: z.array(z.object({ crewId: z.uuid(), participantIds: z.array(z.uuid()) })) }).strict().parse(commands[0]);
    assert.deepEqual(body.staffing, [{ crewId: crewA, participantIds: [personC] }]); assert.deepEqual(api.crews[0]?.people.map((profile) => profile.id), [personA]);
  } finally { await page.close(); }
});

void test('visit staffing moves a person between crews in one atomic save and keeps fields editable for invalid drafts', { concurrency: false }, async () => {
  const api = staffingFixture(); const page = await domHarness(api);
  try {
    const { StaffingEditor } = await import('../src/components/staffing-editor'); await page.render(createElement(StaffingEditor, { deliveryId, appointmentId, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document; await waitFor(() => document.querySelectorAll('input[data-participant-id]').length === 6, 'available assignment choices');
    function choice(row: number, id: string) { const node = document.querySelectorAll('form section')[row]?.querySelector(`input[data-participant-id="${id}"]`); assert.ok(node instanceof page.dom.window.HTMLInputElement); return node; }
    await act(async () => { choice(0, personA).click(); }); assert.equal(button(document, 'Save all visit staff').disabled, true); assert.equal(choice(0, personC).disabled, false);
    await act(async () => { choice(0, personC).click(); choice(1, personA).click(); });
    assert.equal(button(document, 'Save all visit staff').disabled, false);
    await act(async () => { choice(0, personA).click(); }); assert.equal(button(document, 'Save all visit staff').disabled, true); assert.match(document.body.textContent ?? '', /Also selected in another crew/);
    await act(async () => { choice(0, personA).click(); });
    const reason = document.querySelector('input[name="reason"]'); assert.ok(reason instanceof page.dom.window.HTMLInputElement); reason.value = 'DEMO move to match work';
    const pending = api.defer(availabilityPath, 'PATCH'); const form = reason.closest('form'); assert.ok(form); await submit(form, page); assert.equal(pending.called, true);
    const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call);
    assert.deepEqual(z.object({ version: z.literal(1), assignments: z.array(z.object({ assignmentId: z.uuid(), participantIds: z.array(z.uuid()) })), reason: z.string() }).strict().parse(call.body), { version: 1, assignments: [{ assignmentId: assignmentA, participantIds: [personC] }, { assignmentId: assignmentB, participantIds: [personB, personA] }], reason: 'DEMO move to match work' });
    const saved = { ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }; await act(async () => { pending.reply(saved); });
    await waitFor(() => hasToast(document, 'Saved'), 'atomic staffing save');
  } finally { await page.close(); }
});

void test('a disabled current participant can be removed but cannot be newly selected or moved', { concurrency: false }, async () => {
  const api = staffingFixture(); api.availableParticipants = api.availableParticipants.map((profile) => ({ ...profile, enabled: profile.id !== personA })); const page = await domHarness(api);
  try {
    const { StaffingEditor } = await import('../src/components/staffing-editor'); await page.render(createElement(StaffingEditor, { deliveryId, appointmentId, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document; await waitFor(() => document.querySelectorAll('[data-participant-filter="all"]').length === 2, 'staff choices');
    for (const all of document.querySelectorAll('[data-participant-filter="all"]')) { assert.ok(all instanceof page.dom.window.HTMLButtonElement); await click(all); }
    const same = document.querySelectorAll(`input[data-participant-id="${personA}"]`); const current = same[0]; const other = same[1]; assert.ok(current instanceof page.dom.window.HTMLInputElement); assert.ok(other instanceof page.dom.window.HTMLInputElement);
    assert.equal(current.checked, true); assert.equal(current.disabled, false); assert.equal(other.disabled, true);
    await act(async () => { current.click(); }); assert.equal(current.checked, false); assert.equal(current.disabled, false, 'An unsaved removal may be reverted only in the original assignment'); assert.equal(other.disabled, true);
    assert.match(document.body.textContent ?? '', /Disabled for new staffing/);
  } finally { await page.close(); }
});

void test('staffing refresh keeps table, open staffing draft and stale-version guard without document reload', { concurrency: false }, async () => {
  const api = staffingFixture(); const appointment = api.detail.delivery.appointments[0]; assert.ok(appointment);
  const day = calendarDay(new Date().toISOString()); appointment.startsAt = `${day}T08:00:00Z`; appointment.endsAt = `${day}T10:00:00Z`;
  api.calendar = [{ deliveryId, pickingName: 'DEMO/OUT/STAFF', customerName: 'DEMO customer', appointment }]; const page = await domHarness(api);
  try {
    const { Staffing } = await import('../src/components/staffing'); await page.render(createElement(Staffing, { onOpen: () => undefined })); const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.staffing-table tbody tr') !== null, 'staffing table'); const table = document.querySelector('.staffing-table'); const row = table?.querySelector('tr'); assert.ok(table); assert.ok(row);
    await click(button(document, 'Edit staff')); await waitFor(() => document.querySelector('input[name="reason"]') !== null, 'staffing form'); const reason = document.querySelector('input[name="reason"]'); assert.ok(reason instanceof page.dom.window.HTMLInputElement); reason.value = 'DEMO preserved staffing draft'; const form = reason.closest('form'); assert.ok(form);
    const listRead = api.defer('/calendar'); await click(button(document, '↻ Refresh staffing')); assert.equal(document.querySelector('.staffing-table'), table); assert.equal(reason.value, 'DEMO preserved staffing draft'); await act(async () => { listRead.reply({ message: 'DEMO staffing unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('DEMO staffing unavailable') === true, 'staffing stale data'); assert.equal(table.querySelector('tr'), row); assert.equal(reason.isConnected, true);
    const refresh = api.defer(`/deliveries/${deliveryId}`); await click(button(document, '↻ Refresh visit')); const newer = { ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }; await act(async () => { refresh.reply(newer); }); await waitFor(() => form.textContent?.includes('Use latest data') === true, 'stale staffing guard');
    assert.equal(reason.isConnected, true); assert.equal(reason.value, 'DEMO preserved staffing draft'); await submit(form, page); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false); assert.match(form.textContent ?? '', /record changed while this form was open/);
  } finally { await page.close(); }
});


