import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import { z } from 'zod';
import { en } from '../src/i18n/messages/planning';
import { participantSchema, detailSchema, type DeliveryDetail } from '../src/lib/contracts';
import { planningCalendarDetailSchema, planningCalendarEntrySchema, planningCalendarFieldsSchema } from '../src/lib/planning-calendar';
import { planningLocationDetailSchema, planningLocationFieldsSchema, planningLocationSchema, type PlanningLocation } from '../src/lib/planning-locations';
import { applyTimeStandardSchema, timeStandardDetailSchema, timeStandardFieldsSchema, timeStandardSchema, type ApplyTimeStandard, type TimeStandard } from '../src/lib/planning-time-standards';
import { routePlanningSchema, type RoutePlanning } from '../src/lib/route-drafts';
import { lineWorkTimeSchema, workTimeStandardSnapshotSchema } from '../src/lib/work-times';
import { ApiFixture, button, click, detailFixture, domHarness, editInput, hasToast, user, waitFor } from './refresh-fixtures';

function input(scope: ParentNode, name: string): HTMLInputElement {
  const item = scope.querySelector(`input[name="${name}"]`); assert.ok(item instanceof HTMLInputElement); return item;
}
function textarea(scope: ParentNode, name: string): HTMLTextAreaElement {
  const item = scope.querySelector(`textarea[name="${name}"]`); assert.ok(item instanceof HTMLTextAreaElement); return item;
}
function select(scope: ParentNode, name: string): HTMLSelectElement {
  const item = scope.querySelector(`select[name="${name}"]`); assert.ok(item instanceof HTMLSelectElement); return item;
}
function dialog(document: Document): HTMLElement {
  const item = document.querySelector('[role="dialog"]'); assert.ok(item instanceof HTMLElement); return item;
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function write(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit(scope: ParentNode) {
  const form = scope instanceof HTMLFormElement ? scope : scope.querySelector('form'); assert.ok(form instanceof HTMLFormElement);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
function person() {
  return participantSchema.parse({ id: randomUUID(), version: 1, name: 'DEMO Matteo Ferraro', firstName: 'Matteo', lastName: 'Ferraro',
    preferredName: null, phoneNumber: null, address: null, login: null, external: false, enabled: true, hasPassword: false, skillIds: [] });
}
function location(overrides: Partial<PlanningLocation> = {}) {
  return planningLocationSchema.parse({ id: randomUUID(), version: 1, name: 'DEMO warehouse', kind: 'warehouse',
    address: { street: 'Via Test 10', city: 'Messina', province: 'ME', postalCode: '98123', country: 'IT' },
    point: { latitude: 38.18, longitude: 15.55 }, unloadingEntrance: null, coordinateSource: 'manual', verification: 'operator_confirmed',
    enabled: true, demo: true, updatedAt: '2026-11-13T09:00:00Z', updatedBy: { id: user.id, name: user.name },
    confirmedAt: '2026-11-13T09:00:00Z', confirmedBy: { id: user.id, name: user.name }, ...overrides });
}
function locationDetail(item: PlanningLocation) {
  return planningLocationDetailSchema.parse({ location: item, history: [{ version: item.version, action: 'updated', reason: 'Verified the unloading point',
    at: item.updatedAt, actor: item.updatedBy, snapshot: item }] });
}
function standard(overrides: Partial<TimeStandard> = {}) {
  return timeStandardSchema.parse({ id: randomUUID(), version: 1, name: 'DEMO agreed table delivery', service: 'delivery_only', unit: 'unit', category: null,
    rates: { deliveryMinutesPerUnit: 25, installationMinutesPerUnit: null, collectionMinutesPerUnit: null }, basis: 'elapsed_team_minutes',
    assumptions: 'Two-person team, ground floor', exclusions: 'Assembly excluded', examples: 'DEMO reviewed table visit', sourceReference: 'Francesca example A',
    status: 'confirmed', enabled: true, updatedAt: '2026-11-13T09:00:00Z', updatedBy: { id: user.id, name: user.name }, ...overrides });
}
function identicalProducts(): DeliveryDetail {
  const detail = detailFixture(); const item = detail.delivery.source.items[0]; const line = detail.lineServices?.[0]; assert.ok(item && line);
  detail.delivery.source.salesOrders = [{ id: 1, name: 'TEST/SO/FIRST' }, { id: 2, name: 'TEST/SO/SECOND' }];
  detail.delivery.source.items = [{ ...item, name: 'Same table', sku: 'SAME-SKU', saleOrderId: 1 },
    { ...item, name: 'Same table', sku: 'SAME-SKU', saleOrderId: 2, sourceLineId: 20 }];
  detail.delivery.servicePlan = { defaultService: 'delivery_only', defaultOrigin: 'local', overrides: [] };
  detail.lineServices = [line, { ...line, sourceLineId: 20 }];
  detail.lineWorkTimes = [10, 20].map((sourceLineId) => lineWorkTimeSchema.parse({ sourceLineId, deliveryMinutesPerUnit: null,
    installationMinutesPerUnit: null, collectionMinutesPerUnit: null, stale: false, missingOperations: ['delivery'], remainingMinutes: null,
    basis: 'unknown', canEdit: true, localSavedAt: null, localSavedBy: null }));
  return detailSchema.parse(detail);
}

void test('calendar creates explicit Rome instants, guards duplicate submissions and retries the identical command after response failure', async () => {
  const api = new ApiFixture(); const participant = person(); api.participants = [participant]; api.defer('/planning/calendar').reply({ entries: [] });
  const page = await domHarness(api);
  try {
    const { PlanningCalendar } = await import('../src/components/planning-calendar');
    await page.render(createElement(PlanningCalendar, { active: true }));
    await waitFor(() => !button(page.container, en.add).disabled, 'participant directory'); await click(button(page.container, en.add));
    const box = dialog(page.dom.window.document); await choose(select(box, 'personId'), participant.id);
    const start = box.querySelector('[data-booking-field="startsAt"]'); const end = box.querySelector('[data-booking-field="endsAt"]');
    assert.ok(start instanceof HTMLInputElement && end instanceof HTMLInputElement);
    await editInput(start, '2026-11-16T22:00'); await editInput(end, '2026-11-17T06:00');
    await write(textarea(box, 'sourceReference'), 'DEMO roster confirmed by Francesca'); await write(textarea(box, 'reason'), 'Night shift for the planned trip');
    const pending = api.defer('/planning/calendar', 'POST'); await submit(box); await submit(box);
    const body = planningCalendarFieldsSchema.safeExtend({ requestId: z.uuid(), reason: z.string().min(1) }).parse(api.calls.find(({ method }) => method === 'POST')?.body);
    assert.equal(body.personId, participant.id); assert.equal(body.startsAt, '2026-11-16T21:00:00.000Z'); assert.equal(body.endsAt, '2026-11-17T05:00:00.000Z');
    assert.equal(api.calls.filter(({ method }) => method === 'POST').length, 1);
    await act(async () => { pending.reply({ message: 'Temporary response failure' }, 503); });
    await waitFor(() => !button(box, en.save).disabled, 'retry after failure');
    assert.equal(textarea(box, 'reason').value, 'Night shift for the planned trip');
    const again = api.defer('/planning/calendar', 'POST'); await submit(box);
    assert.deepEqual(api.calls.filter(({ method }) => method === 'POST')[1]?.body, body);
    const { requestId, reason: savedReason, ...fields } = body; assert.equal(savedReason, 'Night shift for the planned trip');
    const entry = planningCalendarEntrySchema.parse({ ...fields, id: requestId, version: 1, archived: false, personName: participant.name,
      updatedAt: '2026-11-13T09:00:00Z', updatedBy: { id: user.id, name: user.name } });
    api.defer('/planning/calendar').reply({ entries: [entry] });
    await act(async () => { again.reply(planningCalendarDetailSchema.parse({ entry, history: [] })); });
    await waitFor(() => page.dom.window.document.querySelector('[role="dialog"]') === null && hasToast(page.dom.window.document, en.saved), 'calendar save');
    assert.ok(page.container.textContent?.includes(participant.name));
  } finally { await page.close(); }
});

void test('location refresh preserves form nodes, focus and scroll, and changed versions need explicit review before saving', async () => {
  const api = new ApiFixture(); const original = location(); const endpoint = `/planning/locations/${original.id}`;
  api.defer('/planning/locations').reply({ locations: [original] }); api.defer(endpoint).reply(locationDetail(original));
  const page = await domHarness(api);
  try {
    const { PlanningLocations } = await import('../src/components/planning-locations');
    await page.render(createElement(PlanningLocations, { active: true }));
    await waitFor(() => page.container.querySelector('tbody')?.textContent?.includes(original.name) === true, 'locations');
    await click(button(page.container, en.edit)); const box = dialog(page.dom.window.document);
    await waitFor(() => !button(box, en.save).disabled, 'location detail');
    const name = input(box, 'name'); await editInput(name, 'My unsaved location label'); await write(textarea(box, 'reason'), 'Keep this draft until reviewed');
    api.defer(endpoint, 'PATCH').reply({ message: 'The location changed. Refresh and review before saving.' }, 409);
    await submit(box); await waitFor(() => box.textContent?.includes('The location changed.') === true, 'server version conflict');
    assert.equal(name.value, 'My unsaved location label'); assert.equal(textarea(box, 'reason').value, 'Keep this draft until reviewed');
    name.focus(); box.scrollTop = 213;
    const read = api.defer(endpoint); await click(button(box, en.refresh)); name.focus();
    assert.equal(input(box, 'name'), name); assert.equal(button(box, en.save).disabled, true);
    const newest = location({ ...original, version: 2, name: 'Warehouse name changed by Francesca' });
    await act(async () => { read.reply(locationDetail(newest)); });
    await waitFor(() => box.textContent?.includes('The record has newer data') === true, 'newer version notice');
    assert.equal(input(box, 'name'), name); assert.equal(name.value, 'My unsaved location label');
    assert.equal(page.dom.window.document.activeElement, name); assert.equal(box.scrollTop, 213);
    await submit(box); assert.equal(api.calls.filter(({ method }) => method === 'PATCH').length, 1, 'New version is not submitted until explicitly reviewed');
    await click(button(box, 'Use latest data'));
    assert.equal(input(box, 'name').value, newest.name); assert.equal(textarea(box, 'reason').value, '');
    await write(textarea(box, 'reason'), 'Reviewed the newest warehouse record');
    const changed = location({ ...newest, version: 3 }); api.defer(endpoint, 'PATCH').reply(locationDetail(changed)); api.defer('/planning/locations').reply({ locations: [changed] });
    await submit(box);
    const command = planningLocationFieldsSchema.extend({ requestId: z.uuid(), reason: z.string(), version: z.number() }).parse(api.calls.filter(({ method }) => method === 'PATCH').at(-1)?.body);
    assert.equal(command.version, 2); assert.equal(command.name, newest.name);
    await waitFor(() => hasToast(page.dom.window.document, en.saved), 'saved latest location');
  } finally { await page.close(); }
});

void test('planning tabs retain list filters and month controls while refresh updates data in place', async () => {
  const api = new ApiFixture(); const item = location(); api.defer('/planning/calendar').reply({ entries: [] }); api.defer('/planning/locations').reply({ locations: [item] });
  const page = await domHarness(api);
  try {
    const { PlanningReferences } = await import('../src/components/planning-references');
    await page.render(createElement(PlanningReferences));
    assert.equal(button(page.container, 'Month').getAttribute('aria-pressed'), 'true');
    await click(button(page.container, en.locations));
    await waitFor(() => Array.from(page.container.querySelectorAll('tbody')).some((body) => body.textContent?.includes(item.name)), 'locations tab');
    const section = Array.from(page.container.querySelectorAll('section')).find((node) => !node.hidden && node.textContent?.includes(en.locationsHelp)); assert.ok(section);
    const search = section.querySelector('input'); assert.ok(search instanceof HTMLInputElement); await editInput(search, 'warehouse');
    api.defer('/planning/calendar').reply({ entries: [] }); await click(button(page.container, en.calendar));
    api.defer('/planning/locations').reply({ locations: [item] }); await click(button(page.container, en.locations));
    assert.equal(section.querySelector('input'), search); assert.equal(search.value, 'warehouse');
    await waitFor(() => !button(section, en.refresh).disabled, 'reactivated location list');
    const table = section.querySelector('table'); const read = api.defer('/planning/locations'); await click(button(section, en.refresh));
    assert.equal(section.querySelector('table'), table); assert.equal(button(page.container, en.locations).getAttribute('aria-pressed'), 'true');
    await act(async () => { read.reply({ locations: [location({ ...item, name: 'DEMO warehouse updated' })] }); });
    await waitFor(() => section.textContent?.includes('DEMO warehouse updated') === true, 'updated list');
    assert.equal(section.querySelector('table'), table); assert.equal(search.value, 'warehouse');
  } finally { await page.close(); }
});

void test('standards require explicit exact-line application, filter incompatible records, preserve provenance and retry the same request', async () => {
  const api = new ApiFixture(); const eligible = standard();
  api.defer('/planning/time-standards').reply([eligible, standard({ name: 'Person-minutes only', basis: 'person_minutes' }),
    standard({ name: 'Different unit', unit: 'box' }), standard({ name: 'Unconfirmed', status: 'draft' })]);
  const page = await domHarness(api);
  try {
    const { DeliveryProductLines } = await import('../src/components/delivery-product-lines');
    const { TimeStandardHistory } = await import('../src/components/delivery-time-standard');
    const calls: ApplyTimeStandard[] = []; let fail = true;
    const apply = async (command: ApplyTimeStandard) => { calls.push(applyTimeStandardSchema.parse(command)); if (fail) throw new TypeError('Response connection lost'); return 2; };
    const detail = identicalProducts();
    await page.render(createElement(DeliveryProductLines, { detail, saveService: async () => 2, saveWorkTimes: async () => 2, applyTimeStandard: apply }));
    const rows = Array.from(page.container.querySelectorAll('.product-row')); const first = rows.find((row) => row.textContent?.includes('TEST/SO/FIRST')); const second = rows.find((row) => row.textContent?.includes('TEST/SO/SECOND'));
    assert.ok(first instanceof HTMLElement && second instanceof HTMLElement);
    await click(button(first, 'Edit work time')); await click(button(second, 'Edit work time'));
    await click(button(first, en.applyTitle)); await click(button(second, en.applyTitle));
    await waitFor(() => first.querySelector('select option[value="' + eligible.id + '"]') !== null, 'matching standards');
    assert.equal(api.calls.filter(({ pathname }) => pathname === '/planning/time-standards').length, 1, 'One shared catalogue read for both identical product lines');
    const selector = second.querySelector('select'); assert.ok(selector instanceof HTMLSelectElement);
    assert.equal(selector.options.length, 2); assert.equal(calls.length, 0, 'Opening the choice never writes rates');
    await choose(selector, eligible.id); await write(textarea(second, 'standardReason'), 'Apply agreed rate only to the second order');
    const applyForm = button(second, en.apply).closest('form'); assert.ok(applyForm);
    await submit(applyForm); await waitFor(() => !button(second, en.apply).disabled, 'retry apply'); fail = false; await submit(applyForm);
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.equal(calls[0]?.sourceLineId, 20);
    assert.equal(calls[0]?.standardVersion, 1); assert.equal(first.querySelector('select')?.value, '', 'The identical SKU in the first order remains unselected');
    const snapshot = workTimeStandardSnapshotSchema.parse(eligible);
    await page.render(createElement(TimeStandardHistory, { details: { sourceLineId: 20, reason: 'Exact order line choice', saved: {
      sourceLineId: 20, ...eligible.rates, updatedAt: '2026-11-13T10:00:00Z', updatedBy: { id: user.id, name: user.name },
      context: { productId: 1, saleOrderId: 2, uom: 'unit', uomId: null, addressKey: 'a'.repeat(64) }, timeStandard: snapshot,
    } } }));
    assert.ok(page.container.textContent?.includes('Francesca example A')); assert.ok(page.container.textContent?.includes('v1'));
    assert.ok(page.container.textContent?.includes('Two-person team, ground floor')); assert.ok(page.container.textContent?.includes('Exact order line choice'));
  } finally { await page.close(); }
});

void test('refreshing a changed standard retains the entered reason and requires reviewing its new version', async () => {
  const api = new ApiFixture(); const original = standard(); api.defer('/planning/time-standards').reply([original]); const page = await domHarness(api);
  try {
    const { DeliveryTimeStandard, TimeStandardsProvider } = await import('../src/components/delivery-time-standard');
    const line = detailFixture().lineServices?.[0]; assert.ok(line);
    const calls: ApplyTimeStandard[] = [];
    await page.render(createElement(TimeStandardsProvider, null, createElement(DeliveryTimeStandard, { line, unit: 'unit', version: 1,
      apply: async (body) => { calls.push(body); return 2; } })));
    await click(button(page.container, en.applyTitle)); await waitFor(() => page.container.querySelector('select option[value="' + original.id + '"]') !== null, 'standard selection');
    const selection = page.container.querySelector('select'); assert.ok(selection instanceof HTMLSelectElement); await choose(selection, original.id);
    const reason = textarea(page.container, 'standardReason'); await write(reason, 'Reviewed this exact installation context');
    const read = api.defer('/planning/time-standards'); await click(button(page.container, en.refresh)); reason.focus();
    assert.equal(button(page.container, en.apply).disabled, true);
    const revised = standard({ ...original, version: 2, rates: { ...original.rates, deliveryMinutesPerUnit: 30 } });
    await act(async () => { read.reply([revised]); });
    await waitFor(() => page.container.textContent?.includes(en.stale) === true, 'changed standard');
    assert.equal(textarea(page.container, 'standardReason'), reason); assert.equal(reason.value, 'Reviewed this exact installation context');
    await submit(page.container); assert.equal(calls.length, 0);
    await click(button(page.container, en.latest)); await submit(page.container);
    assert.equal(calls[0]?.standardVersion, 2); assert.equal(calls[0]?.sourceLineId, line.sourceLineId);
  } finally { await page.close(); }
});

void test('switching route availability mode preserves manually entered hours and the selected people', async () => {
  const api = new ApiFixture(); const page = await domHarness(api);
  try {
    const { RouteResourceFields } = await import('../src/components/route-planning-controls');
    const participant = person();
    const original = routePlanningSchema.parse({ participantIds: [participant.id], participantAvailability: [{ participantId: participant.id,
      workingIntervals: [{ startsAt: '2026-11-16T07:00:00Z', endsAt: '2026-11-16T16:00:00Z' }], unavailableIntervals: [] }],
      vehicleAvailability: null, driver: { kind: 'participant', participantId: participant.id }, transferBufferMinutes: 15 });
    const changes: RoutePlanning[] = [];
    function Harness() {
      const [value, setValue] = useState(original);
      return createElement(RouteResourceFields, { value, participants: [participant], onChange: (next) => { changes.push(next); setValue(next); } });
    }
    await page.render(createElement(Harness));
    const mode = Array.from(page.container.querySelectorAll('select')).find((element) => Array.from(element.options).some(({ value }) => value === 'shared_calendar')); assert.ok(mode);
    await choose(mode, 'shared_calendar'); assert.equal(page.container.querySelector('[data-booking-field]'), null);
    await choose(mode, 'manual');
    assert.deepEqual(changes.map(({ participantAvailability }) => participantAvailability), [original.participantAvailability, original.participantAvailability]);
    assert.deepEqual(changes.map(({ participantIds }) => participantIds), [original.participantIds, original.participantIds]);
    const start = page.container.querySelector('[data-booking-field]'); assert.ok(start instanceof HTMLInputElement); assert.equal(start.value, '2026-11-16T08:00');
  } finally { await page.close(); }
});

void test('work-time standard form maps explicit team rates and provenance, then edits the saved version without inventing other operations', async () => {
  const api = new ApiFixture(); api.defer('/planning/time-standards').reply([]); const page = await domHarness(api);
  try {
    const { PlanningTimeStandards } = await import('../src/components/planning-time-standards');
    await page.render(createElement(PlanningTimeStandards, { active: true })); await click(button(page.container, en.add));
    let box = dialog(page.dom.window.document);
    await editInput(input(box, 'name'), 'DEMO confirmed table assembly'); await editInput(input(box, 'unit'), ' unit ');
    await choose(select(box, 'service'), 'installation_only'); await choose(select(box, 'basis'), 'elapsed_team_minutes');
    await editInput(input(box, 'installationMinutesPerUnit'), '45');
    assert.equal(input(box, 'deliveryMinutesPerUnit').disabled, true); assert.equal(input(box, 'collectionMinutesPerUnit').disabled, true);
    await write(textarea(box, 'sourceReference'), 'Francesca approved example 2026-11-13'); await write(textarea(box, 'assumptions'), 'Two people; delivered goods already indoors');
    await write(textarea(box, 'exclusions'), 'Travel and delivery excluded'); await write(textarea(box, 'examples'), 'One DEMO table');
    await write(textarea(box, 'reason'), 'Record the agreed assembly standard'); await choose(select(box, 'status'), 'confirmed');
    const pending = api.defer('/planning/time-standards', 'POST'); await submit(box);
    const body = timeStandardFieldsSchema.extend({ requestId: z.uuid(), reason: z.string().min(1) }).parse(api.calls.find(({ method }) => method === 'POST')?.body);
    assert.equal(body.unit, 'unit'); assert.equal(body.service, 'installation_only'); assert.equal(body.basis, 'elapsed_team_minutes');
    assert.deepEqual(body.rates, { deliveryMinutesPerUnit: null, installationMinutesPerUnit: 45, collectionMinutesPerUnit: null });
    assert.equal(body.sourceReference, 'Francesca approved example 2026-11-13'); assert.equal(body.assumptions, 'Two people; delivered goods already indoors');
    const { requestId, reason, ...fields } = body; assert.equal(reason, 'Record the agreed assembly standard');
    const saved = standard({ ...fields, id: requestId }); api.defer('/planning/time-standards').reply([saved]);
    await act(async () => { pending.reply(saved); });
    await waitFor(() => page.dom.window.document.querySelector('[role="dialog"]') === null && page.container.querySelector('tbody')?.textContent?.includes(saved.name) === true, 'new standard row');
    const endpoint = `/planning/time-standards/${saved.id}`;
    api.defer(endpoint).reply(timeStandardDetailSchema.parse({ item: saved, history: [{ version: 1, at: saved.updatedAt, actor: saved.updatedBy,
      reason, before: null, after: saved }] }));
    await click(button(page.container, en.edit)); box = dialog(page.dom.window.document);
    await waitFor(() => !button(box, en.save).disabled, 'standard editing');
    await editInput(input(box, 'installationMinutesPerUnit'), '50'); await write(textarea(box, 'reason'), 'Reviewed a second assembly example');
    await act(async () => { input(box, 'enabled').click(); });
    const updated = standard({ ...saved, version: 2, enabled: false, rates: { ...saved.rates, installationMinutesPerUnit: 50 } });
    api.defer(endpoint, 'PATCH').reply(updated); api.defer('/planning/time-standards').reply([updated]); await submit(box);
    const patch = timeStandardFieldsSchema.extend({ requestId: z.uuid(), reason: z.string().min(1), version: z.number().int().positive() })
      .parse(api.calls.find(({ method }) => method === 'PATCH')?.body);
    assert.equal(patch.version, 1); assert.equal(patch.enabled, false); assert.equal(patch.rates.installationMinutesPerUnit, 50);
    assert.equal(patch.sourceReference, body.sourceReference); assert.equal(patch.rates.deliveryMinutesPerUnit, null);
    await waitFor(() => page.dom.window.document.querySelector('[role="dialog"]') === null, 'standard updated');
  } finally { await page.close(); }
});

void test('location creation validates coordinates and sends independent address and unloading points with explicit provenance', async () => {
  const api = new ApiFixture(); api.defer('/planning/locations').reply({ locations: [] }); const page = await domHarness(api);
  try {
    const { PlanningLocations } = await import('../src/components/planning-locations');
    await page.render(createElement(PlanningLocations, { active: true })); await click(button(page.container, en.add));
    const box = dialog(page.dom.window.document);
    for (const [name, value] of [['name', 'DEMO operator warehouse'], ['street', 'Via Test 12'], ['city', 'Messina'], ['province', 'ME'], ['postalCode', '98123'], ['country', 'IT'],
      ['addressLatitude', 'not a coordinate'], ['addressLongitude', '15.55']] as const) {
      await editInput(input(box, name), value);
    }
    await write(textarea(box, 'entranceNote'), 'Use the east loading gate'); await write(textarea(box, 'reason'), 'Francesca checked both points');
    await choose(select(box, 'verification'), 'operator_confirmed');
    await submit(box); assert.equal(api.calls.some(({ method }) => method === 'POST'), false, 'Invalid numeric coordinates cannot reach the API');
    await editInput(input(box, 'addressLatitude'), '38.18');
    await submit(box); assert.equal(api.calls.some(({ method }) => method === 'POST'), false, 'An entrance note cannot be silently discarded without its coordinates');
    assert.equal(textarea(box, 'entranceNote').value, 'Use the east loading gate');
    await editInput(input(box, 'entranceLatitude'), '38.181'); await editInput(input(box, 'entranceLongitude'), '15.552');
    const pending = api.defer('/planning/locations', 'POST'); await submit(box);
    const command = planningLocationFieldsSchema.extend({ requestId: z.uuid(), reason: z.string() }).parse(api.calls.find(({ method }) => method === 'POST')?.body);
    assert.deepEqual(command.address, { street: 'Via Test 12', city: 'Messina', province: 'ME', postalCode: '98123', country: 'IT' });
    assert.deepEqual(command.point, { latitude: 38.18, longitude: 15.55 });
    assert.deepEqual(command.unloadingEntrance, { point: { latitude: 38.181, longitude: 15.552 }, note: 'Use the east loading gate' });
    assert.equal(command.coordinateSource, 'manual'); assert.equal(command.verification, 'operator_confirmed'); assert.equal(command.demo, false);
    assert.equal(command.enabled, true); assert.equal(command.reason, 'Francesca checked both points');
    const { requestId, reason, ...fields } = command; assert.equal(reason, 'Francesca checked both points');
    const saved = location({ ...fields, id: requestId }); api.defer('/planning/locations').reply({ locations: [saved] });
    await act(async () => { pending.reply(locationDetail(saved)); });
    await waitFor(() => page.dom.window.document.querySelector('[role="dialog"]') === null, 'location created');
  } finally { await page.close(); }
});
