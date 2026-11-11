import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { workLineSchema, appointmentSchema, calendarSchema, crewSchema, importSchema, templateSchema, userSchema } from '../src/lib/contracts';
import { ApiFixture, button, click, deliveryId, detailFixture, domHarness, editInput, hasToast, listFixture, settle, user, waitFor } from './refresh-fixtures';

void test('dashboard refresh retains its table during pending/failure and the newest view response wins', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'initial dashboard data');
    const table = document.querySelector('.delivery-table');
    const row = table?.querySelector('tbody tr');
    assert.ok(table);
    assert.ok(row);
    const pending = api.defer('/deliveries');
    await click(button(document, '↻ Refresh'));
    assert.equal(pending.called, true);
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.equal(table.querySelector('tbody tr'), row);
    assert.equal(table.isConnected, true);
    await act(async () => { pending.reply({ message: 'DEMO refresh unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('DEMO refresh unavailable') === true, 'dashboard refresh error');
    assert.match(document.body.textContent ?? '', /Previously loaded data is still shown/);
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.match(table.textContent ?? '', /DEMO\/OUT\/REFRESH/);

    const older = api.defer('/deliveries', 'GET', '?view=inbox&page=1');
    await click(button(document, '↻ Refresh'));
    assert.equal(older.called, true);
    const newer = api.defer('/deliveries', 'GET', '?view=planned&page=1');
    const planned = Array.from(document.querySelectorAll('nav[aria-label="Delivery views"] button')).find((entry) => entry.textContent?.includes('Planned'));
    assert.ok(planned instanceof page.dom.window.HTMLButtonElement);
    await click(planned);
    assert.equal(newer.called, true);
    await act(async () => { newer.reply(listFixture('DEMO/OUT/NEWEST')); });
    await waitFor(() => table.textContent?.includes('DEMO/OUT/NEWEST') === true, 'newest dashboard response');
    await act(async () => { older.reply(listFixture('DEMO/OUT/STALE')); });
    await settle();
    assert.equal(document.querySelector('.delivery-table'), table);
    assert.match(table.textContent ?? '', /DEMO\/OUT\/NEWEST/);
    assert.doesNotMatch(table.textContent ?? '', /DEMO\/OUT\/STALE/);
    assert.equal(planned.classList.contains('active'), true);
  } finally { await page.close(); }
});

void test('delivery refresh preserves DOM, draft text, scroll, selected tab and expanded sections across revisions', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea[name="notes"]') !== null, 'delivery instructions');
    const panel = document.querySelector('.delivery-panel');
    const body = document.querySelector('.panel-body');
    const notes = document.querySelector('textarea[name="notes"]');
    assert.ok(panel);
    assert.ok(body instanceof page.dom.window.HTMLElement);
    assert.ok(notes instanceof page.dom.window.HTMLTextAreaElement);
    const form = notes.closest('form');
    assert.ok(form);
    await act(async () => { notes.value = 'Unsaved operator draft'; notes.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
    body.scrollTop = 410;
    const sameRevision = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    assert.equal(document.querySelector('.panel-body'), body);
    assert.equal(document.querySelector('textarea[name="notes"]'), notes);
    assert.equal(notes.value, 'Unsaved operator draft');
    assert.equal(body.scrollTop, 410);
    await act(async () => { sameRevision.reply(detailFixture(1, 'DEMO refreshed customer')); });
    await waitFor(() => panel.textContent?.includes('DEMO refreshed customer') === true, 'same-revision refresh');
    assert.equal(document.querySelector('textarea[name="notes"]'), notes);
    assert.equal(notes.value, 'Unsaved operator draft');
    assert.equal(body.scrollTop, 410);

    const newRevision = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    const changed = detailFixture(2, 'DEMO newer customer');
    changed.delivery.instructions.notes = 'Newer saved instructions';
    await act(async () => { newRevision.reply(changed); });
    await waitFor(() => panel.textContent?.includes('DEMO newer customer') === true, 'new server revision');
    assert.equal(document.querySelector('.panel-body'), body);
    assert.equal(document.querySelector('textarea[name="notes"]'), notes);
    assert.equal(notes.value, 'Unsaved operator draft');
    assert.equal(body.scrollTop, 410);
    assert.match(form.textContent ?? '', /current input has been kept/);
    const mutationCount = api.calls.filter((call) => call.method === 'PATCH').length;
    await act(async () => { form.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, mutationCount, 'A refresh must not silently adopt a new version for an old draft');
    assert.match(form.textContent ?? '', /record changed while this form was open/);
    await click(button(form, 'Use latest data'));
    const latestNotes = document.querySelector('textarea[name="notes"]');
    assert.ok(latestNotes instanceof page.dom.window.HTMLTextAreaElement);
    assert.equal(latestNotes.value, 'Newer saved instructions');

    await click(button(panel, 'Issues & returns'));
    const registration = Array.from(panel.querySelectorAll('details')).find((entry) => entry.querySelector('summary')?.textContent === 'Register an issue as operator');
    assert.ok(registration);
    registration.open = true;
    const description = registration.querySelector('textarea[name="description"]');
    assert.ok(description instanceof page.dom.window.HTMLTextAreaElement);
    await act(async () => { description.value = 'Unsaved issue description'; description.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
    body.scrollTop = 275;
    const issueRefresh = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    assert.equal(registration.open, true);
    assert.equal(description.isConnected, true);
    await act(async () => { issueRefresh.reply(detailFixture(3)); });
    await waitFor(() => panel.querySelector('.panel-meta')?.textContent?.includes('v3') === true, 'issue-tab refresh');
    assert.equal(registration.isConnected, true);
    assert.equal(registration.open, true);
    assert.equal(description.value, 'Unsaved issue description');
    assert.equal(body.scrollTop, 275);
    assert.equal(button(panel, 'Issues & returns').classList.contains('active'), true);
    const failed = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    await act(async () => { failed.reply({ message: 'DEMO detail unavailable' }, 503); });
    await waitFor(() => panel.querySelector('[role="alert"]')?.textContent?.includes('DEMO detail unavailable') === true, 'detail refresh failure');
    assert.equal(document.querySelector('.panel-body'), body);
    assert.equal(registration.open, true);
    assert.equal(description.value, 'Unsaved issue description');
    assert.equal(body.scrollTop, 275);
  } finally { await page.close(); }
});

void test('a late refresh cannot overwrite a committed delivery mutation or reset its form', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  let changes = 0;
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => { changes++; } }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea[name="notes"]') !== null, 'delivery form');
    const panel = document.querySelector('.delivery-panel');
    const body = document.querySelector('.panel-body');
    const notes = document.querySelector('textarea[name="notes"]');
    assert.ok(panel);
    assert.ok(body instanceof page.dom.window.HTMLElement);
    assert.ok(notes instanceof page.dom.window.HTMLTextAreaElement);
    const form = notes.closest('form');
    assert.ok(form);
    await act(async () => { notes.value = 'Mutation draft'; notes.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
    const mutation = api.defer(`/deliveries/${deliveryId}/instructions`, 'PATCH');
    await act(async () => { form.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(mutation.called, true);
    const staleRefresh = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    assert.equal(staleRefresh.called, true);
    const committed = detailFixture(3, 'DEMO mutation committed');
    committed.delivery.instructions.notes = 'Mutation draft';
    await act(async () => { mutation.reply(committed); });
    await waitFor(() => panel.textContent?.includes('DEMO mutation committed') === true, 'committed mutation response');
    assert.equal(changes, 1);
    await act(async () => { staleRefresh.reply(detailFixture(2, 'DEMO stale refresh')); });
    await settle();
    assert.equal(document.querySelector('.panel-body'), body);
    assert.equal(document.querySelector('textarea[name="notes"]'), notes);
    assert.equal(notes.value, 'Mutation draft');
    assert.match(panel.textContent ?? '', /DEMO mutation committed/);
    assert.doesNotMatch(panel.textContent ?? '', /DEMO stale refresh/);
    assert.match(panel.querySelector('.panel-meta')?.textContent ?? '', /v3/);
    await waitFor(() => hasToast(document, 'Saved'), 'committed save toast');
    assert.doesNotMatch(form.textContent ?? '', /\bSaved\b/);
    const toaster = document.querySelector('[data-sonner-toaster]');
    assert.ok(toaster);
    assert.equal(toaster.closest('[aria-hidden="true"]'), null, 'The live toast stays exposed while the dialog is open');
  } finally { await page.close(); }
});

void test('calendar refresh retains the grid, current day mode, anchor date, bookings and scroll on success/failure', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.calendar = calendarSchema.parse([{ deliveryId, pickingName: 'DEMO calendar booking', customerName: 'DEMO calendar customer',
    appointment: { id: '50000000-0000-4000-8000-000000000010', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'booked', cancellationReason: null, returnRequestId: null, assignments: [], results: [] } }]);
  const page = await domHarness(api);
  try {
    const { Calendar } = await import('../src/components/calendar');
    await page.render(createElement(Calendar, { refreshKey: 0, onOpen: () => undefined }));
    const document = page.dom.window.document;
    await click(button(document, 'Day'));
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'day calendar load');
    const scroll = document.querySelector('.calendar-scroll');
    const grid = document.querySelector('.calendar-grid');
    const event = document.querySelector('.calendar-event');
    const date = document.querySelector('#calendar-date');
    assert.ok(scroll instanceof page.dom.window.HTMLElement);
    assert.ok(grid);
    assert.ok(event);
    assert.ok(date instanceof page.dom.window.HTMLInputElement);
    const anchor = date.value;
    scroll.scrollTop = 615;
    const pending = api.defer('/calendar');
    await click(button(document, '↻ Refresh'));
    assert.equal(document.querySelector('.calendar-grid'), grid);
    assert.equal(document.querySelector('.calendar-event'), event);
    assert.equal(scroll.scrollTop, 615);
    await act(async () => { pending.reply(api.calendar); });
    await waitFor(() => !button(document, '↻ Refresh').disabled, 'calendar refresh response');
    assert.equal(document.querySelector('.calendar-scroll'), scroll);
    assert.equal(document.querySelector('.calendar-grid'), grid);
    assert.equal(document.querySelector('.calendar-event'), event);
    assert.equal(scroll.scrollTop, 615);
    assert.equal(date.value, anchor);
    assert.equal(button(document, 'Day').classList.contains('active'), true);
    const failed = api.defer('/calendar');
    await click(button(document, '↻ Refresh'));
    await act(async () => { failed.reply({ message: 'DEMO calendar unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('DEMO calendar unavailable') === true, 'calendar refresh failure');
    assert.equal(document.querySelector('.calendar-grid'), grid);
    assert.equal(document.querySelector('.calendar-event'), event);
    assert.equal(scroll.scrollTop, 615);
    assert.equal(date.value, anchor);
    assert.match(document.body.textContent ?? '', /Previously loaded bookings are still displayed/);
  } finally { await page.close(); }
});

void test('directory refresh retains mounted crew rows and an open crew draft when the server revision changes', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const crew = crewSchema.parse({ id: '50000000-0000-4000-8000-000000000020', version: 1, name: 'DEMO initial crew', classification: 'indoor', area: 'Messina', enabled: true,
    people: [{ id: '50000000-0000-4000-8000-000000000021', name: 'DEMO participant', external: false }] });
  api.crews = [crew];
  api.templates = [templateSchema.parse({ id: '50000000-0000-4000-8000-000000000022', version: 1, title: 'DEMO task', severity: 'low', order: 1, checklist: ['DEMO check'], enabled: true, requiredSkillIds: [] })];
  const page = await domHarness(api);
  try {
    const { Directory } = await import('../src/components/directory');
    await page.render(createElement(Directory, { user: userSchema.parse({ ...user, role: 'admin' }) }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.crews-table tbody tr') !== null, 'crew directory');
    const row = document.querySelector('.crews-table tbody tr');
    const region = document.querySelector('.crews-table-region');
    assert.ok(row);
    assert.ok(region);
    const refresh = button(document, '↻ Refresh');
    const manageCrew = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === `Manage crew ${crew.name}`);
    assert.ok(manageCrew);
    await click(manageCrew);
    const editor = document.querySelector('.dialog');
    const name = editor?.querySelector('input[name="name"]');
    assert.ok(editor instanceof page.dom.window.HTMLElement);
    assert.ok(name instanceof page.dom.window.HTMLInputElement);
    await act(async () => { name.value = 'Unsaved crew draft'; name.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); });
    editor.scrollTop = 190;
    const next = api.defer('/crews');
    await click(refresh);
    assert.equal(document.querySelector('.crews-table tbody tr'), row);
    assert.equal(document.querySelector('.dialog'), editor);
    assert.equal(name.value, 'Unsaved crew draft');
    await act(async () => { next.reply([{ ...crew, version: 2, name: 'DEMO updated server crew' }]); });
    await waitFor(() => row.textContent?.includes('DEMO updated server crew') === true, 'updated directory revision');
    assert.equal(document.querySelector('.crews-table-region'), region);
    assert.equal(document.querySelector('.crews-table tbody tr'), row);
    assert.equal(document.querySelector('.dialog'), editor);
    assert.equal(editor.querySelector('input[name="name"]'), name);
    assert.equal(name.value, 'Unsaved crew draft');
    assert.equal(editor.scrollTop, 190);
    assert.match(editor.textContent ?? '', /draft and its original version are preserved/);
    const failed = api.defer('/crews');
    await click(refresh);
    await act(async () => { failed.reply({ message: 'DEMO directory unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('DEMO directory unavailable') === true, 'directory failure');
    assert.equal(document.querySelector('.crews-table-region'), region);
    assert.equal(document.querySelector('.dialog'), editor);
    assert.equal(name.value, 'Unsaved crew draft');
    assert.equal(editor.scrollTop, 190);
  } finally { await page.close(); }
});

void test('source-sync refresh retains expanded diagnostics and loaded rows during pending/failure', { concurrency: false }, async () => {
  const api = new ApiFixture();
  api.imports = [importSchema.parse({ id: '50000000-0000-4000-8000-000000000030', status: 'succeeded', startedAt: '2026-11-03T08:00:00Z',
    finishedAt: '2026-11-03T08:00:01Z', processed: 20, error: null, details: ['DEMO diagnostics'] })];
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'workspace');
    const sourceSync = Array.from(document.querySelectorAll('nav[aria-label="Backoffice sections"] button')).find((entry) => entry.textContent?.includes('Source sync'));
    assert.ok(sourceSync instanceof page.dom.window.HTMLButtonElement);
    await click(sourceSync);
    await waitFor(() => document.querySelector('details summary')?.textContent === 'Run details', 'source-sync diagnostics');
    const diagnostics = document.querySelector('details');
    const row = diagnostics?.closest('tr');
    assert.ok(diagnostics);
    assert.ok(row);
    diagnostics.open = true;
    const refreshHistory = button(document, '↻ Refresh history');
    const pending = api.defer('/imports');
    await click(refreshHistory);
    assert.equal(diagnostics.open, true);
    assert.equal(row.isConnected, true);
    await act(async () => { pending.reply(api.imports); });
    await waitFor(() => !refreshHistory.disabled, 'source-sync refresh');
    assert.equal(document.querySelector('details'), diagnostics);
    assert.equal(diagnostics.open, true);
    const failed = api.defer('/imports');
    await click(refreshHistory);
    await act(async () => { failed.reply({ message: 'DEMO source-sync unavailable' }, 503); });
    await waitFor(() => document.body.textContent?.includes('DEMO source-sync unavailable') === true, 'source-sync failure');
    assert.equal(document.querySelector('details'), diagnostics);
    assert.equal(diagnostics.open, true);
    assert.equal(row.isConnected, true);
  } finally { await page.close(); }
});

void test('source sync reports the import outcome even when the command returns HTTP success', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'workspace');
    const sourceSync = Array.from(document.querySelectorAll('nav[aria-label="Backoffice sections"] button')).find((entry) => entry.textContent?.includes('Source sync'));
    assert.ok(sourceSync instanceof page.dom.window.HTMLButtonElement);
    await click(sourceSync);
    const runImport = button(document, '⇄ Run import');
    await waitFor(() => !runImport.disabled, 'ready import command');
    const response = api.defer('/imports', 'POST');
    const failedImport = importSchema.parse({ id: '50000000-0000-4000-8000-000000000031', status: 'failed', startedAt: '2026-11-03T08:00:00Z', finishedAt: '2026-11-03T08:00:01Z', processed: 0, error: 'DEMO import failed', details: ['DEMO diagnostics'] });
    await click(runImport);
    assert.equal(response.called, true);
    api.imports = [failedImport];
    await act(async () => { response.reply(failedImport, 201); });
    await waitFor(() => hasToast(document, 'Import failed', 'error'), 'failed import toast');
    assert.equal(hasToast(document, 'Import completed'), false);
    await waitFor(() => document.querySelector('tbody tr')?.textContent?.includes('DEMO import failed') === true, 'persistent import diagnostics');
  } finally { await page.close(); }
});

void test('uncertain booking retries retain their receipt but an explicitly reset fresh draft gets a new receipt and version', { concurrency: false }, async () => {
  const api = new ApiFixture();
  const page = await domHarness(api);
  const bookingBody = z.object({ version: z.number().int().positive(), requestId: z.uuid(), startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }), returnRequestId: z.uuid().optional(), workLines: z.array(workLineSchema).min(1) }).strict();
  try {
    const { DeliveryPanel } = await import('../src/components/delivery-panel');
    await page.render(createElement(DeliveryPanel, { id: deliveryId, user, onClose: () => undefined, onChanged: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('textarea[name="notes"]') !== null, 'loaded delivery');
    const panel = document.querySelector('.delivery-panel');
    assert.ok(panel);
    await click(button(panel, 'Visits & tasks'));
    const start = panel.querySelector('input[data-booking-field="startsAt"]');
    assert.ok(start instanceof page.dom.window.HTMLInputElement);
    const bookingForm = start.closest('form');
    assert.ok(bookingForm);
    async function fillAndSubmit(day: string) {
      const startsAt = bookingForm?.querySelector('input[data-booking-field="startsAt"]');
      const endsAt = bookingForm?.querySelector('input[data-booking-field="endsAt"]');
      assert.ok(startsAt instanceof page.dom.window.HTMLInputElement);
      assert.ok(endsAt instanceof page.dom.window.HTMLInputElement);
      await editInput(startsAt, `${day}T09:00`);
      await editInput(endsAt, `${day}T10:00`);
      await act(async () => {
        bookingForm?.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
    }
    const firstResponse = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await fillAndSubmit('2026-11-05');
    assert.equal(firstResponse.called, true);
    const firstCall = api.calls.find((call) => call.pathname === `/deliveries/${deliveryId}/appointments` && call.method === 'POST');
    assert.ok(firstCall);
    const first = bookingBody.parse(firstCall.body);
    assert.equal(first.version, 1);
    await act(async () => { firstResponse.reply({ message: 'DEMO response lost; server outcome is uncertain' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO response lost; server outcome is uncertain', 'error'), 'uncertain booking failure');
    const retryResponse = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await fillAndSubmit('2026-11-05');
    assert.equal(retryResponse.called, true);
    const retryCall = api.calls.filter((call) => call.pathname === `/deliveries/${deliveryId}/appointments` && call.method === 'POST').at(-1);
    assert.ok(retryCall);
    assert.deepEqual(bookingBody.parse(retryCall.body), first, 'An exact uncertain retry must keep the original request receipt and payload');
    await act(async () => { retryResponse.reply({ message: 'DEMO response still uncertain' }, 503); });
    await waitFor(() => hasToast(document, 'DEMO response still uncertain', 'error'), 'second uncertain response');

    const refreshed = detailFixture(2);
    const earlierBooking = appointmentSchema.parse({ id: '50000000-0000-4000-8000-000000000040', startsAt: first.startsAt, endsAt: first.endsAt,
      status: 'booked', cancellationReason: null, returnRequestId: null, assignments: [], results: [] });
    refreshed.delivery.appointments = [earlierBooking];
    refreshed.progress = 'planned'; refreshed.views = ['planned']; refreshed.coverage = { assigned: 0, total: 1 };
    const refreshResponse = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    await act(async () => { refreshResponse.reply(refreshed); });
    await waitFor(() => bookingForm.textContent?.includes('Use latest data') === true, 'new server revision and preserved old draft');
    assert.equal(start.isConnected, true);
    assert.equal(start.value, '2026-11-05T09:00');
    await click(button(bookingForm, 'Use latest data'));
    const resetStart = bookingForm.querySelector('input[data-booking-field="startsAt"]');
    assert.ok(resetStart instanceof page.dom.window.HTMLInputElement);
    assert.equal(resetStart.value, '');
    const newResponse = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await fillAndSubmit('2026-11-06');
    assert.equal(newResponse.called, true);
    const latestCall = api.calls.filter((call) => call.pathname === `/deliveries/${deliveryId}/appointments` && call.method === 'POST').at(-1);
    assert.ok(latestCall);
    const latest = bookingBody.parse(latestCall.body);
    assert.equal(latest.version, 2);
    assert.notEqual(latest.requestId, first.requestId, 'Explicitly accepting a fresh server version must start a new booking intent');
    assert.equal(latest.startsAt, '2026-11-06T08:00:00.000Z');
    const duringSave = api.defer(`/deliveries/${deliveryId}`);
    await click(button(panel, '↻ Refresh'));
    const concurrentRevision = { ...refreshed, delivery: { ...refreshed.delivery, version: 3 } };
    await act(async () => { duringSave.reply(concurrentRevision); });
    await waitFor(() => bookingForm.textContent?.includes('Use latest data') === true, 'new revision while booking response is pending');
    const guardedReset = button(bookingForm, 'Use latest data');
    assert.equal(guardedReset.disabled, true, 'A pending receipt must not be reset while its request is still unresolved');
    const callsBeforeDuplicate = api.calls.filter((call) => call.method === 'POST').length;
    await act(async () => { bookingForm.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, callsBeforeDuplicate, 'Programmatic duplicate submits must not issue a second pending command');
    await act(async () => { newResponse.reply({ message: 'DEMO pending command failed' }, 503); });
    await waitFor(() => !guardedReset.disabled, 'pending command settled');
    await click(guardedReset);
    const finalResponse = api.defer(`/deliveries/${deliveryId}/appointments`, 'POST');
    await fillAndSubmit('2026-11-07');
    assert.equal(finalResponse.called, true);
    const finalCall = api.calls.filter((call) => call.pathname === `/deliveries/${deliveryId}/appointments` && call.method === 'POST').at(-1);
    assert.ok(finalCall);
    const finalBody = bookingBody.parse(finalCall.body);
    assert.equal(finalBody.version, 3);
    assert.notEqual(finalBody.requestId, latest.requestId);
    const saved = detailFixture(4);
    saved.delivery.appointments = [earlierBooking, appointmentSchema.parse({ ...earlierBooking, id: '50000000-0000-4000-8000-000000000041', startsAt: finalBody.startsAt, endsAt: finalBody.endsAt })];
    saved.progress = 'planned'; saved.views = ['planned']; saved.coverage = { assigned: 0, total: 2 };
    await act(async () => { finalResponse.reply(saved); });
    await waitFor(() => hasToast(document, 'Saved'), 'new booking confirmation');
  } finally { await page.close(); }
});

