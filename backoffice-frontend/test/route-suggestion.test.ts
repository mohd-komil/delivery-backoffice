import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { routeDraftInputSchema, routePreviewSchema, routeWorkMinutes, routeJobSchema } from '../src/lib/route-drafts';
import { ApiFixture, button, click, domHarness, waitFor } from './refresh-fixtures';

const first = '50000000-0000-4000-8000-000000000061';
const second = '50000000-0000-4000-8000-000000000062';
const at = '2026-11-15T08:00:00.000Z';
const input = routeDraftInputSchema.parse({ name: 'Test order', departAt: at, crewId: null, vehicleId: null,
  startPointId: 'warehouse', endPointId: 'warehouse', useLocalEstimates: true,
  stops: [{ deliveryId: first, workMinutes: 20 }, { deliveryId: second, workMinutes: 30 }], manualEstimates: [] });
function preview(fingerprint = 'a'.repeat(64)) {
  return routePreviewSchema.parse({ jobs: [], pointContexts: [], warnings: [],
    feasibility: { status: 'feasible_estimate', checkedAt: at, fingerprint, findings: [], workDurations: [] },
    timeline: { departAt: at, startPointId: 'warehouse', endPointId: 'warehouse', returnDepartAt: at, returnAt: at,
      stops: [], returnTravelMinutes: 20, returnTravelSource: 'local_demo', travelMinutes: 60, workMinutes: 50, waitingMinutes: 0, totalMinutes: 110 } });
}

void test('unknown duration stays unknown, instead of inventing thirty minutes', () => {
  const job = routeJobSchema.parse({ deliveryId: first, pickingName: 'DEMO', orderNames: [], customerName: 'Demo', address: null, city: null,
    point: null, distanceKm: null, suggestedWorkMinutes: null, planningStatus: 'unplanned', remaining: [] });
  assert.equal(routeWorkMinutes(job), null);
  assert.equal(routeDraftInputSchema.parse({ ...input, stops: [{ deliveryId: first, workMinutes: null, workDurationSource: 'unknown' }] }).stops[0]?.workMinutes, null);
});

for (const changed of [false, true]) {
  void test(`proposed order requires explicit apply and fresh constraints (changed=${String(changed)})`, async () => {
    const api = new ApiFixture();
    api.defer('/routes/suggest-order', 'POST').reply({ status: 'suggested', objective: 'travel_minutes', current: preview(), suggested: preview(),
      deliveryIds: [second, first], travelMinutesSaved: 12, totalMinutesSaved: 12, evaluatedOrders: 2 });
    api.defer('/routes/preview', 'POST').reply(preview(changed ? 'b'.repeat(64) : undefined));
    const page = await domHarness(api);
    const applied: string[][] = [];
    try {
      const { RouteOrderSuggestion } = await import('../src/components/route-order-suggestion');
      await page.render(createElement(RouteOrderSuggestion, { input, preview: preview(), previewStale: false, revision: 0, pointName: (id: string) => id, onApply: (ids: string[]) => { applied.push(ids); } }));
      await click(button(page.container, 'Suggest stop order'));
      await waitFor(() => page.container.textContent?.includes('A shorter valid order') === true, 'comparison');
      assert.deepEqual(applied, [], 'Suggestion never changes the draft automatically');
      await click(button(page.container, 'Apply proposed order'));
      await waitFor(() => api.calls.filter((call) => call.pathname === '/routes/preview').length === 1, 'freshness check');
      if (changed) {
        await waitFor(() => page.dom.window.document.body.textContent?.includes('The draft or its data changed') === true, 'stale warning');
        assert.deepEqual(applied, []);
      } else {
        await waitFor(() => applied.length === 1, 'explicit application');
        assert.deepEqual(applied, [[second, first]]);
      }
      assert.equal(api.calls.some((call) => call.pathname.includes('/appointments') || call.method === 'PATCH'), false);
    } finally { await page.close(); }
  });
}
