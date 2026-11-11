'use client';

import { useEffect, useRef, useState } from 'react';
import { mountInboxLeafletMap, type InboxLeafletMap, type InboxMapCanvasLabels, type InboxMapPoint } from '@/lib/inbox-leaflet-map';
import type { InboxMapArea } from '@/lib/inbox-map-area';
import { Button } from './ui/button';

export type { InboxMapCanvasLabels, InboxMapPoint } from '@/lib/inbox-leaflet-map';

export function InboxMapCanvas({ points, filterKey, visible, onOpen, labels, area = null, onAreaChange, selectionDisabled = false }: {
  points: readonly InboxMapPoint[];
  filterKey: string;
  visible: boolean;
  onOpen: (id: string) => void;
  labels: InboxMapCanvasLabels;
  area?: InboxMapArea | null;
  onAreaChange?: (area: InboxMapArea) => void;
  selectionDisabled?: boolean;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  const [map, setMap] = useState<InboxLeafletMap | null>(null);
  const [revision, retry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [areaUnavailable, setAreaUnavailable] = useState(false);

  useEffect(() => { open.current = onOpen; }, [onOpen]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active = true;
    let mounted: InboxLeafletMap | undefined;
    void import('leaflet').then((leaflet) => {
      if (!active) return;
      mounted = mountInboxLeafletMap(element, leaflet, (id) => { open.current(id); }, (failure) => {
        if (active) setTilesFailed(failure);
      });
      setMap(mounted);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; mounted?.destroy(); };
  }, [revision]);

  useEffect(() => {
    if (!map || !visible || failed) return;
    try {
      map.resize();
      map.update(points, filterKey, labels);
      map.setArea(area);
    } catch {
      let active = true;
      queueMicrotask(() => { if (active) setFailed(true); });
      return () => { active = false; };
    }
  }, [area, failed, filterKey, labels, map, points, visible]);

  const loading = !map && !failed;
  return <div className="inbox-map-surface">
    <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border bg-card p-2">
      {onAreaChange ? <Button type="button" size="sm" className="mr-auto" disabled={!map || failed || !visible || selectionDisabled} onClick={() => {
        const bounds = map?.visibleArea();
        setAreaUnavailable(!bounds);
        if (bounds) onAreaChange(bounds);
      }}>{labels.useVisibleArea}</Button> : null}
      <Button type="button" variant="outline" size="sm" disabled={!map || failed} onClick={() => { map?.fit(); }}>{labels.fitAll}</Button>
      <Button type="button" variant="outline" size="sm" aria-label={labels.zoomIn} title={labels.zoomIn} disabled={!map || failed} onClick={() => { map?.zoomIn(); }}>+</Button>
      <Button type="button" variant="outline" size="sm" aria-label={labels.zoomOut} title={labels.zoomOut} disabled={!map || failed} onClick={() => { map?.zoomOut(); }}>−</Button>
    </div>
    {areaUnavailable ? <p role="status" className="px-3 py-2 text-xs text-destructive">{labels.areaUnavailable}</p> : null}
    <div className="relative">
      <div ref={canvas} className="inbox-leaflet-map" role="region" aria-label={labels.region} inert={loading || failed || !visible} />
      {loading || failed ? <div className="absolute inset-0 z-[500] grid place-content-center gap-3 bg-muted/95 p-5 text-center">
        <p role={failed ? 'alert' : 'status'}>{failed ? labels.loadError : labels.loading}</p>
        {failed ? <Button type="button" variant="outline" size="sm" onClick={() => {
          setMap(null); setFailed(false); setTilesFailed(false); retry((value) => value + 1);
        }}>{labels.retry}</Button> : null}
      </div> : null}
    </div>
    {tilesFailed && !failed ? <p role="status" className="inbox-map-tile-warning border-t border-border px-3 py-2 text-sm">{labels.tilesError}</p> : null}
  </div>;
}
