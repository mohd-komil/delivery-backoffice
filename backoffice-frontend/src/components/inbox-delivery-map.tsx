'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { apiRequest, errorMessage } from '@/lib/api';
import { inboxMapSchema, type InboxMapData, type MapDelivery } from '@/lib/inbox-map';
import { inboxMapViewportKey, type InboxMapArea } from '@/lib/inbox-map-area';
import { InboxMapCanvas } from './inbox-map-canvas';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Empty } from './ui';

export function InboxDeliveryMap({ query, refreshKey, visible, onOpen, area = null, onAreaChange }: {
  query: string; refreshKey: number; visible: boolean; onOpen: (id: string) => void;
  area?: InboxMapArea | null; onAreaChange?: (area: InboxMapArea | null) => void;
}) {
  const t = useTranslations('inboxMap');
  const locale = useLocale();
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{ query: string; data: InboxMapData } | null>(null);
  const [settled, setSettled] = useState<{ query: string; refreshKey: number; retry: number; error: unknown } | null>(null);
  const current = snapshot?.query === query;
  const busy = visible && (settled?.query !== query || settled.refreshKey !== refreshKey || settled.retry !== retry);
  const error = !busy && settled?.query === query ? settled.error : null;

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void apiRequest(`/deliveries/map?view=inbox${query ? `&${query}` : ''}`, inboxMapSchema, { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setSnapshot({ query, data });
        setSettled({ query, refreshKey, retry, error: null });
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setSettled({ query, refreshKey, retry, error: failure });
      },
    );
    return () => controller.abort();
  }, [query, refreshKey, retry, visible]);

  const data = snapshot?.data;
  const points = useMemo(() => data?.markers.map((marker) => ({
    deliveryId: marker.deliveryId, pickingName: marker.pickingName, customerName: marker.customerName,
    latitude: marker.point.latitude, longitude: marker.point.longitude,
  })) ?? [], [data]);
  const labels = useMemo(() => ({
    region: t('canvas'), loading: t('loadingMap'), loadError: t('loadError'), tilesError: t('tilesError'),
    retry: t('retry'), zoomIn: t('zoomIn'), zoomOut: t('zoomOut'), fitAll: t('fitAll'), closePopup: t('closePopup'),
    useVisibleArea: t('useVisibleArea'), areaUnavailable: t('areaUnavailable'),
    openDelivery: (picking: string) => t('openDelivery', { picking }),
    groupedDeliveries: (count: number) => t('groupedDeliveries', { count }),
  }), [t]);

  return <section hidden={!visible} aria-label={t('title')} className="mb-6 min-w-0">
    <Card className="min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 max-w-3xl text-xs text-muted-foreground">{t('description')}</p></div>
        {current && data ? <p className="text-xs tabular-nums text-muted-foreground">{t('counts', { mapped: data.mappedCount, total: data.total })}</p> : null}
      </div>
      {onAreaChange ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <div><p className="font-medium">{t(area ? 'areaActive' : 'areaHelp')}</p>
          {area && current && data?.area ? <p className="mt-1 text-muted-foreground">{t('excludedMissing', { count: data.area.excludedMissingCoordinates })}</p> : null}</div>
        {area ? <Button type="button" variant="outline" size="sm" onClick={() => onAreaChange(null)}>{t('clearArea')}</Button> : null}
      </div> : null}
      <div role="status" aria-live="polite" className="flex min-h-8 items-center gap-3 text-xs">
        {error ? <><p className="flex-1 text-destructive">{errorMessage(error, locale)} {t(snapshot ? 'stale' : 'unavailable')}</p><Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button></>
          : <p className="text-muted-foreground">{busy ? t(snapshot ? 'refreshing' : 'loading') : t('interactionHint')}</p>}
      </div>
      {!snapshot ? <div className="grid min-h-72 place-items-center rounded-md border border-border bg-muted/30 p-5 text-center text-sm text-muted-foreground">{t(busy ? 'loading' : 'unavailable')}</div> : null}
      {snapshot ? <div className="relative" aria-busy={busy}>
        <div inert={!current} className={!current ? 'opacity-35' : ''}>
          <div hidden={data?.mappedCount === 0 && !onAreaChange}>
            <InboxMapCanvas points={points} filterKey={inboxMapViewportKey(snapshot.query)} visible={visible && current && ((data?.mappedCount ?? 0) > 0 || !!onAreaChange)} onOpen={onOpen} labels={labels}
              area={area} onAreaChange={onAreaChange} selectionDisabled={!current || busy || !!error} />
          </div>
          {data?.total === 0 ? <Empty title={t('empty')}>{t('emptyHelp')}</Empty> : data?.mappedCount === 0 ? <Empty title={t('noCoordinates')}>{t('noCoordinatesHelp')}</Empty> : null}
          {data && data.missingCount > 0 ? <section aria-label={t('missingTitle')} className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <h3 className="text-sm font-medium">{t('missingTitle')} · {data.missingCount}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('missingHelp')}</p>
            <MapDeliveryList deliveries={data.missingCoordinates} onOpen={onOpen} />
          </section> : null}
          {data && data.mappedCount > 0 ? <details className="mt-4 rounded-md border border-border p-3">
            <summary className="cursor-pointer text-xs font-medium">{t('allDeliveries', { count: data.mappedCount })}</summary>
            <MapDeliveryList deliveries={data.markers} onOpen={onOpen} />
          </details> : null}
        </div>
        {!current ? <div className="absolute inset-0 grid place-items-center rounded-md bg-background/60 p-4 text-center text-sm" role="status">{t(error ? 'changedFiltersError' : 'refreshing')}</div> : null}
      </div> : null}
      <p className="text-xs text-muted-foreground">{t('demoHint')}</p>
    </Card>
  </section>;
}

function MapDeliveryList({ deliveries, onOpen }: { deliveries: readonly MapDelivery[]; onOpen: (id: string) => void }) {
  const t = useTranslations('inboxMap');
  return <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
    {deliveries.map((delivery) => <li key={delivery.deliveryId}>
      <button type="button" aria-label={t('openDelivery', { picking: delivery.pickingName })} onClick={() => onOpen(delivery.deliveryId)} className="w-full rounded-md p-2 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">{delivery.pickingName}</span><span className="ml-2 text-muted-foreground">{delivery.customerName}</span>
        <span className="mt-1 block text-muted-foreground">{[delivery.address, delivery.geography.city, delivery.geography.province, delivery.geography.postalCode].filter(Boolean).join(', ') || t('addressMissing')}</span>
      </button>
    </li>)}
  </ul>;
}
