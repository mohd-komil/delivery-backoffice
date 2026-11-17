import type { Map as LeafletMap } from 'leaflet';

export function installReducedMotionMapKeys(element: HTMLElement, map: LeafletMap) {
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== element || event.altKey || event.ctrlKey || event.metaKey
      || typeof window.matchMedia !== 'function' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault(); event.stopPropagation();
    const factor = event.shiftKey ? 3 : 1;
    map.panBy([offset[0] * factor, offset[1] * factor], { animate: false });
  };
  element.addEventListener('keydown', onKey);
  return () => element.removeEventListener('keydown', onKey);
}
