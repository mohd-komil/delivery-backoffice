import type * as Leaflet from 'leaflet';

/** Interactive tiles only: browser caching, attribution and referrer are retained. */
export function openStreetMapTiles(leaflet: typeof Leaflet) {
  return leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, noWrap: true, updateWhenIdle: true, keepBuffer: 1,
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  });
}
