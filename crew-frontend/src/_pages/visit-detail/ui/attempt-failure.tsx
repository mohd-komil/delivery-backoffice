'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Button } from '@/shared/ui/button';
import { Icon } from '@/shared/ui/icon';
import { recordFailedAttempt } from '../api/commands';
import type { VisitActions } from '../model/actions';

export function AttemptFailureForm({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const id = useId();
  const attempt = useRef<{ reason: string; version: number; requestId: string } | null>(null);
  const [missingReason, setMissingReason] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!visit.canFinish || visit.status !== 'in_progress' || actions.busy) return;

    const form = event.currentTarget;
    const value = new FormData(form).get('reason');
    const reason = typeof value === 'string' ? value.trim() : '';
    if (!reason) {
      setMissingReason(true);
      form.querySelector('textarea')?.focus();
      return;
    }

    const { version } = visit;
    const previous = attempt.current;
    const requestId = previous?.reason === reason && previous.version === version ? previous.requestId : crypto.randomUUID();
    attempt.current = { reason, version, requestId };
    setMissingReason(false);
    void actions.run('attemptFailure', () => recordFailedAttempt(visit.id, { reason, version, requestId }));
  }

  return <details className="panel detail-section attempt-failure">
    <summary>
      <span className="section-icon"><Icon name="alert" size={17} /></span>
      <span>{t('attemptFailureTitle')}</span>
      <span className="attempt-chevron"><Icon name="chevron" size={17} /></span>
    </summary>
    <form className="attempt-failure-form" onSubmit={submit} aria-busy={actions.busy === 'attemptFailure'}>
      <p id={`${id}-hint`} className="text-muted">{t('attemptFailureHint')}</p>
      <label className="field" htmlFor={`${id}-reason`}>
        <span>{t('attemptFailureReason')}</span>
        <textarea id={`${id}-reason`} name="reason" required maxLength={2000} rows={3} disabled={actions.busy !== null}
          aria-invalid={missingReason || undefined} aria-describedby={missingReason ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={() => setMissingReason(false)} />
      </label>
      {missingReason ? <p id={`${id}-error`} className="field-error" role="alert">{t('attemptFailureReasonRequired')}</p> : null}
      <Button type="submit" variant="secondary" className="justify-self-start" disabled={actions.busy !== null} aria-describedby={`${id}-hint`}>
        {actions.busy === 'attemptFailure' ? t('attemptFailureSending') : t('attemptFailureSubmit')}
      </Button>
    </form>
  </details>;
}

export function AttemptFailureResult({ failure }: { failure: VisitDetail['failedAttempt'] }) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const reduceMotion = useReducedMotion();

  return <motion.section className="panel detail-section attempt-failure" aria-labelledby="attempt-result-heading"
    initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
    <h2 id="attempt-result-heading"><span className="section-icon"><Icon name="alert" size={17} /></span>{t('attemptFailureTitle')}</h2>
    <p className="text-muted">{t('attemptFailureBackofficeReview')}</p>
    {failure ? <dl className="detail-fields">
      <div><dt>{t('attemptFailureReason')}</dt><dd>{failure.reason}</dd></div>
      <div><dt>{t('attemptFailureRecordedBy')}</dt><dd>{failure.actor.name}</dd></div>
      <div><dt>{t('attemptFailureRecordedAt')}</dt><dd>{formatVisitDate(failure.at, locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
      })}</dd></div>
    </dl> : null}
  </motion.section>;
}
