import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import type { AvailableParticipant, Skill, SkillSnapshot } from '../src/lib/contracts';
import { matchesParticipantChoiceFilter, participantChoiceStates } from '../src/lib/participant-choice-filters';
import { ApiFixture, click, domHarness } from './refresh-fixtures';

const assembly: Skill = { id: '87000000-0000-4000-8000-000000000001', version: 1, name: 'Assembly', description: null, enabled: true };
const requirements: SkillSnapshot[] = [{ id: assembly.id, name: assembly.name }];
const availableId = '87000000-0000-4000-8000-000000000011';
const busyId = '87000000-0000-4000-8000-000000000012';
const unskilledId = '87000000-0000-4000-8000-000000000013';
const inactiveId = '87000000-0000-4000-8000-000000000014';
const elsewhereId = '87000000-0000-4000-8000-000000000015';

function person(id: string, name: string, overrides: Partial<AvailableParticipant> = {}): AvailableParticipant {
  return { id, name, external: false, enabled: true, busy: false, skillIds: [assembly.id], conflicts: [], ...overrides };
}

function profiles(): AvailableParticipant[] {
  return [
    person(availableId, 'Matteo Ferraro'),
    person(busyId, 'Davide Vitale', { busy: true, conflicts: [{ appointmentId: '87000000-0000-4000-8000-000000000020', pickingName: 'DEMO/OUT/BUSY', startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T10:00:00Z' }] }),
    person(unskilledId, 'Andrea Grasso', { skillIds: [] }),
    person(inactiveId, 'Antonio Lombardo', { enabled: false }),
    person(elsewhereId, 'Alessandro Costa'),
  ];
}

const options = { selectedIds: [busyId], assignedElsewhereIds: [elsewhereId], retainedIds: [], requiredSkills: requirements, skills: [assembly] };

void test('availability filters account for overlapping blockers and do not make selected blocked people available', () => {
  const people = profiles().map((profile) => profile.id === busyId ? { ...profile, skillIds: [] } : profile);
  const choices = participantChoiceStates(people, options);
  assert.deepEqual(choices.filter((choice) => matchesParticipantChoiceFilter(choice, 'available')).map((choice) => choice.person.id), [availableId]);
  assert.deepEqual(choices.filter((choice) => matchesParticipantChoiceFilter(choice, 'busy')).map((choice) => choice.person.id), [busyId, elsewhereId]);
  assert.deepEqual(choices.filter((choice) => matchesParticipantChoiceFilter(choice, 'missingSkills')).map((choice) => choice.person.id), [busyId, unskilledId]);
  assert.deepEqual(choices.filter((choice) => matchesParticipantChoiceFilter(choice, 'selected')).map((choice) => choice.person.id), [busyId]);
  const busy = choices.find((choice) => choice.person.id === busyId); assert.ok(busy);
  assert.equal(busy.available, false); assert.equal(busy.disabled, false, 'Selected blocked participants must be removable');
  assert.equal(choices.find((choice) => choice.person.id === inactiveId)?.disabled, true);
  assert.deepEqual(people[1]?.skillIds, [], 'Classifying choices must not mutate their source');
});

void test('retained inactive staff stay eligible only in their existing assignment; unavailable skills still block them', () => {
  const retained = participantChoiceStates(profiles(), { ...options, retainedIds: [inactiveId] });
  assert.equal(retained.find((choice) => choice.person.id === inactiveId)?.available, true);
  const newlySelected = participantChoiceStates(profiles(), { ...options, selectedIds: [inactiveId] });
  assert.equal(newlySelected.find((choice) => choice.person.id === inactiveId)?.available, false);
  assert.equal(newlySelected.find((choice) => choice.person.id === inactiveId)?.disabled, false);
  const unavailable = participantChoiceStates(profiles(), { ...options, retainedIds: [inactiveId], skills: [{ ...assembly, enabled: false }] });
  assert.equal(unavailable.some((choice) => matchesParticipantChoiceFilter(choice, 'available')), false);
  assert.equal(unavailable.filter((choice) => matchesParticipantChoiceFilter(choice, 'missingSkills')).length, 5);
  assert.equal(unavailable.find((choice) => choice.person.id === inactiveId)?.disabled, true);
});

void test('participant filters keep selected blocked staff visible and removable, with accurate counts and reasons', { concurrency: false }, async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { ParticipantChoices } = await import('../src/components/staffing-editor');
    const changes: { id: string; selected: boolean }[] = [];
    function Choices() {
      const [selectedIds, setSelectedIds] = useState([busyId]);
      return createElement(ParticipantChoices, { label: 'Catania Due participants', people: profiles(), selectedIds, requiredSkills: requirements, skills: [assembly], assignedElsewhereIds: [elsewhereId], onChange: (id, selected) => {
        changes.push({ id, selected });
        setSelectedIds((current) => selected ? [...current, id] : current.filter((value) => value !== id));
      } });
    }
    await page.render(createElement(Choices)); const document = page.dom.window.document;
    function filter(value: string): HTMLButtonElement { const element = document.querySelector(`[data-participant-filter="${value}"]`); assert.ok(element instanceof page.dom.window.HTMLButtonElement); return element; }
    function choice(id: string): HTMLInputElement { const element = document.querySelector(`input[data-participant-id="${id}"]`); assert.ok(element instanceof page.dom.window.HTMLInputElement); return element; }
    assert.equal(filter('all').textContent, 'All5'); assert.equal(filter('available').textContent, 'Available1'); assert.equal(filter('busy').textContent, 'Busy2'); assert.equal(filter('missingSkills').textContent, 'Missing skills1'); assert.equal(filter('selected').textContent, 'Selected1');
    assert.equal(filter('all').getAttribute('aria-pressed'), 'false');
    assert.equal(filter('available').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelectorAll('input[data-participant-id]').length, 2);
    assert.equal(choice(availableId).disabled, false); assert.equal(choice(busyId).disabled, false);
    assert.ok(choice(busyId).closest('[data-selected-outside-filter]'));
    const reasonId = choice(busyId).getAttribute('aria-describedby'); assert.ok(reasonId);
    assert.match(document.getElementById(reasonId)?.textContent ?? '', /DEMO\/OUT\/BUSY/);
    assert.deepEqual(changes, [], 'Changing a filter must not change assignments');
    await act(async () => { choice(busyId).click(); });
    assert.deepEqual(changes, [{ id: busyId, selected: false }]);
    assert.equal(document.querySelector('[data-selected-outside-filter]'), null);
    await click(filter('busy'));
    assert.equal(choice(busyId).disabled, true); assert.equal(choice(elsewhereId).disabled, true);
    assert.match(choice(elsewhereId).closest('label')?.textContent ?? '', /another crew/i);
    await click(filter('missingSkills'));
    assert.equal(choice(unskilledId).disabled, true);
    assert.match(choice(unskilledId).closest('label')?.textContent ?? '', /Assembly/);
    await click(filter('selected')); assert.match(document.body.textContent ?? '', /No participants match this filter/);
    assert.deepEqual(api.calls, [], 'Filtering is local and must not trigger API mutations');
  } finally { await page.close(); }
});

void test('refreshed availability keeps the filter, selection and list scroll while exposing new conflicts', { concurrency: false }, async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { ParticipantChoices } = await import('../src/components/staffing-editor');
    function Choices({ people }: { people: AvailableParticipant[] }) {
      const [selectedIds, setSelectedIds] = useState([availableId]);
      return createElement(ParticipantChoices, { label: 'Visit participants', people, selectedIds, requiredSkills: requirements, skills: [assembly], assignedElsewhereIds: [elsewhereId], onChange: (id, selected) => setSelectedIds((current) => selected ? [...current, id] : current.filter((value) => value !== id)) });
    }
    await page.render(createElement(Choices, { people: profiles() }));
    const document = page.dom.window.document;
    const available = document.querySelector('[data-participant-filter="available"]'); assert.ok(available instanceof page.dom.window.HTMLButtonElement); assert.equal(available.getAttribute('aria-pressed'), 'true');
    const list = document.querySelector('.choice-list'); assert.ok(list instanceof page.dom.window.HTMLElement); list.scrollTop = 42;
    await page.render(createElement(Choices, { people: profiles().map((profile) => profile.id === availableId ? { ...profile, busy: true } : profile) }));
    assert.strictEqual(document.querySelector('.choice-list'), list); assert.equal(list.scrollTop, 42);
    assert.strictEqual(document.querySelector('[data-participant-filter="available"]'), available); assert.equal(available.getAttribute('aria-pressed'), 'true');
    assert.equal(available.textContent, 'Available0');
    const selected = document.querySelector(`input[data-participant-id="${availableId}"]`); assert.ok(selected instanceof page.dom.window.HTMLInputElement);
    assert.equal(selected.checked, true); assert.equal(selected.disabled, false); assert.ok(selected.closest('[data-selected-outside-filter]'));
    assert.match(selected.closest('label')?.textContent ?? '', /Busy/);
    await act(async () => { selected.click(); });
    assert.equal(document.querySelector('input[data-participant-id]'), null);
  } finally { await page.close(); }
});
