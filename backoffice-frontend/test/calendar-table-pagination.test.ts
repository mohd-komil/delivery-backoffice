import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { appointmentSchema, type CalendarEntry } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, waitFor } from './refresh-fixtures';

type Page = Awaited<ReturnType<typeof domHarness>>;

function identifier(value: number) {
  return `85000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function entry(index: number, crews = 1, status: 'booked' | 'cancelled' | 'completed' = 'booked'): CalendarEntry {
  return {
    deliveryId: identifier(index), pickingName: `DEMO/PAGE/${index}`, customerName: `Synthetic customer ${index}`,
    appointment: appointmentSchema.parse({
      id: identifier(100 + index), startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T09:00:00Z', status,
      cancellationReason: status === 'cancelled' ? 'Synthetic cancelled appointment' : null, returnRequestId: null, results: [],
      assignments: Array.from({ length: crews }, (_, position) => ({
        id: identifier(1000 + index * 10 + position), crewId: identifier(2000 + index * 10 + position),
        crewName: `Synthetic crew ${index}.${position + 1}`, people: [], tasks: [],
      })),
    }),
  };
}

function input(page: Page, selector: string) {
  const node = page.dom.window.document.querySelector(selector);
  assert.ok(node instanceof page.dom.window.HTMLInputElement);
  return node;
}

function nextPage(page: Page) {
  const node = page.dom.window.document.querySelector('button[aria-label="Next page"]');
  assert.ok(node instanceof page.dom.window.HTMLButtonElement);
  return node;
}

function rows(page: Page, selector: string) {
  return Array.from(page.dom.window.document.querySelectorAll(`${selector} tbody tr`));
}

void test('Calendar paginates its appointments list while retaining all calendar visits and the current page on Refresh', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.calendar = [...Array.from({ length: 21 }, (_, index) => entry(index + 1)), entry(22, 1, 'cancelled')];
  const page = await domHarness(api);
  try {
    const { Calendar } = await import('../src/components/calendar');
    const opened: string[] = [];
    await page.render(createElement(Calendar, { refreshKey: 0, onOpen: (id) => { opened.push(id); } }));
    const document = page.dom.window.document;
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'initial calendar load');
    await editInput(input(page, '#calendar-month'), '2026-11');
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'November calendar load');
    const tableSelector = '.section-gap table';
    assert.equal(rows(page, tableSelector).length, 10);
    assert.equal(document.querySelector('.section-title .badge')?.textContent, '21');
    const monthCell = document.querySelector('.calendar-month td[data-date="2026-11-10"]');
    assert.ok(monthCell);
    assert.equal(monthCell.querySelectorAll('.calendar-month-event').length, 3);
    assert.match(monthCell.textContent ?? '', /\+18 more/);
    assert.doesNotMatch(document.querySelector('.section-gap')?.textContent ?? '', /DEMO\/PAGE\/22/);

    await click(nextPage(page));
    const pageTwoRows = rows(page, tableSelector);
    assert.equal(pageTwoRows.length, 10);
    assert.match(pageTwoRows[0]?.textContent ?? '', /DEMO\/PAGE\/11/);
    assert.match(pageTwoRows[9]?.textContent ?? '', /DEMO\/PAGE\/20/);
    const firstButton = pageTwoRows[0]?.querySelector('button');
    assert.ok(firstButton instanceof page.dom.window.HTMLButtonElement);
    await click(firstButton);
    assert.deepEqual(opened, [identifier(11)]);

    const table = document.querySelector(tableSelector);
    const scroll = table?.parentElement;
    assert.ok(scroll instanceof page.dom.window.HTMLElement);
    scroll.scrollLeft = 190;
    const pending = api.defer('/calendar');
    await click(button(document, '↻ Refresh'));
    assert.equal(document.querySelector(tableSelector), table);
    assert.equal(rows(page, tableSelector)[0], pageTwoRows[0]);
    assert.equal(scroll.scrollLeft, 190);
    await act(async () => { pending.reply(api.calendar); });
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'calendar page refresh');
    assert.equal(rows(page, tableSelector)[0], pageTwoRows[0]);
    assert.equal(scroll.scrollLeft, 190);

    await click(nextPage(page));
    assert.equal(rows(page, tableSelector).length, 1);
    assert.match(rows(page, tableSelector)[0]?.textContent ?? '', /DEMO\/PAGE\/21/);
    assert.equal(nextPage(page).disabled, true);
    await click(button(document, 'Day'));
    await editInput(input(page, '#calendar-date'), '2026-11-10');
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'day calendar load');
    assert.equal(rows(page, tableSelector).length, 10);
    assert.equal(rows(page, tableSelector)[0]?.querySelector('button')?.textContent, 'DEMO/PAGE/1');
    assert.equal(document.querySelectorAll('.calendar-grid .calendar-event').length, 21);
  } finally { await page.close(); }
});

void test('Visit staffing paginates flattened crew rows, preserves its page on Refresh and resets after a date change', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.calendar = [...Array.from({ length: 6 }, (_, index) => entry(index + 1, 2)), entry(7, 0), entry(8, 1, 'completed'), entry(9, 1, 'cancelled')];
  const page = await domHarness(api);
  try {
    const { Staffing } = await import('../src/components/staffing');
    const opened: string[] = [];
    await page.render(createElement(Staffing, { onOpen: (id) => { opened.push(id); } }));
    const document = page.dom.window.document;
    await waitFor(() => !button(document, '↻ Refresh staffing').disabled, 'staffing load');
    await editInput(input(page, '#staffing-date'), '2026-11-10');
    await waitFor(() => !button(document, '↻ Refresh staffing').disabled, 'selected date load');
    assert.equal(rows(page, '.staffing-table').length, 10, 'Ten assignment rows, rather than ten appointments');
    assert.match(rows(page, '.staffing-table')[9]?.textContent ?? '', /Synthetic crew 5\.2/);
    await click(nextPage(page));
    const secondPageRows = rows(page, '.staffing-table');
    assert.equal(secondPageRows.length, 3);
    assert.match(secondPageRows[0]?.textContent ?? '', /Synthetic crew 6\.1/);
    assert.match(secondPageRows[1]?.textContent ?? '', /Synthetic crew 6\.2/);
    assert.match(secondPageRows[2]?.textContent ?? '', /DEMO\/PAGE\/7/);
    assert.doesNotMatch(document.querySelector('.staffing-table')?.textContent ?? '', /DEMO\/PAGE\/[89]/);
    assert.equal(nextPage(page).disabled, true);
    const noCrewRow = secondPageRows[2];
    assert.ok(noCrewRow);
    await click(button(noCrewRow, 'Open delivery'));
    assert.deepEqual(opened, [identifier(7)]);

    const table = document.querySelector('.staffing-table');
    const scroll = document.querySelector('.staffing-table-region');
    assert.ok(scroll instanceof page.dom.window.HTMLElement);
    scroll.scrollLeft = 220;
    const pending = api.defer('/calendar');
    await click(button(document, '↻ Refresh staffing'));
    assert.equal(document.querySelector('.staffing-table'), table);
    assert.equal(rows(page, '.staffing-table')[0], secondPageRows[0]);
    await act(async () => { pending.reply(api.calendar); });
    await waitFor(() => !button(document, '↻ Refresh staffing').disabled, 'staffing page refresh');
    assert.equal(rows(page, '.staffing-table')[0], secondPageRows[0]);
    assert.equal(scroll.scrollLeft, 220);
    assert.equal(input(page, '#staffing-date').value, '2026-11-10');

    await editInput(input(page, '#staffing-date'), '2026-11-11');
    await waitFor(() => !button(document, '↻ Refresh staffing').disabled, 'changed staffing date load');
    assert.equal(rows(page, '.staffing-table').length, 10);
    assert.match(rows(page, '.staffing-table')[0]?.textContent ?? '', /Synthetic crew 1\.1/);
    assert.ok(api.calls.every((call) => call.method === 'GET'));
  } finally { await page.close(); }
});
