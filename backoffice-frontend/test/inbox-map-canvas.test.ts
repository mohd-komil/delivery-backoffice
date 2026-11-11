import assert from 'node:assert/strict';
import test from 'node:test';
import type { FitBoundsOptions, LatLngBoundsExpression, Map as LeafletMap, PanOptions, PointExpression, Popup } from 'leaflet';
import { mountInboxLeafletMap, type InboxMapCanvasLabels, type InboxMapPoint } from '../src/lib/inbox-leaflet-map';
import { ApiFixture, domHarness } from './refresh-fixtures';

const labels: InboxMapCanvasLabels = {
  region: 'Delivery map', loading: 'Loading map', loadError: 'Map could not load', tilesError: 'Map tiles could not load',
  retry: 'Retry', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fitAll: 'Show all locations', closePopup: 'Close point',
  useVisibleArea: 'Use visible area', areaUnavailable: 'Map area is not ready',
  openDelivery: (picking) => `Open ${picking}`, groupedDeliveries: (count) => `${count} deliveries at this location`,
};
const first: InboxMapPoint = { deliveryId: 'one', pickingName: 'DEMO/1', customerName: 'First customer', latitude: 37.5, longitude: 15.1 };
const samePoint: InboxMapPoint = { ...first, deliveryId: 'two', pickingName: '<img src=x onerror=alert(1)>', customerName: 'Second <script>customer</script>' };
const remote: InboxMapPoint = { ...first, deliveryId: 'three', pickingName: 'DEMO/3', customerName: 'Third customer', latitude: 38.2, longitude: 15.5 };

function rectangle(x: number, y: number, width: number, height: number): DOMRect {
  const values = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  return { ...values, toJSON: () => ({ ...values }) };
}

void test('real Leaflet preserves viewport and grouped markers across Refresh, supports keyboard and cleans up', async (context) => {
  const page = await domHarness(new ApiFixture());
  let mounted: ReturnType<typeof mountInboxLeafletMap> | undefined;
  try {
    const leaflet = await import('leaflet');
    let activeMap: LeafletMap | undefined;
    let fits = 0;
    const pans: { x: number; y: number; animate: boolean | undefined }[] = [];
    const originalFit = leaflet.Map.prototype.fitBounds;
    context.mock.method(leaflet.Map.prototype, 'fitBounds', function (this: LeafletMap, bounds: LatLngBoundsExpression, options?: FitBoundsOptions) {
      activeMap = this;
      fits += 1;
      return originalFit.call(this, bounds, options);
    });
    const originalPan = leaflet.Map.prototype.panBy;
    context.mock.method(leaflet.Map.prototype, 'panBy', function (this: LeafletMap, offset: PointExpression, options?: PanOptions) {
      const point = leaflet.point(offset);
      pans.push({ x: point.x, y: point.y, animate: options?.animate });
      return originalPan.call(this, offset, options);
    });
    function liveMap() { assert.ok(activeMap); return activeMap; }
    function livePopup() {
      let activePopup: Popup | undefined;
      liveMap().eachLayer((layer) => { if (layer instanceof leaflet.Popup) activePopup = layer; });
      assert.ok(activePopup);
      return activePopup;
    }
    const mapElement = page.dom.window.document.createElement('div');
    let mapWidth = 640;
    Object.defineProperties(mapElement, { clientWidth: { get: () => mapWidth }, clientHeight: { value: 420 } });
    page.container.append(mapElement);
    const opened: string[] = [];
    const tileFailures: boolean[] = [];
    mounted = mountInboxLeafletMap(mapElement, leaflet, (id) => opened.push(id), (failed) => tileFailures.push(failed));
    assert.equal(mounted.visibleArea(), null, 'uninitialized maps cannot supply a stale area');
    assert.equal(mapElement.querySelectorAll('.leaflet-tile').length, 0, 'hidden/uninitialized map must not load tiles');
    mounted.update([first, samePoint, remote], '', labels);
    assert.equal(fits, 1);
    assert.equal(mapElement.querySelectorAll('.leaflet-marker-icon').length, 2, 'coincident deliveries share a selectable group');
    assert.equal(liveMap().scrollWheelZoom.enabled(), false);
    assert.equal(liveMap().options.inertia, false);
    const attribution = mapElement.querySelector('.leaflet-control-attribution');
    assert.match(attribution?.textContent ?? '', /OpenStreetMap.*contributors/);
    const tile = mapElement.querySelector('.leaflet-tile');
    assert.ok(tile instanceof page.dom.window.HTMLImageElement);
    assert.equal(new URL(tile.src).hostname, 'tile.openstreetmap.org');
    assert.equal(tile.referrerPolicy, 'strict-origin-when-cross-origin');
    tile.dispatchEvent(new page.dom.window.Event('error'));
    assert.equal(tileFailures.at(-1), true);
    tile.dispatchEvent(new page.dom.window.Event('load'));
    assert.equal(tileFailures.at(-1), false);

    const groupedMarker = mapElement.querySelector('[aria-label="2 deliveries at this location"]');
    const singleMarker = mapElement.querySelector('[aria-label="Open DEMO/3 · Third customer"]');
    assert.ok(groupedMarker instanceof page.dom.window.HTMLElement);
    assert.ok(singleMarker instanceof page.dom.window.HTMLElement);
    assert.equal(singleMarker.tabIndex, 0);
    singleMarker.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(opened, ['three']);
    const originalRect = page.dom.window.HTMLElement.prototype.getBoundingClientRect;
    context.mock.method(page.dom.window.HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
      if (this === mapElement) return rectangle(100, 100, 640, 420);
      if (this.classList.contains('leaflet-popup')) return rectangle(150, 70, 250, 190);
      return originalRect.call(this);
    });
    groupedMarker.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.deepEqual(pans.at(-1), { x: 0, y: -42, animate: false }, 'a clipped popup is moved inside the map with 12px padding and no animation');
    assert.equal(livePopup().options.maxWidth, 300);
    assert.equal(livePopup().options.minWidth, 220);
    const popup = mapElement.querySelector('.inbox-map-popup');
    assert.ok(popup);
    assert.equal(mapElement.querySelector('.leaflet-popup-close-button')?.getAttribute('aria-label'), 'Close point');
    assert.equal(popup.querySelectorAll('button').length, 2);
    assert.equal(popup.querySelectorAll('img,script').length, 0, 'source labels must remain text, never HTML');
    const secondButton = popup.querySelector('[data-delivery-id="two"]');
    assert.ok(secondButton instanceof page.dom.window.HTMLButtonElement);
    secondButton.click();
    assert.deepEqual(opened, ['three', 'two']);

    mounted.zoomIn();
    liveMap().panBy([30, 20], { animate: false });
    const before = { zoom: liveMap().getZoom(), center: liveMap().getCenter() };
    const selectedArea = mounted.visibleArea();
    assert.ok(selectedArea);
    const bounds = liveMap().getBounds();
    assert.ok(Math.abs(selectedArea.north - bounds.getNorth()) < 1e-8);
    assert.ok(Math.abs(selectedArea.west - bounds.getWest()) < 1e-8);
    mounted.setArea(selectedArea);
    mounted.setArea(selectedArea);
    assert.deepEqual({ zoom: liveMap().getZoom(), center: liveMap().getCenter() }, before, 'selecting an area does not move the viewport');
    const pansBeforeRefresh = pans.length;
    mounted.update([structuredClone(first), structuredClone(samePoint), structuredClone(remote)], '', labels);
    assert.equal(fits, 1);
    assert.deepEqual({ zoom: liveMap().getZoom(), center: liveMap().getCenter() }, before);
    assert.equal(mapElement.querySelector('[aria-label="2 deliveries at this location"]'), groupedMarker);
    assert.equal(mapElement.querySelector('.inbox-map-popup'), popup);
    assert.equal(pans.length, pansBeforeRefresh, 'identical Refresh must not pan the open popup again');
    mounted.resize();
    assert.equal(fits, 1, 'reopening the Map view must not refit');
    mounted.update([first, samePoint], 'city=Catania', labels);
    assert.equal(fits, 2);
    assert.equal(mapElement.querySelectorAll('.leaflet-marker-icon').length, 1);
    assert.equal(mapElement.querySelector('.inbox-map-popup'), null, 'new filters close the prior popup instead of moving the fitted map');
    const narrowedMarker = mapElement.querySelector('[aria-label="2 deliveries at this location"]');
    assert.ok(narrowedMarker instanceof page.dom.window.HTMLElement);
    mapWidth = 235;
    narrowedMarker.click();
    assert.equal(livePopup().options.maxWidth, 179, 'a popup created on desktop adapts to the current narrow map when opened');
    assert.equal(livePopup().options.minWidth, 179, 'minimum content width must also fit the map');
    assert.equal(mapElement.querySelector('.leaflet-popup-content')?.getAttribute('style')?.includes('width: 180px'), true, 'Leaflet applies the responsive content width');
    mounted.fit();
    assert.equal(fits, 3, 'explicit fit control is available after manual pan/zoom');
    assert.equal(mapElement.querySelector('.inbox-map-popup'), null, 'explicit fit closes the popup before repositioning its marker');
    mounted.setArea(null);
    mapWidth = 0;
    assert.equal(mounted.visibleArea(), null, 'hidden maps cannot be used to select an area');
    assert.throws(() => mounted?.update([{ ...first, latitude: Number.NaN }], '', labels), /Invalid map coordinates/);
    mounted.destroy();
    assert.equal(mounted.visibleArea(), null, 'destroyed maps cannot return bounds');
    mounted = undefined;
    assert.equal(mapElement.querySelectorAll('.leaflet-pane').length, 0);
    const remounted = mountInboxLeafletMap(mapElement, leaflet, () => undefined, () => undefined);
    remounted.destroy();
  } finally {
    mounted?.destroy();
    await page.close();
  }
});
