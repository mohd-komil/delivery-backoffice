import type * as Leaflet from 'leaflet';
import { normalizeInboxMapArea, type InboxMapArea } from './inbox-map-area';

export type InboxMapPoint = {
  deliveryId: string;
  pickingName: string;
  customerName: string;
  latitude: number;
  longitude: number;
};

export type InboxMapCanvasLabels = {
  region: string;
  loading: string;
  loadError: string;
  tilesError: string;
  retry: string;
  zoomIn: string;
  zoomOut: string;
  fitAll: string;
  closePopup: string;
  useVisibleArea: string;
  areaUnavailable: string;
  openDelivery: (picking: string) => string;
  groupedDeliveries: (count: number) => string;
};

type PointGroup = { key: string; points: InboxMapPoint[] };

function groupPoints(points: readonly InboxMapPoint[]): PointGroup[] {
  const groups = new Map<string, InboxMapPoint[]>();
  for (const point of [...points].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId))) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
      || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      throw new Error('Invalid map coordinates');
    }
    const key = `${point.latitude},${point.longitude}`;
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return [...groups].map(([key, grouped]) => ({ key, points: grouped }));
}

function markerTitle(points: readonly InboxMapPoint[], labels: InboxMapCanvasLabels): string {
  const first = points[0];
  return points.length > 1 ? labels.groupedDeliveries(points.length)
    : first ? `${labels.openDelivery(first.pickingName)} · ${first.customerName}` : '';
}

function popupContent(points: readonly InboxMapPoint[], labels: InboxMapCanvasLabels, onOpen: (id: string) => void): HTMLElement {
  const content = document.createElement('div');
  content.className = 'inbox-map-popup';
  const heading = document.createElement('p');
  heading.className = 'inbox-map-popup-heading';
  heading.textContent = labels.groupedDeliveries(points.length);
  content.append(heading);
  const list = document.createElement('ul');
  for (const point of points) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inbox-map-popup-job';
    button.dataset.deliveryId = point.deliveryId;
    button.setAttribute('aria-label', `${labels.openDelivery(point.pickingName)} · ${point.customerName}`);
    const picking = document.createElement('strong');
    picking.textContent = point.pickingName;
    const customer = document.createElement('span');
    customer.textContent = point.customerName;
    button.append(picking, customer);
    button.addEventListener('click', () => { onOpen(point.deliveryId); });
    item.append(button);
    list.append(item);
  }
  content.append(list);
  return content;
}

/** Leaflet is supplied only after a browser-side import; this module is safe to import during SSR. */
export function mountInboxLeafletMap(
  element: HTMLElement,
  leaflet: typeof Leaflet,
  onOpen: (id: string) => void,
  onTileError: (failed: boolean) => void,
) {
  const map = leaflet.map(element, {
    zoomControl: false, attributionControl: true, keyboard: true,
    // Predictable viewport updates also respect reduced-motion preferences.
    zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    minZoom: 3, maxZoom: 19, scrollWheelZoom: false, inertia: false,
  });
  const reducedMotionKeyboard = (event: KeyboardEvent) => {
    if (event.target !== element || event.altKey || event.ctrlKey || event.metaKey
      || typeof window.matchMedia !== 'function' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = event.shiftKey ? 3 : 1;
    map.panBy([offset[0] * factor, offset[1] * factor], { animate: false });
  };
  element.addEventListener('keydown', reducedMotionKeyboard);
  // Browser-native caching/referer; only tiles required by the current interactive view are loaded.
  const tiles = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, noWrap: true, updateWhenIdle: true, keepBuffer: 1,
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  });
  const failedTiles = new Set<string>();
  let destroyed = false;
  const tileKey = ({ x, y, z }: Leaflet.Coords) => `${z}/${x}/${y}`;
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
  tiles.addTo(map);
  const markers = leaflet.layerGroup().addTo(map);
  let currentPoints: readonly InboxMapPoint[] = [];
  let currentFilterKey: string | null = null;
  let renderedSignature: string | null = null;
  let openGroupKey: string | null = null;
  let initialized = false;
  let areaOverlay: Leaflet.Rectangle | null = null;
  let currentAreaSignature: string | null = null;

  function keepPopupVisible(popup: Leaflet.Popup | undefined): void {
    if (!popup) return;
    if (element.clientWidth > 0) {
      // Leave room for Leaflet's content margins and 12px padding on both sides.
      const maxWidth = Math.max(1, Math.min(300, element.clientWidth - 56));
      popup.options.maxWidth = maxWidth;
      popup.options.minWidth = Math.min(220, maxWidth);
      popup.update();
    }
    const popupElement = popup.getElement();
    if (!popupElement) return;
    const popupBounds = popupElement.getBoundingClientRect();
    const mapBounds = element.getBoundingClientRect();
    if (!mapBounds.width || !mapBounds.height || !popupBounds.width || !popupBounds.height) return;
    const padding = 12;
    const x = popupBounds.left < mapBounds.left + padding ? popupBounds.left - mapBounds.left - padding
      : Math.max(0, popupBounds.right - mapBounds.right + padding);
    const y = popupBounds.top < mapBounds.top + padding ? popupBounds.top - mapBounds.top - padding
      : Math.max(0, popupBounds.bottom - mapBounds.bottom + padding);
    if (x || y) map.panBy([x, y], { animate: false });
  }

  function fit(): void {
    if (destroyed) return;
    map.closePopup();
    openGroupKey = null;
    if (!currentPoints.length) map.setView([41.9, 12.5], 5, { animate: false });
    else map.fitBounds(leaflet.latLngBounds(currentPoints.map((point) => leaflet.latLng(point.latitude, point.longitude))), {
      padding: [36, 36], maxZoom: 14, animate: false,
    });
    initialized = true;
  }

  function resize(): void {
    if (!destroyed && initialized) map.invalidateSize({ pan: false, animate: false, debounceMoveend: true });
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (element.clientWidth > 0 && element.clientHeight > 0) resize();
  });
  observer?.observe(element);

  return {
    update(points: readonly InboxMapPoint[], filterKey: string, labels: InboxMapCanvasLabels): void {
      if (destroyed) return;
      const groups = groupPoints(points);
      currentPoints = points;
      const filterChanged = currentFilterKey !== filterKey;
      if (!initialized || filterChanged) fit();
      currentFilterKey = filterKey;
      // Refreshing identical data keeps marker elements, popup selection and map viewport intact.
      const signature = JSON.stringify(groups.map(({ key, points: grouped }) => ({ key,
        title: markerTitle(grouped, labels), closePopup: labels.closePopup,
        points: grouped.map((point) => ({ ...point, openLabel: labels.openDelivery(point.pickingName) })),
      })));
      if (signature === renderedSignature) return;
      const previousOpenGroup = openGroupKey;
      markers.clearLayers();
      for (const { key, points: grouped } of groups) {
        const first = grouped[0];
        if (!first) continue;
        const glyph = document.createElement('span');
        glyph.className = 'inbox-map-pin-glyph';
        glyph.textContent = grouped.length > 1 ? String(grouped.length) : '•';
        glyph.setAttribute('aria-hidden', 'true');
        const title = markerTitle(grouped, labels);
        const marker = leaflet.marker([first.latitude, first.longitude], {
          title, alt: title, keyboard: true, riseOnHover: true,
          icon: leaflet.divIcon({ html: glyph, className: 'inbox-map-pin', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18] }),
        }).addTo(markers);
        const markerElement = marker.getElement();
        markerElement?.setAttribute('aria-label', title);
        markerElement?.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          if (grouped.length === 1) onOpen(first.deliveryId);
          else marker.togglePopup();
        });
        if (grouped.length === 1) marker.on('click', () => { onOpen(first.deliveryId); });
        else {
          marker.bindPopup(popupContent(grouped, labels, onOpen), { maxWidth: 300, minWidth: 220, autoPan: false });
          marker.on('popupopen', () => {
            openGroupKey = key;
            const close = marker.getPopup()?.getElement()?.querySelector('.leaflet-popup-close-button');
            close?.setAttribute('aria-label', labels.closePopup);
            close?.setAttribute('title', labels.closePopup);
            keepPopupVisible(marker.getPopup());
          });
          marker.on('popupclose', () => { if (openGroupKey === key) openGroupKey = null; });
          if (key === previousOpenGroup) marker.openPopup();
        }
      }
      renderedSignature = signature;
    },
    fit,
    resize,
    visibleArea(): InboxMapArea | null {
      if (destroyed || !initialized || element.clientWidth <= 0 || element.clientHeight <= 0) return null;
      const bounds = map.getBounds();
      return normalizeInboxMapArea({ north: bounds.getNorth(), south: bounds.getSouth(), east: bounds.getEast(), west: bounds.getWest() });
    },
    setArea(area: InboxMapArea | null): void {
      if (destroyed || !initialized) return;
      const signature = JSON.stringify(area);
      if (signature === currentAreaSignature) return;
      currentAreaSignature = signature;
      if (!area) {
        areaOverlay?.remove();
        areaOverlay = null;
        return;
      }
      const bounds = leaflet.latLngBounds([area.south, area.west], [area.north, area.east]);
      if (areaOverlay) areaOverlay.setBounds(bounds);
      else {
        const renderer = leaflet.svg();
        if (renderer) areaOverlay = leaflet.rectangle(bounds, {
          renderer, interactive: false, color: 'var(--info-foreground)', weight: 2,
          fillOpacity: 0.06, dashArray: '6 5',
        }).addTo(map);
      }
    },
    zoomIn(): void { if (!destroyed && initialized) map.zoomIn(1, { animate: false }); },
    zoomOut(): void { if (!destroyed && initialized) map.zoomOut(1, { animate: false }); },
    destroy(): void {
      destroyed = true;
      element.removeEventListener('keydown', reducedMotionKeyboard);
      observer?.disconnect();
      map.remove();
    },
  };
}

export type InboxLeafletMap = ReturnType<typeof mountInboxLeafletMap>;
