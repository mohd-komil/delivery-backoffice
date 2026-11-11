import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { participantCalendarSchema } from '../src/lib/contracts';
import { monthApiFixture, monthParticipantId, monthParticipantPath } from './calendar-month-fixtures';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, waitFor } from './refresh-fixtures';

type CalendarKind = 'main' | 'participant';
type Page = Awaited<ReturnType<typeof domHarness>>;

function settings(kind: CalendarKind) {
  return kind === 'main'
    ? { path: '/calendar', prefix: 'calendar', refresh: '↻ Refresh', retry: 'Retry' }
    : { path: monthParticipantPath, prefix: 'participant-calendar', refresh: '↻ Refresh calendar', retry: 'Retry calendar' };
}

async function renderCalendar(page: Page, kind: CalendarKind, onOpen: (id: string) => void) {
  if (kind === 'main') {
    const { Calendar } = await import('../src/components/calendar');
    await page.render(createElement(Calendar, { refreshKey: 0, onOpen }));
  } else {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId: monthParticipantId, refreshKey: 0, onOpen }));
  }
  await ready(page, kind);
}

async function ready(page: Page, kind: CalendarKind) {
  await waitFor(() => !button(page.dom.window.document, settings(kind).refresh).disabled, `${kind} calendar response`);
}

function picker(page: Page, kind: CalendarKind, mode: 'month' | 'date' = 'month') {
  const input = page.dom.window.document.querySelector(`#${settings(kind).prefix}-${mode}`);
  assert.ok(input instanceof page.dom.window.HTMLInputElement);
  return input;
}

async function chooseMonth(page: Page, kind: CalendarKind, month: string) {
  await editInput(picker(page, kind), month);
  await ready(page, kind);
}

function cell(page: Page, date: string) {
  const result = page.dom.window.document.querySelector(`.calendar-month td[data-date="${date}"]`);
  assert.ok(result, `Month cell ${date} is present`);
  return result;
}

function labelledButton(page: Page, label: string) {
  const result = Array.from(page.dom.window.document.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === label);
  assert.ok(result, `Button ${label} is present`);
  return result;
}

function response(api: ApiFixture, kind: CalendarKind): unknown {
  return kind === 'main' ? api.calendar : api.participantCalendars.get(monthParticipantPath);
}

for (const kind of ['main', 'participant'] as const) {
  void test(`${kind} opens in Month view and navigates months, actual visits and complete selected days`, { concurrency: false }, async () => {
    const api = monthApiFixture(); const page = await domHarness(api); const opened: string[] = [];
    try {
      await renderCalendar(page, kind, (id) => { opened.push(id); }); const document = page.dom.window.document;
      await ready(page, kind);
      assert.equal(button(document, 'Month').getAttribute('aria-pressed'), 'true');
      const todayMonth = picker(page, kind).value;
      await chooseMonth(page, kind, '2026-11');
      assert.equal(picker(page, kind).type, 'month');
      assert.equal(document.querySelector('.calendar-period-label')?.textContent, 'November 2026');
      assert.deepEqual(Array.from(document.querySelectorAll('.calendar-month thead th')).map((node) => node.textContent), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
      assert.equal(document.querySelectorAll('.calendar-month td[data-date]').length, 42);
      assert.equal(document.querySelector('.calendar-month td[data-date]')?.getAttribute('data-date'), '2026-10-26');
      assert.equal(Array.from(document.querySelectorAll('.calendar-month td[data-date]')).at(-1)?.getAttribute('data-date'), '2026-12-06');
      const call = api.calls.filter((candidate) => candidate.pathname === settings(kind).path).at(-1); assert.ok(call);
      const query = new URLSearchParams(call.search);
      assert.deepEqual({ from: query.get('from'), to: query.get('to') }, { from: '2026-10-25T23:00:00.000Z', to: '2026-12-06T23:00:00.000Z' });
      const event = Array.from(cell(page, '2026-11-03').querySelectorAll('.calendar-month-event')).find((candidate) => candidate.querySelector('strong')?.textContent === 'DEMO/OUT/MONTH');
      assert.ok(event instanceof page.dom.window.HTMLButtonElement);
      assert.equal(event.querySelector('.calendar-event-time')?.textContent, '09:00–11:30');
      assert.match(event.textContent ?? '', /Saved Catania crew/);
      assert.match(event.textContent ?? '', /Saved assembly task/);
      assert.match(event.title, /09:00.*UTC\+01:00.*11:30.*UTC\+01:00/);
      await click(event); assert.deepEqual(opened, [deliveryId]);
      assert.match(cell(page, '2026-11-02').textContent ?? '', /MIDNIGHT-END/);
      assert.doesNotMatch(cell(page, '2026-11-03').textContent ?? '', /MIDNIGHT-END/, 'An exclusive midnight end must not occupy the next day');
      assert.match(cell(page, '2026-11-04').textContent ?? '', /CROSSES-MIDNIGHT/);
      assert.match(cell(page, '2026-12-01').textContent ?? '', /DEMO\/OUT\/ADJACENT/);
      assert.doesNotMatch(cell(page, '2026-11-05').textContent ?? '', /CANCELLED-MONTH/);
      assert.equal(cell(page, '2026-11-03').querySelectorAll('.calendar-month-event').length, 3);
      assert.equal(labelledButton(page, 'Show all visits on 2026-11-03').textContent, '+2 more');

      await click(labelledButton(page, 'View 2026-11-02 in Day mode')); await ready(page, kind);
      assert.equal(button(document, 'Day').getAttribute('aria-pressed'), 'true'); assert.equal(picker(page, kind, 'date').value, '2026-11-02');
      assert.equal(document.querySelector('.calendar-month'), null); assert.ok(document.querySelector('.calendar-grid'));
      await click(button(document, 'Month')); await ready(page, kind);
      await click(labelledButton(page, 'Show all visits on 2026-11-03')); await ready(page, kind);
      assert.equal(picker(page, kind, 'date').value, '2026-11-03');
      assert.equal(document.querySelectorAll('.calendar-grid .calendar-event').length, 5, 'More shows every visit for the selected day');
      await click(button(document, 'Month')); await ready(page, kind); await chooseMonth(page, kind, '2026-12');
      await click(button(document, 'Next month')); await ready(page, kind); assert.equal(picker(page, kind).value, '2027-01');
      await click(button(document, 'Previous month')); await ready(page, kind); assert.equal(picker(page, kind).value, '2026-12');
      await click(button(document, 'Today')); await ready(page, kind); assert.equal(picker(page, kind).value, todayMonth);
      assert.equal(button(document, 'Month').getAttribute('aria-pressed'), 'true');

      await click(button(document, 'Day')); await ready(page, kind); await editInput(picker(page, kind, 'date'), '2026-01-31'); await ready(page, kind);
      await click(button(document, 'Month')); await ready(page, kind); await chooseMonth(page, kind, '2026-03');
      await click(button(document, 'Day')); await ready(page, kind); assert.equal(picker(page, kind, 'date').value, '2026-03-31');
      await click(button(document, 'Month')); await ready(page, kind); await click(button(document, 'Previous month')); await ready(page, kind);
      await click(button(document, 'Day')); await ready(page, kind); assert.equal(picker(page, kind, 'date').value, '2026-02-28');
      assert.ok(api.calls.every((candidate) => candidate.method === 'GET'));
    } finally { await page.close(); }
  });

  void test(`${kind} Month refresh preserves mounted cells, focus, scroll and filters while newer periods reject stale responses`, { concurrency: false }, async () => {
    const api = monthApiFixture(); const page = await domHarness(api);
    try {
      await renderCalendar(page, kind, () => undefined); const document = page.dom.window.document;
      await ready(page, kind); await chooseMonth(page, kind, '2026-11');
      const cancelled = document.querySelector('input[name="showCancelled"]');
      if (kind === 'participant') { assert.ok(cancelled instanceof page.dom.window.HTMLInputElement); await act(async () => { cancelled.click(); }); assert.match(cell(page, '2026-11-05').textContent ?? '', /CANCELLED-MONTH/); }
      const table = document.querySelector('.calendar-month'); const dayCell = cell(page, '2026-11-03'); const event = dayCell.querySelector('.calendar-month-event'); const scroll = document.querySelector('.calendar-month-scroll'); const monthPicker = picker(page, kind);
      assert.ok(table); assert.ok(event); assert.ok(scroll instanceof page.dom.window.HTMLElement);
      scroll.scrollLeft = 337; scroll.scrollTop = 113; monthPicker.focus();
      function unchanged(scroll: HTMLElement) {
        assert.equal(document.querySelector('.calendar-month'), table); assert.equal(cell(page, '2026-11-03'), dayCell); assert.equal(dayCell.querySelector('.calendar-month-event'), event);
        assert.equal(document.querySelector('.calendar-month-scroll'), scroll); assert.equal(scroll.scrollLeft, 337); assert.equal(scroll.scrollTop, 113);
        assert.equal(picker(page, kind), monthPicker); assert.equal(monthPicker.value, '2026-11'); assert.equal(document.activeElement, monthPicker); assert.equal(button(document, 'Month').getAttribute('aria-pressed'), 'true');
        if (kind === 'participant') { assert.ok(cancelled instanceof page.dom.window.HTMLInputElement); assert.equal(cancelled.checked, true); }
      }
      const pending = api.defer(settings(kind).path); await click(button(document, settings(kind).refresh)); unchanged(scroll);
      await act(async () => { pending.reply(response(api, kind)); }); await ready(page, kind); unchanged(scroll);
      const failed = api.defer(settings(kind).path); await click(button(document, settings(kind).refresh));
      await act(async () => { failed.reply({ message: 'Synthetic month refresh unavailable' }, 503); }); await ready(page, kind); unchanged(scroll);
      assert.match(document.body.textContent ?? '', /Synthetic month refresh unavailable/);
      const invalid = api.defer(settings(kind).path); await click(button(document, settings(kind).retry));
      await act(async () => { invalid.reply({ entries: 'invalid untrusted response' }); }); await ready(page, kind); unchanged(scroll);
      assert.match(document.body.textContent ?? '', /backend returned an unexpected response/i);

      const older = api.defer(settings(kind).path); await click(button(document, settings(kind).refresh));
      await chooseMonth(page, kind, '2026-12');
      let stale: unknown;
      if (kind === 'main') stale = api.calendar.map((row) => ({ ...row, pickingName: 'STALE MONTH RESPONSE' }));
      else { const current = participantCalendarSchema.parse(response(api, kind)); stale = { ...current, participant: { ...current.participant, name: 'STALE MONTH RESPONSE' } }; }
      await act(async () => { older.reply(stale); }); await settle();
      assert.equal(picker(page, kind).value, '2026-12'); assert.equal(document.querySelector('.calendar-period-label')?.textContent, 'December 2026'); assert.doesNotMatch(document.body.textContent ?? '', /STALE MONTH RESPONSE/);
      const staleFailure = api.defer(settings(kind).path); await click(button(document, settings(kind).refresh));
      await chooseMonth(page, kind, '2027-01'); await act(async () => { staleFailure.reply({ message: 'STALE MONTH FAILURE' }, 503); }); await settle();
      assert.equal(picker(page, kind).value, '2027-01'); assert.doesNotMatch(document.body.textContent ?? '', /STALE MONTH FAILURE/);
    } finally { await page.close(); }
  });
}
