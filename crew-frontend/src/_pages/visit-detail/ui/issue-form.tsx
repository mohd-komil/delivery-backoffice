'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { issueTypes, reportIssue, type IssueType } from '../api/commands';
import type { VisitActions } from '../model/actions';
import { encodePhoto, photoAccept, photoError } from '../model/photo';
import { visitItemLabel } from '../model/item-reference';

import { issueTypeLabels } from './issue-labels';

type IssueDraft = { type: IssueType; description: string; itemId: number | null; photo: File };

function sameDraft(a: IssueDraft, b: IssueDraft) {
  return a.type === b.type && a.description === b.description && a.itemId === b.itemId && a.photo === b.photo;
}

export function IssueForm({ visit, actions }: { visit: VisitDetail; actions: VisitActions }) {
  const t = useTranslations('crew');
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ requestId: string; draft: IssueDraft } | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [issueType,setIssueType]=useState<IssueType>('other');
  const [error, setError] = useState<'photoSize' | 'photoType' | 'photoRequired' | 'issueDescriptionRequired' | 'issueItemRequired' | null>(null);

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.item(0);
    event.currentTarget.value = '';
    if (!file) return;

    const failure = photoError(file);
    setError(failure);
    setPhoto(failure ? null : file);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (visit.status !== 'in_progress' || actions.busy) return;

    const form = event.currentTarget;
    const fields = new FormData(form);
    const type = issueTypes.find((value) => value === fields.get('type'));
    const rawDescription = fields.get('description');
    const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
    if (!type || !description) {
      setError('issueDescriptionRequired');
      return;
    }
    const itemId = visit.items.find((item) => String(item.sourceLineId) === fields.get('item'))?.sourceLineId ?? null;
    if(type==='damage'&&itemId===null){
      setError('issueItemRequired');form.querySelector<HTMLSelectElement>('#issue-item')?.focus();return;
    }
    if (!photo) {
      setError('photoRequired');
      return;
    }

    setError(null);
    const draft = { type, description, itemId, photo };
    const previous = attempt.current;
    const requestId = previous && sameDraft(previous.draft, draft) ? previous.requestId : crypto.randomUUID();
    attempt.current = { draft, requestId };

    const saved = await actions.run('issue', async () => {
      const encoded = await encodePhoto(photo);
      if (!encoded) return { ok: false, status: 400, code: 'PHOTO_READ_FAILED' };
      return reportIssue(visit.id, {
        version: visit.version,
        requestId,
        type,
        description,
        itemIds: itemId === null ? [] : [itemId],
        photo: encoded,
      });
    });
    if (!saved) return;

    attempt.current = null;
    setPhoto(null);
    setIssueType('other');
    form.reset();
  }

  return <section className="panel detail-section" aria-labelledby="issue-heading">
    <h2 id="issue-heading"><span className="section-icon"><Icon name="alert" size={17} /></span>{t('reportIssue')}</h2>
    <p className="text-muted">{t('reportIssueDescription')}</p>
    <form className="issue-form" onSubmit={(event) => void submit(event)} aria-busy={actions.busy === 'issue'}>
      <fieldset disabled={actions.busy !== null || visit.status !== 'in_progress'}>
        <div className="issue-fields">
          <label className="field" htmlFor="issue-type">
            <span>{t('issueType')}</span>
            <select id="issue-type" name="type" value={issueType} onChange={(event)=>{
              const next=issueTypes.find((type)=>type===event.currentTarget.value);if(next)setIssueType(next);
              if(error==='issueItemRequired')setError(null);
            }}>
              {issueTypes.map((type) => <option key={type} value={type}>{t(issueTypeLabels[type])}</option>)}
            </select>
          </label>
          {visit.items.length ? <label className="field" htmlFor="issue-item">
            <span>{t(issueType==='damage'?'issueDamageItem':'issueItem')}</span>
            <select id="issue-item" name="item" defaultValue="" required={issueType==='damage'} aria-invalid={error==='issueItemRequired'||undefined}
              onChange={()=>{if(error==='issueItemRequired')setError(null);}}>
              <option value="">{t(issueType==='damage'?'issueItemRequired':'noIssueItem')}</option>
              {visit.items.map((item) => <option key={item.sourceLineId} value={item.sourceLineId}>{visitItemLabel(item,(line)=>t('productLine',{line}))}</option>)}
            </select>
          </label> : null}
        </div>
        <label className="field" htmlFor="issue-description">
          <span>{t('issueDescription')}</span>
          <textarea id="issue-description" name="description" rows={4} maxLength={2000} required />
        </label>
        <div className="photo-field" role="group" aria-labelledby="photo-label">
          <p id="photo-label" className="field-label">{t('issuePhoto')}</p>
          <p id="photo-hint" className="text-muted">{t('photoHint')}</p>
          <div className="photo-actions">
            <input ref={camera} type="file" hidden accept={photoAccept} capture="environment" onChange={choosePhoto} />
            <input ref={picker} type="file" hidden accept={photoAccept} onChange={choosePhoto} />
            <Button variant="secondary" onClick={() => camera.current?.click()} aria-describedby="photo-hint">
              <Icon name="camera" size={16} />{t('takePhoto')}
            </Button>
            <Button variant="secondary" onClick={() => picker.current?.click()} aria-describedby="photo-hint">{t('choosePhoto')}</Button>
          </div>
          {photo ? <div className="selected-photo">
            <p role="status" aria-live="polite"><Icon name="check" size={16} />{photo.name}</p>
            <Button variant="ghost" onClick={() => { setPhoto(null); setError(null); }}>{t('removePhoto')}</Button>
          </div> : null}
        </div>
        {error ? <Notice>{t(error)}</Notice> : null}
        <Button type="submit" className="issue-submit">
          {actions.busy === 'issue' ? t('sendingIssue') : t('sendIssue')}<Icon name="arrowRight" size={16} />
        </Button>
      </fieldset>
    </form>
  </section>;
}
