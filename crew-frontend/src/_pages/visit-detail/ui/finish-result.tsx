'use client';

import { Combobox } from '@/shared/ui/combobox';

import { motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Button } from '@/shared/ui/button';
import { DatePicker } from '@/shared/ui/date-picker';
import { Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { finishVisit, type FinishResult as ResultInput } from '../api/commands';
import { actualStartOptions } from '../model/actual-start';
import type { VisitActions } from '../model/actions';
import { finishErrorStep, finishSteps, readFinishWork, type FinishDraftError, type FinishStep } from '../model/finish-draft';
import { readFinishEvidence, refusalReasonMaxLength } from '../model/finish-evidence';
import { itemCheckFieldName } from '../model/item-check';
import { encodePhoto } from '../model/photo';
import { currentSignatures, signatureDraftScope, signatureInputFingerprint, type SignaturePair, type SignatureStrokes } from '../model/signature';
import { FinishItems } from './finish-items';
import { FinishPhotos, usePhotoPreviews, type FinishPhoto } from './finish-photos';
import { SignaturePad } from './signature-pad';
import { WorkScopeNotice } from './work-scope-notice';

function ActualStartInput({ missing }: { missing: boolean }) {
  const t = useTranslations('crew');
  const id = useId();
  const [wallTime, setWallTime] = useState('');
  const [selected, setSelected] = useState('');
  const options = actualStartOptions(wallTime);
  const chosen = options.length === 1 ? options[0]?.value ?? '' : options.find((option) => option.value === selected)?.value ?? '';
  const invalid = wallTime.length > 0 && options.length === 0;
  const message = invalid ? t('finishInvalidRomeTime') : missing && !chosen ? t('finishStartRequired') : null;

  return <div className="finish-start">
    <label className="field" htmlFor={id}>
      <span>{t('finishActualStart')}</span>
      <DatePicker id={id} label={t('finishActualStart')} type="datetime-local" required step="60" value={wallTime} aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${id}-hint ${id}-error` : `${id}-hint`} onValueChange={(value) => {
          setWallTime(value);
          setSelected('');
        }} />
    </label>
    <p id={`${id}-hint`} className="text-muted">{t('finishLegacyStartHint')}</p>
    {options.length > 1 ? <label className="field" htmlFor={`${id}-occurrence`}>
      <span>{t('finishChooseOccurrence')}</span>
      <Combobox id={`${id}-occurrence`} value={chosen} required onChange={(event) => setSelected(event.currentTarget.value)}>
        <option value="">{t('finishChooseOccurrence')}</option>
        {options.map((option) => <option key={option.value} value={option.value}>UTC{option.offset}</option>)}
      </Combobox>
    </label> : null}
    <input type="hidden" name="actualStart" value={chosen} />
    {message ? <p id={`${id}-error`} className="field-error" role="alert">{message}</p> : null}
  </div>;
}

const reportStepLabels = {
  work: 'finishStepWork',
  photos: 'finishStepPhotos',
  signatures: 'finishStepSignatures',
} as const;

function SignatureOutcomeFields({ refused, photosProhibited, attached, error, onOutcome, onProhibition, clearError }: {
  refused: boolean;
  photosProhibited: boolean;
  attached: boolean;
  error: FinishDraftError['field'] | undefined;
  onOutcome: (refused: boolean) => void;
  onProhibition: (prohibited: boolean) => void;
  clearError: () => void;
}) {
  const t = useTranslations('crew');
  const id = useId();
  const reduceMotion = useReducedMotion();
  const choiceClass = 'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-[var(--info-bg)] has-checked:text-[var(--info-fg)]';

  return <fieldset className="rounded-lg bg-[var(--muted-surface)] p-3!">
    <legend className="px-1 text-sm font-semibold">{t('signatureOutcome')}</legend>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={choiceClass}><input className="size-4 shrink-0 accent-primary" type="radio" name="signatureOutcome" value="signed"
        checked={!refused} onChange={() => onOutcome(false)} />{t('signatureOutcomeSigned')}</label>
      <label className={choiceClass}><input className="size-4 shrink-0 accent-primary" type="radio" name="signatureOutcome" value="refused"
        checked={refused} onChange={() => onOutcome(true)} />{t('signatureOutcomeRefused')}</label>
    </div>
    {refused ? <motion.div initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="grid gap-2">
      <label className="field" htmlFor={`${id}-refusal`}>
        <span>{t('signatureRefusalReason')}</span>
        <textarea id={`${id}-refusal`} name="refusalReason" required rows={2} maxLength={refusalReasonMaxLength}
          aria-invalid={error === 'refusalReason' || undefined} aria-describedby={error === 'refusalReason' ? `${id}-refusal-error` : undefined}
          onChange={() => { if (error === 'refusalReason') clearError(); }} />
      </label>
      {error === 'refusalReason' ? <p id={`${id}-refusal-error`} className="field-error" role="alert">{t('signatureRefusalReasonRequired')}</p> : null}
      <label className="checklist-item">
        <input type="checkbox" name="photoProhibited" value="yes" checked={photosProhibited} disabled={attached}
          aria-describedby={attached ? `${id}-attached` : undefined} onChange={(event) => onProhibition(event.currentTarget.checked)} />
        {t('signatureRefusalPhotosProhibited')}
      </label>
      {attached ? <p id={`${id}-attached`} className="text-muted">{t('signatureRefusalRemovePhotos')}</p> : null}
      {error === 'refusalPhotoConflict' ? <p className="field-error" role="alert">{t('signatureRefusalRemovePhotos')}</p> : null}
      {photosProhibited ? <>
        <label className="field" htmlFor={`${id}-photo-reason`}>
          <span>{t('signatureRefusalNoPhotoReason')}</span>
          <textarea id={`${id}-photo-reason`} name="noPhotoReason" required rows={2} maxLength={refusalReasonMaxLength}
            aria-invalid={error === 'noPhotoReason' || undefined} aria-describedby={error === 'noPhotoReason' ? `${id}-photo-error` : undefined}
            onChange={() => { if (error === 'noPhotoReason') clearError(); }} />
        </label>
        {error === 'noPhotoReason' ? <p id={`${id}-photo-error`} className="field-error" role="alert">{t('signatureRefusalNoPhotoReasonRequired')}</p> : null}
      </> : null}
    </motion.div> : null}
  </fieldset>;
}

function reportPanel(step: FinishStep) {
  return `[data-report-step="${step}"]`;
}

function errorField(form: HTMLFormElement, error: FinishDraftError) {
  switch (error.field) {
    case 'quantity':
    case 'incompleteWork': {
      const field = form.elements.namedItem(error.name);
      return field instanceof HTMLElement ? field : null;
    }
    case 'itemCheck': {
      const field = form.elements.namedItem(itemCheckFieldName(error.lineId, error.reason));
      return field instanceof HTMLElement ? field : null;
    }
    case 'signature':
    case 'signatureDuplicate':
      return form.querySelector<HTMLElement>(`[data-signature-pad="${error.field === 'signature' ? error.role : 'crew'}"]`);
    default: {
      const selectors = {
        summary: '[name="summary"]',
        actualStart: 'input[type="datetime-local"]',
        photos: '[data-finish-general-photos] [data-finish-photo-action]',
        customerName: '[name="customerSignerName"]',
        refusalWork: '[name^="quantity-"]',
        refusalReason: '[name="refusalReason"]',
        noPhotoReason: '[name="noPhotoReason"]',
        refusalPhotoConflict: '[data-finish-general-photos]',
      };
      return form.querySelector<HTMLElement>(selectors[error.field]);
    }
  }
}

function ReportPanel({ id, step, current, children }: { id: string; step: FinishStep; current: FinishStep; children: ReactNode }) {
  const t = useTranslations('crew');
  const reduceMotion = useReducedMotion();
  const active = step === current;
  return <motion.section id={`${id}-${step}`} data-report-step={step} aria-label={t(reportStepLabels[step])}
    hidden={!active} tabIndex={-1} initial={false} animate={{ opacity: active ? 1 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.16 }}
    className={active ? 'grid min-w-0 gap-4 rounded-xl border border-border p-3 sm:p-4' : 'hidden'}>
    {children}
  </motion.section>;
}

function FinishForm({ visit, actions, onCloseReport }: { visit: VisitDetail; actions: VisitActions; onCloseReport?: () => void }) {
  const t = useTranslations('crew');
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [step, setStep] = useState<FinishStep>('work');
  const [focus, setFocus] = useState<{ step: FinishStep; field: HTMLElement | null; reportValidity: boolean } | null>(null);
  const [error, setError] = useState<FinishDraftError | null>(null);
  const [photos, setPhotos] = useState<FinishPhoto[]>([]);
  const [refused, setRefused] = useState(false);
  const [photosProhibited, setPhotosProhibited] = useState(false);
  const previews=usePhotoPreviews();
  const [draftRevision, setDraftRevision] = useState(0);
  const [signatureDraft, setSignatureDraft] = useState<{ scope: string; pair: SignaturePair; inputFingerprint: string } | null>(null);
  const scope = signatureDraftScope(visit.version, visit.responsibleParticipant?.id ?? null, draftRevision);
  const signatures = currentSignatures(signatureDraft, scope);
  const hasCurrentDrawing = signatures.customer.length > 0 || signatures.crew.length > 0;
  const needsNewSignatures = signatureDraft !== null && signatureDraft.scope !== scope
    && (signatureDraft.pair.customer.length > 0 || signatureDraft.pair.crew.length > 0);
  const submitDisabled = actions.busy !== null;

  useEffect(() => {
    if (!focus) return;
    const field = focus.field ?? formRef.current?.querySelector<HTMLElement>(reportPanel(focus.step));
    if (!field) return;
    const details = field.closest('details');
    if (details) details.open = true;
    if (focus.reportValidity && (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) {
      field.reportValidity();
      return;
    }
    const combobox = field.matches('[data-combobox-native]') ? field.closest('[data-slot="combobox"]')?.querySelector('button') : null;
    (combobox ?? field).focus();
  }, [focus]);

  function openStep(next: FinishStep, field: HTMLElement | null = null, reportValidity = false) {
    setStep(next);
    setFocus({ step: next, field, reportValidity });
  }

  function showError(form: HTMLFormElement, validation: FinishDraftError) {
    setError(validation);
    openStep(finishErrorStep(validation), errorField(form, validation));
  }

  function checkNativeFields(form: HTMLFormElement, current: FinishStep) {
    const invalid = form.querySelector<HTMLElement>(`${reportPanel(current)} :is(input, select, textarea):invalid`);
    if (!invalid) return true;
    openStep(current, invalid, true);
    return false;
  }

  function changePhotos(next: FinishPhoto[]) {
    setPhotos(next);
    if (hasCurrentDrawing) setDraftRevision((previous) => previous + 1);
    if (error?.field === 'photos') setError(null);
  }

  function changeSignature(role: keyof SignaturePair, transform: (strokes: SignatureStrokes) => SignatureStrokes) {
    if (!formRef.current) return;
    const inputFingerprint = signatureDraft?.scope === scope && hasCurrentDrawing ? signatureDraft.inputFingerprint
      : signatureInputFingerprint(new FormData(formRef.current));
    setSignatureDraft((previous) => {
      const pair = currentSignatures(previous, scope);
      return { scope, pair: { ...pair, [role]: transform(pair[role]) }, inputFingerprint };
    });
    if ((error?.field === 'signature' && error.role === role) || error?.field === 'signatureDuplicate') setError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!visit.canFinish || actions.busy) return;

    const form = event.currentTarget;
    const fields = new FormData(form);
    const draft = readFinishWork(visit, fields);
    if (!draft.ok) return showError(form, draft.error);
    if (!checkNativeFields(form, 'work')) return;
    if (step === 'work') {
      setError(null);
      return openStep('photos');
    }

    const evidence = readFinishEvidence(fields, signatures, draft.work.quantities, photos.length);
    // The evidence checks needed before drawing are the same ones used when sending.
    if (!evidence.ok && (step === 'signatures' || finishErrorStep(evidence.error) !== 'signatures')) {
      return showError(form, evidence.error);
    }
    if (!checkNativeFields(form, 'photos')) return;
    const unavailablePhotoScope = form.querySelector<HTMLElement>('[data-finish-general-photos] [data-finish-photo-unavailable="true"]');
    if (unavailablePhotoScope) {
      return openStep('photos', unavailablePhotoScope);
    }
    if (step === 'photos') {
      setError(null);
      return openStep('signatures');
    }
    if (!evidence.ok || !checkNativeFields(form, 'signatures')) return;

    if (signatureDraft?.inputFingerprint !== signatureInputFingerprint(fields)) {
      setDraftRevision((previous) => previous + 1);
      setError(null);
      return;
    }
    setError(null);
    const { itemChecks, ...work } = draft.work;
    const input = {
      ...work,
      ...(itemChecks.length ? { itemChecks } : {}),
      ...evidence.evidence,
    } satisfies Omit<ResultInput, 'photos'>;
    const fingerprint = JSON.stringify({ ...input, version: visit.version, photos: photos.map(({ previewUrl, sourceLineId }) => ({ previewUrl, sourceLineId })) });
    const previous = attempt.current;
    const requestId = previous?.fingerprint === fingerprint ? previous.requestId : crypto.randomUUID();
    attempt.current = { fingerprint, requestId };

    void actions.run('finish', async () => {
      const encoded: ResultInput['photos'] = [];
      for (const { file, sourceLineId } of photos) {
        const photo = await encodePhoto(file);
        if (!photo) return { ok: false, status: 400, code: 'PHOTO_READ_FAILED' };
        encoded.push(sourceLineId === undefined ? photo : { ...photo, sourceLineId });
      }
      return finishVisit(visit.id, { ...input, photos: encoded, version: visit.version, requestId });
    });
  }

  return <form ref={formRef} className="finish-form" method="post" noValidate onSubmit={submit} onChangeCapture={(event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
    if (event.target instanceof HTMLSelectElement && event.target.hasAttribute('data-finish-photo-scope')) return;
    if (hasCurrentDrawing) setDraftRevision((previous) => previous + 1);
  }} aria-busy={actions.busy === 'finish'}>
    <fieldset disabled={submitDisabled}>
      <nav aria-label={t('finishHeading')}>
        <ol className="grid grid-cols-3 gap-1.5 sm:gap-2">
          {finishSteps.map((entry, index) => <li key={entry} className="min-w-0">
            <Button variant="secondary" aria-current={entry === step ? 'step' : undefined} aria-controls={`${id}-${entry}`}
              className="min-h-11 w-full flex-wrap gap-1.5 px-1.5! text-xs aria-[current=step]:border-[var(--info-fg)] aria-[current=step]:bg-[var(--info-bg)] aria-[current=step]:text-[var(--info-fg)] sm:px-3!"
              onClick={() => { if (entry !== step) openStep(entry); }}>
              <span aria-hidden="true" className="font-mono tabular-nums">{index + 1}</span>{t(reportStepLabels[entry])}
            </Button>
          </li>)}
        </ol>
      </nav>
      <ReportPanel id={id} step="work" current={step}>
        {visit.actualStartedAt === null ? <ActualStartInput missing={error?.field === 'actualStart'} /> : null}
        {error?.field === 'refusalWork' ? <p className="field-error" role="alert">{t('signatureRefusalRequiresWork')}</p> : null}
        <FinishItems items={visit.items} issues={visit.issues}
          error={error?.field === 'quantity' || error?.field === 'itemCheck' || error?.field === 'incompleteWork' ? error : null}
          clearError={() => setError(null)}
          linePhotos={photosProhibited ? undefined : (sourceLineId) => <FinishPhotos items={visit.items} fixedLineId={sourceLineId}
            photos={photos} requiredError={false} onChange={changePhotos} previews={previews} />} />
        <div className="finish-summary">
          <label className="field" htmlFor={`${id}-summary`}>
            <span>{t('finishSummary')}</span>
            <textarea id={`${id}-summary`} name="summary" required maxLength={2000} rows={3}
              onChange={() => { if (error?.field === 'summary') setError(null); }}
              aria-invalid={error?.field === 'summary' ? true : undefined} aria-describedby={error?.field === 'summary' ? `${id}-summary-error` : undefined} />
          </label>
          {error?.field === 'summary' ? <p id={`${id}-summary-error`} className="field-error" role="alert">{t('finishSummaryRequired')}</p> : null}
        </div>
      </ReportPanel>
      <ReportPanel id={id} step="photos" current={step}>
        {photosProhibited ? null : <div data-finish-general-photos>
          <FinishPhotos items={visit.items} photos={photos} requiredError={error?.field === 'photos'} onChange={changePhotos} previews={previews} />
        </div>}
        <SignatureOutcomeFields refused={refused} photosProhibited={photosProhibited} attached={photos.length > 0} error={error?.field}
          onOutcome={(value) => { setRefused(value); setPhotosProhibited(false); setError(null); }}
          onProhibition={(value) => { setPhotosProhibited(value); setError(null); }} clearError={() => setError(null)} />
      </ReportPanel>
      <ReportPanel id={id} step="signatures" current={step}>
        <div className="finish-signatures border-0! pt-0!" aria-labelledby={`${id}-signature-heading`}>
          <h3 id={`${id}-signature-heading`}>{t('signatureHeading')}</h3>
          <p className="text-muted">{t(refused ? 'signatureRefusalReviewHint' : 'signatureReviewHint')}</p>
          {refused ? null : <><label className="field" htmlFor={`${id}-customer-signer`}>
            <span>{t('signatureCustomerName')}</span>
            <input id={`${id}-customer-signer`} name="customerSignerName" required maxLength={200} autoComplete="off"
              aria-invalid={error?.field === 'customerName' || undefined}
              aria-describedby={error?.field === 'customerName' ? `${id}-signer-error` : undefined}
              onChange={() => { if (error?.field === 'customerName') setError(null); }} />
          </label>
          {error?.field === 'customerName' ? <p id={`${id}-signer-error`} className="field-error" role="alert">{t('signatureCustomerNameRequired')}</p> : null}</>}
          {visit.responsibleParticipant ? <p className="signature-crew-name">{t('signatureResponsibleName', { name: visit.responsibleParticipant.name })}</p> : null}
          {needsNewSignatures ? <Notice tone="info">{t('signatureReviewAgain')}</Notice> : null}
          <div className={refused ? 'grid max-w-xl gap-2' : 'signature-pads'}>
            {refused ? null : <SignaturePad key={`${scope}:customer`} role="customer" strokes={signatures.customer} disabled={submitDisabled}
              error={error?.field === 'signature' && error.role === 'customer' ? t('signatureCustomerRequired') : null}
              update={(transform) => changeSignature('customer', transform)} />}
            <SignaturePad key={`${scope}:crew`} role="crew" strokes={signatures.crew} disabled={submitDisabled}
              error={error?.field === 'signatureDuplicate' ? t('signatureDistinct') : error?.field === 'signature' && error.role === 'crew' ? t('signatureCrewRequired') : null}
              update={(transform) => changeSignature('crew', transform)} />
          </div>
        </div>
      </ReportPanel>
      <div className="visit-action-bar">
        <div className="visit-action-bar-controls">
          {step !== 'work' || onCloseReport ? <Button variant="secondary" className="min-h-11! shrink-0" onClick={() => {
            if (step === 'work') onCloseReport?.();
            else openStep(step === 'photos' ? 'work' : 'photos');
          }}>
            <Icon name="arrowLeft" size={16} />{t(step === 'work' ? 'finishBackToVisit' : 'finishBackStep')}
          </Button> : null}
          <Button type="submit" className="min-h-11! flex-1">
            {actions.busy === 'finish' ? t('finishSending')
              : step === 'signatures' ? t(refused ? 'signatureRefusalSubmit' : 'finishSubmit') : t('finishContinue')}
            <Icon name={step === 'signatures' ? 'check' : 'arrowRight'} size={17} />
          </Button>
        </div>
      </div>
    </fieldset>
  </form>;
}

const refusalStatusMessages = {
  pending: 'signatureRefusalPending',
  approved: 'signatureRefusalApproved',
  corrected: 'signatureRefusalCorrected',
} as const;

export function VisitFinishResult({ visit, actions, reportOpen = true, onCloseReport }: {
  visit: VisitDetail;
  actions: VisitActions;
  reportOpen?: boolean;
  onCloseReport?: () => void;
}) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const finished = visit.status === 'completed';

  const hidden = !reportOpen && visit.canFinish && visit.status === 'in_progress' && !visit.scopeReviewReason && !!visit.responsibleParticipant;

  return <section id="visit-result" tabIndex={-1} hidden={hidden} className={hidden ? 'hidden' : 'panel detail-section finish-section scroll-mt-4'} aria-labelledby="finish-heading">
    <header className="grid min-w-0 gap-3 border-b border-border pb-3">
      <h2 id="finish-heading"><span className="section-icon"><Icon name="check" size={17} /></span>{t('finishHeading')}</h2>
      <dl className="detail-fields finish-meta">
        {visit.responsibleParticipant ? <div><dt>{t('finishResponsible')}</dt><dd>{visit.responsibleParticipant.name}</dd></div> : null}
        {visit.actualStartedAt ? <div><dt>{t('finishActualStart')}</dt><dd>{formatVisitDate(visit.actualStartedAt, locale, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
        })}</dd></div> : null}
      </dl>
    </header>
    {finished ? (
      visit.signatureRefusalStatus ? <Notice tone="info">{t(refusalStatusMessages[visit.signatureRefusalStatus])}</Notice>
        : <p className="flex items-start gap-2 rounded-lg bg-[var(--success-bg)] p-3 text-[var(--success-fg)]">
          <Icon name="check" size={17} />{t('finishBackofficeReview')}
        </p>
    ) : <>
      {visit.unfinishedChecklistCount > 0 ? <p className="finish-checklist-info">
        <Icon name="list" size={16} />{t('finishChecklistPending', { count: visit.unfinishedChecklistCount })}
      </p> : null}
      {visit.scopeReviewReason ? <WorkScopeNotice reason={visit.scopeReviewReason} />
        : !visit.responsibleParticipant ? <p className="text-muted">{t('finishNoResponsible')}</p>
        : visit.status === 'booked' ? <p className="text-muted">{t('visitNotInProgress')}</p>
          : visit.canFinish ? <FinishForm visit={visit} actions={actions} onCloseReport={onCloseReport} />
            : <p className="text-muted">{t('finishNotResponsible')}</p>}
    </>}
  </section>;
}
