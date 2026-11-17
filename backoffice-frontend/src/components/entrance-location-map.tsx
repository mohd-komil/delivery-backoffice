'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { mountEntranceLeafletMap } from '@/lib/entrance-leaflet-map';
import type { EntrancePoint } from '@/lib/delivery-entrance';
import { Button } from './ui/button';

export function EntranceLocationMap({ entrance = null, reference, referenceLabel, disabled = false, onPlace, label }: {
  entrance?: EntrancePoint | null;
  reference: EntrancePoint | null;
  referenceLabel: string;
  disabled?: boolean;
  onPlace?: (point: EntrancePoint) => void;
  label?: string;
}) {
  const t = useTranslations('entranceReview');
  const canvas = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<ReturnType<typeof mountEntranceLeafletMap> | null>(null);
  const [revision, retry] = useState(0);
  const [failure, setFailure] = useState(false);
  const [tileFailure, setTileFailure] = useState(false);
  const place = useEffectEvent((point: EntrancePoint) => { if (!disabled) onPlace?.(point); });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active = true;
    let mounted: ReturnType<typeof mountEntranceLeafletMap> | undefined;
    void import('leaflet').then((leaflet) => {
      if (!active) return;
      mounted = mountEntranceLeafletMap(element, leaflet, place, (failed) => { if (active) setTileFailure(failed); });
      setMap(mounted);
    }).catch(() => { if (active) setFailure(true); });
    return () => { active = false; mounted?.destroy(); };
  }, [revision]);
  const entranceTitle = t('ownEntrance');
  const editable = !!onPlace && !disabled;
  useEffect(() => {
    map?.update(entrance ? { point: entrance, title: entranceTitle } : null,
      reference ? { point: reference, title: referenceLabel } : null, editable);
  }, [editable, entrance, entranceTitle, map, reference, referenceLabel]);
  const loading = !map && !failure;
  return <div className="space-y-2">
    <div className="relative min-w-0 overflow-hidden rounded-md border border-border bg-muted/40">
      <div className="flex justify-end gap-2 border-b border-border p-2">
        <Button type="button" variant="outline" size="sm" aria-label={t('zoomIn')} disabled={loading || failure} onClick={() => map?.zoomIn()}>+</Button>
        <Button type="button" variant="outline" size="sm" aria-label={t('zoomOut')} disabled={loading || failure} onClick={() => map?.zoomOut()}>−</Button>
      </div>
      <div ref={canvas} role="region" aria-label={label ?? t('mapLabel')} inert={loading || failure} className="entrance-leaflet-map h-56 w-full sm:h-72" />
      {loading || failure ? <div className="absolute inset-0 grid place-content-center gap-2 bg-muted/95 p-4 text-center">
        <p role={failure ? 'alert' : 'status'} className="text-sm">{t(failure ? 'mapUnavailable' : 'mapLoading')}</p>
        {failure ? <Button type="button" variant="outline" size="sm" onClick={() => {
          setMap(null); setFailure(false); retry((current) => current + 1);
        }}>{t('retryMap')}</Button> : null}
      </div> : null}
    </div>
    {tileFailure ? <p role="status" className="text-xs text-destructive">{t('tilesUnavailable')}</p> : null}
    {!failure && !loading && onPlace ? <p className="text-xs text-muted-foreground">{t('mapInstructions')}</p> : null}
    {reference || entrance ? <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {reference ? <li><span aria-hidden="true" className="mr-1 text-foreground">●</span>{t('suggestionReference')} · {referenceLabel}</li> : null}
      {entrance ? <li><span aria-hidden="true" className="mr-1 text-foreground">✓</span>{entranceTitle}</li> : null}
    </ul> : null}
  </div>;
}
