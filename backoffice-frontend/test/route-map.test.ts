import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { RouteMapPoint } from '../src/components/route-map';
import { ApiFixture, domHarness, waitFor } from './refresh-fixtures';

const departure: RouteMapPoint = { id: 'depot', kind: 'start', label: 'Demo warehouse', point: { latitude: 38.1, longitude: 15.1 } };
const stopA: RouteMapPoint = { id: 'A', kind: 'stop', label: 'DEMO/1', point: { latitude: 38.2, longitude: 15.2 } };
const stopB: RouteMapPoint = { id: 'B', kind: 'stop', label: 'DEMO/2', point: { latitude: 38.3, longitude: 15.3 } };
const end: RouteMapPoint = { ...departure, kind: 'return' };

void test('Google map waits for browser configuration and updates ordered pins and geometry without remounting', async () => {
  const page = await domHarness(new ApiFixture());
  try {
    const { RouteMap } = await import('../src/components/route-map');
    const document = page.dom.window.document;
    const sdkScripts = () => [...document.scripts].filter((script) => script.src.includes('maps.googleapis.com'));
    await page.render(createElement(RouteMap, { config: null, points: [departure, stopA, end], encodedPolyline: null }));
    assert.equal(sdkScripts().length, 0);
    assert.match(page.container.textContent ?? '', /browser key is required/);

    let mapCount = 0;
    let fitCount = 0;
    const decoded: string[] = [];
    const markers: StubMarker[] = [];
    const lines: StubLine[] = [];
    class StubMap {
      constructor() { mapCount += 1; }
      fitBounds() { fitCount += 1; }
    }
    class StubBounds {
      extend() {}
    }
    class StubMarker extends HTMLElement {
      map: object | null = null;
      constructor({ title }: { title: string }) {
        super();
        this.title = title;
        markers.push(this);
      }
    }
    class StubPin extends HTMLElement {
      constructor({ glyphText }: { glyphText: string }) {
        super();
        this.textContent = glyphText;
      }
    }
    class StubLine {
      private map: object | null;
      constructor({ map }: { map: object }) {
        this.map = map;
        lines.push(this);
      }
      get visible() { return this.map !== null; }
      setMap(map: object | null) { this.map = map; }
    }

    page.dom.window.customElements.define('route-stub-marker', StubMarker);
    page.dom.window.customElements.define('route-stub-pin', StubPin);
    const libraries = {
      maps: { Map: StubMap, Polyline: StubLine },
      core: { LatLngBounds: StubBounds },
      marker: { AdvancedMarkerElement: StubMarker, PinElement: StubPin },
      geometry: { encoding: { decodePath(encoded: string) {
        decoded.push(encoded);
        return [{ lat: () => 38.1, lng: () => 15.1 }, { lat: () => 38.2, lng: () => 15.2 }];
      } } },
    };
    Reflect.set(page.dom.window, 'google', { maps: { importLibrary: (name: keyof typeof libraries) => Promise.resolve(libraries[name]) } });
    const config = { key: 'synthetic_test_browser_key' };
    await page.render(createElement(RouteMap, {
      config, points: [departure, stopA, stopB, end], encodedPolyline: 'first-road-path',
    }));
    const script = sdkScripts()[0];
    assert.ok(script);
    const scriptUrl = new URL(script.src);
    assert.equal(scriptUrl.origin, 'https://maps.googleapis.com');
    assert.equal(scriptUrl.pathname, '/maps/api/js');
    assert.equal(scriptUrl.searchParams.get('key'), config.key);
    const sdkReady = window.__backofficeGoogleMapsReady;
    assert.ok(sdkReady);
    await act(async () => { sdkReady(); });
    await waitFor(() => markers.length === 3, 'warehouse and stops added to map');
    const activeTitles = () => markers.filter((marker) => marker.map !== null).map((marker) => marker.title);
    assert.deepEqual(activeTitles(), ['Departure and return · Demo warehouse', 'Stop 1 · DEMO/1', 'Stop 2 · DEMO/2']);
    assert.deepEqual(decoded, ['first-road-path']);
    assert.equal(fitCount, 1);
    assert.equal(lines[0]?.visible, true);

    await page.render(createElement(RouteMap, {
      config, points: [departure, stopB, stopA, end], encodedPolyline: null,
    }));
    assert.equal(lines[0]?.visible, false);
    assert.deepEqual(activeTitles(), ['Departure and return · Demo warehouse', 'Stop 1 · DEMO/2', 'Stop 2 · DEMO/1']);

    await page.render(createElement(RouteMap, {
      config, points: [departure, stopB, stopA, end], encodedPolyline: 'second-road-path',
    }));
    assert.deepEqual(decoded, ['first-road-path', 'second-road-path']);
    assert.equal(lines[1]?.visible, true);
    assert.equal(mapCount, 1);
    assert.equal(fitCount, 1);
    assert.equal(sdkScripts().length, 1);

    const authFailure = window.gm_authFailure;
    assert.ok(authFailure);
    await act(async () => { authFailure(); });
    assert.match(page.container.querySelector('[role="alert"]')?.textContent ?? '', /Google Maps could not load/);
  } finally {
    await page.close();
  }
});
