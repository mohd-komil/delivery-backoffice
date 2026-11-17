import type * as Leaflet from 'leaflet';
import type { EntrancePoint } from './delivery-entrance';
import { mapCoordinatesSchema } from './map-coordinates';
import { openStreetMapTiles } from './open-street-map';
import { installReducedMotionMapKeys } from './leaflet-reduced-motion';

export type EntranceMapPin = { point: EntrancePoint; title: string };

/** Keep the suggested address marker separate from the operator's unloading entrance. */
export function mountEntranceLeafletMap(
  element: HTMLElement, leaflet: typeof Leaflet,
  onPlace: (point: EntrancePoint) => void, onTileError: (failed: boolean) => void,
) {
  const map = leaflet.map(element, {
    zoomControl: false, attributionControl: true, keyboard: true,
    zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    minZoom: 3, maxZoom: 19, scrollWheelZoom: false, inertia: false,
  });
  const tiles = openStreetMapTiles(leaflet).addTo(map);
  const removeKeyboardHandler = installReducedMotionMapKeys(element, map);
  const failedTiles = new Set<string>();
  const tileKey = ({ x, y, z }: Leaflet.Coords) => `${z}/${x}/${y}`;
  let destroyed = false;
  tiles.on('tileerror', (event: Leaflet.TileErrorEvent) => {
    failedTiles.add(tileKey(event.coords));
    if (!destroyed) onTileError(true);
  });
  const clearTileFailure = (event: Leaflet.TileEvent) => {
    failedTiles.delete(tileKey(event.coords));
    if (!destroyed) onTileError(failedTiles.size > 0);
  };
  tiles.on('tileload', clearTileFailure);
  tiles.on('tileunload', clearTileFailure);
  let entrance: Leaflet.Marker | null = null;
  let reference: Leaflet.Marker | null = null;
  let referenceKey = '';
  let initialized = false;
  let editable = false;
  function place(position: Leaflet.LatLng) {
    if (!editable || destroyed) return;
    const point = mapCoordinatesSchema.safeParse({ latitude: position.lat, longitude: position.wrap().lng });
    if (point.success) onPlace(point.data);
  }
  map.on('click', (event: Leaflet.LeafletMouseEvent) => { place(event.latlng); });
  function pin(value: EntranceMapPin, own: boolean) {
    const glyph = document.createElement('span');
    glyph.className = 'inbox-map-pin-glyph';
    glyph.textContent = own ? '✓' : '•';
    glyph.setAttribute('aria-hidden', 'true');
    const marker = leaflet.marker([value.point.latitude, value.point.longitude], {
      title: value.title, alt: value.title, keyboard: true, draggable: own && editable,
      bubblingMouseEvents: false,
      icon: leaflet.divIcon({ html: glyph, className: 'inbox-map-pin', iconSize: [34, 34], iconAnchor: [17, 17] }),
    }).addTo(map);
    marker.getElement()?.setAttribute('aria-label', value.title);
    marker.getElement()?.setAttribute('data-location-kind', own ? 'entrance' : 'reference');
    // A reference marker handles its click; it must never bubble into an entrance placement.
    marker.on('click', () => undefined);
    if (own) marker.on('dragend', () => { place(marker.getLatLng()); });
    return marker;
  }
  function resize() {
    if (!destroyed && initialized) map.invalidateSize({ pan: false, animate: false });
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(element);
  return {
    update(own: EntranceMapPin | null, suggested: EntranceMapPin | null, allowEditing: boolean) {
      if (destroyed) return;
      editable = allowEditing;
      const nextReferenceKey = JSON.stringify(suggested);
      const changedReference = referenceKey !== nextReferenceKey;
      if (changedReference) {
        reference?.remove();
        reference = suggested ? pin(suggested, false) : null;
        referenceKey = nextReferenceKey;
      }
      if (own && !entrance) entrance = pin(own, true);
      else if (own && entrance) entrance.setLatLng([own.point.latitude, own.point.longitude]);
      else if (!own) { entrance?.remove(); entrance = null; }
      if (editable) entrance?.dragging?.enable(); else entrance?.dragging?.disable();
      const focus = own ?? suggested;
      if (!initialized || (changedReference && !own)) {
        map.setView(focus ? [focus.point.latitude, focus.point.longitude] : [41.9, 12.5], focus ? 17 : 5, { animate: false });
        initialized = true;
      }
      resize();
    },
    zoomIn() { if (!destroyed) map.zoomIn(1, { animate: false }); },
    zoomOut() { if (!destroyed) map.zoomOut(1, { animate: false }); },
    destroy() { destroyed = true; observer?.disconnect(); removeKeyboardHandler(); map.remove(); },
  };
}
