import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema, type CalendarEntry } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, waitFor } from './refresh-fixtures';

type Page = Awaited<ReturnType<typeof domHarness>>;
const teamA = '81000000-0000-4000-8000-000000000101';
const teamB = '81000000-0000-4000-8000-000000000102';
const unusedTeam = '81000000-0000-4000-8000-000000000103';
function identifier(number: number) { return `81000000-0000-4000-8000-${String(number).padStart(12, '0')}`; }

function entry(number: number, customerName: string, city: string | null, province: string | null, postalCode: string | null, teams: string[], cancelled = false): CalendarEntry {
  return {
    deliveryId: identifier(number + 1000), pickingName: `FILTER/OUT/${number}`, customerName,
    geography: { city, province, postalCode, source: city ? 'odoo' : null },
    appointment: appointmentSchema.parse({ id: identifier(number), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z',
      status: cancelled ? 'cancelled' : 'booked', cancellationReason: cancelled ? 'Test cancellation' : null, returnRequestId: null, results: [],
      assignments: teams.map((crewId, index) => ({ id: identifier(number * 10 + index + 500), crewId,
        crewName: crewId === teamA ? 'Catania Team' : 'Messina Team', people: [], tasks: [] })),
    }),
  };
}

function fixture() {
  const api = new ApiFixture();
  api.calendar = [
    entry(1, 'Mario Rossi', 'Acireale', 'CT', '95024', [teamA]),
    entry(2, 'Mario Bianchi', 'Catania', 'CT', '95100', [teamA]),
    entry(3, 'Mario Rossi', 'Messina', 'ME', '98123', [teamB]),
    entry(4, 'Lucia Greco', 'Messina', 'ME', '98124', [teamB]),
    entry(5, 'Sara Conti', 'Catania', 'CT', '95100', [teamA, teamB]),
    entry(6, 'Unknown destination', null, null, null, []),
    entry(7, 'Cancelled customer', 'Roma', 'RM', '00100', [teamB], true),
  ];
  api.calendarFilterCatalog = {
    destinations: [
      { city: 'Acireale', province: 'CT', postalCode: '95024', count: 3 },
      { city: 'Catania', province: 'CT', postalCode: '95100', count: 7 },
      { city: 'Messina', province: 'ME', postalCode: '98123', count: 8 },
      { city: 'Messina', province: 'ME', postalCode: '98124', count: 4 },
      { city: 'Roma', province: 'RM', postalCode: '00100', count: 1 },
      { city: 'Palermo', province: 'PA', postalCode: '90100', count: 2 },
      { city: null, province: null, postalCode: null, count: 1 },
    ],
    crews: [{ id: teamA, name: 'Catania Team', enabled: true }, { id: teamB, name: 'Messina Team', enabled: true },
      { id: unusedTeam, name: 'Unused archived team', enabled: false }],
  };
  return api;
}

function select(page: Page, label: string) {
  const found = page.dom.window.document.querySelector(`select[aria-label="${label}"]`);
  assert.ok(found instanceof HTMLSelectElement, label);
  return found;
}
async function choose(page: Page, label: string, value: string | null | undefined) {
  const input = select(page, label);
  await act(async () => { input.value = value === undefined ? '' : JSON.stringify(value); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
function customer(page: Page) {
  const input = page.dom.window.document.querySelector('input[type="search"]');
  assert.ok(input instanceof HTMLInputElement);
  return input;
}
function picker(page: Page, mode: 'month' | 'date' = 'month') {
  const input = page.dom.window.document.querySelector(`#calendar-${mode}`);
  assert.ok(input instanceof HTMLInputElement);
  return input;
}
async function ready(page: Page) { await waitFor(() => !button(page.dom.window.document, '↻ Refresh').disabled, 'calendar response'); }
async function render(page: Page) {
  const { Calendar } = await import('../src/components/calendar');
  await page.render(createElement(Calendar, { refreshKey: 0, onOpen: () => undefined }));
  await ready(page);
  await editInput(picker(page), '2026-11');
  await ready(page);
}
function rowNames(page: Page) {
  const table = [...page.dom.window.document.querySelectorAll('table')].find((candidate) => candidate.querySelector('caption')?.textContent === 'Appointments in this view');
  return [...(table?.querySelectorAll('tbody tr td:first-child') ?? [])].map((cell) => cell.textContent);
}
function gridNames(page: Page) {
  return [...page.dom.window.document.querySelectorAll('.calendar-month-event strong, .calendar-event strong')].map((node) => node.textContent);
}

void test('Calendar combines all five filters, fills sole destinations in both directions and hides cancelled visits', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await render(page);
    assert.equal(rowNames(page).length, 6);
    assert.ok([...select(page, 'City').options].some((option) => option.textContent?.includes('Roma')));
    assert.ok(!rowNames(page).includes('FILTER/OUT/7'), 'A known catalog destination does not reveal a cancelled appointment');
    assert.equal(select(page, 'City').value, '', 'Initial load never narrows the calendar automatically');
    await choose(page, 'City', 'Acireale');
    assert.equal(select(page, 'Province').value, JSON.stringify('CT'));
    assert.equal(select(page, 'Postal code (CAP)').value, JSON.stringify('95024'));
    assert.deepEqual(rowNames(page), ['FILTER/OUT/1']); assert.deepEqual(gridNames(page), ['FILTER/OUT/1']);
    assert.ok(page.container.textContent?.includes('1 of 6 appointments'));

    await click(button(page.container, 'Clear filters'));
    await choose(page, 'Postal code (CAP)', '98124');
    assert.equal(select(page, 'City').value, JSON.stringify('Messina'));
    assert.equal(select(page, 'Province').value, JSON.stringify('ME'));
    assert.deepEqual(rowNames(page), ['FILTER/OUT/4']); assert.deepEqual(gridNames(page), ['FILTER/OUT/4']);

    await click(button(page.container, 'Clear filters'));
    await choose(page, 'Team', teamA);
    await editInput(customer(page), ' MÁRIO ');
    assert.deepEqual(rowNames(page), ['FILTER/OUT/1', 'FILTER/OUT/2']);
    await choose(page, 'City', 'Catania');
    assert.deepEqual(rowNames(page), ['FILTER/OUT/2']); assert.deepEqual(gridNames(page), ['FILTER/OUT/2']);
    assert.ok(![...select(page, 'Province').options].some((option) => option.value === JSON.stringify('ME')));

    await click(button(page.container, 'Clear filters'));
    await choose(page, 'City', null); await choose(page, 'Team', null);
    assert.deepEqual(rowNames(page), ['FILTER/OUT/6']); assert.deepEqual(gridNames(page), ['FILTER/OUT/6']);
    assert.equal(select(page, 'Province').value, '', 'Unknown data is not silently selected');
    assert.ok(api.calls.every((call) => call.method === 'GET'));
  } finally { await page.close(); }
});

void test('Calendar preserves filters, drafts and scroll on Refresh/failure and across Day Week Month changes', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await render(page);
    await choose(page, 'Team', teamB); await choose(page, 'City', 'Messina'); await editInput(customer(page), 'Rossi');
    const input = customer(page); const originalMonth = picker(page).value;
    const scroll = page.container.querySelector('.calendar-month-scroll'); assert.ok(scroll instanceof HTMLElement);
    scroll.scrollLeft = 200; scroll.scrollTop = 95; input.focus();
    const assertRetained = () => {
      assert.ok(customer(page) === input); assert.equal(input.value, 'Rossi'); assert.ok(page.dom.window.document.activeElement === input);
      assert.equal(picker(page).value, originalMonth); assert.equal(select(page, 'Team').value, JSON.stringify(teamB));
      assert.equal(select(page, 'City').value, JSON.stringify('Messina')); assert.equal(scroll.scrollLeft, 200); assert.equal(scroll.scrollTop, 95);
      assert.deepEqual(rowNames(page), ['FILTER/OUT/3']);
    };
    const pending = api.defer('/calendar'); await click(button(page.container, '↻ Refresh')); assertRetained();
    await act(async () => { pending.reply(api.calendar); }); await ready(page); assertRetained();
    const failed = api.defer('/calendar'); await click(button(page.container, '↻ Refresh'));
    await act(async () => { failed.reply({ message: 'Calendar unavailable in test' }, 503); }); await ready(page); assertRetained();
    await click(button(page.container, 'Retry')); await ready(page); assertRetained();

    const day = page.container.querySelector('button[aria-label="View 2026-11-03 in Day mode"]'); assert.ok(day instanceof HTMLButtonElement);
    await click(day); await ready(page); assert.equal(button(page.container, 'Day').getAttribute('aria-pressed'), 'true');
    assert.equal(customer(page).value, 'Rossi'); assert.deepEqual(rowNames(page), ['FILTER/OUT/3']); assert.deepEqual(gridNames(page), ['FILTER/OUT/3']);
    await click(button(page.container, 'Week')); await ready(page); assert.equal(select(page, 'Team').value, JSON.stringify(teamB));
    assert.deepEqual(rowNames(page), ['FILTER/OUT/3']); assert.deepEqual(gridNames(page), ['FILTER/OUT/3']);
    await click(button(page.container, 'Month')); await ready(page);
    await click(button(page.container, 'Next month')); await ready(page);
    assert.equal(select(page, 'City').value, JSON.stringify('Messina')); assert.equal(customer(page).value, 'Rossi');
    assert.ok(page.container.textContent?.includes('No appointments match these filters'));
    assert.equal(select(page, 'Team').selectedOptions[0]?.textContent, 'Messina Team');
    await click(button(page.container, 'Previous month')); await ready(page); assert.deepEqual(rowNames(page), ['FILTER/OUT/3']);
  } finally { await page.close(); }
});

void test('Calendar table resets pagination when filters change and clear restores the period', { concurrency: false }, async () => {
  const api = fixture();
  api.calendar = Array.from({ length: 12 }, (_, index) => entry(index + 1, index === 11 ? 'Unique customer' : 'Other customer', 'Catania', 'CT', '95100', [teamA]));
  const page = await domHarness(api);
  try {
    await render(page); assert.equal(rowNames(page).length, 10);
    const next = page.container.querySelector('button[aria-label="Next page"]'); assert.ok(next instanceof HTMLButtonElement);
    await click(next); assert.deepEqual(rowNames(page), ['FILTER/OUT/11', 'FILTER/OUT/12']);
    await editInput(customer(page), 'Unique'); assert.deepEqual(rowNames(page), ['FILTER/OUT/12']);
    assert.ok(page.container.textContent?.includes('Page 1 of 1'));
    await click(button(page.container, 'Clear filters')); assert.equal(customer(page).value, '');
    assert.equal(rowNames(page).length, 10); assert.equal(rowNames(page)[0], 'FILTER/OUT/1');
    assert.ok(page.container.textContent?.includes('Page 1 of 2'));
  } finally { await page.close(); }
});

void test('Calendar does not autofill geography from a stale catalog while loading or after a failed catalog refresh', { concurrency: false }, async () => {
  const api = fixture(); const page = await domHarness(api);
  try {
    await render(page);
    const pending = api.defer('/calendar/filter-options');
    await click(button(page.container, '↻ Refresh'));
    await choose(page, 'City', 'Acireale');
    assert.equal(select(page, 'City').value, JSON.stringify('Acireale'));
    assert.equal(select(page, 'Province').value, '');
    assert.equal(select(page, 'Postal code (CAP)').value, '', 'The sole old CAP is not evidence about the pending result');
    assert.ok(api.calendarFilterCatalog);
    api.calendarFilterCatalog.destinations.push({ city: 'Acireale', province: 'CT', postalCode: '95025', count: 2 });
    await act(async () => { pending.reply(api.calendarFilterCatalog); }); await ready(page);
    assert.equal(select(page, 'City').value, JSON.stringify('Acireale'));
    assert.equal(select(page, 'Province').value, ''); assert.equal(select(page, 'Postal code (CAP)').value, '');
    assert.deepEqual(rowNames(page), ['FILTER/OUT/1']);
    await choose(page, 'City', 'Acireale');
    assert.equal(select(page, 'Province').value, JSON.stringify('CT'), 'A new explicit choice can use the successful response');
    assert.equal(select(page, 'Postal code (CAP)').value, '', 'Two current CAP choices remain unselected');

    await click(button(page.container, 'Clear filters'));
    const failed = api.defer('/calendar/filter-options'); await click(button(page.container, '↻ Refresh'));
    await act(async () => { failed.reply({ message: 'Calendar unavailable in test' }, 503); }); await ready(page);
    await choose(page, 'City', 'Catania');
    assert.equal(select(page, 'City').value, JSON.stringify('Catania'));
    assert.equal(select(page, 'Province').value, ''); assert.equal(select(page, 'Postal code (CAP)').value, '');
    await click(button(page.container, 'Retry filter lists')); await ready(page);
    assert.equal(select(page, 'Province').value, ''); assert.equal(select(page, 'Postal code (CAP)').value, '');
    await choose(page, 'City', 'Catania');
    assert.equal(select(page, 'Province').value, JSON.stringify('CT')); assert.equal(select(page, 'Postal code (CAP)').value, JSON.stringify('95100'));
  } finally { await page.close(); }
});

void test('Calendar filter lists use the global catalog even with no visits or matching customer in the period', { concurrency: false }, async () => {
  const api = fixture(); api.calendar = [];
  const page = await domHarness(api);
  try {
    await render(page);
    const hasOption = (label: string, value: string) => [...select(page, label).options].some((option) => option.value === JSON.stringify(value));
    assert.ok(hasOption('City', 'Palermo')); assert.ok(hasOption('Province', 'PA')); assert.ok(hasOption('Postal code (CAP)', '90100'));
    const archived = [...select(page, 'Team').options].find((option) => option.value === JSON.stringify(unusedTeam));
    assert.ok(archived); assert.equal(archived.disabled, false, 'A historical team remains usable as a filter');
    await choose(page, 'Team', unusedTeam); await editInput(customer(page), 'Nobody matches');
    assert.ok(hasOption('City', 'Palermo')); assert.ok(hasOption('Province', 'PA')); assert.ok(hasOption('Postal code (CAP)', '90100'));
    assert.ok(hasOption('Team', teamA)); assert.ok(hasOption('Team', teamB));
    await choose(page, 'City', 'Palermo');
    assert.equal(select(page, 'Province').value, JSON.stringify('PA')); assert.equal(select(page, 'Postal code (CAP)').value, JSON.stringify('90100'));
    assert.ok(page.container.textContent?.includes('No appointments match these filters'));
    const catalogCalls = api.calls.filter((call) => call.pathname === '/calendar/filter-options').length;
    await click(button(page.container, 'Next month')); await ready(page);
    assert.equal(select(page, 'City').value, JSON.stringify('Palermo')); assert.equal(select(page, 'Team').value, JSON.stringify(unusedTeam));
    assert.equal(api.calls.filter((call) => call.pathname === '/calendar/filter-options').length, catalogCalls, 'Period navigation does not narrow or refetch the global catalog');
    await click(button(page.container, 'Clear filters'));
    assert.ok(hasOption('City', 'Messina')); assert.ok(hasOption('City', 'Palermo')); assert.ok(hasOption('Team', unusedTeam));
  } finally { await page.close(); }
});

void test('An unavailable global catalog is explicit and never replaced by period-only filter choices', { concurrency: false }, async () => {
  const api = fixture(); const pending = api.defer('/calendar/filter-options'); const page = await domHarness(api);
  try {
    const { Calendar } = await import('../src/components/calendar');
    await page.render(createElement(Calendar, { refreshKey: 0, onOpen: () => undefined }));
    assert.equal(select(page, 'City').disabled, true);
    await act(async () => { pending.reply({ message: 'Catalog unavailable in test' }, 503); }); await ready(page);
    assert.equal(select(page, 'City').disabled, true); assert.equal(select(page, 'Team').disabled, true);
    assert.equal(select(page, 'City').options.length, 1, 'Loaded visits cannot impersonate the complete destination catalog');
    assert.ok(page.container.textContent?.includes('Filter lists could not be updated'));
    await click(button(page.container, 'Retry filter lists')); await ready(page);
    assert.equal(select(page, 'City').disabled, false);
    assert.ok([...select(page, 'City').options].some((option) => option.value === JSON.stringify('Palermo')));
  } finally { await page.close(); }
});
