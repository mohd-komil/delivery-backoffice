type MapPosition = { lat: number; lng: number };

export type MapPin = {
  position: MapPosition;
  title: string;
  glyph: string;
  depot: boolean;
};

export class GoogleMapsAuthenticationError extends Error {}

type MapCanvas = {
  update: (pins: readonly MapPin[], encodedPolyline: string | null) => void;
  destroy: () => void;
};

type MapsLibraries = { maps: object; core: object; marker: object; geometry: object };

declare global {
  interface Window {
    __backofficeGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

const scriptCallback = '__backofficeGoogleMapsReady';
const authFailureListeners = new Set<() => void>();
let sdkLoad: { key: string; promise: Promise<MapsLibraries> } | undefined;
let authenticationFailed = false;

function invalidSdk() {
  return new Error('Google Maps is unavailable');
}

function sdkObject(value: unknown) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw invalidSdk();
  return value;
}

function sdkMember(target: object, name: string): unknown {
  const value: unknown = Reflect.get(target, name);
  return value;
}

function callSdk(target: object, name: string, ...args: unknown[]): unknown {
  const method = sdkMember(target, name);
  if (typeof method !== 'function') throw invalidSdk();
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}

function constructSdk(library: object, name: string, ...args: unknown[]) {
  const constructor = sdkMember(library, name);
  if (typeof constructor !== 'function') throw invalidSdk();
  const instance: unknown = Reflect.construct(constructor, args);
  return sdkObject(instance);
}

function mapPosition(value: unknown): MapPosition | null {
  if (value === null || typeof value !== 'object') return null;
  const readCoordinate = (name: 'lat' | 'lng'): unknown => {
    const member = sdkMember(value, name);
    return typeof member === 'function' ? callSdk(value, name) : member;
  };
  const lat = readCoordinate('lat');
  const lng = readCoordinate('lng');
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90
    || typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function createMap(canvas: HTMLElement, libraries: MapsLibraries, mapId: string, initial?: { center: MapPosition; zoom: number }) {
  return constructSdk(libraries.maps, 'Map', canvas, {
    mapId, mapTypeControl: false, streetViewControl: false, clickableIcons: false, gestureHandling: 'cooperative', ...initial,
  });
}

function addMapMarker(libraries: MapsLibraries, map: object, pin: MapPin, draggable = false) {
  const marker = constructSdk(libraries.marker, 'AdvancedMarkerElement', {
    position: pin.position, title: pin.title, gmpDraggable: draggable,
  });
  const glyph = constructSdk(libraries.marker, 'PinElement', {
    glyphText: pin.glyph,
    glyphColor: '#ffffff',
    background: pin.depot ? '#334155' : '#1d4ed8',
    borderColor: pin.depot ? '#0f172a' : '#1e3a8a',
  });
  if (!(marker instanceof HTMLElement) || !(glyph instanceof HTMLElement)) throw invalidSdk();
  marker.append(glyph);
  if (!Reflect.set(marker, 'map', map)) throw invalidSdk();
  return marker;
}

async function importMapsLibraries(): Promise<MapsLibraries> {
  const google = sdkObject(sdkMember(window, 'google'));
  const api = sdkObject(sdkMember(google, 'maps'));
  const [maps, core, marker, geometry] = await Promise.all([
    callSdk(api, 'importLibrary', 'maps'),
    callSdk(api, 'importLibrary', 'core'),
    callSdk(api, 'importLibrary', 'marker'),
    callSdk(api, 'importLibrary', 'geometry'),
  ]);
  return {
    maps: sdkObject(maps),
    core: sdkObject(core),
    marker: sdkObject(marker),
    geometry: sdkObject(geometry),
  };
}

export function onGoogleMapsAuthFailure(listener: () => void) {
  authFailureListeners.add(listener);
  return () => { authFailureListeners.delete(listener); };
}

export function loadGoogleMaps(key: string): Promise<MapsLibraries> {
  if (authenticationFailed) return Promise.reject(new GoogleMapsAuthenticationError());
  if (!/^[a-zA-Z0-9_-]{20,120}$/.test(key)) return Promise.reject(invalidSdk());
  if (sdkLoad) return sdkLoad.key === key ? sdkLoad.promise : Promise.reject(invalidSdk());

  const promise = new Promise<MapsLibraries>((resolve, reject) => {
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.search = new URLSearchParams({
      key, loading: 'async', callback: scriptCallback, v: 'quarterly', auth_referrer_policy: 'origin',
    }).toString();
    const script = document.createElement('script');
    script.async = true;
    script.referrerPolicy = 'strict-origin';
    script.src = url.href;
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    if (nonce) script.nonce = nonce;
    const timeout = window.setTimeout(fail, 12_000);

    function finish() {
      window.clearTimeout(timeout);
      delete window.__backofficeGoogleMapsReady;
      script.onerror = null;
    }

    function fail() {
      finish();
      script.remove();
      reject(invalidSdk());
    }

    window.__backofficeGoogleMapsReady = () => {
      void importMapsLibraries().then((libraries) => { finish(); resolve(libraries); }, fail);
    };
    window.gm_authFailure = () => {
      authenticationFailed = true;
      fail();
      for (const listener of authFailureListeners) listener();
    };
    script.onerror = fail;
    document.head.append(script);
  });

  sdkLoad = { key, promise: promise.catch((failure: unknown) => {
    sdkLoad = undefined;
    throw failure;
  }) };
  return sdkLoad.promise;
}

export function mountGoogleMap(canvas: HTMLElement, libraries: MapsLibraries, mapId: string): MapCanvas {
  const map = createMap(canvas, libraries, mapId);
  let markers: HTMLElement[] = [];
  let line: object | null = null;
  let path: MapPosition[] = [];
  let lastPins = '';
  let lastLine: string | null = null;
  let lastCoordinates = '';
  let fittedRoad = false;

  function clearMarkers() {
    for (const marker of markers) Reflect.set(marker, 'map', null);
    markers = [];
  }

  function setPolyline(encodedPolyline: string | null) {
    if (line) callSdk(line, 'setMap', null);
    line = null;
    path = [];
    if (!encodedPolyline) return;
    const encoding = sdkObject(sdkMember(libraries.geometry, 'encoding'));
    const decoded = callSdk(encoding, 'decodePath', encodedPolyline);
    if (!Array.isArray(decoded) || decoded.length < 2) throw invalidSdk();
    path = decoded.map((value: unknown) => {
      const position = mapPosition(value);
      if (!position) throw invalidSdk();
      return position;
    });
    line = constructSdk(libraries.maps, 'Polyline', {
      map, path, clickable: false, strokeColor: '#1d4ed8', strokeWeight: 5, strokeOpacity: 0.86,
    });
  }

  return {
    update(pins, encodedPolyline) {
      const pinKey = JSON.stringify(pins);
      if (pinKey !== lastPins) {
        clearMarkers();
        for (const pin of pins) markers.push(addMapMarker(libraries, map, pin));
        lastPins = pinKey;
      }
      if (encodedPolyline !== lastLine) {
        setPolyline(encodedPolyline);
        lastLine = encodedPolyline;
      }
      const uniquePositions = new Map(pins.map(({ position }) => [`${position.lat}/${position.lng}`, position]));
      const coordinates = [...uniquePositions.keys()].sort().join(';');
      if (coordinates === lastCoordinates && (!path.length || fittedRoad)) return;
      lastCoordinates = coordinates;
      fittedRoad = path.length > 0;
      const positions = [...uniquePositions.values()];
      if (positions.length === 1 && !path.length) {
        callSdk(map, 'setCenter', positions[0]);
        callSdk(map, 'setZoom', 14);
      } else {
        const bounds = constructSdk(libraries.core, 'LatLngBounds');
        for (const position of [...positions, ...path]) callSdk(bounds, 'extend', position);
        callSdk(map, 'fitBounds', bounds, 52);
      }
    },
    destroy() {
      clearMarkers();
      if (line) callSdk(line, 'setMap', null);
      canvas.replaceChildren();
    },
  };
}

export function mountGoogleEntranceMap(
  canvas: HTMLElement, libraries: MapsLibraries, mapId: string, onPlacement: (position: MapPosition) => void,
) {
  const map = createMap(canvas, libraries, mapId, { center: { lat: 42.5, lng: 12.5 }, zoom: 5 });
  let entranceMarker: HTMLElement | null = null;
  let referenceMarker: HTMLElement | null = null;
  let focusKey = '';
  let lastReference = '';
  let lastEntrance = '';
  const clickListener = sdkObject(callSdk(map, 'addListener', 'click', (event: unknown) => {
    if (!event || typeof event !== 'object') return;
    const interaction = sdkMember(event, 'domEvent');
    if (interaction instanceof Event && interaction.target instanceof Node && referenceMarker?.contains(interaction.target)) return;
    const position = mapPosition(sdkMember(event, 'latLng'));
    if (position) onPlacement(position);
  }));

  function onDragEnd() {
    const position = entranceMarker && mapPosition(sdkMember(entranceMarker, 'position'));
    if (position) onPlacement(position);
  }

  function clearEntrance() {
    if (!entranceMarker) return;
    entranceMarker.removeEventListener('gmp-dragend', onDragEnd);
    Reflect.set(entranceMarker, 'map', null);
    entranceMarker = null;
  }

  function clearReference() {
    if (referenceMarker) Reflect.set(referenceMarker, 'map', null);
    referenceMarker = null;
  }

  return {
    update(entrance: MapPin | null, reference: MapPin | null) {
      const referenceKey = JSON.stringify(reference);
      const entranceKey = JSON.stringify(entrance);
      const referenceChanged = referenceKey !== lastReference;
      if (referenceChanged) {
        clearReference();
        if (reference) referenceMarker = addMapMarker(libraries, map, reference);
        lastReference = referenceKey;
      }
      if (entranceKey !== lastEntrance) {
        if (!entrance) clearEntrance();
        else if (entranceMarker) {
          if (!Reflect.set(entranceMarker, 'position', entrance.position)) throw invalidSdk();
        } else {
          entranceMarker = addMapMarker(libraries, map, entrance, true);
          entranceMarker.addEventListener('gmp-dragend', onDragEnd);
        }
        lastEntrance = entranceKey;
      }
      const focus = entrance ?? reference;
      if (focus && (!focusKey || (referenceChanged && !entrance))) {
        focusKey = JSON.stringify(focus.position);
        callSdk(map, 'setCenter', focus.position);
        callSdk(map, 'setZoom', 16);
      }
    },
    destroy() {
      callSdk(clickListener, 'remove');
      clearEntrance();
      clearReference();
      canvas.replaceChildren();
    },
  };
}
