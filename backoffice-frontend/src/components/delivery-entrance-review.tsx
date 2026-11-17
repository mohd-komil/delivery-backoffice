'use client';

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';
import type { EntranceReviewData, EntranceReviewSave, EntranceSuggestion } from '@/lib/delivery-entrance';
import { coordinateFromText, mapCoordinatesSchema } from '@/lib/map-coordinates';
import { formatDateTime } from '@/lib/time';
import { EntranceLocationMap } from './entrance-location-map';
import { GeocodingAttribution } from './delivery-geocoding';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, useDialogState } from './ui/dialog';
import { Input } from './ui/input';
import { Field, Notice, Pending } from './ui';

type ReviewActions = {
  load: (signal: AbortSignal) => Promise<EntranceReviewData>;
  suggest: (addressKey: string, signal: AbortSignal) => Promise<EntranceSuggestion>;
  find?: (addressKey: string, signal: AbortSignal) => Promise<EntranceSuggestion>;
  save: (input: EntranceReviewSave) => Promise<EntranceReviewData>;
};

type Draft = { addressKey: string; latitude: string; longitude: string; confirmed: boolean };

const suggestionMessages = {
  exact: 'suggestionExact',
  approximate: 'suggestionApproximate',
  ambiguous: 'suggestionAmbiguous',
  not_found: 'suggestionNotFound',
  unconfigured: 'suggestionUnconfigured',
  unavailable: 'suggestionUnavailable',
  rate_limited: 'suggestionRateLimited',
  missing_address: 'suggestionMissingAddress',
  outside_demo: 'suggestionOutsideDemo',
  not_requested: 'suggestionNotRequested',
  invalid_address: 'suggestionInvalidAddress',
  pending: 'suggesting',
  quota_exceeded: 'suggestionQuotaExceeded',
} as const satisfies Record<EntranceSuggestion['status'], string>;

export function DeliveryEntranceReview({ load, suggest, find, save, disabled }: ReviewActions & { disabled?: boolean }) {
  const t = useTranslations('entranceReview');
  const [mounted, setMounted, open] = useDialogState<boolean>();

  return <Dialog open={open} onOpenChange={(next) => setMounted(next ? true : null)}>
    <DialogPrimitive.Trigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled}>{t('open')}</Button></DialogPrimitive.Trigger>
    {mounted ? <EntranceReviewEditor load={load} suggest={suggest} find={find} save={save} onClose={() => setMounted(null)} /> : null}
  </Dialog>;
}

function EntranceReviewEditor({ load, suggest, find, save, onClose }: ReviewActions & { onClose: () => void }) {
  const t = useTranslations('entranceReview');
  const locale = useLocale();
  const title = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  const helpId = useId();
  const errorId = useId();
  const [data, setData] = useState<EntranceReviewData | null>(null);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ revision: number; failed: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<{ pending: boolean; failure?: { cause: unknown } }>({ pending: false });
  const [manualRequest, setManualRequest] = useState<{ addressKey: string; attempt: number } | null>(null);
  const [resolved, setResolved] = useState<{ key: string; value: EntranceSuggestion | null } | null>(null);
  const requestAddress = useEffectEvent(load);
  const requestSuggestion = useEffectEvent(suggest);
  const findAddress = useEffectEvent(find ?? suggest);

  useEffect(() => {
    const controller = new AbortController();
    void requestAddress(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setLoaded({ revision, failed: false });
      },
      () => { if (!controller.signal.aborted) setLoaded({ revision, failed: true }); },
    );
    return () => controller.abort();
  }, [revision]);

  const saved = data?.stale ? null : data?.entrance;
  const referencePoint = data?.referencePoint;
  const completeAddress = !!data && Object.values(data.address).every((part) => !!part?.trim());
  const explicitRequest = manualRequest?.addressKey === data?.addressKey ? manualRequest : null;
  const suggestionAddressKey = completeAddress
    ? explicitRequest?.addressKey ?? (!saved && !referencePoint ? data?.addressKey : undefined)
    : undefined;
  const suggestionAttempt = explicitRequest?.attempt ?? 0;
  const suggestionKey = suggestionAddressKey ? `${suggestionAddressKey}/${suggestionAttempt}` : '';
  useEffect(() => {
    if (!suggestionAddressKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (suggestionAttempt > 0 ? findAddress(suggestionAddressKey, controller.signal) : requestSuggestion(suggestionAddressKey, controller.signal)).then(
        (value) => {
          if (controller.signal.aborted) return;
          setResolved({ key: suggestionKey, value: value.addressKey === suggestionAddressKey ? value : null });
        },
        () => { if (!controller.signal.aborted) setResolved({ key: suggestionKey, value: null }); },
      );
    }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [suggestionAddressKey, suggestionKey, suggestionAttempt]);

  const loading = loaded?.revision !== revision;
  const activeDraft = draft?.addressKey === data?.addressKey ? draft : null;
  const latitude = activeDraft?.latitude ?? (saved ? String(saved.point.latitude) : '');
  const longitude = activeDraft?.longitude ?? (saved ? String(saved.point.longitude) : '');
  const parsed = mapCoordinatesSchema.safeParse({ latitude: coordinateFromText(latitude), longitude: coordinateFromText(longitude) });
  const invalid = !!(latitude.trim() || longitude.trim()) && !parsed.success;
  const point = parsed.success ? parsed.data : null;
  const changed = point !== null && (!saved || point.latitude !== saved.point.latitude || point.longitude !== saved.point.longitude);
  const conflict = saveState.failure?.cause instanceof ApiError && saveState.failure.cause.status === 409;
  const canSave = !!(point && activeDraft?.confirmed && changed && completeAddress && !loading && !loaded?.failed && !conflict);
  const suggesting = !!suggestionKey && resolved?.key !== suggestionKey;
  const suggestion = suggestionKey && resolved?.key === suggestionKey ? resolved.value : null;
  const reference = referencePoint ?? suggestion?.point ?? null;
  const referenceLabel = t(data?.referenceGeocoding || suggestion?.source === 'geoapify' ? 'geoapifyReference' : referencePoint || suggestion?.source === 'source' ? 'sourceReference' : 'providerReference');
  const attribution = data?.referenceGeocoding?.attribution ?? (suggestion?.point ? suggestion.attribution : undefined);

  function updateDraft(changes: Partial<Pick<Draft, 'latitude' | 'longitude' | 'confirmed'>>) {
    if (!data || savingRef.current) return;
    setDraft({ addressKey: data.addressKey, latitude, longitude, confirmed: false, ...changes });
    if (!conflict) setSaveState({ pending: false });
  }

  function refresh() {
    setDraft((current) => current ? { ...current, confirmed: false } : null);
    setSaveState({ pending: false });
    setRevision((current) => current + 1);
  }

  async function confirm() {
    if (savingRef.current || !canSave || !point || !data) return;
    savingRef.current = true;
    setSaveState({ pending: true });
    try {
      await save({ addressKey: data.addressKey, deliveryVersion: data.deliveryVersion, version: saved?.version ?? null, point, confirmed: true });
      toast.success(t('savedToast'));
      onClose();
    } catch (cause: unknown) {
      setSaveState({ pending: false, failure: { cause } });
    } finally {
      savingRef.current = false;
    }
  }

  return <DialogContent
    className="top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl p-4 sm:p-6"
    onOpenAutoFocus={(event) => {
      if (!title.current) return;
      event.preventDefault();
      title.current.focus();
    }}
    onEscapeKeyDown={(event) => { if (savingRef.current) event.preventDefault(); }}
    onInteractOutside={(event) => { if (savingRef.current) event.preventDefault(); }}
  >
    <div className="mb-4 space-y-1">
      <DialogTitle asChild><h2 ref={title} tabIndex={-1} className="text-lg font-semibold">{t('title')}</h2></DialogTitle>
      <DialogPrimitive.Description className="text-sm text-muted-foreground">{t('description')}</DialogPrimitive.Description>
    </div>
    {loading ? <Pending>{t('loading')}</Pending> : null}
    {!loading && loaded?.failed ? <Notice tone="error"><div className="flex flex-wrap items-center justify-between gap-2"><span>{t('loadFailed')}</span><Button type="button" variant="outline" size="sm" onClick={refresh}>{t('retry')}</Button></div></Notice> : null}
    {data ? <div className="space-y-4">
      <section aria-label={t('sourceAddress')} className="rounded-md border border-border bg-muted/40 p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('sourceAddress')}</p>
        <p className="mt-1 text-sm font-medium">{[data.address.street, data.address.city, data.address.country].filter(Boolean).join(', ') || t('suggestionMissingAddress')}</p>
        <p className={`mt-1 text-xs ${saved ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{t(saved ? 'saved' : data.stale ? 'stale' : 'noSaved')}</p>
        {saved ? <p className="mt-1 text-xs text-muted-foreground">{t('savedAt', { date: formatDateTime(saved.confirmedAt, locale), name: saved.confirmedBy.name })}</p> : null}
      </section>
      {draft && !activeDraft ? <Notice>{t('addressChanged')}</Notice> : null}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted-foreground">
            {!completeAddress ? t('suggestionMissingAddress') : suggesting ? t('suggesting') : referencePoint ? t('suggestionApproximate') : suggestion ? t(suggestionMessages[suggestion.status]) : suggestionKey && resolved ? t('suggestionLoadFailed') : null}
          </p>
          {!referencePoint && completeAddress ? <Button
            type="button" variant="outline" size="sm" disabled={suggesting || loading || saveState.pending}
            onClick={() => setManualRequest((current) => ({ addressKey: data.addressKey, attempt: (current?.attempt ?? 0) + 1 }))}
          >{t('suggest')}</Button> : null}
        </div>
        <EntranceLocationMap
          entrance={point} reference={reference} referenceLabel={referenceLabel}
          disabled={saveState.pending || loading}
          onPlace={(next) => updateDraft({ latitude: next.latitude.toFixed(7), longitude: next.longitude.toFixed(7) })}
        />
        {data.referenceGeocoding || suggestion?.source === 'geoapify' ? <GeocodingAttribution /> : null}
        {attribution ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{attribution}</p> : null}
      </div>
      <fieldset disabled={saveState.pending || loading} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('latitude')}><Input inputMode="decimal" value={latitude} maxLength={20}
            aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : helpId}
            onChange={(event) => updateDraft({ latitude: event.target.value })}
          /></Field>
          <Field label={t('longitude')}><Input inputMode="decimal" value={longitude} maxLength={20}
            aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : helpId}
            onChange={(event) => updateDraft({ longitude: event.target.value })}
          /></Field>
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">{t('coordinatesHelp')}</p>
        {invalid ? <p id={errorId} role="status" className="text-xs text-destructive">{t('invalidCoordinates')}</p> : null}
        <label className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <Input type="checkbox" className="mt-0.5" disabled={!completeAddress || !point || !changed || conflict}
            checked={activeDraft?.confirmed ?? false}
            onChange={(event) => updateDraft({ confirmed: event.target.checked })}
          />
          <span>{t('confirmation')}</span>
        </label>
      </fieldset>
      {saveState.failure ? <Notice tone="error"><div className="flex flex-wrap items-center justify-between gap-2">
        <span>{conflict ? t('saveConflict') : errorMessage(saveState.failure.cause, locale)}</span>
        {conflict ? <Button type="button" variant="outline" size="sm" onClick={refresh}>{t('retry')}</Button> : null}
      </div></Notice> : null}
    </div> : null}
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" disabled={saveState.pending} onClick={onClose}>{t('cancel')}</Button>
      <Button type="button" disabled={!canSave || saveState.pending} onClick={() => { void confirm(); }}>{t(saveState.pending ? 'saving' : 'save')}</Button>
    </div>
  </DialogContent>;
}
