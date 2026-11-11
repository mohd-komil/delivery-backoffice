import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { z } from 'zod';
import { routeDraftInputSchema, routeDraftSchema, routeJobSchema, type RouteJob } from '../src/lib/route-drafts';
import { ApiFixture, button, click, deliveryId, domHarness, editInput, settle, waitFor } from './refresh-fixtures';

const draftId = '50000000-0000-4000-8000-000000000070';
const nearId = '50000000-0000-4000-8000-000000000071';
const fartherId = '50000000-0000-4000-8000-000000000072';
const collectionId = '50000000-0000-4000-8000-000000000073';
const warehouse = { id: 'demo-warehouse', name: 'Synthetic warehouse', latitude: 38.19, longitude: 15.55 };
const instant = '2026-11-09T09:00:00.000Z';
const catalog = { drafts: [], points: [warehouse], roadRoutingEnabled: true, googleMaps: { key: 'synthetic-not-used' } };
const createInputSchema = routeDraftInputSchema.extend({ requestId: z.uuid() });

function job(id: string, name: string, distanceKm: number | null, work: 'delivery' | 'installation' | 'collection', minutes: number): RouteJob {
  return routeJobSchema.parse({
    deliveryId: id, pickingName: `DEMO/${name}`, customerName: `Synthetic ${name}`, orderNames: [`SO/${name}`],
    address: `Synthetic Street ${name}`, city: 'Messina', point: { latitude: 38.19, longitude: 15.55 },
    distanceKm, suggestedWorkMinutes: minutes, planningStatus: 'unplanned',
    remaining: [{ sourceLineId: minutes, orderName: `SO/${name}`, productName: 'Same SKU chair', uom: 'unit',
      deliveryMilli: work === 'delivery' ? 2000 : 0, installationMilli: work === 'installation' ? 1000 : 0,
      collectionMilli: work === 'collection' ? 1000 : 0 }],
  });
}

const anchor = job(deliveryId, 'Anchor', null, 'delivery', 45);
const near = job(nearId, 'Near', 2, 'installation', 60);
const farther = job(fartherId, 'Farther', 8, 'delivery', 25);
const collection = job(collectionId, 'Collection', 3, 'collection', 20);

function answer(api: ApiFixture, radius: string, jobs: RouteJob[], anchorJob: RouteJob | null = anchor) {
  api.defer('/routes').reply(catalog);
  const response = api.defer('/routes/jobs', 'GET', `?anchorId=${deliveryId}&radiusKm=${radius}`);
  response.reply({ jobs, anchorJob, anchorHasCoordinates: !!anchorJob?.point });
  return response;
}

function pendingAnswer(api: ApiFixture, radius: string) {
  api.defer('/routes').reply(catalog);
  return api.defer('/routes/jobs', 'GET', `?anchorId=${deliveryId}&radiusKm=${radius}`);
}

function radiusField(document: Document): HTMLInputElement {
  const control = Array.from(document.querySelectorAll('label'))
    .find((label) => label.textContent?.includes('Radius (km)'))?.querySelector('input');
  assert.ok(control instanceof HTMLInputElement, 'Radius input must have an accessible label');
  return control;
}

function choice(document: Document, name: string): HTMLInputElement {
  const control = document.querySelector(`input[aria-label="Select DEMO/${name}"]`);
  assert.ok(control instanceof HTMLInputElement, `Missing checkbox for ${name}`);
  return control;
}

async function toggle(input: HTMLInputElement) {
  assert.equal(input.disabled, false);
  await act(async () => { input.click(); });
}

function createButton(document: Document): HTMLButtonElement {
  const control = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.startsWith('Create draft'));
  assert.ok(control, 'Missing create-draft action');
  return control;
}

function saved(jobs: RouteJob[]) {
  return routeDraftSchema.parse({
    id: draftId, version: 1, createdAt: instant, updatedAt: instant, name: 'Nearby · DEMO/Anchor', departAt: instant,
    crewId: null, vehicleId: null, startPointId: warehouse.id, endPointId: warehouse.id,
    stops: jobs.map((item) => ({ deliveryId: item.deliveryId, workMinutes: item.suggestedWorkMinutes })), manualEstimates: [], jobs,
    pointContexts: [], warnings: [],
    timeline: { departAt: instant, startPointId: warehouse.id, endPointId: warehouse.id, returnDepartAt: null, stops: [], returnAt: null, returnTravelMinutes: null, returnTravelSource: null, travelMinutes: null,
      workMinutes: 125, waitingMinutes: 0, totalMinutes: null },
  });
}

void test('Inbox nearby work automatically searches locally and creates one draft with exactly the selected work', async () => {
  const api = new ApiFixture();
  const initial = answer(api, '10', [near, collection, farther]);
  const page = await domHarness(api);
  const opened: string[] = [];
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft: (id) => { opened.push(id); } }));
    const document = page.dom.window.document;
    await waitFor(() => initial.called && document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'automatic nearby results');
    assert.equal(radiusField(document).value, '10');
    await toggle(choice(document, 'Near'));
    await toggle(choice(document, 'Collection'));
    assert.equal(choice(document, 'Farther').checked, false);
    const post = api.defer('/routes', 'POST');
    await click(createButton(document));
    await waitFor(() => post.called, 'draft creation');
    const mutation = api.calls.find((call) => call.pathname === '/routes' && call.method === 'POST');
    assert.ok(mutation);
    const input = createInputSchema.parse(mutation.body);
    assert.deepEqual(input.stops, [
      { deliveryId, workMinutes: 45, workDurationSource: 'remaining_estimate' }, { deliveryId: nearId, workMinutes: 60, workDurationSource: 'remaining_estimate' }, { deliveryId: collectionId, workMinutes: 20, workDurationSource: 'remaining_estimate' },
    ]);
    assert.equal(input.crewId, null);
    assert.equal(input.vehicleId, null);
    assert.equal(input.startPointId, warehouse.id);
    assert.equal(input.endPointId, warehouse.id);
    assert.deepEqual(input.manualEstimates, []);
    assert.equal(api.calls.some((call) => call.pathname.includes('preview') || call.pathname.includes('google') || call.pathname.includes('appointments')), false);
    assert.equal(document.querySelector('script[src*="maps.googleapis.com"]'), null);
    await act(async () => { post.reply(saved([anchor, near, collection])); });
    await waitFor(() => document.body.textContent?.includes('Open draft') === true, 'saved draft action');
    await click(button(document, 'Open draft'));
    assert.deepEqual(opened, [draftId]);
    assert.equal(api.calls.filter((call) => call.pathname === '/routes' && call.method === 'POST').length, 1);
  } finally { await page.close(); }
});

void test('shrinking the nearby radius removes hidden selections, and returning to a wider radius does not silently reselect them', async () => {
  const api = new ApiFixture();
  answer(api, '10', [near, farther]);
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Farther"]') !== null, 'wider results');
    await toggle(choice(document, 'Farther'));
    const narrow = pendingAnswer(api, '5');
    await editInput(radiusField(document), '5');
    assert.equal(createButton(document).disabled, true, 'A changed radius invalidates the old selectable result immediately');
    await waitFor(() => narrow.called, 'narrow search');
    await act(async () => { narrow.reply({ jobs: [near], anchorJob: anchor, anchorHasCoordinates: true }); });
    await waitFor(() => !createButton(document).disabled, 'narrow result');
    assert.equal(document.querySelector('input[aria-label="Select DEMO/Farther"]'), null);
    assert.match(createButton(document).textContent ?? '', /1 stop/);
    answer(api, '10', [near, farther]);
    await editInput(radiusField(document), '10');
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Farther"]') !== null && !createButton(document).disabled, 'wider result again');
    assert.equal(choice(document, 'Farther').checked, false);
    assert.match(createButton(document).textContent ?? '', /1 stop/);
  } finally { await page.close(); }
});

void test('an aborted nearby response cannot overwrite the latest radius result', async () => {
  const api = new ApiFixture();
  const old = pendingAnswer(api, '10');
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => old.called, 'old search');
    const latest = answer(api, '5', [near]);
    await editInput(radiusField(document), '5');
    await waitFor(() => latest.called && document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'latest search');
    await act(async () => { old.reply({ jobs: [farther], anchorJob: anchor, anchorHasCoordinates: true }); });
    await settle();
    assert.equal(radiusField(document).value, '5');
    assert.ok(choice(document, 'Near'));
    assert.equal(document.querySelector('input[aria-label="Select DEMO/Farther"]'), null);
    assert.equal(api.calls.find((call) => call.search.endsWith('radiusKm=10'))?.signal?.aborted, true);
  } finally { await page.close(); }
});

void test('nearby refresh keeps input and selections mounted but prevents saving stale or failed results', async () => {
  const api = new ApiFixture();
  answer(api, '10', [near, farther]);
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    const onOpenDraft = () => undefined;
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'initial work');
    const input = radiusField(document);
    const checkbox = choice(document, 'Near');
    await toggle(checkbox);
    const refresh = pendingAnswer(api, '10');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '2', onOpenDraft }));
    assert.equal(radiusField(document), input);
    assert.equal(choice(document, 'Near'), checkbox);
    assert.equal(checkbox.checked, true);
    assert.equal(createButton(document).disabled, true);
    await waitFor(() => refresh.called, 'refresh fetch');
    await act(async () => { refresh.reply({ message: 'Synthetic refresh failure' }, 503); });
    await waitFor(() => document.body.textContent?.includes('Synthetic refresh failure') === true, 'refresh failure');
    assert.equal(choice(document, 'Near'), checkbox);
    assert.equal(checkbox.checked, true);
    assert.equal(createButton(document).disabled, true);
    answer(api, '10', [near, farther]);
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '3', onOpenDraft }));
    await waitFor(() => !createButton(document).disabled, 'successful refresh');
    assert.equal(radiusField(document), input);
    assert.equal(choice(document, 'Near'), checkbox);
    assert.equal(checkbox.checked, true);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});

void test('a failed draft creation keeps the same request ID and departure for a safe retry', async () => {
  const api = new ApiFixture();
  answer(api, '10', [near]);
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'nearby work');
    await toggle(choice(document, 'Near'));
    api.defer('/routes', 'POST').reply({ message: 'Synthetic save unavailable' }, 503);
    await click(createButton(document));
    await waitFor(() => document.body.textContent?.includes('Synthetic save unavailable') === true, 'save failure');
    await waitFor(() => !createButton(document).disabled, 'save retry available');
    api.defer('/routes', 'POST').reply(saved([anchor, near]));
    await click(createButton(document));
    await waitFor(() => document.body.textContent?.includes('Open draft') === true, 'retry success');
    const creates = api.calls.filter((call) => call.pathname === '/routes' && call.method === 'POST');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0]?.body, creates[1]?.body, 'Retry must retain both request ID and the provisional departure instant');
    createInputSchema.parse(creates[0]?.body);
  } finally { await page.close(); }
});

void test('fully reserved nearby work requires an explicit visit in Routes and cannot be silently added as free work', async () => {
  const api = new ApiFixture();
  const reserved: RouteJob = { ...near, planningStatus: 'confirmed', hasAvailableRemaining: false, remaining: [] };
  answer(api, '10', [reserved, farther]);
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    const onOpenDraft = () => undefined;
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft }));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'reserved nearby result');
    assert.equal(choice(document, 'Near').disabled, true);
    assert.equal(choice(document, 'Farther').disabled, false);
    assert.match(document.body.textContent ?? '', /All remaining work is reserved for booked visits/);
    await click(button(document, 'Select nearest 1'));
    assert.equal(choice(document, 'Near').checked, false);
    assert.equal(choice(document, 'Farther').checked, true);
    assert.match(createButton(document).textContent ?? '', /2 stops/);

    answer(api, '10', [reserved, farther], { ...anchor, planningStatus: 'confirmed', hasAvailableRemaining: false, remaining: [] });
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '2', onOpenDraft }));
    await waitFor(() => document.body.textContent?.includes('Finding nearby work') === false, 'reserved anchor response');
    assert.equal(createButton(document).disabled, true);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});

void test('missing coordinates and an invalid radius block geographic draft creation', async () => {
  const api = new ApiFixture();
  answer(api, '10', [], { ...anchor, point: null });
  const page = await domHarness(api);
  try {
    const { InboxNearbyWork } = await import('../src/components/inbox-nearby-work');
    await page.render(createElement(InboxNearbyWork, { deliveryId, revision: '1', onOpenDraft: () => undefined }));
    const document = page.dom.window.document;
    await waitFor(() => document.body.textContent?.toLowerCase().includes('coordinates') === true, 'missing coordinates notice');
    assert.equal(createButton(document).disabled, true);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
    const calls = api.calls.length;
    await editInput(radiusField(document), '51');
    assert.equal(radiusField(document).getAttribute('aria-invalid'), 'true');
    assert.match(document.body.textContent ?? '', /Enter a radius from 1 to 50 km/);
    assert.equal(createButton(document).disabled, true);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 220)); });
    assert.equal(api.calls.length, calls, 'Invalid radius must not send an API request');
  } finally { await page.close(); }
});

void test('selecting an Inbox delivery opens nearby work automatically and preserves it across detail tabs and refresh', async () => {
  const api = new ApiFixture();
  answer(api, '10', [near, farther]);
  const page = await domHarness(api);
  try {
    const { Backoffice } = await import('../src/components/backoffice');
    await page.render(createElement(Backoffice));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelector('.delivery-table') !== null, 'Inbox delivery list');
    assert.equal(api.calls.some((call) => call.pathname === '/routes/jobs'), false, 'Nearby search begins only when a delivery is chosen');
    await click(button(document, 'DEMO/OUT/REFRESH'));
    await waitFor(() => document.querySelector('input[aria-label="Select DEMO/Near"]') !== null, 'automatic nearby work in delivery details');
    const panel = document.querySelector('.delivery-panel');
    const body = document.querySelector('.panel-body');
    assert.ok(panel);
    assert.ok(body instanceof HTMLElement);
    const radius = radiusField(document);
    answer(api, '5', [near]);
    await editInput(radius, '5');
    await waitFor(() => !createButton(document).disabled, 'five-kilometre search');
    const checkbox = choice(document, 'Near');
    await toggle(checkbox);
    await click(button(panel, 'History'));
    assert.equal(choice(document, 'Near'), checkbox, 'Changing a detail tab must keep the nearby component mounted');
    assert.ok(checkbox.closest('[hidden]'));
    await click(button(panel, 'Overview'));
    assert.equal(radiusField(document), radius);
    assert.equal(radius.value, '5');
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.closest('[hidden]'), null);
    body.scrollTop = 184;
    const refresh = pendingAnswer(api, '5');
    await click(button(panel, '↻ Refresh'));
    assert.equal(radiusField(document), radius);
    assert.equal(choice(document, 'Near'), checkbox);
    assert.equal(body.scrollTop, 184);
    await waitFor(() => refresh.called, 'nearby refresh with delivery details');
    await act(async () => { refresh.reply({ jobs: [near], anchorJob: anchor, anchorHasCoordinates: true }); });
    await waitFor(() => !createButton(document).disabled, 'refreshed nearby work');
    assert.equal(radius.value, '5');
    assert.equal(checkbox.checked, true);
    assert.equal(body.scrollTop, 184);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  } finally { await page.close(); }
});
