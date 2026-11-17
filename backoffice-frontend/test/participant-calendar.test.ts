import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { participantCalendarSchema, type ParticipantCalendarData } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, waitFor } from './refresh-fixtures';

const participantId = '71000000-0000-4000-8000-000000000001';
const otherParticipantId = '71000000-0000-4000-8000-000000000002';
const appointmentId = '71000000-0000-4000-8000-000000000030';
const cancelledId = '71000000-0000-4000-8000-000000000031';
const calendarPath = `/participants/${participantId}/calendar`;

function calendarFixture(id = participantId, name = 'Giulia Santoro'): ParticipantCalendarData {
  const assignment = {
    id: '71000000-0000-4000-8000-000000000020', crewId: '71000000-0000-4000-8000-000000000010', crewName: 'Historic Messina crew',
    people: [{ id, name: 'DEMO name at booking', external: true }, { id: '71000000-0000-4000-8000-000000000003', name: 'Historic teammate', external: false }],
    tasks: [
      { id: '71000000-0000-4000-8000-000000000041', templateId: '71000000-0000-4000-8000-000000000051', title: 'Assembly shared by this crew', severity: 'high', order: 2,
        checklist: [{ id: '71000000-0000-4000-8000-000000000061', label: 'Inspect assembly', done: false, waiver: null }] },
      { id: '71000000-0000-4000-8000-000000000040', templateId: '71000000-0000-4000-8000-000000000050', title: 'Protect the customer floor', severity: 'low', order: 1,
        checklist: [{ id: '71000000-0000-4000-8000-000000000060', label: 'Protection checked', done: true, waiver: null }] },
    ],
  };
  return participantCalendarSchema.parse({
    participant: { id, version: 3, name, firstName: name.split(' ')[0], lastName: 'Santoro', preferredName: null, phoneNumber: '+39 000 100 0017', address: 'Via del Prototipo (indirizzo fittizio)', external: false, enabled: true },
    entries: [
      { deliveryId, pickingName: 'DEMO/OUT/PERSONAL', customerName: 'Synthetic Palermo customer', appointmentId, startsAt: '2026-11-03T08:15:00Z', endsAt: '2026-11-03T10:45:00Z', status: 'booked', assignment, returnVisit: false },
      { deliveryId, pickingName: 'DEMO/OUT/CANCELLED', customerName: 'Synthetic cancelled customer', appointmentId: cancelledId, startsAt: '2026-11-03T12:00:00Z', endsAt: '2026-11-03T13:00:00Z', status: 'cancelled', assignment: { ...assignment, id: '71000000-0000-4000-8000-000000000021', tasks: [] }, returnVisit: false },
      { deliveryId, pickingName: 'DEMO/OUT/RETURN', customerName: 'Synthetic return customer', appointmentId: '71000000-0000-4000-8000-000000000032', startsAt: '2026-11-04T09:00:00Z', endsAt: '2026-11-04T10:00:00Z', status: 'in_progress', assignment: { ...assignment, id: '71000000-0000-4000-8000-000000000022', tasks: [] }, returnVisit: true },
    ],
  });
}

function fixtureApi() {
  const api = new ApiFixture();
  api.participantCalendars.set(calendarPath, calendarFixture());
  return api;
}

void test('participant calendar distinguishes full-trip occupancy from on-site visits', async () => {
  const api = fixtureApi();
  const value = calendarFixture();
  value.routeReservations = [{ routeId: '71000000-0000-4000-8000-000000000080', name: 'DEMO whole-day route', status: 'published',
    startsAt: '2026-11-03T06:00:00Z', endsAt: '2026-11-03T16:00:00Z', bufferMinutes: 20 }];
  api.participantCalendars.set(calendarPath, value);
  const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined }));
    await ready(page);
    assert.match(page.container.textContent ?? '', /Whole-trip reservations/);
    assert.match(page.container.textContent ?? '', /gap between visits does not mean availability/);
    assert.match(page.container.textContent ?? '', /DEMO whole-day route/);
    assert.match(page.container.textContent ?? '', /Transfer buffer: 20 min/);
    assert.equal(page.container.querySelector('[data-appointment-id="71000000-0000-4000-8000-000000000080"]'), null);
  } finally { await page.close(); }
});

function dateInput(page: Awaited<ReturnType<typeof domHarness>>) {
  const input = page.dom.window.document.querySelector('#participant-calendar-date');
  assert.ok(input instanceof page.dom.window.HTMLInputElement);
  return input;
}

async function ready(page: Awaited<ReturnType<typeof domHarness>>) {
  await waitFor(() => !button(page.dom.window.document, '↻ Refresh calendar').disabled, 'participant calendar response');
}

async function chooseDate(page: Awaited<ReturnType<typeof domHarness>>, day: string) {
  await editInput(dateInput(page), day);
  await ready(page);
}

function requestBounds(api: ApiFixture, path = calendarPath) {
  const call = api.calls.filter((candidate) => candidate.pathname === path).at(-1);
  assert.ok(call);
  const query = new URLSearchParams(call.search);
  return { from: query.get('from'), to: query.get('to') };
}

void test('participant calendar renders actual crew snapshots and ordered shared tasks with both Rome visit endpoints', { concurrency: false }, async () => {
  const api = fixtureApi(); const page = await domHarness(api); const opened: string[] = [];
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: (id) => { opened.push(id); } }));
    const document = page.dom.window.document;
    await click(button(document, 'Week')); await ready(page); await chooseDate(page, '2026-11-03');
    assert.equal(document.querySelector('h1')?.textContent, 'Participant calendar');
    assert.match(document.body.textContent ?? '', /Giulia Santoro/);
    const calendarEvent = Array.from(document.querySelectorAll('.calendar-event')).find((entry) => entry.querySelector('strong')?.textContent === 'DEMO/OUT/PERSONAL');
    assert.ok(calendarEvent);
    assert.equal(calendarEvent.querySelector('.calendar-event-time')?.textContent, '09:15–11:45', 'The event itself must visibly show both visit endpoints in Rome time');
    assert.match(calendarEvent.getAttribute('title') ?? '', /09:15.*UTC\+01:00.*11:45.*UTC\+01:00/);
    const visit = document.querySelector(`.participant-visits article[data-appointment-id="${appointmentId}"]`); assert.ok(visit);
    const text = visit.textContent ?? '';
    assert.match(text, /Historic Messina crew/);
    assert.match(text, /Historic teammate/);
    assert.match(text, /DEMO name at booking \(external\)/);
    assert.match(text, /09:15.*UTC\+01:00/);
    assert.match(text, /11:45.*UTC\+01:00/);
    assert.ok(text.indexOf('Protect the customer floor') < text.indexOf('Assembly shared by this crew'), 'Tasks are displayed in their saved order');
    assert.match(text, /Protection checked/);
    assert.match(text, /Inspect assembly/);
    assert.equal(visit.querySelectorAll('[aria-label="Completed"]').length, 1);
    assert.equal(visit.querySelectorAll('[aria-label="Pending"]').length, 1);
    assert.match(document.body.textContent ?? '', /Crew tasks have no separate start or end time/);
    assert.match(document.body.textContent ?? '', /Return visit/i);
    assert.doesNotMatch(document.body.textContent ?? '', /DEMO\/OUT\/CANCELLED/);
    await click(button(visit, 'Open delivery'));
    assert.deepEqual(opened, [deliveryId]);
    assert.ok(api.calls.every((call) => call.method === 'GET'), 'The participant calendar is a read-only projection');
  } finally { await page.close(); }
});

void test('calendar navigation changes real dates and exact Rome week/day query bounds across the autumn clock change', { concurrency: false }, async () => {
  const api = fixtureApi(); const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined }));
    const document = page.dom.window.document;
    await click(button(document, 'Week')); await ready(page); const today = dateInput(page).value;
    await chooseDate(page, '2026-11-01');
    assert.deepEqual(requestBounds(api), { from: '2026-10-25T23:00:00.000Z', to: '2026-11-01T23:00:00.000Z' });
    await click(button(document, 'Next')); await ready(page);
    assert.equal(dateInput(page).value, '2026-11-08');
    assert.deepEqual(requestBounds(api), { from: '2026-11-01T23:00:00.000Z', to: '2026-11-08T23:00:00.000Z' });
    await click(button(document, 'Previous')); await ready(page); assert.equal(dateInput(page).value, '2026-11-01');
    await click(button(document, 'Day')); await ready(page);
    assert.deepEqual(requestBounds(api), { from: '2026-10-31T23:00:00.000Z', to: '2026-11-01T23:00:00.000Z' });
    await click(button(document, 'Previous')); await ready(page); assert.equal(dateInput(page).value, '2026-10-31');
    await click(button(document, 'Next')); await ready(page); assert.equal(dateInput(page).value, '2026-11-01');
    await click(button(document, 'Today')); await ready(page); assert.equal(dateInput(page).value, today);
    assert.equal(button(document, 'Day').classList.contains('active'), true);
  } finally { await page.close(); }
});

void test('cancelled visits are optional and empty/error states remain actionable without inventing tasks', { concurrency: false }, async () => {
  const api = fixtureApi(); const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined }));
    const document = page.dom.window.document;
    await click(button(document, 'Week')); await ready(page); await chooseDate(page, '2026-11-03');
    const toggle = document.querySelector('input[name="showCancelled"]'); assert.ok(toggle instanceof page.dom.window.HTMLInputElement);
    assert.equal(toggle.checked, false); assert.equal(document.querySelector(`[data-appointment-id="${cancelledId}"]`), null);
    await act(async () => { toggle.click(); });
    const cancelled = document.querySelector(`.participant-visits article[data-appointment-id="${cancelledId}"]`); assert.ok(cancelled);
    assert.match(cancelled.textContent ?? '', /cancelled/i);
    assert.doesNotMatch(cancelled.textContent ?? '', /Assembly shared by this crew/);
    const failed = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    await act(async () => { failed.reply({ message: 'Synthetic personal calendar unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic personal calendar unavailable') === true, 'calendar error');
    assert.equal(cancelled.isConnected, true);
    api.participantCalendars.set(calendarPath, { ...calendarFixture(), entries: [] });
    await click(button(document, 'Retry calendar')); await ready(page);
    assert.equal(document.querySelectorAll('.participant-visits article').length, 0);
    assert.match(document.body.textContent ?? '', /No .*visits.*period/i);
    assert.doesNotMatch(document.body.textContent ?? '', /Synthetic personal calendar unavailable/);
  } finally { await page.close(); }
});

void test('refresh retains the mounted grid, focused date, selected mode, cancelled preference and scroll during pending/success/failure', { concurrency: false }, async () => {
  const api = fixtureApi(); const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined }));
    const document = page.dom.window.document;
    await click(button(document, 'Day')); await ready(page); await chooseDate(page, '2026-11-03');
    const toggle = document.querySelector('input[name="showCancelled"]'); assert.ok(toggle instanceof page.dom.window.HTMLInputElement);
    await act(async () => { toggle.click(); });
    const input = dateInput(page); const scroll = document.querySelector('.calendar-scroll'); const grid = document.querySelector('.calendar-grid');
    const event = document.querySelector('.calendar-event'); const visit = document.querySelector(`.participant-visits article[data-appointment-id="${appointmentId}"]`);
    assert.ok(scroll instanceof page.dom.window.HTMLElement); assert.ok(grid); assert.ok(event); assert.ok(visit);
    const dateTrigger = input.parentElement?.querySelector('button[role="combobox"]');
    assert.ok(dateTrigger instanceof page.dom.window.HTMLButtonElement);
    scroll.scrollTop = 721; dateTrigger.focus();
    const pending = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    function assertPreserved(scroll: HTMLElement, toggle: HTMLInputElement) {
      assert.equal(document.querySelector('.calendar-scroll'), scroll); assert.equal(document.querySelector('.calendar-grid'), grid); assert.equal(document.querySelector('.calendar-event'), event);
      assert.equal(document.querySelector(`.participant-visits article[data-appointment-id="${appointmentId}"]`), visit);
      assert.ok(dateInput(page) === input, 'The date value bridge remains mounted'); assert.equal(input.value, '2026-11-03'); assert.ok(document.activeElement === dateTrigger, 'The visible date picker retains focus');
      assert.equal(scroll.scrollTop, 721); assert.equal(toggle.checked, true); assert.equal(button(document, 'Day').classList.contains('active'), true);
    }
    assertPreserved(scroll, toggle);
    const updated = calendarFixture(); updated.participant.name = 'Giulia refreshed';
    await act(async () => { pending.reply(updated); }); await ready(page); assertPreserved(scroll, toggle);
    assert.match(document.body.textContent ?? '', /Giulia refreshed/);
    const failed = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    await act(async () => { failed.reply({ message: 'Synthetic refresh failed' }, 503); }); await ready(page); assertPreserved(scroll, toggle);
    assert.match(document.body.textContent ?? '', /Synthetic refresh failed/);
  } finally { await page.close(); }
});

void test('late responses cannot overwrite a new date or leak a previous participant into another calendar', { concurrency: false }, async () => {
  const api = fixtureApi(); const otherPath = `/participants/${otherParticipantId}/calendar`;
  api.participantCalendars.set(otherPath, calendarFixture(otherParticipantId, 'Elena Moretti'));
  const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined }));
    const document = page.dom.window.document;
    await click(button(document, 'Day')); await ready(page); await chooseDate(page, '2026-11-03');
    const older = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    await chooseDate(page, '2026-11-04');
    await act(async () => { older.reply({ ...calendarFixture(), participant: { ...calendarFixture().participant, name: 'STALE PERSON RESPONSE' } }); }); await settle();
    assert.equal(dateInput(page).value, '2026-11-04'); assert.doesNotMatch(document.body.textContent ?? '', /STALE PERSON RESPONSE/);
    const previous = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    const next = api.defer(otherPath);
    await page.render(createElement(ParticipantCalendar, { participantId: otherParticipantId, refreshKey: 0, onOpen: () => undefined }));
    assert.equal(next.called, true); assert.doesNotMatch(document.body.textContent ?? '', /Giulia Santoro/);
    assert.equal(document.querySelectorAll('.participant-visits article').length, 0, 'Prior participant entries must be hidden while the next participant loads');
    assert.equal(document.querySelectorAll('.calendar-event').length, 0);
    await act(async () => { previous.reply({ message: 'STALE PRIOR PERSON FAILURE' }, 503); }); await settle();
    assert.doesNotMatch(document.body.textContent ?? '', /STALE PRIOR PERSON FAILURE/);
    await act(async () => { next.reply(calendarFixture(otherParticipantId, 'Elena Moretti')); }); await ready(page);
    assert.match(document.body.textContent ?? '', /Elena Moretti/); assert.doesNotMatch(document.body.textContent ?? '', /Giulia Santoro|STALE PRIOR/);
    assert.equal(api.calls.filter((call) => call.pathname === calendarPath).at(-1)?.signal?.aborted, true);
  } finally { await page.close(); }
});

void test('calendar refresh keeps an already open real delivery panel and its unsaved operator draft', { concurrency: false }, async () => {
  const api = fixtureApi(); const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement<NonNullable<Parameters<typeof Backoffice>[0]>>(Backoffice, { participantId }));
    await ready(page);
    const document = page.dom.window.document;
    await click(button(document, 'Week')); await ready(page); await chooseDate(page, '2026-11-03');
    const visit = document.querySelector(`.participant-visits article[data-appointment-id="${appointmentId}"]`); assert.ok(visit);
    await click(button(visit, 'Open delivery'));
    await waitFor(() => document.querySelector('.delivery-panel textarea[name="notes"]') !== null, 'real delivery panel');
    const panel = document.querySelector('.delivery-panel'); const body = panel?.querySelector('.panel-body'); const notes = panel?.querySelector('textarea[name="notes"]');
    assert.ok(panel); assert.ok(body instanceof page.dom.window.HTMLElement); assert.ok(notes instanceof page.dom.window.HTMLTextAreaElement);
    await act(async () => { notes.value = 'Synthetic preserved operator draft'; notes.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); }); body.scrollTop = 287;
    const pending = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    assert.equal(document.querySelector('.delivery-panel'), panel); assert.equal(notes.value, 'Synthetic preserved operator draft');
    await act(async () => { pending.reply(calendarFixture()); }); await ready(page);
    assert.equal(document.querySelector('.delivery-panel'), panel); assert.equal(panel.querySelector('textarea[name="notes"]'), notes); assert.equal(notes.value, 'Synthetic preserved operator draft'); assert.equal(body.scrollTop, 287);
    const failed = api.defer(calendarPath); await click(button(document, '↻ Refresh calendar'));
    await act(async () => { failed.reply({ message: 'Synthetic refresh unavailable while viewing delivery' }, 503); }); await ready(page);
    assert.equal(document.querySelector('.delivery-panel'), panel); assert.equal(notes.isConnected, true); assert.equal(notes.value, 'Synthetic preserved operator draft'); assert.equal(body.scrollTop, 287);
  } finally { await page.close(); }
});

void test('runtime response validation rejects malformed entries and never renders untrusted task markup', { concurrency: false }, async () => {
  const api = fixtureApi(); const invalid = calendarFixture();
  api.participantCalendars.set(calendarPath, { ...invalid, entries: [{ ...invalid.entries[0], startsAt: 'not-an-instant', assignment: { tasks: [{ title: '<img src=x onerror=alert(1)>' }] } }] });
  const page = await domHarness(api);
  try {
    const { ParticipantCalendar } = await import('../src/components/participant-calendar');
    await page.render(createElement(ParticipantCalendar, { participantId, refreshKey: 0, onOpen: () => undefined })); await ready(page);
    const document = page.dom.window.document;
    assert.match(document.body.textContent ?? '', /backend returned an unexpected response/i);
    assert.equal(document.querySelectorAll('.participant-visits article').length, 0);
    assert.equal(document.querySelector('img'), null);
    api.participantCalendars.set(calendarPath, calendarFixture(otherParticipantId, 'Unexpected other person')); await click(button(document, 'Retry calendar')); await ready(page);
    assert.match(document.body.textContent ?? '', /response belongs to another participant/i);
    assert.doesNotMatch(document.body.textContent ?? '', /Unexpected other person/);
    api.participantCalendars.set(calendarPath, calendarFixture()); await click(button(document, 'Retry calendar')); await ready(page);
    await click(button(document, 'Week')); await ready(page); await chooseDate(page, '2026-11-03');
    assert.equal(document.querySelectorAll('.participant-visits article').length, 2);
  } finally { await page.close(); }
});
