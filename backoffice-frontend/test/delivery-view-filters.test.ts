import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { deliveryListSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, listFixture, waitFor } from './refresh-fixtures';

const crewId = '15000000-0000-4000-8000-000000000001';
const teamChoices = [{ id: crewId, name: 'DEMO North crew', count: 21 }];
const geography = {
  cities: [{ value: 'Catania', count: 21 }],
  provinces: [{ value: 'CT', count: 21 }],
  postalCodes: [{ value: '00100', count: 21 }],
};

function filteredList(name: string, page = 1) {
  return deliveryListSchema.parse({
    ...listFixture(name),
    page, total: 21,
    geographyFacets: geography,
    filterFacets: {
      crews: teamChoices,
      issueTypes: [{ value: 'damage', count: 3 }],
      returnStatuses: [{ value: 'planned', count: 4 }],
    },
  });
}

function labelledField(document: Document, label: string) {
  return Array.from(document.querySelectorAll('label')).find((field) => field.firstElementChild?.textContent === label);
}

function filterChip(document: Document, name: string) {
  return Array.from(document.querySelectorAll('button[aria-label]')).find((control) => control.getAttribute('aria-label') === name);
}

function viewButton(document: Document, label: string) {
  const control = Array.from(document.querySelectorAll('nav[aria-label="Delivery views"] button'))
    .find((candidate) => candidate.textContent?.includes(label));
  assert.ok(control instanceof HTMLButtonElement);
  return control;
}

void test('operational filters send server criteria before pagination and retain local search drafts across refresh', async () => {
  const api = new ApiFixture();
  api.list = filteredList('DEMO/ASSIGNED');
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    const readRows = () => {
      const table = document.querySelector('.delivery-table');
      return table?.closest('[hidden]') ? '' : table?.textContent ?? '';
    };
    await waitFor(() => document.querySelector('nav[aria-label="Delivery views"]') !== null, 'delivery navigation');
    await click(viewButton(document, 'Assigned'));
    await waitFor(() => readRows().includes('DEMO/ASSIGNED'), 'assigned results');
    const search = labelledField(document, 'Customer, order or Picking')?.querySelector('input');
    const team = labelledField(document, 'Team')?.querySelector('select');
    assert.ok(search instanceof HTMLInputElement);
    assert.ok(team instanceof HTMLSelectElement);
    assert.equal(labelledField(document, 'Issue type'), undefined);
    assert.equal(labelledField(document, 'Return visit status'), undefined);
    assert.match(team.textContent ?? '', /DEMO North crew \(21\)/u);

    const unfilteredPageTwo = api.defer('/deliveries', 'GET', '?view=assigned&page=2');
    unfilteredPageTwo.reply(filteredList('DEMO/SECOND-PAGE', 2));
    await click(button(document, 'Next'));
    await waitFor(() => readRows().includes('DEMO/SECOND-PAGE'), 'second assigned page');

    const teamQuery = `?view=assigned&page=1&crewId=${crewId}`;
    const teamRequest = api.defer('/deliveries', 'GET', teamQuery);
    teamRequest.reply(filteredList('DEMO/TEAM'));
    await act(async () => { team.value = crewId; team.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => teamRequest.called && readRows().includes('DEMO/TEAM'), 'team returns to page one');

    const searchQuery = `&search=SO%2F2026&crewId=${crewId}`;
    const searchRequest = api.defer('/deliveries', 'GET', `?view=assigned&page=1${searchQuery}`);
    searchRequest.reply(filteredList('DEMO/SEARCH'));
    await editInput(search, ' SO/2026 ');
    await click(button(document, 'Search'));
    await waitFor(() => searchRequest.called && readRows().includes('DEMO/SEARCH'), 'combined search and team');

    const pageTwoQuery = `?view=assigned&page=2${searchQuery}`;
    const filteredPageTwo = api.defer('/deliveries', 'GET', pageTwoQuery);
    filteredPageTwo.reply(filteredList('DEMO/SEARCH-PAGE2', 2));
    await click(button(document, 'Next'));
    await waitFor(() => filteredPageTwo.called && readRows().includes('DEMO/SEARCH-PAGE2'), 'filtered page two');
    await editInput(search, 'unsent draft');
    const refresh = api.defer('/deliveries', 'GET', pageTwoQuery);
    refresh.reply(filteredList('DEMO/AFTER-REFRESH', 2));
    await click(button(document, '↻ Refresh'));
    await waitFor(() => refresh.called && readRows().includes('DEMO/AFTER-REFRESH'), 'refresh with applied criteria');
    assert.equal(search.value, 'unsent draft');

    await click(viewButton(document, 'Issues'));
    await waitFor(() => api.calls.some(({ search: query }) => query === '?view=issues&page=1'), 'new view independent filters');
    const issue = labelledField(document, 'Issue type')?.querySelector('select');
    assert.ok(issue instanceof HTMLSelectElement);
    await waitFor(() => !issue.disabled, 'issue facets');
    const issueRequest = api.defer('/deliveries', 'GET', '?view=issues&page=1&issueType=damage');
    issueRequest.reply(filteredList('DEMO/DAMAGE'));
    await act(async () => { issue.value = 'damage'; issue.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => issueRequest.called && readRows().includes('DEMO/DAMAGE'), 'issue type');

    await click(viewButton(document, 'Assigned'));
    await waitFor(() => api.calls.filter(({ search: query }) => query === `?view=assigned&page=1${searchQuery}`).length === 2, 'return to applied filters');
    const clear = api.defer('/deliveries', 'GET', '?view=assigned&page=1');
    clear.reply(filteredList('DEMO/CLEARED'));
    await click(button(document, 'Clear filters'));
    await waitFor(() => clear.called && readRows().includes('DEMO/CLEARED'), 'clear all filters');

    await click(viewButton(document, 'Planned'));
    assert.equal(labelledField(document, 'Team'), undefined);
    await click(button(document, 'More filters'));
    assert.ok(document.querySelector('button[aria-label="Visit date from"]'));
    await click(viewButton(document, 'Return visit required'));
    assert.ok(labelledField(document, 'Return visit status'));
    assert.equal(labelledField(document, 'Issue type'), undefined);
    await click(viewButton(document, 'Completed'));
    await click(button(document, 'More filters'));
    assert.ok(document.querySelector('button[aria-label="Completion date from"]'));
    assert.equal(labelledField(document, 'Return visit status'), undefined);
  } finally { await page.close(); }
});

void test('applied filter chips clear one criterion at a time while keeping the search draft and open filters', async () => {
  const api = new ApiFixture();
  api.list = filteredList('DEMO/ASSIGNED');
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('nav[aria-label="Delivery views"]') !== null, 'delivery navigation');
    await click(viewButton(document, 'Assigned'));

    const search = labelledField(document, 'Customer, order or Picking')?.querySelector('input');
    const team = labelledField(document, 'Team')?.querySelector('select');
    assert.ok(search instanceof HTMLInputElement);
    assert.ok(team instanceof HTMLSelectElement);
    await waitFor(() => !team.disabled, 'team choices');
    await act(async () => { team.value = crewId; team.dispatchEvent(new Event('change', { bubbles: true })); });
    await editInput(search, 'SO/2026');
    await click(button(document, 'Search'));

    const disclosure = button(document, 'More filters');
    const advanced = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
    assert.ok(advanced instanceof HTMLElement);
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(advanced.hidden, true);
    await click(disclosure);
    assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(advanced.hidden, false);
    const city = labelledField(document, 'City')?.querySelector('select');
    assert.ok(city instanceof HTMLSelectElement);
    await waitFor(() => !city.disabled, 'city choices');

    const applied = `?view=assigned&page=1&search=SO%2F2026&crewId=${crewId}`;
    const chosenCity = api.defer('/deliveries', 'GET', `${applied}&city=Catania`);
    chosenCity.reply({ ...api.list, matchingGeographyFacets: geography });
    const chosenLocation = `${applied}&city=Catania&province=CT&postalCode=00100`;
    await act(async () => { city.value = JSON.stringify('Catania'); city.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => api.calls.some(({ search: query }) => query === chosenLocation), 'auto-selected province and postal code');
    await editInput(search, 'unsent draft');

    const locationName = 'Remove Location: Catania, CT, 00100';
    const locationChip = filterChip(document, locationName);
    assert.ok(locationChip instanceof HTMLButtonElement);
    const teamChip = filterChip(document, 'Remove Team: DEMO North crew');
    assert.ok(teamChip instanceof HTMLButtonElement);
    const clearLocation = api.defer('/deliveries', 'GET', applied);
    clearLocation.reply({ ...api.list, matchingGeographyFacets: geography });
    locationChip.focus();
    await click(locationChip);
    await waitFor(() => clearLocation.called && !button(document, '↻ Refresh').disabled, 'results without location');
    assert.equal(filterChip(document, locationName), undefined);
    assert.equal(city.value, '');
    assert.equal(labelledField(document, 'Province')?.querySelector('select')?.value, '');
    assert.equal(labelledField(document, 'Postal code (CAP)')?.querySelector('select')?.value, '');
    assert.equal(search.value, 'unsent draft');
    assert.equal(document.activeElement, teamChip);

    const searchChip = filterChip(document, 'Remove Customer, order or Picking: SO/2026');
    assert.ok(searchChip instanceof HTMLButtonElement);
    const teamOnly = `?view=assigned&page=1&crewId=${crewId}`;
    const clearSearch = api.defer('/deliveries', 'GET', teamOnly);
    clearSearch.reply(api.list);
    await click(searchChip);
    await waitFor(() => clearSearch.called, 'team retained without applied search');
    assert.equal(search.value, 'unsent draft');

    const refresh = api.defer('/deliveries', 'GET', teamOnly);
    refresh.reply(api.list);
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'updated team results');
    await click(button(document, '↻ Refresh'));
    await waitFor(() => refresh.called, 'refresh using remaining filter');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(search.value, 'unsent draft');
    assert.equal(filterChip(document, 'Remove Team: DEMO North crew'), teamChip);
  } finally { await page.close(); }
});

void test('an empty operational view keeps catalogue choices selectable and completes compatible geography', async () => {
  const api = new ApiFixture();
  const empty = deliveryListSchema.parse({
    ...filteredList('DEMO/ASSIGNED'), items: [], total: 0,
    geographyFacets: {
      cities: [{ value: 'Catania', count: 0 }, { value: 'Messina', count: 0 }],
      provinces: [{ value: 'CT', count: 0 }, { value: 'ME', count: 0 }],
      postalCodes: [{ value: '00100', count: 0 }, { value: '98121', count: 0 }],
    },
    filterFacets: { crews: [{ id: crewId, name: 'DEMO North crew', count: 0 }], issueTypes: [], returnStatuses: [] },
  });
  api.list = empty;
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('nav[aria-label="Delivery views"]') !== null, 'delivery navigation');
    await click(viewButton(document, 'Assigned'));
    await click(button(document, 'More filters'));
    function control(label: string) {
      const select = labelledField(document, label)?.querySelector('select');
      assert.ok(select instanceof HTMLSelectElement);
      return select;
    }
    const team = control('Team');
    const city = control('City');
    const province = control('Province');
    const postalCode = control('Postal code (CAP)');
    await waitFor(() => !team.disabled && !city.disabled && !province.disabled && !postalCode.disabled, 'catalogue loaded on empty Assigned');
    assert.match(team.textContent ?? '', /DEMO North crew \(0\)/u);
    assert.match(city.textContent ?? '', /Catania \(0\)/u);
    assert.match(province.textContent ?? '', /ME \(0\)/u);
    assert.match(postalCode.textContent ?? '', /98121 \(0\)/u);

    const assigned = `?view=assigned&page=1&crewId=${crewId}`;
    const teamRequest = api.defer('/deliveries', 'GET', assigned);
    teamRequest.reply(empty);
    await act(async () => { team.value = crewId; team.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => teamRequest.called && !city.disabled, 'team filter applied without a matching row');

    const cityRequest = api.defer('/deliveries', 'GET', `${assigned}&city=Catania`);
    const cataniaList = {
      ...empty,
      geographyFacets: { cities: empty.geographyFacets?.cities ?? [], provinces: [{ value: 'CT', count: 0 }], postalCodes: [{ value: '00100', count: 0 }] },
      matchingGeographyFacets: geography,
    };
    cityRequest.reply(cataniaList);
    const locationRequest = api.defer('/deliveries', 'GET', `${assigned}&city=Catania&province=CT&postalCode=00100`);
    locationRequest.reply(cataniaList);
    await act(async () => { city.value = JSON.stringify('Catania'); city.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => locationRequest.called && !postalCode.disabled, 'geography completes from the catalogue despite zero matches');
    assert.equal(province.value, JSON.stringify('CT'));
    assert.equal(postalCode.value, JSON.stringify('00100'));
    assert.doesNotMatch(province.textContent ?? '', /ME \(0\)/u);
    assert.equal(document.querySelector('table.delivery-table tbody tr'), null);
  } finally { await page.close(); }
});
