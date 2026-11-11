import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { crewSchema, participantSchema, skillSchema, vehicleSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, user, waitFor } from './refresh-fixtures';

const admin = { ...user, role: 'admin' as const };
function id(index: number) { return `91000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }
function number(index: number) { return String(index + 1).padStart(2, '0'); }
function fixture(count = 20) {
  const api = new ApiFixture();
  api.skills = Array.from({ length: 20 }, (_, index) => skillSchema.parse({ id: id(101 + index), version: 1, name: `DEMO Skill ${number(index)}`, description: null, enabled: true }));
  api.participants = Array.from({ length: count }, (_, index) => participantSchema.parse({
    id: id(index + 1), version: 1, name: `DEMO Person ${number(index)}`, firstName: 'DEMO', lastName: `Person ${number(index)}`,
    preferredName: null, phoneNumber: null, address: null, login: null, hasPassword: false, skillIds: [id(101)], external: false, enabled: true,
  }));
  api.crews = Array.from({ length: 20 }, (_, index) => crewSchema.parse({ id: id(201 + index), version: 1, name: `DEMO Crew ${number(index)}`, area: index === 19 ? 'Special district' : 'General district', classification: 'indoor', enabled: true, people: [] }));
  api.vehicles = Array.from({ length: 20 }, (_, index) => vehicleSchema.parse({ id: id(301 + index), version: 1, name: `DEMO Van ${number(index)}`, plate: `DEMO-${number(index)}`, ownership: 'company', providerName: null, providerContact: null, enabled: true, operationalStatus: 'available', notes: null }));
  return api;
}
function rows(document: Document, table: string) { return Array.from(document.querySelectorAll(`${table} tbody tr`)); }
function input(document: ParentNode, selector: string): HTMLInputElement { const element = document.querySelector(selector); assert.ok(element instanceof HTMLInputElement); return element; }
function namedButton(document: ParentNode, name: string): HTMLButtonElement { const element = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === name); assert.ok(element); return element; }

void test('participants show ten rows per page and retain page two, row nodes and an open edit draft on refresh', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory');
    await page.render(createElement(Directory, { user: admin, initialTab: 'participants' }));
    const document = page.dom.window.document;
    await waitFor(() => rows(document, '.participants-table').length === 10, 'first ten participants');
    assert.match(rows(document, '.participants-table')[0]?.textContent ?? '', /DEMO Person 01/);
    assert.doesNotMatch(document.querySelector('.participants-table')?.textContent ?? '', /DEMO Person 11/);
    assert.ok(button(document, 'Participants 20'));
    await click(button(document, 'Next'));
    const first = rows(document, '.participants-table')[0]; assert.ok(first);
    assert.equal(rows(document, '.participants-table').length, 10);
    assert.match(first.textContent ?? '', /DEMO Person 11/);
    assert.equal(button(document, 'Next').disabled, true);
    await click(button(first, 'Edit participant'));
    const name = input(document, '.dialog input[name="firstName"]');
    await editInput(name, 'Preserved draft');
    const response = api.defer('/participants');
    await click(button(document, '↻ Refresh'));
    assert.equal(rows(document, '.participants-table')[0], first);
    await act(async () => { response.reply(api.participants.map((person) => ({ ...person, version: person.version + 1 }))); });
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'participant refresh');
    assert.equal(rows(document, '.participants-table')[0], first);
    assert.equal(input(document, '.dialog input[name="firstName"]'), name);
    assert.equal(name.value, 'Preserved draft');
    assert.match(first.textContent ?? '', /DEMO Person 11/);
    assert.equal(button(document, 'Next').disabled, true);
    await click(namedButton(document, 'Close participant editor'));
    await click(button(document, 'Crews 20')); await click(button(document, '+ New crew'));
    assert.equal(document.querySelectorAll('.dialog input[data-participant-id]').length, 20, 'Pagination must not truncate roster choices');
    assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});

void test('deleting the sole participant on page two clamps the table to the remaining first page', { concurrency: false }, async () => {
  const api = fixture(11); const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory');
    await page.render(createElement(Directory, { user: admin, initialTab: 'participants' })); const document = page.dom.window.document;
    await waitFor(() => rows(document, '.participants-table').length === 10, 'participant list');
    await click(button(document, 'Next')); assert.equal(rows(document, '.participants-table').length, 1);
    await click(namedButton(document, 'Delete DEMO Person 11'));
    const deletion = api.defer(`/participants/${id(11)}`, 'DELETE');
    await click(button(document, 'Delete permanently'));
    api.participants = api.participants.filter((person) => person.id !== id(11));
    await act(async () => { deletion.reply({ id: id(11), deleted: true }); });
    await waitFor(() => document.querySelector('[role="dialog"]') === null, 'deleted participant');
    assert.equal(rows(document, '.participants-table').length, 10);
    assert.match(rows(document, '.participants-table')[0]?.textContent ?? '', /DEMO Person 01/);
    assert.equal(button(document, 'Previous').disabled, true); assert.equal(button(document, 'Next').disabled, true);
  } finally { await page.close(); }
});

void test('crew filtering resets page two while keeping the table and complete directory available', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory');
    await page.render(createElement(Directory, { user: admin })); const document = page.dom.window.document;
    await waitFor(() => rows(document, '.crews-table').length === 10, 'crews');
    const table = document.querySelector('.crews-table');
    await click(button(document, 'Next')); assert.match(rows(document, '.crews-table')[0]?.textContent ?? '', /DEMO Crew 11/);
    await editInput(input(document, 'input[placeholder="Filter by area"]'), 'Special');
    assert.equal(document.querySelector('.crews-table'), table);
    assert.equal(rows(document, '.crews-table').length, 1); assert.match(table?.textContent ?? '', /DEMO Crew 20/);
    assert.equal(button(document, 'Previous').disabled, true);
    await editInput(input(document, 'input[placeholder="Filter by area"]'), '');
    assert.match(rows(document, '.crews-table')[0]?.textContent ?? '', /DEMO Crew 01/);
    assert.ok(button(document, 'Crews 20'));
  } finally { await page.close(); }
});

void test('skills and participant skill tables paginate independently without truncating participant counts', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { SkillsDirectory } = await import('../src/components/skills-directory');
    await page.render(createElement(SkillsDirectory, { user: admin })); const document = page.dom.window.document;
    await waitFor(() => rows(document, '.skills-table').length === 10, 'skills');
    const first = rows(document, '.skills-table')[0]; assert.ok(first);
    assert.equal(first.querySelectorAll('td')[1]?.textContent, '20', 'Skill usage counts include participants on all pages');
    await click(button(document, 'Next')); assert.match(rows(document, '.skills-table')[0]?.textContent ?? '', /DEMO Skill 11/);
    await editInput(input(document, '.directory-filters input'), 'Skill 20');
    assert.equal(rows(document, '.skills-table').length, 1); assert.equal(button(document, 'Previous').disabled, true);
    await editInput(input(document, '.directory-filters input'), '');
    await click(button(document, 'Next')); await click(button(document, 'Participant skills'));
    assert.equal(rows(document, '.participant-skills-table').length, 10);
    assert.match(rows(document, '.participant-skills-table')[0]?.textContent ?? '', /DEMO Person 01/);
    assert.equal(button(document, 'Previous').disabled, true);
    await click(button(document, 'Next')); assert.match(rows(document, '.participant-skills-table')[0]?.textContent ?? '', /DEMO Person 11/);
  } finally { await page.close(); }
});

void test('vehicle filtering returns to page one without changing the directory data', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    const { VehiclesDirectory } = await import('../src/components/vehicles-directory');
    await page.render(createElement(VehiclesDirectory, { user: admin })); const document = page.dom.window.document;
    await waitFor(() => rows(document, '.vehicles-table').length === 10, 'vehicles');
    await click(button(document, 'Next')); assert.match(rows(document, '.vehicles-table')[0]?.textContent ?? '', /DEMO Van 11/);
    await editInput(input(document, '.directory-filters input'), 'Van 20');
    assert.equal(rows(document, '.vehicles-table').length, 1); assert.match(rows(document, '.vehicles-table')[0]?.textContent ?? '', /DEMO Van 20/);
    assert.equal(button(document, 'Previous').disabled, true);
    await editInput(input(document, '.directory-filters input'), '');
    assert.equal(rows(document, '.vehicles-table').length, 10); assert.match(rows(document, '.vehicles-table')[0]?.textContent ?? '', /DEMO Van 01/);
    assert.equal(api.vehicles.length, 20); assert.equal(api.calls.some((call) => call.method !== 'GET'), false);
  } finally { await page.close(); }
});
