import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { LatLngExpression, Map as LeafletMap, Marker, ZoomPanOptions } from 'leaflet';
import type { EntranceReviewData, EntranceReviewSave, EntranceSuggestion } from '../src/lib/delivery-entrance';
import { ApiFixture, button, click, domHarness, editInput, waitFor } from './refresh-fixtures';

const addressKey = '1'.repeat(64);
const suggested = { latitude: 38.1, longitude: 15.2 };
const confirmedBy = { id: '925e098b-d537-4e11-86fc-0cdfd5cab04a', name: 'Francesca' };

void test('suggestion remains a reference, while Leaflet placement, drag and re-confirmation save only the operator pin without a browser key', async (context) => {
  const page = await domHarness(new ApiFixture());
  try {
    const { ApiError } = await import('../src/lib/api');
    const { DeliveryEntranceReview } = await import('../src/components/delivery-entrance-review');
    const leaflet = await import('leaflet');
    let activeMap: LeafletMap | undefined;
    const originalView = leaflet.Map.prototype.setView;
    context.mock.method(leaflet.Map.prototype, 'setView', function (this: LeafletMap, center: LatLngExpression, zoom?: number, options?: ZoomPanOptions) {
      activeMap = this;
      return originalView.call(this, center, zoom, options);
    });
    function liveMap() { assert.ok(activeMap); return activeMap; }
    function markers() {
      const found: Marker[] = [];
      liveMap().eachLayer((layer) => { if (layer instanceof leaflet.Marker) found.push(layer); });
      return found;
    }

    let loads = 0;
    let lookups = 0;
    let unrelatedSubmits = 0;
    const saves: EntranceReviewSave[] = [];
    let data: EntranceReviewData = {
      addressKey, deliveryVersion: 2, entrance: null, stale: false, address: { street: 'Demo Street', city: 'Messina', country: 'IT' },
      referencePoint: null, mapConfig: null,
    };
    await page.render(createElement('form', { onSubmit: (event) => { event.preventDefault(); unrelatedSubmits += 1; } }, createElement(DeliveryEntranceReview, {
      load: () => { loads += 1; return Promise.resolve(data); },
      suggest: (key) => {
        assert.equal(key, addressKey);
        lookups += 1;
        const result: EntranceSuggestion = { addressKey, status: 'exact', point: suggested, source: 'google' };
        return Promise.resolve(result);
      },
      save: (payload) => {
        saves.push(payload);
        if (saves.length === 1) {
          data = { ...data, deliveryVersion: 3 };
          return Promise.reject(new ApiError(409, 'Conflict'));
        }
        data = {
          ...data, entrance: { point: payload.point, version: 1, confirmedAt: '2026-11-06T10:00:00Z', confirmedBy },
        };
        return Promise.resolve(data);
      },
    })));

    const { body } = page.dom.window.document;
    const coordinate = (index: number) => {
      const result = body.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')[index];
      assert.ok(result);
      return result;
    };
    const attestation = () => {
      const result = body.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(result);
      return result;
    };
    const saveButton = () => button(body, 'Confirm and save entrance');
    const openReview = () => click(button(page.container, 'Review unloading entrance'));

    assert.deepEqual([loads, lookups], [0, 0]);
    await openReview();
    await waitFor(() => body.textContent?.includes('Address match found.') === true, 'automatic suggestion');
    assert.deepEqual([loads, lookups], [1, 1]);
    assert.equal(coordinate(0).value, '');
    assert.equal(coordinate(1).value, '');
    assert.equal(attestation().disabled, true);
    assert.equal(saveButton().disabled, true);
    assert.deepEqual(saves, []);
    await waitFor(() => activeMap !== undefined && markers().length === 1, 'reference marker');
    assert.equal(body.querySelector('script[src*="maps.googleapis.com"]'), null);
    assert.match(body.querySelector('.leaflet-control-attribution')?.textContent ?? '', /OpenStreetMap/);
    const referencePin = markers()[0];
    assert.ok(referencePin);
    assert.equal(referencePin.getLatLng().lat, suggested.latitude);
    assert.equal(referencePin.getLatLng().lng, suggested.longitude);
    assert.equal(referencePin.dragging?.enabled(), false);
    await act(async () => {
      referencePin.getElement()?.click();
    });
    assert.equal(coordinate(0).value, '', 'clicking the suggested marker does not copy it into the editor');
    await act(async () => { liveMap().fire('click', { latlng: leaflet.latLng(38.15, 15.21) }); });
    assert.equal(saveButton().disabled, true);
    const operatorPin = markers().find((marker) => marker.dragging?.enabled());
    assert.ok(operatorPin);
    await act(async () => {
      operatorPin.setLatLng([38.16, 15.22]);
      operatorPin.fire('dragend');
    });
    assert.equal(Number(coordinate(0).value), 38.16);
    assert.equal(Number(coordinate(1).value), 15.22);
    await editInput(coordinate(1), '15,23');
    await act(async () => { attestation().click(); });
    await click(saveButton());
    await waitFor(() => body.textContent?.includes('Reload the current record') === true, 'conflict notice');
    assert.equal(coordinate(1).value, '15,23');
    assert.equal(saveButton().disabled, true);
    await click(button(body, 'Reload address'));
    await waitFor(() => attestation().disabled === false, 'new version load');
    assert.equal(coordinate(1).value, '15,23');
    assert.equal(attestation().checked, false);
    await act(async () => { attestation().click(); });
    await click(saveButton());
    await waitFor(() => !body.querySelector('[role="dialog"]'), 'close after save');
    assert.deepEqual(saves, [
      { addressKey, deliveryVersion: 2, version: null, point: { latitude: 38.16, longitude: 15.23 }, confirmed: true },
      { addressKey, deliveryVersion: 3, version: null, point: { latitude: 38.16, longitude: 15.23 }, confirmed: true },
    ]);
    assert.equal(body.querySelector('.entrance-leaflet-map'), null);

    await openReview();
    await waitFor(() => body.textContent?.includes('Entrance confirmed') === true, 'reused saved entrance');
    assert.equal(lookups, 1, 'opening a confirmed address does not send another suggestion request');
    assert.equal(Number(coordinate(0).value), 38.16);
    assert.equal(Number(coordinate(1).value), 15.23);
    assert.equal(saveButton().disabled, true);
    assert.equal(unrelatedSubmits, 0);
  } finally {
    await page.close();
  }
});
