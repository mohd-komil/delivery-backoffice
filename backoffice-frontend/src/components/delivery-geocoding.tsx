'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { apiRequest, ApiError, errorMessage, mutate } from '@/lib/api';
import { deliveryGeocodingSchema, type DeliveryGeocoding as GeocodingRecord } from '@/lib/delivery-geocoding';
import { formatDateTime } from '@/lib/time';
import { EntranceLocationMap } from './entrance-location-map';
import { Button } from './ui/button';
import { Notice } from './ui';

export function GeocodingAttribution() {
  return <span className="text-xs text-muted-foreground"><a href="https://www.geoapify.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Powered by Geoapify</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">OpenStreetMap</a></span>;
}

export function DeliveryGeocoding({ deliveryId, revision, onChanged }: {
  deliveryId: string; revision: string; onChanged: () => void;
}) {
  const t = useTranslations('geocoding');
  const locale = useLocale();
  const resource = `/deliveries/${encodeURIComponent(deliveryId)}/geocoding`;
  const [snapshot, setSnapshot] = useState<{ resource: string; record: GeocodingRecord } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [settled, setSettled] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [operation, setOperation] = useState<'lookup' | 'accept' | null>(null);
  const submitting = useRef(false);
  const generation = useRef(0);
  const lifecycle = useRef({ active: true });
  const read = useRef<AbortController | null>(null);
  const key = `${resource}:${revision}:${refresh}`;
  const record = snapshot?.resource === resource ? snapshot.record : null;
  const loading = settled !== key;
  const conflict = failure?.cause instanceof ApiError && failure.cause.status === 409;

  useEffect(() => {
    const lifetime = { active: true };
    lifecycle.current = lifetime;
    const controller = new AbortController();
    const current = ++generation.current;
    read.current = controller;
    void apiRequest(resource, deliveryGeocodingSchema, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setSnapshot({ resource, record: value }); setFailure(null); setSettled(key);
    }, (cause: unknown) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setFailure({ cause }); setSettled(key);
    });
    return () => { lifetime.active = false; controller.abort(); };
  }, [key, resource]);

  async function submit(action: 'lookup' | 'accept') {
    if (!record || loading || submitting.current || conflict) return;
    if (action === 'accept' && (record.status !== 'review_required' || record.recordVersion === null)) return;
    submitting.current = true;
    const current = ++generation.current;
    const lifetime = lifecycle.current;
    read.current?.abort();
    setOperation(action); setFailure(null);
    try {
      const body = { deliveryVersion: record.deliveryVersion, addressKey: record.addressKey,
        ...(action === 'accept' ? { recordVersion: record.recordVersion } : {}) };
      const value = await mutate(`${resource}${action === 'accept' ? '/accept' : ''}`, deliveryGeocodingSchema, body);
      if (!lifetime.active || current !== generation.current) return;
      setSnapshot({ resource, record: value });
      if (value.status === 'accepted') { toast.success(t('savedToast')); onChanged(); }
    } catch (cause: unknown) {
      if (lifetime.active && current === generation.current) setFailure({ cause });
    } finally { submitting.current = false; setOperation(null); }
  }

  return <section aria-label={t('title')} className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="text-sm font-medium">{t('title')}</h4>
        <p role="status" className="mt-1 text-xs text-muted-foreground">{loading && !record ? t('loading') : record ? t(record.reason === 'source_review' ? 'sourceReview' : record.status) : t('loadFailed')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {record?.status !== 'accepted' && record?.status !== 'review_required' ? <Button type="button" size="sm"
          disabled={loading || operation !== null || !record?.configured || record.status === 'pending' || record.status === 'invalid_address' || conflict}
          onClick={() => { void submit('lookup'); }}>{t(operation === 'lookup' ? 'locating' : 'locate')}</Button> : null}
        <Button type="button" size="sm" variant="outline" disabled={loading || operation !== null} onClick={() => setRefresh((value) => value + 1)}>{t('refresh')}</Button>
      </div>
    </div>
    {record?.retryAt ? <p className="text-xs text-muted-foreground">{t('retryAt', { date: formatDateTime(record.retryAt, locale) })}</p> : null}
    {failure ? <Notice tone="error">{conflict ? t('conflict') : errorMessage(failure.cause, locale)}</Notice> : null}
    {record?.candidate ? <div className="space-y-2">
      <p className="text-sm font-medium [overflow-wrap:anywhere]">{record.candidate.formattedAddress}</p>
      <p className="text-xs text-muted-foreground">{t('precision', { precision: t(record.candidate.precision) })} · {record.candidate.point.latitude.toFixed(6)}, {record.candidate.point.longitude.toFixed(6)}</p>
      <p className="text-xs text-muted-foreground">{t(record.acceptance === 'automatic' ? 'automatic' : record.acceptance === 'operator' ? 'operator' : 'candidateOnly')}</p>
      <EntranceLocationMap reference={record.candidate.point} referenceLabel="Geoapify" label={t('mapLabel')} />
      {record.status === 'review_required' ? <div className="space-y-2 rounded-md border border-border bg-background p-3">
        <p className="text-xs">{t('reviewHelp')}</p>
        <Button type="button" size="sm" disabled={loading || operation !== null || conflict} onClick={() => { void submit('accept'); }}>{t(operation === 'accept' ? 'saving' : 'accept')}</Button>
      </div> : null}
      <GeocodingAttribution />
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{record.candidate.attribution}</p>
    </div> : null}
    <p className="text-xs text-muted-foreground">{t('entranceSeparate')}</p>
  </section>;
}
