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

void test('a referenced record stays visible and the delete dialog explains how to resolve the conflict', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'participants');
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

void test('a newer refresh invalidates an open deletion confirmation instead of silently using its new version', { concurrency: false }, async () => {
  const api = fixture();
  const { page, document } = await openDirectory(api, 'templates');
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

void test('operator can inspect full directory records but receives no editing, deletion or credential controls', { concurrency: false }, async () => {
  for (const subject of subjects) {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject.kind, false);
    try {
      assert.equal(document.querySelector('button[aria-label^="Delete "]'), null);
      await click(namedButton(document, `View ${subject.name}`));
      const view = dialog(document);
      assert.match(view.textContent ?? '', new RegExp(subject.name));
      assert.equal(view.querySelector('input, textarea'), null, 'Read view must not expose editable controls');
      assert.equal(Array.from(view.querySelectorAll('button')).some((entry) => /^(Edit |Delete)/.test(entry.textContent ?? '')), false);
      assert.equal(view.textContent?.includes('carlo.test@example.test'), false, 'Operator details do not reveal admin-only login information');
      if (subject.kind === 'participants') {
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
