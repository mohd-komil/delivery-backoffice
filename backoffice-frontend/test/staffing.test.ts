import assert from 'node:assert/strict';
import test from 'node:test';
import { appointmentParticipantsSchema } from '../src/lib/contracts';
import { replaceStaffSelection, staffingAvailabilityProblems, staffingSelectionProblems, type CrewStaffSelection } from '../src/lib/staffing';

const personId = '60000000-0000-4000-8000-000000000001';
const disabled = appointmentParticipantsSchema.parse({ people: [{ id: personId, name: 'DEMO known person', external: false, enabled: false, busy: false, skillIds: [], conflicts: [] }] }).people;

void test('staffing enforces a person per crew and one crew per person without mutating a draft', () => {
  const rows: CrewStaffSelection[] = [{ id: 'crew-a', crewName: 'DEMO A', participantIds: [personId] }, { id: 'crew-b', crewName: 'DEMO B', participantIds: [] }];
  assert.match(staffingSelectionProblems(rows).join(' '), /DEMO B needs at least one/);
  const moved = replaceStaffSelection(replaceStaffSelection(rows, 'crew-a', personId, false), 'crew-b', personId, true);
  assert.deepEqual(rows[0]?.participantIds, [personId]);
  assert.deepEqual(moved[0]?.participantIds, []);
  assert.deepEqual(moved[1]?.participantIds, [personId]);
  const duplicate = replaceStaffSelection(rows, 'crew-b', personId, true);
  assert.match(staffingSelectionProblems(duplicate).join(' '), /more than once/);
  assert.deepEqual(replaceStaffSelection(duplicate, 'crew-b', personId, true), duplicate, 'Checking the same choice twice must not duplicate its identity');
});

void test('disabled people may remain only in the same existing assignment and busy people cannot be retained', () => {
  const original = [{ id: 'assignment-a', crewName: 'DEMO A', participantIds: [personId] }];
  assert.deepEqual(staffingAvailabilityProblems(original, disabled, original), []);
  assert.match(staffingAvailabilityProblems(original, disabled).join(' '), /disabled for new staffing/);
  assert.match(staffingAvailabilityProblems([{ ...original[0], id: 'assignment-b', crewName: 'DEMO B', participantIds: [personId] }], disabled, original).join(' '), /disabled/);
  assert.match(staffingAvailabilityProblems(original, disabled.map((person) => ({ ...person, busy: true })), original).join(' '), /overlapping appointment/);
  assert.match(staffingAvailabilityProblems(original, []).join(' '), /no longer available/);
});

