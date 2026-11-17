import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { crewSchema, participantSchema, skillSchema, templateSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, settle, user, waitFor } from './refresh-fixtures';

const admin = { ...user, role: 'admin' as const };
const personId = '69000000-0000-4000-8000-000000000001';
const crewId = '69000000-0000-4000-8000-000000000002';
const templateId = '69000000-0000-4000-8000-000000000003';
const skillId = '69000000-0000-4000-8000-000000000004';
const subjects = [
  { kind: 'participants', id: personId, name: 'DEMO Carlo Testa', version: 2 },
  { kind: 'crews', id: crewId, name: 'DEMO Directory crew', version: 3 },
  { kind: 'templates', id: templateId, name: 'DEMO Directory task', version: 4 },
] as const;
type DirectoryKind = typeof subjects[number]['kind'];
type RecordValue = z.infer<typeof participantSchema> | z.infer<typeof crewSchema> | z.infer<typeof templateSchema>;

function fixture() {
  const api = new ApiFixture();
  api.skills = [skillSchema.parse({ id: skillId, version: 1, name: 'DEMO Assembly', description: null, enabled: true })];
  api.participants = [participantSchema.parse({ id: personId, version: 2, name: 'DEMO Carlo Testa', firstName: 'Carlo', lastName: 'Testa',
    preferredName: 'Carletto', phoneNumber: '+390000000069', address: 'DEMO Via Prova 69', login: 'carlo.test@example.test',
    hasPassword: true, external: false, enabled: true, skillIds: [skillId] })];
  api.crews = [crewSchema.parse({ id: crewId, version: 3, name: 'DEMO Directory crew', classification: 'indoor', area: 'DEMO Catania', enabled: true,
    people: [{ id: personId, name: 'DEMO Carlo Testa', external: false }] })];
  api.templates = [templateSchema.parse({ id: templateId, version: 4, title: 'DEMO Directory task', severity: 'high', order: 2,
    checklist: ['DEMO inspect packaging', 'DEMO confirm assembly'], requiredSkillIds: [skillId], enabled: true })];
  return api;
}

function namedButton(scope: ParentNode, name: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === name);
  assert.ok(found, `Missing named action: ${name}`);
  return found;
}

function dialog(document: Document): HTMLElement {
  const found = document.querySelector('[role="dialog"]');
  assert.ok(found instanceof HTMLElement);
  return found;
}

function input(scope: ParentNode, name: string): HTMLInputElement {
  const found = scope.querySelector(`input[name="${name}"]`);
  assert.ok(found instanceof HTMLInputElement);
  return found;
}

function textarea(scope: ParentNode, name: string): HTMLTextAreaElement {
  const found = scope.querySelector(`textarea[name="${name}"]`);
  assert.ok(found instanceof HTMLTextAreaElement);
  return found;
}

async function submit(scope: ParentNode): Promise<void> {
  const form = scope.querySelector('form');
  assert.ok(form instanceof HTMLFormElement);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

function putRecord(api: ApiFixture, record: RecordValue): void {
  if ('firstName' in record) api.participants = [...api.participants.filter((entry) => entry.id !== record.id), record];
  else if ('title' in record) api.templates = [...api.templates.filter((entry) => entry.id !== record.id), record];
  else api.crews = [...api.crews.filter((entry) => entry.id !== record.id), record];
}

function recordName(record: RecordValue): string { return 'title' in record ? record.title : record.name; }

function deletedToastCount(document: Document): number {
  return Array.from(document.querySelectorAll('[data-sonner-toast][data-type="success"] [data-title]'))
    .filter((title) => title.textContent === 'Deleted').length;
}

async function openDirectory(api: ApiFixture, kind: DirectoryKind, isAdmin = true) {
  const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory');
    await page.render(createElement(Directory, { user: isAdmin ? admin : user, initialTab: kind }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('button[aria-label^="View DEMO"]') !== null, 'directory actions');
    return { page, document };
  } catch (failure: unknown) { await page.close(); throw failure; }
}

for (const subject of subjects) {
  void test(`${subject.kind} delete requires confirmation, sends its original version, and removes only after success`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject.kind);
    try {
      const previousToasts = deletedToastCount(document);
      const rowAction = namedButton(document, `Delete ${subject.name}`);
      await click(rowAction);
      assert.match(dialog(document).textContent ?? '', new RegExp(subject.name));
      assert.match(dialog(document).textContent ?? '', /permanent|cannot be undone/i);
      assert.equal(api.calls.some((call) => call.method === 'DELETE'), false, 'Opening confirmation must never delete');
      await click(button(dialog(document), 'Cancel'));
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(rowAction.isConnected, true);
      await click(rowAction);
      const response = api.defer(`/${subject.kind}/${subject.id}`, 'DELETE');
      const confirm = button(dialog(document), 'Delete permanently');
      await click(confirm);
      assert.equal(response.called, true);
      assert.equal(confirm.disabled, true, 'Repeated destructive submissions are blocked while pending');
      assert.equal(rowAction.isConnected, true, 'A pending request must not optimistically remove the record');
      const call = api.calls.find((candidate) => candidate.method === 'DELETE');
      assert.ok(call);
      assert.deepEqual(z.object({ version: z.number().int().positive() }).strict().parse(call.body), { version: subject.version });
      if (subject.kind === 'participants') api.participants = [];
      else if (subject.kind === 'crews') api.crews = [];
      else api.templates = [];
      await act(async () => { response.reply({ id: subject.id, deleted: true }); });
      await waitFor(() => deletedToastCount(document) > previousToasts, 'deletion toast');
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(rowAction.isConnected, false);
      assert.equal(api.calls.filter((candidate) => candidate.method === 'DELETE').length, 1);
      if (subject.kind === 'crews') assert.equal(api.participants.length, 1, 'Deleting a crew leaves its participants intact');
    } finally { await page.close(); }
  });
}

void test('operator deletion keeps a referenced record visible and explains how to resolve the roster conflict', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'participants', false);
  try {
    const previousToasts = deletedToastCount(document);
    const rowAction = namedButton(document, 'Delete DEMO Carlo Testa');
    await click(rowAction);
    const confirmation = dialog(document);
    const response = api.defer(`/participants/${personId}`, 'DELETE');
    await click(button(confirmation, 'Delete permanently'));
    await act(async () => { response.reply({ message: 'Participant belongs to a default crew. Remove them from the crew before deleting.' }, 409); });
    await waitFor(() => confirmation.textContent?.includes('Remove them from the crew before deleting.') === true, 'actionable conflict');
    assert.equal(dialog(document), confirmation);
    assert.equal(rowAction.isConnected, true);
    assert.equal(deletedToastCount(document), previousToasts);
    assert.equal(button(confirmation, 'Cancel').disabled, false);
    await click(button(confirmation, 'Cancel'));
    assert.equal(api.calls.filter((call) => call.method === 'DELETE').length, 1);
  } finally { await page.close(); }
});

void test('a newer refresh invalidates an operator deletion confirmation instead of silently using its new version', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'templates', false);
  try {
    const refresh = api.defer('/templates');
    await click(button(document, '↻ Refresh'));
    await click(namedButton(document, 'Delete DEMO Directory task'));
    const confirmation = dialog(document);
    api.templates = api.templates.map((template) => ({ ...template, version: 5, title: 'DEMO Concurrent rename' }));
    await act(async () => { refresh.reply(api.templates); });
    await waitFor(() => button(confirmation, 'Delete permanently').disabled, 'stale delete blocked');
    assert.equal(dialog(document), confirmation);
    assert.match(confirmation.textContent ?? '', /changed|newer|refresh|review/i);
    assert.match(confirmation.textContent ?? '', /DEMO Directory task/, 'The confirmation preserves the originally reviewed identity');
    await act(async () => { button(confirmation, 'Delete permanently').click(); });
    await settle();
    assert.equal(api.calls.some((call) => call.method === 'DELETE'), false);
  } finally { await page.close(); }
});

void test('operator can inspect complete directory records with editing and deletion controls', { concurrency: false }, async () => {
  for (const subject of subjects) {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject.kind, false);
    try {
      assert.ok(document.querySelector('button[aria-label^="Delete "]'));
      await click(namedButton(document, `View ${subject.name}`));
      const view = dialog(document);
      assert.match(view.textContent ?? '', new RegExp(subject.name));
      assert.equal(view.querySelector('input, textarea'), null, 'Read view must not expose editable controls');
      assert.equal(Array.from(view.querySelectorAll('button')).some((entry) => /^Edit /.test(entry.textContent ?? '')), true);
      assert.equal(button(view, 'Delete').disabled, false);
      if (subject.kind === 'participants') {
        assert.equal(view.textContent?.includes('carlo.test@example.test'), true, 'Authorized profile editors see the existing Crew login');
        assert.match(view.textContent ?? '', /Password configured/);
        assert.match(view.textContent ?? '', /Carletto/);
        assert.match(view.textContent ?? '', /\+390000000069/);
        assert.match(view.textContent ?? '', /DEMO Via Prova 69/);
        assert.match(view.textContent ?? '', /DEMO Assembly/);
      } else if (subject.kind === 'crews') {
        assert.match(view.textContent ?? '', /DEMO Catania/);
        assert.match(view.textContent ?? '', /DEMO Carlo Testa/);
      } else {
        assert.match(view.textContent ?? '', /DEMO inspect packaging/);
        assert.match(view.textContent ?? '', /DEMO confirm assembly/);
        assert.match(view.textContent ?? '', /DEMO Assembly/);
      }
      assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    } finally { await page.close(); }
  }
});

for (const subject of subjects) {
  void test(`operator can create, edit and delete ${subject.kind} through the real directory forms`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject.kind, false);
    try {
      const label = subject.kind === 'participants' ? 'participant' : subject.kind === 'crews' ? 'crew' : 'template';
      await click(button(document, `+ New ${label}`));
      const record = subject.kind === 'participants'
        ? participantSchema.parse({ id: '69000000-0000-4000-8000-000000000005', version: 1, name: 'Carlo Operatore', firstName: 'Carlo', lastName: 'Operatore',
          preferredName: null, phoneNumber: null, address: null, login: null, hasPassword: false, external: false, enabled: true, skillIds: [] })
        : subject.kind === 'crews'
          ? crewSchema.parse({ id: '69000000-0000-4000-8000-000000000006', version: 1, name: 'DEMO Operator crew', classification: 'indoor', area: 'Messina', enabled: true, people: [] })
          : templateSchema.parse({ id: '69000000-0000-4000-8000-000000000007', version: 1, title: 'DEMO Operator template', severity: 'medium', order: 1,
            checklist: ['DEMO Inspect'], requiredSkillIds: [], enabled: true });
      if ('firstName' in record) {
        input(dialog(document), 'firstName').value = 'Carlo';
        input(dialog(document), 'lastName').value = 'Operatore';
      } else if ('title' in record) {
        input(dialog(document), 'title').value = record.title;
        textarea(dialog(document), 'checklist').value = 'DEMO Inspect';
      } else {
        input(dialog(document), 'name').value = record.name;
        input(dialog(document), 'area').value = record.area;
      }
      const creation = api.defer(`/${subject.kind}`, 'POST');
      await submit(dialog(document));
      assert.equal(creation.called, true);
      const createCall = api.calls.find((entry) => entry.method === 'POST');
      assert.ok(createCall);
      if (subject.kind === 'participants') {
        assert.deepEqual(z.object({ firstName: z.literal('Carlo'), lastName: z.literal('Operatore'), login: z.null(), skillIds: z.array(z.uuid()) }).parse(createCall.body),
          { firstName: 'Carlo', lastName: 'Operatore', login: null, skillIds: [] });
      } else if (subject.kind === 'crews') {
        assert.deepEqual(z.object({ name: z.literal('DEMO Operator crew'), area: z.literal('Messina'), participantIds: z.array(z.uuid()) }).parse(createCall.body),
          { name: 'DEMO Operator crew', area: 'Messina', participantIds: [] });
      } else {
        assert.deepEqual(z.object({ title: z.literal('DEMO Operator template'), checklist: z.array(z.string()), requiredSkillIds: z.array(z.uuid()) }).parse(createCall.body),
          { title: 'DEMO Operator template', checklist: ['DEMO Inspect'], requiredSkillIds: [] });
      }
      putRecord(api, record);
      await act(async () => { creation.reply(record); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator creation');

      await click(namedButton(document, `View ${recordName(record)}`));
      await click(button(dialog(document), `Edit ${label}`));
      const revised = 'firstName' in record ? { ...record, firstName: 'Mario', name: 'Mario Operatore', version: 2 }
        : 'title' in record ? { ...record, title: `${record.title} revised`, version: 2 }
          : { ...record, name: `${record.name} revised`, version: 2 };
      if ('firstName' in revised) input(dialog(document), 'firstName').value = 'Mario';
      else if ('title' in revised) input(dialog(document), 'title').value = revised.title;
      else input(dialog(document), 'name').value = revised.name;
      const update = api.defer(`/${subject.kind}/${record.id}`, 'PATCH');
      await submit(dialog(document));
      assert.equal(update.called, true);
      const updateCall = api.calls.find((entry) => entry.method === 'PATCH');
      assert.ok(updateCall);
      assert.equal(z.object({ version: z.literal(1) }).passthrough().parse(updateCall.body).version, 1);
      putRecord(api, revised);
      await act(async () => { update.reply(revised); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator update');

      await click(namedButton(document, `Delete ${recordName(revised)}`));
      assert.equal(api.calls.some((entry) => entry.method === 'DELETE'), false);
      await click(button(dialog(document), 'Cancel'));
      assert.equal(namedButton(document, `View ${recordName(revised)}`).isConnected, true);
      await click(namedButton(document, `Delete ${recordName(revised)}`));
      const deletion = api.defer(`/${subject.kind}/${record.id}`, 'DELETE');
      await click(button(dialog(document), 'Delete permanently'));
      assert.equal(deletion.called, true);
      const deleteCall = api.calls.find((entry) => entry.method === 'DELETE');
      assert.ok(deleteCall);
      assert.deepEqual(z.object({ version: z.literal(2) }).strict().parse(deleteCall.body), { version: 2 });
      if (subject.kind === 'participants') api.participants = api.participants.filter((entry) => entry.id !== record.id);
      else if (subject.kind === 'crews') api.crews = api.crews.filter((entry) => entry.id !== record.id);
      else api.templates = api.templates.filter((entry) => entry.id !== record.id);
      await act(async () => { deletion.reply({ id: record.id, deleted: true }); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator deletion');
      assert.equal(document.querySelector(`button[aria-label="View ${recordName(revised)}"]`), null);
      assert.equal(namedButton(document, `View ${subject.name}`).isConnected, true, 'Unrelated directory records remain unchanged');
    } finally { await page.close(); }
  });
}

void test('operator profile editing preserves the existing Crew login and omits a blank replacement password', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'participants', false);
  try {
    await click(namedButton(document, 'View DEMO Carlo Testa'));
    await click(button(dialog(document), 'Edit participant'));
    const editor = dialog(document);
    assert.equal(input(editor, 'login').value, 'carlo.test@example.test');
    assert.equal(input(editor, 'password').value, '');
    assert.equal(editor.querySelector('[name="role"]'), null, 'Crew profiles cannot change Backoffice account roles');
    input(editor, 'phoneNumber').value = '+390000000070';
    const update = api.defer(`/participants/${personId}`, 'PATCH');
    await submit(editor);
    const call = api.calls.find((entry) => entry.method === 'PATCH');
    assert.ok(call);
    const body = z.object({ version: z.literal(2), login: z.literal('carlo.test@example.test'), phoneNumber: z.literal('+390000000070'), skillIds: z.array(z.uuid()) }).passthrough().parse(call.body);
    assert.equal(Object.hasOwn(body, 'password'), false, 'Blank password input must preserve the stored password');
    assert.equal(Object.hasOwn(body, 'role'), false);
    assert.deepEqual(body.skillIds, [skillId]);
    const original = api.participants[0]; assert.ok(original);
    const saved = { ...original, phoneNumber: '+390000000070', version: 3 };
    putRecord(api, saved);
    await act(async () => { update.reply(saved); });
    await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator profile saved');
  } finally { await page.close(); }
});

void test('a late read started before deletion cannot restore the deleted crew to the directory', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'crews');
  try {
    const previousToasts = deletedToastCount(document);
    const oldCrews = [...api.crews];
    const refresh = api.defer('/crews');
    await click(button(document, '↻ Refresh'));
    await click(namedButton(document, 'Delete DEMO Directory crew'));
    const deletion = api.defer(`/crews/${crewId}`, 'DELETE');
    await click(button(dialog(document), 'Delete permanently'));
    api.crews = [];
    await act(async () => { deletion.reply({ id: crewId, deleted: true }); });
    await waitFor(() => deletedToastCount(document) > previousToasts, 'confirmed deletion');
    await act(async () => { refresh.reply(oldCrews); });
    await settle();
    assert.equal(document.querySelector('button[aria-label="Delete DEMO Directory crew"]'), null);
    assert.match(document.body.textContent ?? '', /No crews yet/);
    assert.equal(api.participants.length, 1);
  } finally { await page.close(); }
});

void test('delete conflicts explain roster removal or disabling in the selected English, Italian, Russian or Uzbek language', { concurrency: false }, async () => {
  const languages = [
    { locale: 'en', confirm: 'Delete permanently', roster: /Remove them from the crew before deleting/, history: /Disable it instead of deleting/ },
    { locale: 'it', confirm: 'Elimina definitivamente', roster: /Rimuovilo dalla squadra prima di eliminarlo/, history: /Disattivalo invece di eliminarlo/ },
    { locale: 'ru', confirm: 'Удалить навсегда', roster: /Сначала уберите его из бригады/, history: /Отключите её вместо удаления/ },
    { locale: 'uz', confirm: 'Butunlay o‘chirish', roster: /brigadadan olib tashlang/, history: /O‘chirish o‘rniga uni faolsizlantiring/ },
  ] as const;
  const failures = [
    { kind: 'roster', message: 'Participant belongs to a default crew. Remove them from the crew before deleting.' },
    { kind: 'history', message: 'Participant is referenced by delivery history or planning. Disable it instead of deleting.' },
  ] as const;
  for (const language of languages) for (const failure of failures) {
    const api = fixture();
    const page = await domHarness(api);
    try {
      const { DirectoryDeleteDialog } = await import('../src/components/directory-record-dialogs');
      const participant = api.participants[0]; assert.ok(participant);
      let deleted = false; let closed = false;
      await page.render(createElement(DirectoryDeleteDialog, {
        record: { kind: 'participant', value: participant }, currentVersion: participant.version,
        onClose: () => { closed = true; }, onDeleted: () => { deleted = true; },
      }), language.locale);
      const document = page.dom.window.document;
      const response = api.defer(`/participants/${personId}`, 'DELETE');
      await click(button(dialog(document), language.confirm));
      await act(async () => { response.reply({ message: failure.message }, 409); });
      await waitFor(() => document.querySelector('[role="alert"]') !== null, `${language.locale} localized ${failure.kind} conflict`);
      const message = document.querySelector('[role="alert"]')?.textContent ?? '';
      assert.match(message, language[failure.kind]);
      if (language.locale !== 'en') assert.equal(message.includes(failure.message), false, 'Known conflict must not append its raw English response');
      assert.equal(deleted, false); assert.equal(closed, false);
      assert.equal(button(dialog(document), language.confirm).disabled, false);
    } finally { await page.close(); }
  }
});
