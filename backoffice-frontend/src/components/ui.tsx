'use client';

import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';
import { Button } from './ui/button';

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon" aria-hidden="true">↗</span><h3>{title}</h3>{children ? <p>{children}</p> : null}</div>;
}

export function Pending({ children }: { children?: ReactNode }) {
  const t = useTranslations('common');
  return <div className="pending" role="status"><span className="spinner" />{children ?? t('loadingWorkspace')}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

export function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return <fieldset className="field"><legend>{label}</legend>{children}</fieldset>;
}

export function ActionForm({ onSubmit, children, submitLabel, successMessage, secondary = false, disabled = false, submitDisabled = false, dataVersion, onResetDraft, followLatestWhenUntouched = false }: {
  onSubmit: (data: FormData) => Promise<void | number>;
  children: ReactNode;
  submitLabel: string;
  successMessage?: string;
  secondary?: boolean;
  disabled?: boolean;
  submitDisabled?: boolean;
  dataVersion?: number;
  onResetDraft?: () => void;
  /** Safe for drafts captured by field change events. */
  followLatestWhenUntouched?: boolean;
}) {
  const t = useTranslations('common');
  const locale = useLocale();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ kind: 'stale' } | { kind: 'submission'; failure: unknown } | null>(null);
  const [draftVersion, setDraftVersion] = useState(followLatestWhenUntouched ? undefined : dataVersion);
  const [resetCount, setResetCount] = useState(0);
  const submitting = useRef(false);
  const formVersion = followLatestWhenUntouched ? draftVersion ?? dataVersion : draftVersion;
  const stale = dataVersion !== undefined && formVersion !== dataVersion;

  function retainDraftVersion() {
    setDraftVersion((version) => version ?? dataVersion);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (stale) { setError({ kind: 'stale' }); return; }
    if (disabled || submitDisabled) return;
    const data = new FormData(event.currentTarget);
    submitting.current = true;
    setSaving(true); setError(null);
    try {
      const savedVersion = await onSubmit(data);
      if (followLatestWhenUntouched) setDraftVersion(undefined);
      else if (typeof savedVersion === 'number') setDraftVersion(savedVersion);
      toast.success(successMessage ?? t('saved'));
    } catch (failure) {
      if (failure instanceof TypeError || (failure instanceof ApiError && ![400, 401, 409, 422].includes(failure.status))) {
        toast.error(errorMessage(failure, locale));
      } else {
        setError({ kind: 'submission', failure });
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return <form onSubmit={(event) => { void submit(event); }} className="action-form">
    <fieldset key={followLatestWhenUntouched ? `${resetCount}:${formVersion}` : resetCount} disabled={saving || disabled}
      onChangeCapture={followLatestWhenUntouched ? retainDraftVersion : undefined}>{children}</fieldset>
    {stale ? <Notice>{t('newerRecord')} <Button type="button" variant="outline" disabled={saving} onClick={() => { if (submitting.current) return; onResetDraft?.(); setDraftVersion(followLatestWhenUntouched ? undefined : dataVersion); setResetCount((value) => value + 1); setError(null); }}>{t('latestData')}</Button></Notice> : null}
    {error ? <Notice tone="error">{error.kind === 'stale' ? t('changedBeforeSave') : errorMessage(error.failure, locale)}</Notice> : null}
    <div className="form-actions"><Button variant={secondary ? 'outline' : 'default'} disabled={saving || disabled || submitDisabled} type="submit">{saving ? t('saving') : submitLabel}</Button></div>
  </form>;
}

export function textField(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== 'string') throw new Error(`Missing ${name}.`);
  return value.trim();
}

export function optionalText(data: FormData, name: string): string | null {
  return textField(data, name) || null;
}
