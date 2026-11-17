import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { appointmentSchema, crewSchema, participantSchema, skillSchema, templateSchema, type Participant } from '../src/lib/contracts';
import { assignmentSkillRequirements, missingParticipantSkills, skillSelectionProblems } from '../src/lib/skills';
import { staffingSkillProblems } from '../src/lib/staffing';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, user, waitFor } from './refresh-fixtures';

const assemblyId = '86000000-0000-4000-8000-000000000001';
const electricId = '86000000-0000-4000-8000-000000000002';
const disabledId = '86000000-0000-4000-8000-000000000003';
const firstId = '86000000-0000-4000-8000-000000000010';
const secondId = '86000000-0000-4000-8000-000000000011';
const qualifiedId = '86000000-0000-4000-8000-000000000012';
const unskilledId = '86000000-0000-4000-8000-000000000013';
const crewId = '86000000-0000-4000-8000-000000000020';
const visitId = '86000000-0000-4000-8000-000000000030';
const assignmentId = '86000000-0000-4000-8000-000000000031';
const templateId = '86000000-0000-4000-8000-000000000040';
const taskId = '86000000-0000-4000-8000-000000000041';
const admin = { ...user, role: 'admin' as const };

function person(id: string, name: string, skillIds: string[]): Participant {
  return participantSchema.parse({ id, version: 1, name, firstName: 'DEMO', lastName: name, preferredName: null, phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds });
}

function fixture() {
  const api = new ApiFixture();
  api.skills = [skillSchema.parse({ id: assemblyId, version: 1, name: 'Assembly', description: 'DEMO assembly capability', enabled: true }), skillSchema.parse({ id: electricId, version: 1, name: 'Electrical', description: null, enabled: true }), skillSchema.parse({ id: disabledId, version: 1, name: 'Archived skill', description: null, enabled: false })];
  api.participants = [person(firstId, 'DEMO assembly only', [assemblyId]), person(secondId, 'DEMO electrical only', [electricId]), person(qualifiedId, 'DEMO qualified override', [assemblyId, electricId]), person(unskilledId, 'DEMO unskilled', [])];
  api.availableParticipants = api.participants.map((profile) => ({ id: profile.id, name: profile.name, skillIds: profile.skillIds, external: false, enabled: true, busy: false, conflicts: [] }));
  api.crews = [crewSchema.parse({ id: crewId, version: 1, name: 'DEMO default crew', classification: 'indoor', area: 'Messina', enabled: true, people: api.participants.slice(0, 2).map((profile) => ({ id: profile.id, name: profile.name, external: false })) })];
  api.templates = [templateSchema.parse({ id: templateId, version: 1, title: 'DEMO skilled task', severity: 'high', order: 2, checklist: ['DEMO check'], enabled: true, requiredSkillIds: [assemblyId, electricId] })];
  return api;
}

function input(scope: ParentNode, selector: string): HTMLInputElement {
  const found = scope.querySelector(selector); assert.ok(found instanceof HTMLInputElement); return found;
}

function htmlForm(scope: ParentNode): HTMLFormElement {
  const found = scope.querySelector('form'); assert.ok(found instanceof HTMLFormElement); return found;
}

async function toggle(scope: ParentNode, selector: string) {
  const found = input(scope, selector); assert.equal(found.disabled, false); await act(async () => { found.click(); }); return found;
}

async function submit(form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

function booked(api: ApiFixture, assigned: boolean) {
  const appointment = appointmentSchema.parse({ id: visitId, startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, results: [], assignments: assigned ? [{ id: assignmentId, crewId, crewName: 'DEMO recorded crew', people: api.crews[0]?.people, tasks: [{ id: taskId, templateId, title: 'DEMO recorded task', severity: 'high', order: 1, checklist: [], requiredSkillsSnapshot: [{ id: assemblyId, name: 'Recorded Assembly' }, { id: electricId, name: 'Recorded Electrical' }] }] }] : [] });
  api.detail.delivery.appointments = [appointment]; return appointment;
}

void test('skills qualification checks every actual person, not the union or names; legacy task requirements remain empty', () => {
  const api = fixture(); const appointment = booked(api, true); const assignment = appointment.assignments[0]; assert.ok(assignment);
  const requirements = assignmentSkillRequirements(assignment);
  assert.deepEqual(missingParticipantSkills({ skillIds: [assemblyId] }, requirements), [{ id: electricId, name: 'Recorded Electrical' }]);
  const rows = [{ id: assignmentId, crewName: 'DEMO saved crew', participantIds: [firstId, secondId] }];
  const problems = staffingSkillProblems(rows, api.availableParticipants, new Map([[assignmentId, requirements]]), api.skills);
  assert.equal(problems.length, 2); assert.match(problems.join(' '), /assembly only needs Recorded Electrical/); assert.match(problems.join(' '), /electrical only needs Recorded Assembly/);
  assert.deepEqual(staffingSkillProblems([{ ...rows[0], id: assignmentId, crewName: 'DEMO saved crew', participantIds: [qualifiedId] }], api.availableParticipants, new Map([[assignmentId, requirements]]), api.skills), []);
  const legacy = appointmentSchema.parse({ ...appointment, assignments: [{ ...assignment, tasks: assignment.tasks.map(({ requiredSkillsSnapshot: _recorded, ...task }) => task) }] }).assignments[0]; assert.ok(legacy); assert.deepEqual(assignmentSkillRequirements(legacy), []);
  assert.deepEqual(skillSelectionProblems([disabledId], [disabledId], api.skills), []); assert.match(skillSelectionProblems([disabledId], [], api.skills).join(' '), /disabled/);
});

void test('admin skill create and disable use validated HTTP payloads and operator catalog management includes participant grants', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { SkillsDirectory } = await import('../src/components/skills-directory'); await page.render(createElement(SkillsDirectory, { user: admin })); const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.skills-table') !== null, 'skills catalog');
    assert.equal(document.querySelectorAll('.skills-table tbody tr')[0]?.querySelectorAll('td')[1]?.textContent, '2');
    await click(button(document, '+ New skill')); const dialog = document.querySelector('.dialog'); assert.ok(dialog); input(dialog, '[name="name"]').value = 'DEMO new skill';
    const description = dialog.querySelector('textarea'); assert.ok(description instanceof HTMLTextAreaElement); description.value = 'DEMO description';
    const create = api.defer('/skills', 'POST'); await submit(htmlForm(dialog)); assert.equal(create.called, true);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call); assert.deepEqual(z.object({ name: z.string(), description: z.string().nullable(), enabled: z.boolean() }).strict().parse(call.body), { name: 'DEMO new skill', description: 'DEMO description', enabled: true });
    const created = skillSchema.parse({ id: '86000000-0000-4000-8000-000000000009', version: 1, name: 'DEMO new skill', description: 'DEMO description', enabled: true }); api.skills.push(created); await act(async () => { create.reply(created); }); await waitFor(() => document.querySelector('.dialog') === null, 'create completion');
    const edit = Array.from(document.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label') === 'Edit skill Assembly'); assert.ok(edit); await click(edit); const editor = document.querySelector('.dialog'); assert.ok(editor); await toggle(editor, '[name="enabled"]');
    const patch = api.defer(`/skills/${assemblyId}`, 'PATCH'); await submit(htmlForm(editor)); assert.equal(patch.called, true); const mutation = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(mutation); assert.equal(z.object({ version: z.literal(1), enabled: z.literal(false) }).passthrough().parse(mutation.body).enabled, false);
    const skill = api.skills[0]; assert.ok(skill); await act(async () => { patch.reply({ ...skill, version: 2, enabled: false }); }); await settle();
    await page.render(createElement(SkillsDirectory, { key: 'operator', user })); await waitFor(() => document.querySelector('.skills-table') !== null, 'operator catalog'); assert.equal(button(document, '+ New skill').disabled, false); assert.ok(document.querySelector('button[aria-label^="Edit skill "]'));
    await click(button(document, 'Participant skills')); assert.ok(document.querySelector('.participant-skills-table')); assert.equal(button(document, 'Edit skills').disabled, false);
  } finally { await page.close(); }
});

void test('skills refresh preserves filter, table, dialog input and original optimistic version across server updates and failures', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { SkillsDirectory } = await import('../src/components/skills-directory'); await page.render(createElement(SkillsDirectory, { user: admin })); const document = page.dom.window.document; await waitFor(() => document.querySelector('.skills-table') !== null, 'catalog');
    const search = input(document, '.directory-filters input'); await editInput(search, 'Assembly'); const table = document.querySelector('.skills-table'); assert.ok(table); const row = table.querySelector('tbody tr'); assert.ok(row); await click(button(document, 'Edit skill'));
    const editor = document.querySelector('.dialog'); assert.ok(editor instanceof HTMLElement); const name = input(editor, '[name="name"]'); name.value = 'DEMO unsaved name'; editor.scrollTop = 107;
    const pending = api.defer('/skills'); await click(button(document, '↻ Refresh skills')); assert.equal(document.querySelector('.skills-table'), table); assert.equal(name.isConnected, true); const original = api.skills[0]; assert.ok(original); await act(async () => { pending.reply([{ ...original, version: 2, description: 'DEMO changed server description' }, ...api.skills.slice(1)]); });
    await waitFor(() => editor.textContent?.includes('newer skill revision') === true, 'stale revision notice'); assert.equal(name.value, 'DEMO unsaved name'); assert.equal(editor.scrollTop, 107); assert.equal(search.value, 'Assembly'); assert.equal(table.querySelector('tbody tr'), row);
    const patch = api.defer(`/skills/${assemblyId}`, 'PATCH'); await submit(htmlForm(editor)); const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call); assert.equal(z.object({ version: z.number() }).passthrough().parse(call.body).version, 1); await act(async () => { patch.reply({ message: 'DEMO stale revision' }, 409); }); await waitFor(() => editor.textContent?.includes('DEMO stale revision') === true, 'conflict'); assert.equal(name.value, 'DEMO unsaved name');
    const failed = api.defer('/skills'); await click(button(document, '↻ Refresh skills')); await act(async () => { failed.reply({ message: 'DEMO catalog unavailable' }, 503); }); await waitFor(() => document.body.textContent?.includes('DEMO catalog unavailable') === true, 'refresh error'); assert.equal(document.querySelector('.skills-table'), table); assert.equal(name.isConnected, true);
  } finally { await page.close(); }
});

void test('operator participant skills quick edit sends only IDs and captured version; disabled retained links can be removed but not newly granted', { concurrency: false }, async () => {
  const api = fixture(); const original = api.participants[0]; assert.ok(original); api.participants[0] = { ...original, skillIds: [assemblyId, disabledId] }; const page = await domHarness(api);
  try {
    const { SkillsDirectory } = await import('../src/components/skills-directory'); await page.render(createElement(SkillsDirectory, { user })); const document = page.dom.window.document; await waitFor(() => document.querySelector('.skills-table') !== null, 'catalog'); await click(button(document, 'Participant skills')); await click(button(document, 'Edit skills')); const editor = document.querySelector('.dialog'); assert.ok(editor);
    const archived = input(editor, `[data-skill-id="${disabledId}"]`); assert.equal(archived.checked, true); assert.equal(archived.disabled, false); await toggle(editor, `[data-skill-id="${disabledId}"]`); await toggle(editor, `[data-skill-id="${electricId}"]`);
    const patch = api.defer(`/participants/${firstId}/skills`, 'PATCH'); await submit(htmlForm(editor)); assert.equal(patch.called, true); const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call); assert.deepEqual(z.object({ version: z.literal(1), skillIds: z.array(z.uuid()) }).strict().parse(call.body), { version: 1, skillIds: [assemblyId, electricId] }); await act(async () => { patch.reply({ ...original, version: 2, skillIds: [assemblyId, electricId] }); });
    await waitFor(() => document.querySelector('.dialog') === null, 'skill update'); const second = Array.from(document.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label') === 'Edit skills for DEMO electrical only'); assert.ok(second); await click(second); const nextEditor = document.querySelector('.dialog'); assert.ok(nextEditor); assert.equal(input(nextEditor, `[data-skill-id="${disabledId}"]`).disabled, true);
  } finally { await page.close(); }
});

void test('participant and template full editors include skill IDs in their existing single save', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { ParticipantForm } = await import('../src/components/participant-form'); await page.render(createElement(ParticipantForm, { skills: api.skills, onSaved: () => undefined })); const document = page.dom.window.document; input(document, '[name="firstName"]').value = 'DEMO'; input(document, '[name="lastName"]').value = 'New specialist'; await toggle(document, `[data-skill-id="${assemblyId}"]`); const create = api.defer('/participants', 'POST'); await submit(htmlForm(document)); const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call); assert.deepEqual(z.object({ skillIds: z.array(z.uuid()) }).passthrough().parse(call.body).skillIds, [assemblyId]); await act(async () => { create.reply(person('86000000-0000-4000-8000-000000000014', 'DEMO New specialist', [assemblyId])); });
    const { Directory } = await import('../src/components/directory'); await page.render(createElement(Directory, { user: admin, initialTab: 'templates' })); await waitFor(() => document.querySelector('.directory-card') !== null, 'template directory'); await click(button(document, 'Edit template →')); const editor = document.querySelector('.dialog'); assert.ok(editor); assert.equal(input(editor, `[data-skill-id="${disabledId}"]`).disabled, true); await toggle(editor, `[data-skill-id="${electricId}"]`);
    const patch = api.defer(`/templates/${templateId}`, 'PATCH'); await submit(htmlForm(editor)); const mutation = api.calls.find((entry) => entry.pathname === `/templates/${templateId}` && entry.method === 'PATCH'); assert.ok(mutation); assert.deepEqual(z.object({ version: z.literal(1), requiredSkillIds: z.array(z.uuid()) }).passthrough().parse(mutation.body).requiredSkillIds, [assemblyId]); const template = api.templates[0]; assert.ok(template); await act(async () => { patch.reply({ ...template, version: 2, requiredSkillIds: [assemblyId] }); });
  } finally { await page.close(); }
});

void test('participant skill draft survives refresh when a newly selected skill is disabled and remains removable', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { SkillsDirectory } = await import('../src/components/skills-directory'); await page.render(createElement(SkillsDirectory, { user: admin })); const document = page.dom.window.document; await waitFor(() => document.querySelector('.skills-table') !== null, 'catalog'); await click(button(document, 'Participant skills')); await click(button(document, 'Edit skills')); const editor = document.querySelector('.dialog'); assert.ok(editor instanceof HTMLElement); const first = input(editor, `[data-skill-id="${assemblyId}"]`); const selected = await toggle(editor, `[data-skill-id="${electricId}"]`); editor.scrollTop = 81;
    api.skills = api.skills.map((skill) => skill.id === electricId ? { ...skill, enabled: false, version: 2 } : skill); await click(button(document, '↻ Refresh skills')); await waitFor(() => editor.textContent?.includes('Remove the new selection') === true, 'disabled draft conflict'); assert.equal(input(editor, `[data-skill-id="${electricId}"]`), selected); assert.equal(selected.checked, true); assert.equal(selected.disabled, false); assert.equal(first.checked, true); assert.equal(editor.scrollTop, 81); assert.equal(button(document, 'Save participant skills').disabled, true); await submit(htmlForm(editor)); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await toggle(editor, `[data-skill-id="${electricId}"]`); assert.equal(selected.disabled, true); assert.equal(button(document, 'Save participant skills').disabled, false); assert.equal(button(document, 'Participant skills').classList.contains('active'), true);
  } finally { await page.close(); }
});

void test('new assignment accepts task choice before qualification, rejects pooled skills and permits a qualified non-default override', { concurrency: false }, async () => {
  const api = fixture(); const appointment = booked(api, false); const commands: unknown[] = []; const page = await domHarness(api);
  try {
    const { InitialAssignmentForm } = await import('../src/components/initial-assignment-form'); await page.render(createElement(InitialAssignmentForm, { deliveryId, version: 1, appointment, crews: api.crews, templates: api.templates, skills: api.skills, command: async (_path, body) => { commands.push(body); return 2; } })); const document = page.dom.window.document; await waitFor(() => document.body.textContent?.includes('Availability checked') === true, 'availability');
    await toggle(document, `[name="crewIds"][value="${crewId}"]`); const task = input(document, '[name="templateIds"]'); assert.equal(task.disabled, false); await toggle(document, '[name="templateIds"]');
    const first = input(document, `[data-participant-id="${firstId}"]`); const second = input(document, `[data-participant-id="${secondId}"]`); assert.equal(first.checked, true); assert.equal(first.disabled, false); assert.equal(second.checked, true); assert.equal(button(document, 'Assign selected crews').disabled, true); assert.match(document.body.textContent ?? '', /assembly only needs Electrical/); assert.match(document.body.textContent ?? '', /electrical only needs Assembly/);
    const all = document.querySelector('[data-participant-filter="all"]'); assert.ok(all instanceof page.dom.window.HTMLButtonElement); await click(all);
    const unskilled = input(document, `[data-participant-id="${unskilledId}"]`); assert.equal(unskilled.disabled, true); const reasonId = unskilled.getAttribute('aria-describedby'); assert.ok(reasonId); assert.match(document.getElementById(reasonId)?.textContent ?? '', /Missing skills: Assembly, Electrical/); await submit(htmlForm(document)); assert.equal(commands.length, 0);
    await toggle(document, `[data-participant-id="${firstId}"]`); await toggle(document, `[data-participant-id="${secondId}"]`); await toggle(document, `[data-participant-id="${qualifiedId}"]`); assert.equal(button(document, 'Assign selected crews').disabled, false);
    await submit(htmlForm(document)); assert.equal(commands.length, 1); const body = z.object({ staffing: z.array(z.object({ crewId: z.uuid(), participantIds: z.array(z.uuid()) })), templateIds: z.array(z.uuid()) }).passthrough().parse(commands[0]); assert.deepEqual(body.staffing, [{ crewId, participantIds: [qualifiedId] }]); assert.deepEqual(body.templateIds, [templateId]);
  } finally { await page.close(); }
});

void test('availability refresh retains a selected newly unqualified person and task but blocks submit until the actual selection is repaired', { concurrency: false }, async () => {
  const api = fixture(); const appointment = booked(api, false); const qualified = api.participants[2]; assert.ok(qualified); const crew = api.crews[0]; assert.ok(crew); api.crews[0] = { ...crew, people: [{ id: qualified.id, name: qualified.name, external: false }] }; let commands = 0; const page = await domHarness(api);
  try {
    const { InitialAssignmentForm } = await import('../src/components/initial-assignment-form'); await page.render(createElement(InitialAssignmentForm, { deliveryId, version: 1, appointment, crews: api.crews, templates: api.templates, skills: api.skills, command: async () => { commands++; return 2; } })); const document = page.dom.window.document; await waitFor(() => document.body.textContent?.includes('Availability checked') === true, 'availability'); await toggle(document, '[name="crewIds"]'); await toggle(document, '[name="templateIds"]'); const selected = input(document, `[data-participant-id="${qualifiedId}"]`); const task = input(document, '[name="templateIds"]'); assert.equal(button(document, 'Assign selected crews').disabled, false);
    api.availableParticipants = api.availableParticipants.map((profile) => profile.id === qualifiedId ? { ...profile, skillIds: [assemblyId] } : profile); await click(button(document, 'Refresh availability')); await waitFor(() => document.body.textContent?.includes('qualified override needs Electrical') === true, 'updated qualification'); assert.equal(input(document, `[data-participant-id="${qualifiedId}"]`), selected); assert.equal(selected.checked, true); assert.equal(selected.disabled, false); assert.equal(task.checked, true); assert.equal(button(document, 'Assign selected crews').disabled, true); await submit(htmlForm(document)); assert.equal(commands, 0); await toggle(document, `[data-participant-id="${qualifiedId}"]`); assert.equal(document.querySelector(`[data-participant-id="${qualifiedId}"]`), null);
    const all = document.querySelector('[data-participant-filter="all"]'); assert.ok(all instanceof page.dom.window.HTMLButtonElement); await click(all); assert.equal(input(document, `[data-participant-id="${qualifiedId}"]`).disabled, true);
  } finally { await page.close(); }
});

void test('planned staffing uses recorded task requirements and each current person; disabled required skill blocks changes without losing the draft', { concurrency: false }, async () => {
  const api = fixture(); booked(api, true); api.skills = api.skills.map((skill) => ({ ...skill, name: `Renamed ${skill.name}` })); const page = await domHarness(api);
  try {
    const { StaffingEditor } = await import('../src/components/staffing-editor'); await page.render(createElement(StaffingEditor, { deliveryId, appointmentId: visitId, onClose: () => undefined, onChanged: () => undefined })); const document = page.dom.window.document; await waitFor(() => document.querySelectorAll('[data-participant-id]').length === 3, 'available and selected staffing choices'); assert.match(document.body.textContent ?? '', /assembly only needs Recorded Electrical/); assert.doesNotMatch(document.body.textContent ?? '', /needs Renamed Electrical/); assert.equal(button(document, 'Save all visit staff').disabled, true);
    await toggle(document, `[data-participant-id="${firstId}"]`); await toggle(document, `[data-participant-id="${secondId}"]`); await toggle(document, `[data-participant-id="${qualifiedId}"]`); const selected = input(document, `[data-participant-id="${qualifiedId}"]`); const reason = input(document, '[name="reason"]'); reason.value = 'DEMO qualified staffing draft'; assert.equal(button(document, 'Save all visit staff').disabled, false);
    api.skills = api.skills.map((skill) => skill.id === electricId ? { ...skill, enabled: false } : skill); await click(button(document, '↻ Refresh visit')); await waitFor(() => document.body.textContent?.includes('required skills disabled or unavailable: Recorded Electrical') === true, 'disabled recorded requirement'); assert.equal(selected.isConnected, true); assert.equal(selected.checked, true); assert.equal(selected.disabled, false); assert.equal(reason.value, 'DEMO qualified staffing draft'); await submit(htmlForm(document)); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    api.skills = api.skills.map((skill) => skill.id === electricId ? { ...skill, enabled: true } : skill); await click(button(document, '↻ Refresh visit')); await waitFor(() => !button(document, 'Save all visit staff').disabled, 'requirement reenabled');
    const availabilityReads = api.calls.filter((entry) => entry.pathname.endsWith(`/appointments/${visitId}/participants`)).length;
    api.availableParticipants = api.availableParticipants.map((profile) => profile.id === qualifiedId ? { ...profile, skillIds: [assemblyId] } : profile);
    await click(button(document, '↻ Refresh visit')); await waitFor(() => document.body.textContent?.includes('qualified override needs Recorded Electrical') === true, 'visit refresh also rechecks participant skills');
    assert.ok(api.calls.filter((entry) => entry.pathname.endsWith(`/appointments/${visitId}/participants`)).length > availabilityReads);
    assert.equal(selected.checked, true); assert.equal(selected.disabled, false); assert.equal(reason.value, 'DEMO qualified staffing draft');
    api.availableParticipants = api.availableParticipants.map((profile) => profile.id === qualifiedId ? { ...profile, skillIds: [assemblyId, electricId] } : profile);
    await click(button(document, '↻ Refresh visit')); await waitFor(() => !button(document, 'Save all visit staff').disabled, 'current participant capability restored'); const patch = api.defer(`/deliveries/${deliveryId}/appointments/${visitId}/participants`, 'PATCH'); await submit(htmlForm(document)); assert.equal(patch.called, true); const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call); assert.deepEqual(z.object({ version: z.literal(1), assignments: z.array(z.object({ assignmentId: z.uuid(), participantIds: z.array(z.uuid()) })), reason: z.string() }).strict().parse(call.body), { version: 1, assignments: [{ assignmentId, participantIds: [qualifiedId] }], reason: 'DEMO qualified staffing draft' }); await act(async () => { patch.reply({ ...api.detail, delivery: { ...api.detail.delivery, version: 2 } }); });
  } finally { await page.close(); }
});

void test('new assignment with a disabled requirement cannot be submitted even when every selected person holds that ID', { concurrency: false }, async () => {
  const api = fixture(); const appointment = booked(api, false); api.skills = api.skills.map((skill) => skill.id === electricId ? { ...skill, enabled: false } : skill); const qualified = api.participants[2]; assert.ok(qualified); const crew = api.crews[0]; assert.ok(crew); api.crews[0] = { ...crew, people: [{ id: qualified.id, name: qualified.name, external: false }] }; let commands = 0; const page = await domHarness(api);
  try {
    const { InitialAssignmentForm } = await import('../src/components/initial-assignment-form'); await page.render(createElement(InitialAssignmentForm, { deliveryId, version: 1, appointment, crews: api.crews, templates: api.templates, skills: api.skills, command: async () => { commands++; return 2; } })); const document = page.dom.window.document; await waitFor(() => document.body.textContent?.includes('Availability checked') === true, 'availability'); await toggle(document, '[name="crewIds"]'); await toggle(document, '[name="templateIds"]'); assert.match(document.body.textContent ?? '', /Required skills disabled or unavailable: Electrical/); assert.equal(button(document, 'Assign selected crews').disabled, true); await submit(htmlForm(document)); assert.equal(commands, 0);
  } finally { await page.close(); }
});

void test('Skills navigation follows Delivery views and historical required labels are independent of catalog renames', { concurrency: false }, async () => {
  const api = fixture(); booked(api, true); api.skills = api.skills.map((skill) => ({ ...skill, name: `Current ${skill.name}` })); const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice'); await page.render(createElement(Backoffice)); const document = page.dom.window.document; await waitFor(() => document.querySelector('.delivery-table') !== null, 'workspace'); const deliveryViews = document.querySelector('nav[aria-label="Delivery views"]'); const skillsNav = document.querySelector('nav[aria-label="Skills catalog"]'); assert.ok(deliveryViews); assert.ok(skillsNav); assert.ok(deliveryViews.compareDocumentPosition(skillsNav) & Node.DOCUMENT_POSITION_FOLLOWING); const openSkills = skillsNav.querySelector('button'); assert.ok(openSkills instanceof HTMLButtonElement); await click(openSkills); await waitFor(() => document.querySelector('.skills-table') !== null, 'Skills section');
    const { DeliveryPanel } = await import('../src/components/delivery-panel'); await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined })); await waitFor(() => document.querySelector('.panel-meta') !== null, 'delivery detail'); await click(button(document, 'Visits & tasks')); const recorded = document.querySelector('[aria-label="Recorded required skills"]'); assert.ok(recorded); assert.match(recorded.textContent ?? '', /Recorded Assembly.*Recorded Electrical/); assert.doesNotMatch(recorded.textContent ?? '', /Current/);
  } finally { await page.close(); }
});


