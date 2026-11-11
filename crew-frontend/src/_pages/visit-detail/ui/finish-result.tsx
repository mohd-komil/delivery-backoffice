'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { finishVisit, type FinishResult as ResultInput } from '../api/commands';
import { actualStartOptions } from '../model/actual-start';
import type { VisitActions } from '../model/actions';
import { itemCheckFieldName, readItemChecks, type ItemCheckError } from '../model/item-check';
import { readIncompleteWork, type IncompleteWorkError } from '../model/incomplete-work';
import { encodePhoto } from '../model/photo';
import { readFinishQuantities, type QuantityError } from '../model/quantity';
import { currentSignatures, isSignerName, signatureDraftScope, signatureHasInk, signatureInputFingerprint, type SignaturePair, type SignatureStrokes } from '../model/signature';
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
      <input id={id} type="datetime-local" required step="60" value={wallTime} aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${id}-hint ${id}-error` : `${id}-hint`} onChange={(event) => {
          setWallTime(event.currentTarget.value);
          setSelected('');
        }} />
    </label>
    <p id={`${id}-hint`} className="text-muted">{t('finishLegacyStartHint')}</p>
    {options.length > 1 ? <label className="field" htmlFor={`${id}-occurrence`}>
      <span>{t('finishChooseOccurrence')}</span>
      <select id={`${id}-occurrence`} value={chosen} required onChange={(event) => setSelected(event.currentTarget.value)}>
        <option value="">{t('finishChooseOccurrence')}</option>
        {options.map((option) => <option key={option.value} value={option.value}>UTC{option.offset}</option>)}
      </select>
    </label> : null}
    <input type="hidden" name="actualStart" value={chosen} />
    {message ? <p id={`${id}-error`} className="field-error" role="alert">{message}</p> : null}
  </div>;
}

type ValidationError = { field: 'summary' | 'actualStart' | 'photos' | 'customerName' | 'signatureDuplicate' }
  | QuantityError
  | ItemCheckError
  | IncompleteWorkError
  | { field: 'signature'; role: keyof SignaturePair };

function FinishForm({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [error, setError] = useState<ValidationError | null>(null);
  const [photos, setPhotos] = useState<FinishPhoto[]>([]);
  const previews=usePhotoPreviews();
  const [draftRevision, setDraftRevision] = useState(0);
  const [signatureDraft, setSignatureDraft] = useState<{ scope: string; pair: SignaturePair; inputFingerprint: string } | null>(null);
  const scope = signatureDraftScope(visit.version, visit.responsibleParticipant?.id ?? null, draftRevision);
  const signatures = currentSignatures(signatureDraft, scope);
  const hasCurrentDrawing = signatures.customer.length > 0 || signatures.crew.length > 0;
  const needsNewSignatures = signatureDraft !== null && signatureDraft.scope !== scope
    && (signatureDraft.pair.customer.length > 0 || signatureDraft.pair.crew.length > 0);
  const submitDisabled = actions.busy !== null;

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
    const rawSummary = fields.get('summary');
    const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
    if (!summary) {
      setError({ field: 'summary' });
      form.querySelector('textarea')?.focus();
      return;
    }

    const actualStart = fields.get('actualStart');
    if (visit.actualStartedAt === null && (typeof actualStart !== 'string' || !actualStart)) {
      setError({ field: 'actualStart' });
      form.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.focus();
      return;
    }

    const work = readFinishQuantities(visit.items, fields);
    if (!work.ok) {
      setError(work.error);
      const field = form.elements.namedItem(work.error.name);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }

    const remaining = readIncompleteWork(visit.items, work.quantities, fields);
    if (!remaining.ok) {
      setError(remaining.error);
      const field = form.elements.namedItem(remaining.error.name);
      if (field instanceof HTMLElement) field.focus();
      return;
    }

    const checks = readItemChecks(visit.items, fields);
    if (!checks.ok) {
      setError(checks.error);
      const field = form.elements.namedItem(itemCheckFieldName(checks.error.lineId, checks.error.reason));
      if (field instanceof HTMLElement) {
        const details = field.closest('details');
        if (details) details.open = true;
        field.focus();
      }
      return;
    }

    if (!photos.length) {
      setError({ field: 'photos' });
      form.querySelector<HTMLButtonElement>('[data-finish-photo-action]')?.focus();
      return;
    }
    const unavailablePhotoScope = form.querySelector<HTMLSelectElement>('[data-finish-photo-unavailable="true"]');
    if (unavailablePhotoScope) {
      unavailablePhotoScope.focus();
      return;
    }

    const rawSignerName = fields.get('customerSignerName');
    const signerName = typeof rawSignerName === 'string' ? rawSignerName.trim() : '';
    if (!isSignerName(signerName)) {
      setError({ field: 'customerName' });
      form.querySelector<HTMLInputElement>('input[name="customerSignerName"]')?.focus();
      return;
    }

    const missingSignature = !signatureHasInk(signatures.customer) ? 'customer' : !signatureHasInk(signatures.crew) ? 'crew' : null;
    if (missingSignature) {
      setError({ field: 'signature', role: missingSignature });
      form.querySelector<HTMLElement>(`[data-signature-pad="${missingSignature}"]`)?.focus();
      return;
    }
    if (signatureDraft?.inputFingerprint !== signatureInputFingerprint(fields)) {
      setDraftRevision((previous) => previous + 1);
      setError(null);
      return;
    }
    if (JSON.stringify(signatures.customer) === JSON.stringify(signatures.crew)) {
      setError({ field: 'signatureDuplicate' });
      form.querySelector<HTMLElement>('[data-signature-pad="crew"]')?.focus();
      return;
    }

    setError(null);
    const input: Omit<ResultInput, 'photos'> = {
      summary, quantities: work.quantities, incompleteWork: remaining.incompleteWork,
      ...(checks.itemChecks.length ? { itemChecks: checks.itemChecks } : {}),
      ...(visit.actualStartedAt === null && typeof actualStart === 'string' ? { actualStart } : {}),
      customerSignature: { signerName, strokes: signatures.customer },
      crewSignature: { strokes: signatures.crew },
    };
    const fingerprint = JSON.stringify({ ...input, photos: photos.map(({ previewUrl, sourceLineId }) => ({ previewUrl, sourceLineId })) });
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

  return <form ref={formRef} className="finish-form" onSubmit={submit} onChangeCapture={(event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
    if (event.target instanceof HTMLSelectElement && event.target.hasAttribute('data-finish-photo-scope')) return;
    if (hasCurrentDrawing) setDraftRevision((previous) => previous + 1);
  }} aria-busy={actions.busy === 'finish'}>
    <fieldset disabled={submitDisabled}>
      {visit.actualStartedAt === null ? <ActualStartInput missing={error?.field === 'actualStart'} /> : null}
      <div className="finish-summary">
        <label className="field" htmlFor={`${id}-summary`}>
          <span>{t('finishSummary')}</span>
          <textarea id={`${id}-summary`} name="summary" required maxLength={2000} rows={3}
            onChange={() => { if (error?.field === 'summary') setError(null); }}
            aria-invalid={error?.field === 'summary' ? true : undefined} aria-describedby={error?.field === 'summary' ? `${id}-summary-error` : undefined} />
        </label>
        {error?.field === 'summary' ? <p id={`${id}-summary-error`} className="field-error" role="alert">{t('finishSummaryRequired')}</p> : null}
      </div>
      <FinishItems items={visit.items} issues={visit.issues} error={error?.field === 'quantity' || error?.field === 'itemCheck' || error?.field === 'incompleteWork' ? error : null} clearError={() => setError(null)}
        linePhotos={(sourceLineId)=><FinishPhotos items={visit.items} fixedLineId={sourceLineId} photos={photos} requiredError={false} onChange={changePhotos} previews={previews} />} />
      <FinishPhotos items={visit.items} photos={photos} requiredError={error?.field === 'photos'} onChange={changePhotos} previews={previews} />
      <div className="finish-signatures" aria-labelledby={`${id}-signatures`}>
        <h3 id={`${id}-signatures`}>{t('signatureHeading')}</h3>
        <p className="text-muted">{t('signatureReviewHint')}</p>
        <label className="field" htmlFor={`${id}-customer-signer`}>
          <span>{t('signatureCustomerName')}</span>
          <input id={`${id}-customer-signer`} name="customerSignerName" required maxLength={200} autoComplete="off"
            aria-invalid={error?.field === 'customerName' || undefined}
            aria-describedby={error?.field === 'customerName' ? `${id}-signer-error` : undefined}
            onChange={() => { if (error?.field === 'customerName') setError(null); }} />
        </label>
        {error?.field === 'customerName' ? <p id={`${id}-signer-error`} className="field-error" role="alert">{t('signatureCustomerNameRequired')}</p> : null}
        {visit.responsibleParticipant ? <p className="signature-crew-name">{t('signatureResponsibleName', { name: visit.responsibleParticipant.name })}</p> : null}
        {needsNewSignatures ? <Notice tone="info">{t('signatureReviewAgain')}</Notice> : null}
        <div className="signature-pads">
          <SignaturePad key={`${scope}:customer`} role="customer" strokes={signatures.customer} disabled={submitDisabled}
            error={error?.field === 'signature' && error.role === 'customer' ? t('signatureCustomerRequired') : null}
            update={(transform) => changeSignature('customer', transform)} />
          <SignaturePad key={`${scope}:crew`} role="crew" strokes={signatures.crew} disabled={submitDisabled}
            error={error?.field === 'signatureDuplicate' ? t('signatureDistinct') : error?.field === 'signature' && error.role === 'crew' ? t('signatureCrewRequired') : null}
            update={(transform) => changeSignature('crew', transform)} />
        </div>
      </div>
      <Button type="submit" className="issue-submit">
        {actions.busy === 'finish' ? t('finishSending') : t('finishSubmit')}<Icon name="check" size={17} />
      </Button>
    </fieldset>
  </form>;
}

export function VisitFinishResult({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const locale = useLocale();
  const finished = visit.status === 'completed';

  return <section className="panel detail-section finish-section" aria-labelledby="finish-heading">
    <h2 id="finish-heading"><span className="section-icon"><Icon name="check" size={17} /></span>{t('finishHeading')}</h2>
    <dl className="detail-fields finish-meta">
      {visit.responsibleParticipant ? <div><dt>{t('finishResponsible')}</dt><dd>{visit.responsibleParticipant.name}</dd></div> : null}
      {visit.actualStartedAt ? <div><dt>{t('finishActualStart')}</dt><dd>{formatVisitDate(visit.actualStartedAt, locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
      })}</dd></div> : null}
    </dl>
    {finished ? <p className="text-muted">{t('finishBackofficeReview')}</p> : <>
      {visit.unfinishedChecklistCount > 0 ? <p className="finish-checklist-info">
        <Icon name="list" size={16} />{t('finishChecklistPending', { count: visit.unfinishedChecklistCount })}
      </p> : null}
      {visit.scopeReviewReason ? <WorkScopeNotice reason={visit.scopeReviewReason} />
        : !visit.responsibleParticipant ? <p className="text-muted">{t('finishNoResponsible')}</p>
        : visit.status === 'booked' ? <p className="text-muted">{t('visitNotInProgress')}</p>
          : visit.canFinish ? <FinishForm visit={visit} actions={actions} />
            : <p className="text-muted">{t('finishNotResponsible')}</p>}
    </>}
  </section>;
}
