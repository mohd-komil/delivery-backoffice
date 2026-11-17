import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { nearestRoutePoint, routeDraftInputSchema, routeDraftSchema, routeJobSchema } from '../src/lib/route-drafts';
import { ApiFixture, button, click, domHarness, editInput, waitFor } from './refresh-fixtures';

const draftId = '50000000-0000-4000-8000-000000000060';
const anchorId = '50000000-0000-4000-8000-000000000061';
const stopId = '50000000-0000-4000-8000-000000000062';
const departure = '2026-11-06T07:00:00.000Z';
const point = { id: 'demo-warehouse', name: 'Synthetic warehouse', latitude: 38, longitude: 15 };

function job(deliveryId: string, name: string) {
  return routeJobSchema.parse({
    deliveryId, pickingName: `DEMO/${name}`, orderNames: [`SO/${name}`], customerName: name, address: `Synthetic Street ${name}`,
    city: 'Messina', point: { latitude: 38, longitude: 15 }, distanceKm: null, suggestedWorkMinutes: 30, planningStatus: 'unplanned',
    remaining: [{ sourceLineId: 23, orderName: `SO/${name}`, productName: 'Synthetic shelf', uom: 'unit', deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }],
  });
}

const anchor = job(anchorId, 'Anchor');
const stop = job(stopId, 'Stop');
const saved = routeDraftSchema.parse({
  id: draftId, version: 1, createdAt: departure, updatedAt: departure, name: 'Saved route', departAt: departure, crewId: null, vehicleId: null,
  startPointId: point.id, endPointId: point.id, stops: [{ deliveryId: stopId, workMinutes: 30 }], manualEstimates: [], jobs: [stop],
  planning: { participantIds: [], participantAvailability: [], vehicleAvailability: null, driver: { kind: 'unknown' }, transferBufferMinutes: null },
  pointContexts: [{ pointId: point.id, point, addressKey: null }, { pointId: stopId, point: stop.point, addressKey: null }], warnings: [],
  timeline: {
    departAt: departure, startPointId: point.id, endPointId: point.id, returnDepartAt: departure,
    stops: [{ deliveryId: stopId, fromPointId: point.id, travelStartAt: departure, workMinutes: 30, windowStart: null, windowEnd: null, windowStatus: 'none', eta: departure, workStartAt: departure, workEndAt: departure, waitMinutes: 0, late: false, travelMinutes: 20, travelSource: 'demo' }],
    returnAt: departure, returnTravelMinutes: 10, returnTravelSource: 'demo', travelMinutes: 30, workMinutes: 30, waitingMinutes: 0, totalMinutes: 60,
  },
});

function list(version: number, name: string) {
  return { drafts: [{ id: draftId, version, name, departAt: departure, updatedAt: departure, stopCount: 1 }], points: [point] };
}

function field(document: Document, label: string): HTMLInputElement | HTMLSelectElement {
  const control = Array.from(document.querySelectorAll('label')).find((element) => element.firstElementChild?.textContent === label)?.querySelector('input,select');
  assert.ok(control instanceof HTMLInputElement || control instanceof HTMLSelectElement, `Missing field: ${label}`);
  return control;
}

async function select(control: HTMLInputElement | HTMLSelectElement, value: string) {
  assert.ok(control instanceof HTMLSelectElement);
  await act(async () => { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); });
}

void test('route refresh preserves an active draft and search-only anchor, and guards the stale edit', async () => {
  const api = new ApiFixture();
  api.defer('/routes').reply(list(1, saved.name));
  api.defer('/routes/jobs', 'GET', '').reply({ jobs: [stop], anchorHasCoordinates: null });
  api.defer(`/routes/${draftId}`).reply(saved);
  api.defer('/routes/preview', 'POST').reply(saved);
  const page = await domHarness(api);
  try {
    const { RouteDrafts } = await import('../src/components/route-drafts');
    await page.render(createElement(RouteDrafts));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelectorAll('select').length > 0, 'route draft catalog');
    await select(field(document, 'Route draft'), draftId);
    await waitFor(() => document.body.textContent?.includes('60 min') === true && !document.body.textContent.includes('Recalculating'), 'first route preview');

    api.defer('/routes/jobs', 'GET', '?search=Anchor').reply({ jobs: [anchor], anchorHasCoordinates: null });
    const search = field(document, 'Search customer, address, or Picking');
    assert.ok(search instanceof HTMLInputElement);
    await editInput(search, 'Anchor');
    await waitFor(() => Array.from(document.querySelectorAll('option')).some((option) => option.value === anchorId), 'search-only anchor choice');
    const near = `?anchorId=${anchorId}&radiusKm=10`;
    api.defer('/routes/jobs', 'GET', near).reply({ jobs: [stop], anchorHasCoordinates: true });
    const anchorField = field(document, 'Anchor stop');
    await select(anchorField, anchorId);
    await editInput(search, '');
    await waitFor(() => !button(document, 'Add anchor stop').disabled, 'nearby work');

    const name = field(document, 'Route name');
    assert.ok(name instanceof HTMLInputElement);
    const form = name.closest('form');
    assert.ok(form instanceof HTMLFormElement);
    const manual = Array.from(document.querySelectorAll('details')).find((element) => element.querySelector('summary')?.textContent === 'Manual travel times');
    assert.ok(manual);
    manual.open = true;
    const updated = { ...saved, version: 2, name: 'Server updated route' };
    api.defer('/routes').reply(list(2, updated.name));
    api.defer('/routes/jobs', 'GET', '').reply({ jobs: [stop], anchorHasCoordinates: null });
    const draftRefresh = api.defer(`/routes/${draftId}`);
    const nearbyRefresh = api.defer('/routes/jobs', 'GET', near);
    const previewRefresh = api.defer('/routes/preview', 'POST');
    await editInput(name, 'Operator draft');
    await click(button(document, 'Refresh drafts'));
    assert.equal(field(document, 'Route name'), name);
    assert.equal(name.value, 'Operator draft');
    assert.equal(anchorField.value, anchorId);
    assert.equal(manual.open, true);
    assert.equal(manual.isConnected, true);
    await waitFor(() => draftRefresh.called && nearbyRefresh.called && previewRefresh.called, 'draft, nearby and preview refresh requests');
    await act(async () => {
      draftRefresh.reply(updated);
      nearbyRefresh.reply({ jobs: [stop], anchorHasCoordinates: true });
      previewRefresh.reply(saved);
    });
    await waitFor(() => form.textContent?.includes('Use latest data') === true, 'stale route edit warning');
    assert.equal(name.value, 'Operator draft');
    assert.equal(anchorField.value, anchorId);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
    assert.match(form.textContent ?? '', /record changed while this form was open/);

    api.defer('/routes/preview', 'POST').reply(updated);
    await click(button(form, 'Use latest data'));
    assert.equal(field(document, 'Route name').value, updated.name);
  } finally {
    await page.close();
  }
});

const routeDeparture = '2026-11-10T08:00:00.000Z';
const twoStops = routeDraftSchema.parse({
  ...saved, useLocalEstimates: true, departAt: routeDeparture,
  stops: [{ deliveryId: anchorId, workMinutes: 40 }, { deliveryId: stopId, workMinutes: 35 }], jobs: [anchor, stop],
  pointContexts: [...saved.pointContexts, { pointId: anchorId, point: anchor.point, addressKey: null }],
  timeline: {
    departAt: routeDeparture, startPointId: point.id, endPointId: point.id, returnDepartAt: '2026-11-10T10:05:00.000Z',
    stops: [
      { deliveryId: anchorId, fromPointId: point.id, travelStartAt: routeDeparture, workMinutes: 40, windowStart: null, windowEnd: null, windowStatus: 'none', eta: '2026-11-10T08:30:00.000Z', workStartAt: '2026-11-10T08:30:00.000Z', workEndAt: '2026-11-10T09:10:00.000Z', waitMinutes: 0, late: null, travelMinutes: 30, travelSource: 'local_demo' },
      { deliveryId: stopId, fromPointId: anchorId, travelStartAt: '2026-11-10T09:10:00.000Z', workMinutes: 35, windowStart: null, windowEnd: null, windowStatus: 'none', eta: '2026-11-10T09:30:00.000Z', workStartAt: '2026-11-10T09:30:00.000Z', workEndAt: '2026-11-10T10:05:00.000Z', waitMinutes: 0, late: null, travelMinutes: 20, travelSource: 'local_demo' },
    ],
    returnAt: '2026-11-10T10:30:00.000Z', returnTravelMinutes: 25, returnTravelSource: 'local_demo', travelMinutes: 75, workMinutes: 75, waitingMinutes: 0, totalMinutes: 150,
  },
});

void test('reorder and Refresh retain the timeline and editor; manual zero binds current points and Google stays opt-in', async () => {
  const api = new ApiFixture();
  const catalog = { ...list(1, twoStops.name), googleMaps: { key: 'configured-demo-browser-key' }, roadRoutingEnabled: true };
  api.defer('/routes').reply(catalog);
  api.defer('/routes/jobs', 'GET', '').reply({ jobs: [anchor, stop], anchorHasCoordinates: null });
  api.defer(`/routes/${draftId}`).reply(twoStops);
  api.defer('/routes/preview', 'POST').reply(twoStops);
  const page = await domHarness(api);
  try {
    const { RouteDrafts } = await import('../src/components/route-drafts');
    await page.render(createElement(RouteDrafts));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelectorAll('select').length > 0, 'route catalog');
    await select(field(document, 'Route draft'), draftId);
    await waitFor(() => document.body.textContent?.includes('150 min') === true && !document.body.textContent.includes('Recalculating'), 'complete timeline');
    const timeline = document.querySelector('[data-route-timeline]');
    assert.ok(timeline);
    assert.match(timeline.textContent ?? '', /09:00/);
    assert.match(timeline.textContent ?? '', /11:30/);
    assert.match(timeline.textContent ?? '', /Local approximation/);
    assert.equal(document.querySelector('script[src*="maps.googleapis.com"]'), null);
    assert.equal(document.body.textContent?.includes('Route map'), false);
    const firstPreview = api.calls.find((call) => call.pathname === '/routes/preview');
    assert.ok(firstPreview && typeof firstPreview.body === 'object' && firstPreview.body !== null);
    assert.equal('useGoogleRoads' in firstPreview.body, false);
    assert.deepEqual(routeDraftInputSchema.parse(firstPreview.body).planning?.driver, { kind: 'none' });

    const manual = Array.from(document.querySelectorAll('details')).find((element) => element.querySelector('summary')?.textContent === 'Manual travel times');
    assert.ok(manual);
    manual.open = true;
    const minutes = field(document, `${point.name} → Anchor · DEMO/Anchor (min)`);
    assert.ok(minutes instanceof HTMLInputElement);
    const manualPreview = api.defer('/routes/preview', 'POST');
    await editInput(minutes, '0');
    await waitFor(() => manualPreview.called, 'manual preview');
    const manualRequest = api.calls.filter((call) => call.pathname === '/routes/preview').at(-1);
    const manualInput = routeDraftInputSchema.parse(manualRequest?.body);
    assert.deepEqual(manualInput.manualEstimates, [{ fromPointId: point.id, toPointId: anchorId, minutes: 0, context: {
      from: { point: { latitude: 38, longitude: 15 }, addressKey: null }, to: { point: anchor.point, addressKey: null },
    } }]);
    manualPreview.reply({ ...twoStops, manualEstimates: manualInput.manualEstimates });
    await waitFor(() => !document.body.textContent?.includes('Recalculating'), 'manual reply');

    const reordering = api.defer('/routes/preview', 'POST');
    await click(button(document, 'Move down'));
    await waitFor(() => reordering.called, 'reordered preview');
    assert.equal(document.querySelector('[data-route-timeline]'), timeline);
    assert.match(timeline.textContent ?? '', /Previous calculation shown/);
    assert.equal(manual.open, true);
    const reorderedRequest = api.calls.filter((call) => call.pathname === '/routes/preview').at(-1);
    const reorderedInput = routeDraftInputSchema.parse(reorderedRequest?.body);
    assert.deepEqual(reorderedInput.stops.map(({ deliveryId }) => deliveryId), [stopId, anchorId]);
    assert.equal(reorderedInput.manualEstimates[0]?.minutes, 0);

    api.defer('/routes').reply(catalog);
    api.defer('/routes/jobs', 'GET', '').reply({ jobs: [anchor, stop], anchorHasCoordinates: null });
    api.defer(`/routes/${draftId}`).reply(twoStops);
    const refreshing = api.defer('/routes/preview', 'POST');
    const name = field(document, 'Route name');
    await click(button(document, 'Refresh drafts'));
    assert.equal(field(document, 'Route name'), name);
    assert.equal(document.querySelector('[data-route-timeline]'), timeline);
    assert.equal(manual.open, true);
    await waitFor(() => refreshing.called, 'refresh preview');
    await act(async () => {
      reordering.reply({ ...twoStops, timeline: { ...twoStops.timeline, totalMinutes: 999 } });
      refreshing.reply({ ...twoStops, stops: reorderedInput.stops, manualEstimates: reorderedInput.manualEstimates, timeline: {
        ...twoStops.timeline, stops: [...twoStops.timeline.stops].reverse(), totalMinutes: 167, returnAt: '2026-11-10T10:47:00.000Z',
      } });
    });
    await waitFor(() => timeline.textContent?.includes('167 min') === true, 'current reordered timeline');
    assert.equal(timeline.textContent?.includes('999 min'), false);
    assert.equal(timeline.textContent?.includes('Previous calculation shown'), false);
    const patch = api.defer(`/routes/${draftId}`, 'PATCH');
    patch.reply({ ...twoStops, ...reorderedInput, version: 2 });
    await click(button(document, 'Save draft'));
    await waitFor(() => patch.called, 'save reordered draft');
    const save = routeDraftInputSchema.parse(api.calls.find((call) => call.method === 'PATCH')?.body);
    assert.equal(save.useLocalEstimates, true);
    assert.deepEqual(save.manualEstimates, manualInput.manualEstimates);
    assert.deepEqual(save.stops.map(({ deliveryId }) => deliveryId), [stopId, anchorId]);
  } finally { await page.close(); }
});

void test('new draft suggests the nearest point but respects an explicit departure or return selection', async () => {
  const catania = { id: 'catania-public-point', name: 'Catania demo', latitude: 37.51, longitude: 15.08 };
  const messina = { id: 'messina-public-point', name: 'Messina demo', latitude: 38.19, longitude: 15.55 };
  const milano = { id: 'legacy-milano', name: 'Milano demo', latitude: 45.49, longitude: 9.13 };
  const localJob = { ...anchor, point: { latitude: 37.5026, longitude: 15.0844 }, suggestedWorkMinutes: null };
  assert.equal(nearestRoutePoint([milano, messina, catania], localJob.point)?.id, catania.id);
  assert.equal(nearestRoutePoint([], localJob.point), undefined);
  assert.equal(nearestRoutePoint([milano, catania], null)?.id, milano.id);
  const api = new ApiFixture();
  api.defer('/routes').reply({ drafts: [], points: [milano, messina, catania] });
  api.defer('/routes/jobs', 'GET', '').reply({ jobs: [localJob], anchorHasCoordinates: null });
  const page = await domHarness(api);
  try {
    const { RouteDrafts } = await import('../src/components/route-drafts');
    await page.render(createElement(RouteDrafts));
    const document = page.dom.window.document;
    await waitFor(() => document.body.textContent?.includes('Catania demo') === true, 'catalog');
    await select(field(document, 'Return point'), messina.id);
    await click(button(document, 'Add stop'));
    assert.equal(field(document, 'Departure point').value, milano.id);
    assert.equal(field(document, 'Return point').value, messina.id);
    assert.match(document.body.textContent ?? '', /Review work duration/);
    const duration = field(document, 'Work duration (min)');
    assert.equal(duration.value, '', 'Unknown work duration must not be replaced with thirty minutes');
    await click(button(document, 'New draft'));
    await click(button(document, 'Add stop'));
    assert.equal(field(document, 'Departure point').value, catania.id);
    assert.equal(field(document, 'Return point').value, catania.id);
    const localToggle = Array.from(document.querySelectorAll('label')).find((label) => label.textContent === 'Use local approximate travel times')?.querySelector('input');
    assert.ok(localToggle instanceof HTMLInputElement);
    assert.equal(localToggle.checked, true);
  } finally { await page.close(); }
});

void test('manual stale-point warning is visible outside the collapsed manual editor', async () => {
  const api = new ApiFixture();
  const stale = routeDraftSchema.parse({ ...twoStops, warnings: [{ code: 'manual_estimate_stale', fromPointId: point.id, toPointId: anchorId }] });
  const page = await domHarness(api);
  try {
    const { RouteTimeline } = await import('../src/components/route-planning-panels');
    await page.render(createElement(RouteTimeline, { preview: stale, pointName: (id: string) => id === point.id ? point.name : 'Changed delivery', stale: false, loading: false, roadLoading: false, onRoadRetry: () => undefined, error: undefined }));
    const document = page.dom.window.document;
    assert.match(document.querySelector('[data-route-timeline]')?.textContent ?? '', /This manual time is excluded until you review and confirm it/);
    assert.equal(document.querySelector('details'), null);
  } finally { await page.close(); }
});

void test('route work requires an explicit visit, keeps order-line identity, and preserves the choice and manual duration on Refresh', async () => {
  const firstVisitId = '50000000-0000-4000-8000-000000000071';
  const secondVisitId = '50000000-0000-4000-8000-000000000072';
  const legacyVisitId = '50000000-0000-4000-8000-000000000073';
  const options = [
    { id: firstVisitId, startsAt: '2026-11-11T09:00:00Z', endsAt: '2026-11-11T10:00:00Z', customerConfirmed: true, needsReview: false, suggestedWorkMinutes: 40 },
    { id: secondVisitId, startsAt: '2026-11-12T09:00:00Z', endsAt: '2026-11-12T10:00:00Z', customerConfirmed: true, needsReview: false, suggestedWorkMinutes: 20 },
    { id: legacyVisitId, startsAt: '2026-11-13T09:00:00Z', endsAt: '2026-11-13T10:00:00Z', customerConfirmed: true, needsReview: true, suggestedWorkMinutes: null },
  ];
  const available = routeJobSchema.parse({ ...stop, workBasis: 'available_remaining', hasAvailableRemaining: true, appointmentId: null,
    workReviewReason: null, appointmentOptions: options, suggestedWorkMinutes: 40,
    remaining: [{ sourceLineId: 511, orderName: 'SO/A', productName: 'Same chair', uom: 'unit', deliveryMilli: 1000, installationMilli: 1000, collectionMilli: 0 }] });
  const selectedJob = routeJobSchema.parse({ ...available, workBasis: 'appointment', appointmentId: secondVisitId, suggestedWorkMinutes: 20,
    remaining: [{ sourceLineId: 521, orderName: 'SO/B', productName: 'Same chair', uom: 'unit', deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }] });
  const unbound = { ...saved, jobs: [available] };
  const selectedDraft = { ...saved, stops: [{ deliveryId: stopId, appointmentId: secondVisitId, workMinutes: 20 }], jobs: [selectedJob] };
  const api = new ApiFixture();
  api.defer('/routes').reply(list(1, saved.name));
  api.defer('/routes/jobs', 'GET', '').reply({ jobs: [available], anchorHasCoordinates: null });
  api.defer(`/routes/${draftId}`).reply(unbound);
  api.defer('/routes/preview', 'POST').reply(unbound);
  const page = await domHarness(api);
  try {
    const { RouteDrafts } = await import('../src/components/route-drafts');
    await page.render(createElement(RouteDrafts));
    const document = page.dom.window.document;
    await waitFor(() => document.querySelectorAll('select').length > 0, 'route catalog');
    await select(field(document, 'Route draft'), draftId);
    await waitFor(() => document.body.textContent?.includes('60 min') === true && !document.body.textContent.includes('Recalculating'), 'available route work');
    const work = field(document, 'Work for this stop');
    assert.ok(work instanceof HTMLSelectElement);
    assert.equal(work.value, '', 'A booked visit must not be chosen implicitly');
    assert.equal(Array.from(work.options).find(({ value }) => value === legacyVisitId)?.disabled, true);
    const stopCard = work.closest('li');
    assert.ok(stopCard);
    assert.match(stopCard.textContent ?? '', /SO\/A · Line 511/);

    const selecting = api.defer('/routes/preview', 'POST');
    await select(work, secondVisitId);
    assert.match(stopCard.textContent ?? '', /Updating the selected work/);
    assert.doesNotMatch(stopCard.textContent ?? '', /SO\/A · Line 511/);
    assert.equal(field(document, 'Work duration (min)').value, '20');
    await waitFor(() => selecting.called, 'explicit scoped preview');
    const previewRequest = routeDraftInputSchema.parse(api.calls.filter(({ pathname }) => pathname === '/routes/preview').at(-1)?.body);
    assert.deepEqual(previewRequest.stops, [{ deliveryId: stopId, appointmentId: secondVisitId, workMinutes: 20 }]);
    await act(async () => { selecting.reply(selectedDraft); });
    await waitFor(() => stopCard.textContent?.includes('Planned work on 1 line') === true, 'scoped order line');
    assert.match(stopCard.textContent ?? '', /SO\/B · Line 521/);
    assert.doesNotMatch(stopCard.textContent ?? '', /SO\/A · Line 511/);

    const duration = field(document, 'Work duration (min)');
    assert.ok(duration instanceof HTMLInputElement);
    api.defer('/routes/preview', 'POST').reply(selectedDraft);
    await editInput(duration, '27');
    await waitFor(() => !document.body.textContent?.includes('Recalculating'), 'manual duration preview');
    const scopedWork = Array.from(stopCard.querySelectorAll('details')).find((detail) => detail.querySelector('summary')?.textContent === 'Planned work on 1 line');
    assert.ok(scopedWork);
    scopedWork.open = true;
    api.defer('/routes').reply(list(1, saved.name));
    api.defer('/routes/jobs', 'GET', '').reply({ jobs: [available], anchorHasCoordinates: null });
    api.defer(`/routes/${draftId}`).reply(unbound);
    const refreshing = api.defer('/routes/preview', 'POST');
    await click(button(document, 'Refresh drafts'));
    await waitFor(() => refreshing.called, 'scoped refresh');
    assert.equal(field(document, 'Work for this stop'), work);
    assert.equal(work.value, secondVisitId);
    assert.equal(field(document, 'Work duration (min)'), duration);
    assert.equal(duration.value, '27');
    assert.equal(scopedWork.isConnected, true);
    assert.equal(scopedWork.open, true);
    await act(async () => { refreshing.reply(selectedDraft); });
    await waitFor(() => !document.body.textContent?.includes('Recalculating'), 'scoped refresh response');
    assert.equal(scopedWork.isConnected, true);
    assert.equal(scopedWork.open, true);
    const patch = api.defer(`/routes/${draftId}`, 'PATCH');
    patch.reply({ ...selectedDraft, version: 2, stops: [{ deliveryId: stopId, appointmentId: secondVisitId, workMinutes: 27 }] });
    await click(button(document, 'Save draft'));
    await waitFor(() => patch.called, 'scoped save');
    const savedInput = routeDraftInputSchema.parse(api.calls.find(({ method }) => method === 'PATCH')?.body);
    assert.deepEqual(savedInput.stops, [{ deliveryId: stopId, appointmentId: secondVisitId, workMinutes: 27, workDurationSource: 'manual' }]);
  } finally { await page.close(); }
});
