import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { skillSchema, vehicleSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, settle, user, waitFor } from './refresh-fixtures';

const admin = { ...user, role: 'admin' as const };
const skillId = '69100000-0000-4000-8000-000000000001';
const otherSkillId = '69100000-0000-4000-8000-000000000002';
const vehicleId = '69100000-0000-4000-8000-000000000003';
const otherVehicleId = '69100000-0000-4000-8000-000000000004';
const subjects = [
  { kind: 'skills', id: skillId, name: 'DEMO Catalogue assembly', otherName: 'DEMO Catalogue wiring', version: 3, label: 'Skill', refresh: '↻ Refresh skills' },
  { kind: 'vehicles', id: vehicleId, name: 'DEMO Catalogue carrier', otherName: 'DEMO Catalogue van', version: 4, label: 'Vehicle', refresh: '↻ Refresh vehicles' },
] as const;
type Subject = typeof subjects[number];

function fixture() {
  const api = new ApiFixture();
  api.skills = [
    skillSchema.parse({ id: skillId, version: 3, name: 'DEMO Catalogue assembly', description: 'Wall-mounted cabinet installation\nRequires suitable fixings', enabled: true }),
    skillSchema.parse({ id: otherSkillId, version: 1, name: 'DEMO Catalogue wiring', description: null, enabled: true }),
  ];
  api.vehicles = [
    vehicleSchema.parse({ id: vehicleId, version: 4, name: 'DEMO Catalogue carrier', plate: 'AA 123 BB', ownership: 'external',
      providerName: 'DEMO Messina transport', providerContact: '+39000000691', operationalStatus: 'maintenance', enabled: true, notes: 'Tail lift inspection\nKeep loading bay clear' }),
    vehicleSchema.parse({ id: otherVehicleId, version: 1, name: 'DEMO Catalogue van', plate: 'CC 456 DD', ownership: 'company',
      providerName: null, providerContact: null, operationalStatus: 'available', enabled: true, notes: null }),
  ];
  return api;
}

function namedButton(scope: ParentNode, name: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label') === name);
  assert.ok(found, `Missing action: ${name}`);
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

async function submit(scope: ParentNode): Promise<void> {
  const form = scope.querySelector('form');
  assert.ok(form instanceof HTMLFormElement);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

function deletionToasts(document: Document): number {
  return Array.from(document.querySelectorAll('[data-sonner-toast][data-type="success"] [data-title]'))
    .filter((entry) => entry.textContent === 'Deleted').length;
}

function removeFixtureRecord(api: ApiFixture, subject: Subject): void {
  if (subject.kind === 'skills') api.skills = api.skills.filter((entry) => entry.id !== subject.id);
  else api.vehicles = api.vehicles.filter((entry) => entry.id !== subject.id);
}

async function openDirectory(api: ApiFixture, subject: Subject, isAdmin = true) {
  const page = await domHarness(api);
  try {
    if (subject.kind === 'skills') {
      const { SkillsDirectory } = await import('../src/components/skills-directory');
      await page.render(createElement(SkillsDirectory, { user: isAdmin ? admin : user }));
    } else {
      const { VehiclesDirectory } = await import('../src/components/vehicles-directory');
      await page.render(createElement(VehiclesDirectory, { user: isAdmin ? admin : user }));
    }
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector(`.${subject.kind}-table`) !== null, `${subject.kind} catalog`);
    return { page, document };
  } catch (failure: unknown) { await page.close(); throw failure; }
}

void test('operators can inspect complete skill and vehicle details with scoped editing and deletion controls', { concurrency: false }, async () => {
  for (const subject of subjects) {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject, false);
    try {
      assert.ok(document.querySelector('button[aria-label^="Delete "]'));
      assert.ok(document.querySelector('button[aria-label^="Edit "]'));
      await click(namedButton(document, `View ${subject.name}`));
      const view = dialog(document);
      assert.match(view.textContent ?? '', new RegExp(`${subject.label} details`));
      assert.match(view.textContent ?? '', new RegExp(subject.name));
      assert.equal(view.querySelector('input, textarea'), null);
      assert.equal(button(view, `Edit ${subject.label.toLowerCase()}`).disabled, false);
      assert.equal(button(view, 'Delete').disabled, false);
      if (subject.kind === 'skills') {
        assert.match(view.textContent ?? '', /Wall-mounted cabinet installation/);
        assert.match(view.textContent ?? '', /Requires suitable fixings/);
      } else {
        for (const value of ['AA 123 BB', 'DEMO Messina transport', '+39000000691', 'Tail lift inspection', 'Keep loading bay clear']) {
          assert.equal(view.textContent?.includes(value), true, `Missing vehicle detail: ${value}`);
        }
        assert.match(view.textContent ?? '', /maintenance/i);
      }
      assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
    } finally { await page.close(); }
  }
});

for (const subject of subjects) {
  void test(`operator can create, edit and delete a ${subject.label.toLowerCase()} through the catalog`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject, false);
    try {
      const name = `DEMO Operator ${subject.label}`;
      const id = subject.kind === 'skills' ? '69100000-0000-4000-8000-000000000005' : '69100000-0000-4000-8000-000000000006';
      await click(button(document, `+ New ${subject.label.toLowerCase()}`));
      input(dialog(document), 'name').value = name;
      if (subject.kind === 'vehicles') input(dialog(document), 'plate').value = 'ee 789 ff';
      const create = api.defer(`/${subject.kind}`, 'POST');
      await submit(dialog(document));
      assert.equal(create.called, true);
      const creationCall = api.calls.find((entry) => entry.method === 'POST');
      assert.ok(creationCall);
      assert.equal(z.object({ name: z.string() }).passthrough().parse(creationCall.body).name, name);
      const created = subject.kind === 'skills'
        ? skillSchema.parse({ id, version: 1, name, description: null, enabled: true })
        : vehicleSchema.parse({ id, version: 1, name, plate: 'EE 789 FF', ownership: 'company', providerName: null,
          providerContact: null, operationalStatus: 'available', enabled: true, notes: null });
      if ('plate' in created) api.vehicles.push(created);
      else api.skills.push(created);
      await act(async () => { create.reply(created); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator create completed');

      await click(namedButton(document, `Edit ${subject.label.toLowerCase()} ${name}`));
      const revisedName = `${name} revised`;
      input(dialog(document), 'name').value = revisedName;
      const patch = api.defer(`/${subject.kind}/${id}`, 'PATCH');
      await submit(dialog(document));
      assert.equal(patch.called, true);
      const editCall = api.calls.find((entry) => entry.method === 'PATCH');
      assert.ok(editCall);
      assert.deepEqual(z.object({ version: z.number(), name: z.string() }).parse(editCall.body), { version: 1, name: revisedName });
      const edited = { ...created, name: revisedName, version: 2 };
      if ('plate' in edited) api.vehicles = api.vehicles.map((entry) => entry.id === id ? edited : entry);
      else api.skills = api.skills.map((entry) => entry.id === id ? edited : entry);
      await act(async () => { patch.reply(edited); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator edit completed');

      await click(namedButton(document, `Delete ${revisedName}`));
      const deletion = api.defer(`/${subject.kind}/${id}`, 'DELETE');
      await click(button(dialog(document), 'Delete permanently'));
      assert.equal(deletion.called, true);
      const deleteCall = api.calls.find((entry) => entry.method === 'DELETE');
      assert.ok(deleteCall);
      assert.deepEqual(z.object({ version: z.literal(2) }).strict().parse(deleteCall.body), { version: 2 });
      if (subject.kind === 'skills') api.skills = api.skills.filter((entry) => entry.id !== id);
      else api.vehicles = api.vehicles.filter((entry) => entry.id !== id);
      await act(async () => { deletion.reply({ id, deleted: true }); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'operator deletion completed');
      assert.equal(document.querySelector(`button[aria-label="View ${revisedName}"]`), null);
      assert.equal(namedButton(document, `View ${subject.name}`).isConnected, true, 'Existing unrelated records remain available');
    } finally { await page.close(); }
  });

  void test(`${subject.kind} deletion requires confirmation and preserves filters until the server confirms success`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject);
    try {
      const search = document.querySelector('.directory-filters input');
      assert.ok(search instanceof HTMLInputElement);
      await editInput(search, 'DEMO Catalogue');
      const table = document.querySelector(`.${subject.kind}-table`);
      assert.ok(table);
      const rowAction = namedButton(document, `Delete ${subject.name}`);
      await click(rowAction);
      assert.match(dialog(document).textContent ?? '', /permanent|cannot be undone/i);
      assert.equal(api.calls.some((call) => call.method === 'DELETE'), false);
      await click(button(dialog(document), 'Cancel'));
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(rowAction.isConnected, true);

      await click(rowAction);
      const previousToasts = deletionToasts(document);
      const response = api.defer(`/${subject.kind}/${subject.id}`, 'DELETE');
      const confirm = button(dialog(document), 'Delete permanently');
      await click(confirm);
      assert.equal(response.called, true);
      assert.equal(confirm.disabled, true);
      assert.equal(rowAction.isConnected, true, 'Pending deletion does not hide a record');
      const call = api.calls.find((entry) => entry.method === 'DELETE');
      assert.ok(call);
      assert.deepEqual(z.object({ version: z.number().int().positive() }).strict().parse(call.body), { version: subject.version });
      removeFixtureRecord(api, subject);
      await act(async () => { response.reply({ id: subject.id, deleted: true }); });
      await waitFor(() => deletionToasts(document) > previousToasts, 'successful deletion toast');
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(rowAction.isConnected, false);
      assert.equal(namedButton(document, `View ${subject.otherName}`).isConnected, true);
      assert.equal(search.value, 'DEMO Catalogue');
      assert.equal(document.querySelector(`.${subject.kind}-table`), table);
      assert.equal(api.calls.filter((entry) => entry.method === 'DELETE').length, 1);
    } finally { await page.close(); }
  });

  void test(`${subject.kind} in-use conflicts preserve the record and explain disabling instead of deleting`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject);
    try {
      const previousToasts = deletionToasts(document);
      const rowAction = namedButton(document, `Delete ${subject.name}`);
      await click(rowAction);
      const confirmation = dialog(document);
      const response = api.defer(`/${subject.kind}/${subject.id}`, 'DELETE');
      await click(button(confirmation, 'Delete permanently'));
      const message = subject.kind === 'skills'
        ? 'Skill is assigned to participants or required by task templates. Disable it instead of deleting.'
        : 'Vehicle is referenced by delivery history or planning. Disable it instead of deleting.';
      await act(async () => { response.reply({ message }, 409); });
      await waitFor(() => confirmation.textContent?.includes('Disable it instead of deleting.') === true, 'actionable in-use conflict');
      assert.equal(dialog(document), confirmation);
      assert.equal(rowAction.isConnected, true);
      assert.equal(deletionToasts(document), previousToasts);
      assert.equal(button(confirmation, 'Cancel').disabled, false);
      await click(button(confirmation, 'Cancel'));
      assert.equal(namedButton(document, `View ${subject.name}`).isConnected, true);
    } finally { await page.close(); }
  });

  void test(`${subject.kind} deletion keeps its reviewed identity and becomes disabled after a concurrent revision`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject);
    try {
      const response = api.defer(`/${subject.kind}`);
      await click(button(document, subject.refresh));
      await click(namedButton(document, `Delete ${subject.name}`));
      const confirmation = dialog(document);
      if (subject.kind === 'skills') api.skills = api.skills.map((entry) => entry.id === subject.id ? { ...entry, version: entry.version + 1, name: 'DEMO Concurrent skill rename' } : entry);
      else api.vehicles = api.vehicles.map((entry) => entry.id === subject.id ? { ...entry, version: entry.version + 1, name: 'DEMO Concurrent vehicle rename' } : entry);
      await act(async () => { response.reply(subject.kind === 'skills' ? api.skills : api.vehicles); });
      await waitFor(() => button(confirmation, 'Delete permanently').disabled, 'stale confirmation disabled');
      assert.equal(dialog(document), confirmation);
      assert.equal(confirmation.textContent?.includes(subject.name), true);
      assert.match(confirmation.textContent ?? '', /changed|newer|refresh|review/i);
      await act(async () => { button(confirmation, 'Delete permanently').click(); });
      await settle();
      assert.equal(api.calls.some((entry) => entry.method === 'DELETE'), false);
    } finally { await page.close(); }
  });

  void test(`${subject.kind} ignores a delayed pre-deletion list response`, { concurrency: false }, async () => {
    const api = fixture();
    const { page, document } = await openDirectory(api, subject);
    try {
      const oldRecords = subject.kind === 'skills' ? [...api.skills] : [...api.vehicles];
      const refresh = api.defer(`/${subject.kind}`);
      await click(button(document, subject.refresh));
      await click(namedButton(document, `Delete ${subject.name}`));
      const response = api.defer(`/${subject.kind}/${subject.id}`, 'DELETE');
      await click(button(dialog(document), 'Delete permanently'));
      removeFixtureRecord(api, subject);
      await act(async () => { response.reply({ id: subject.id, deleted: true }); });
      await waitFor(() => document.querySelector('[role="dialog"]') === null, 'successful deletion');
      await act(async () => { refresh.reply(oldRecords); });
      await settle();
      assert.equal(document.querySelector(`button[aria-label="View ${subject.name}"]`), null);
      assert.equal(namedButton(document, `View ${subject.otherName}`).isConnected, true);
    } finally { await page.close(); }
  });
}
