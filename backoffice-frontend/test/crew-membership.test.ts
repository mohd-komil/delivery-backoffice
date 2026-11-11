import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { crewSchema, participantSchema, type Participant } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, settle, user, waitFor } from './refresh-fixtures';

const ownId = '75000000-0000-4000-8000-000000000001';
const otherId = '75000000-0000-4000-8000-000000000002';
const freeId = '75000000-0000-4000-8000-000000000003';
const disabledCrewPersonId = '75000000-0000-4000-8000-000000000004';
const ownCrewId = '75000000-0000-4000-8000-000000000010';
const otherCrewId = '75000000-0000-4000-8000-000000000011';
const disabledCrewId = '75000000-0000-4000-8000-000000000012';
const admin = { ...user, role: 'admin' as const };
type Page = Awaited<ReturnType<typeof domHarness>>;

function participant(id: string, name: string): Participant {
  return participantSchema.parse({ id, version: 1, name, firstName: name.split(' ')[0], lastName: name.split(' ').at(-1), preferredName: null, phoneNumber: null, address: null, login: null, hasPassword: false, skillIds: [], external: false, enabled: true });
}

function fixture() {
  const api = new ApiFixture();
  api.participants = [participant(ownId, 'Marco Russo'), participant(otherId, 'Marco Russo'), participant(freeId, 'Luca Marino'), participant(disabledCrewPersonId, 'Elena Moretti')];
  function person(id: string) { const profile = api.participants.find((entry) => entry.id === id); assert.ok(profile); return { id: profile.id, name: profile.name, external: profile.external }; }
  api.crews = [
    crewSchema.parse({ id: ownCrewId, version: 7, name: 'Catania One', classification: 'indoor', area: 'Catania', enabled: true, people: [person(ownId)] }),
    crewSchema.parse({ id: otherCrewId, version: 2, name: 'Messina Two', classification: 'outdoor', area: 'Messina', enabled: true, people: [person(otherId)] }),
    crewSchema.parse({ id: disabledCrewId, version: 4, name: 'Disabled Studio', classification: 'indoor', area: 'Messina', enabled: false, people: [person(disabledCrewPersonId)] }),
  ];
  return api;
}

async function renderDirectory(page: Page) {
  const { Directory } = await import('../src/components/directory');
  await page.render(createElement(Directory, { user: admin }));
  await waitFor(() => page.dom.window.document.querySelectorAll('.crews-table tbody tr').length === 3, 'canonical crew directory');
}

function dialog(page: Page) {
  const result = page.dom.window.document.querySelector('.dialog'); assert.ok(result instanceof page.dom.window.HTMLElement); return result;
}

function choice(page: Page, id: string) {
  const result = dialog(page).querySelector(`.choice-list input[data-participant-id="${id}"]`); assert.ok(result instanceof page.dom.window.HTMLInputElement); return result;
}

function input(page: Page, name: string) {
  const result = dialog(page).querySelector(`input[name="${name}"]`); assert.ok(result instanceof page.dom.window.HTMLInputElement); return result;
}

async function submit(page: Page) {
  const form = dialog(page).querySelector('form'); assert.ok(form);
  await act(async () => { form.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })); });
}

function reason(page: Page, id: string) {
  const control = choice(page, id); const description = control.getAttribute('aria-describedby'); assert.ok(description, 'A blocked selection has an accessible explanation');
  const message = page.dom.window.document.getElementById(description); assert.ok(message); return message.textContent ?? '';
}

void test('new crew picker blocks all globally assigned UUIDs including filtered and disabled crews, while free identities remain selectable', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await renderDirectory(page); const document = page.dom.window.document;
    const area = document.querySelector('input[placeholder="Filter by area"]'); assert.ok(area instanceof page.dom.window.HTMLInputElement);
    await editInput(area, 'Catania'); assert.equal(document.querySelectorAll('.crews-table tbody tr').length, 1);
    await click(button(document, '+ New crew'));
    for (const id of [ownId, otherId, disabledCrewPersonId]) { assert.equal(choice(page, id).disabled, true); assert.equal(choice(page, id).checked, false); }
    assert.match(reason(page, ownId), /Already in: Catania One/);
    assert.match(reason(page, otherId), /Already in: Messina Two/);
    assert.match(reason(page, disabledCrewPersonId), /Already in: Disabled Studio/);
    assert.match(reason(page, disabledCrewPersonId), /\(disabled\)/i);
    assert.equal(choice(page, ownId).getAttribute('aria-label'), 'Marco Russo');
    assert.equal(choice(page, otherId).getAttribute('aria-label'), 'Marco Russo');
    assert.notEqual(choice(page, ownId), choice(page, otherId), 'Display names cannot merge distinct participant UUIDs');
    assert.equal(choice(page, freeId).disabled, false);
    await act(async () => { choice(page, freeId).click(); });
    input(page, 'name').value = 'Synthetic new crew'; input(page, 'area').value = 'Catania';
    const pending = api.defer('/crews', 'POST'); await submit(page); assert.equal(pending.called, true);
    const call = api.calls.find((entry) => entry.method === 'POST'); assert.ok(call);
    const body = z.object({ name: z.literal('Synthetic new crew'), area: z.literal('Catania'), classification: z.literal('indoor'), enabled: z.literal(true), participantIds: z.array(z.uuid()) }).strict().parse(call.body);
    assert.deepEqual(body.participantIds, [freeId]);
    await act(async () => { pending.reply(crewSchema.parse({ ...body, id: '75000000-0000-4000-8000-000000000013', version: 1, people: [api.participants.find((entry) => entry.id === freeId)] })); }); await settle();
  } finally { await page.close(); }
});

void test('editing a crew keeps its own member editable and saves the unchanged UUID roster using the captured version', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await renderDirectory(page); const document = page.dom.window.document;
    const manage = document.querySelector('button[aria-label="Manage crew Catania One"]'); assert.ok(manage instanceof page.dom.window.HTMLButtonElement); await click(manage);
    assert.equal(choice(page, ownId).checked, true); assert.equal(choice(page, ownId).disabled, false); assert.equal(choice(page, otherId).disabled, true);
    await act(async () => { choice(page, ownId).click(); }); assert.equal(choice(page, ownId).checked, false); assert.equal(choice(page, ownId).disabled, false);
    await act(async () => { choice(page, ownId).click(); }); assert.equal(choice(page, ownId).checked, true);
    const pending = api.defer(`/crews/${ownCrewId}`, 'PATCH'); await submit(page); assert.equal(pending.called, true);
    const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call);
    const body = z.object({ version: z.literal(7), name: z.literal('Catania One'), area: z.literal('Catania'), classification: z.literal('indoor'), enabled: z.literal(true), participantIds: z.array(z.uuid()) }).strict().parse(call.body);
    assert.deepEqual(body.participantIds, [ownId]);
    const saved = api.crews.find((crew) => crew.id === ownCrewId); assert.ok(saved); await act(async () => { pending.reply({ ...saved, version: 8 }); }); await settle();
    assert.equal(api.calls.filter((entry) => entry.method !== 'GET').length, 1);
  } finally { await page.close(); }
});

void test('refresh preserves a selected free-person draft when another crew acquires it, blocks submission and permits removal', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await renderDirectory(page); const document = page.dom.window.document;
    await click(button(document, '+ New crew')); await act(async () => { choice(page, freeId).click(); });
    const editor = dialog(page); const selected = choice(page, freeId); const name = input(page, 'name'); const area = input(page, 'area');
    name.value = 'Preserved unsaved crew'; area.value = 'Synthetic area'; editor.scrollTop = 239;
    const refresh = api.defer('/crews'); await click(button(document, '↻ Refresh'));
    assert.equal(dialog(page), editor); assert.equal(choice(page, freeId), selected); assert.equal(selected.checked, true);
    api.crews = api.crews.map((crew) => crew.id === otherCrewId ? { ...crew, version: crew.version + 1, people: [...crew.people, { id: freeId, name: 'Luca Marino', external: false }] } : crew);
    await act(async () => { refresh.reply(api.crews); }); await waitFor(() => !button(document, '↻ Refresh').disabled, 'new global memberships');
    assert.equal(dialog(page), editor); assert.equal(choice(page, freeId), selected); assert.equal(selected.checked, true); assert.equal(selected.disabled, false, 'A newly occupied draft selection must remain removable');
    assert.equal(name.value, 'Preserved unsaved crew'); assert.equal(area.value, 'Synthetic area'); assert.equal(editor.scrollTop, 239);
    assert.match(reason(page, freeId), /Already in: Messina Two/); assert.equal(button(editor, 'Create crew').disabled, true);
    await submit(page); assert.equal(api.calls.some((call) => call.method === 'POST'), false, 'Programmatic submission must also validate current global memberships');
    await act(async () => { selected.click(); }); assert.equal(selected.checked, false); assert.equal(selected.disabled, true); assert.equal(button(editor, 'Create crew').disabled, false, 'An empty default roster remains valid after removing the occupied identity');
    assert.equal(name.value, 'Preserved unsaved crew'); assert.equal(area.value, 'Synthetic area');
  } finally { await page.close(); }
});

void test('legacy duplicate own members remain removable, explain every conflicting crew and cannot be saved unchanged', { concurrency: false }, async () => {
  const api = fixture();
  api.crews = api.crews.map((crew) => crew.id === ownCrewId ? crew : { ...crew, people: [...crew.people, { id: ownId, name: 'Marco Russo', external: false }] });
  const page = await domHarness(api);
  try {
    await renderDirectory(page); const document = page.dom.window.document;
    const manage = document.querySelector('button[aria-label="Manage crew Catania One"]'); assert.ok(manage instanceof page.dom.window.HTMLButtonElement); await click(manage);
    const selected = choice(page, ownId); assert.equal(selected.checked, true); assert.equal(selected.disabled, false);
    assert.match(reason(page, ownId), /Messina Two/); assert.match(reason(page, ownId), /Disabled Studio \(disabled\)/);
    assert.doesNotMatch(reason(page, ownId), /Catania One/, 'The edited crew itself does not cause an external-membership conflict');
    assert.equal(button(dialog(page), 'Save crew').disabled, true);
    await submit(page); assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    await act(async () => { selected.click(); }); assert.equal(selected.checked, false); assert.equal(selected.disabled, true); assert.equal(button(dialog(page), 'Save crew').disabled, false);
    const pending = api.defer(`/crews/${ownCrewId}`, 'PATCH'); await submit(page); assert.equal(pending.called, true);
    const call = api.calls.find((entry) => entry.method === 'PATCH'); assert.ok(call);
    assert.deepEqual(z.object({ version: z.literal(7), participantIds: z.array(z.uuid()) }).parse(call.body), { version: 7, participantIds: [] });
    const ownCrew = api.crews.find((crew) => crew.id === ownCrewId); assert.ok(ownCrew); await act(async () => { pending.reply({ ...ownCrew, people: [], version: 8 }); }); await settle();
    assert.equal(api.crews.find((crew) => crew.id === otherCrewId)?.people.some((person) => person.id === ownId), true, 'The UI does not silently rewrite another crew roster');
  } finally { await page.close(); }
});

