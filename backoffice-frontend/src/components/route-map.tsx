'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GoogleMapsAuthenticationError, loadGoogleMaps, mountGoogleMap, onGoogleMapsAuthFailure, type MapPin } from '@/lib/google-maps';
import { Button } from './ui/button';
import { Card } from './ui/card';

type MapConfig = { key: string; mapId?: string | null };

export type RouteMapPoint = {
  id: string;
  label: string;
  point: { latitude: number; longitude: number } | null;
  kind: 'start' | 'stop' | 'return';
};

export function RouteMap({ config, points, encodedPolyline }: {
  config: MapConfig | null;
  points: readonly RouteMapPoint[];
  encodedPolyline: string | null;
}) {
  const t = useTranslations('routes');
  const start = points.find((point) => point.kind === 'start');
  const end = points.find((point) => point.kind === 'return');
  const roundTrip = start?.point && end?.point
    && start.point.latitude === end.point.latitude && start.point.longitude === end.point.longitude;
  const pins: MapPin[] = [];
  let stopNumber = 0;
  let missingCount = 0;
  for (const { kind, point, label } of points) {
    if (kind === 'stop') stopNumber += 1;
    if (!point) {
      missingCount += 1;
      continue;
    }
    if (kind === 'return' && roundTrip) continue;
    const name = label;
    const position = { lat: point.latitude, lng: point.longitude };
    if (kind === 'stop') {
      pins.push({ position, title: t('mapStopLabel', { position: stopNumber, name }), glyph: String(stopNumber), depot: false });
    } else {
      const title = t(roundTrip ? 'mapStartReturnLabel' : kind === 'start' ? 'mapStartLabel' : 'mapReturnLabel', { name });
      pins.push({ position, title, glyph: roundTrip ? '↔' : kind === 'start' ? '↗' : '↙', depot: true });
    }
  }
  return <Card className="grid min-w-0 gap-3 p-4 sm:p-5">
    <h2 className="text-base font-semibold">{t('mapTitle')}</h2>
    {!config ? <p className="text-sm text-muted-foreground">{t('mapMissingKey')}</p> : pins.length === 0
      ? <p className="text-sm text-muted-foreground">{t('mapNoLocations')}</p>
      : <GoogleRouteCanvas config={config} pins={pins} encodedPolyline={encodedPolyline} />}
    {config && missingCount > 0 ? <p className="text-xs text-muted-foreground">{t('mapMissingCoordinates', { count: missingCount })}</p> : null}
    {config && stopNumber > 0 && !encodedPolyline && pins.length > 0 ? <p className="text-xs text-muted-foreground">{t('mapNoRoute')}</p> : null}
  </Card>;
}

function GoogleRouteCanvas({ config, pins, encodedPolyline }: {
  config: MapConfig;
  pins: readonly MapPin[];
  encodedPolyline: string | null;
}) {
  const t = useTranslations('routes');
  const canvas = useRef<HTMLDivElement>(null);
  const [revision, retry] = useState(0);
  const [map, setMap] = useState<ReturnType<typeof mountGoogleMap> | null>(null);
  const [failure, setFailure] = useState<'load' | 'auth' | null>(null);
  const { key, mapId } = config;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active = true;
    let mounted: ReturnType<typeof mountGoogleMap> | undefined;
    const authUnsubscribe = onGoogleMapsAuthFailure(() => { if (active) setFailure('auth'); });
    void loadGoogleMaps(key).then((libraries) => {
      if (!active) return;
      mounted = mountGoogleMap(element, libraries, mapId ?? 'DEMO_MAP_ID');
      setMap(mounted);
    }).catch((error: unknown) => {
      if (active) setFailure((current) => current ?? (error instanceof GoogleMapsAuthenticationError ? 'auth' : 'load'));
    });
    return () => {
      active = false;
      authUnsubscribe();
      mounted?.destroy();
    };
  }, [key, mapId, revision]);

  useEffect(() => {
    if (!map || failure) return;
    try {
      map.update(pins, encodedPolyline);
    } catch {
      let outdated = false;
      queueMicrotask(() => { if (!outdated) setFailure((current) => current ?? 'load'); });
      return () => { outdated = true; };
    }
  }, [encodedPolyline, failure, map, pins]);

  const loading = !map && !failure;
  return <div className="relative min-w-0 overflow-hidden rounded-md border border-border bg-muted/40">
    <div ref={canvas} role="region" aria-label={t('mapCanvasLabel')} inert={loading || !!failure} className="h-72 w-full md:h-[22rem]" />
    {loading || failure ? <div className="absolute inset-0 grid place-content-center gap-3 bg-muted/95 p-4 text-center">
      <p role={failure ? 'alert' : 'status'} className="text-sm text-foreground">{t(failure ? 'mapUnavailable' : 'mapLoading')}</p>
      {failure === 'load' ? <Button type="button" variant="outline" size="sm" onClick={() => {
        setMap(null);
        setFailure(null);
        retry((value) => value + 1);
      }}>{t('mapRetry')}</Button> : null}
    </div> : null}
  </div>;
}
