'use client';

import { Combobox } from '@/shared/ui/combobox';


import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { Icon } from '@/shared/ui/icon';
import { itemCheckFieldName, itemNoteMaxLength, type ItemCheckError } from '../model/item-check';
import { quantityFields, type QuantityError } from '../model/quantity';
import type { IncompleteWorkError } from '../model/incomplete-work';
import { FinishOperation } from './finish-operation';
import { issueTypes, type IssueType } from '../api/commands';
import { issueTypeLabels } from './issue-labels';
import { visitItemLabel } from '../model/item-reference';

function ItemCheckFields({ lineId, itemHeading, itemLabel, error, clearError, issues }: {
  lineId: number;
  itemHeading: string;
  itemLabel:string;
  error: ItemCheckError | null;
  clearError: () => void;
  issues:VisitDetail['issues'];
}) {
  const t = useTranslations('crew');
  const id = useId();
  const [status,setStatus]=useState('');
  const matchingIssues=issues?.filter((issue)=>issue.status==='open'&&issue.itemIds.includes(lineId))??[];
  const [linkedIssueId,setLinkedIssueId]=useState(matchingIssues.length===1?matchingIssues[0]?.id??'':'');
  const [problemType,setProblemType]=useState<IssueType>('other');
  const linkedIssue=matchingIssues.find((issue)=>issue.id===linkedIssueId);

  return <details className="group rounded-md border border-border bg-[var(--muted-surface)]">
    <summary aria-labelledby={`${itemHeading} ${id}-label`} className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2.5 text-sm [&::-webkit-details-marker]:hidden">
      <Icon name="note" size={16} />
      <span id={`${id}-label`}>{t('finishItemCheck')}</span>
      <span className="ms-auto group-open:rotate-180"><Icon name="chevron" size={16} /></span>
    </summary>
    <div className="grid gap-2 px-2.5 pb-2.5" onChange={() => { if (error) clearError(); }}>
      <label className="field">
        <span>{t('finishItemCondition')}</span>
        <Combobox id={`${id}-condition`} aria-label={`${itemLabel} · ${t('finishItemCondition')}`} name={itemCheckFieldName(lineId, 'status')} value={status} onChange={(event)=>setStatus(event.currentTarget.value)} aria-invalid={error?.reason === 'status' || undefined}
          aria-describedby={error?.reason === 'status' ? `${id}-error` : undefined}>
          <option value="">{t('finishItemUnchecked')}</option>
          <option value="ok">{t('finishItemOk')}</option>
          <option value="problem">{t('finishItemProblem')}</option>
        </Combobox>
      </label>
      {status==='problem'?<>
        <label className="field"><span>{t('issueType')}</span>
          <Combobox id={`${id}-problem-type`} aria-label={`${itemLabel} · ${t('issueType')}`} name={itemCheckFieldName(lineId,'problemType')} value={linkedIssue?.type??problemType} disabled={Boolean(linkedIssue)}
            onChange={(event)=>{const value=issueTypes.find((type)=>type===event.currentTarget.value);if(value)setProblemType(value);}}>
            {issueTypes.map((type)=><option key={type} value={type}>{t(issueTypeLabels[type])}</option>)}
          </Combobox>
          {linkedIssue?<input type="hidden" name={itemCheckFieldName(lineId,'problemType')} value={linkedIssue.type}/>:null}
        </label>
        {matchingIssues.length||linkedIssueId?<label className="field"><span>{t('finishExistingIssue')}</span>
          <Combobox id={`${id}-existing-issue`} aria-label={`${itemLabel} · ${t('finishExistingIssue')}`} name={itemCheckFieldName(lineId,'linkedIssueId')} value={linkedIssueId} required={matchingIssues.length>1}
            onChange={(event)=>setLinkedIssueId(event.currentTarget.value)}>
            <option value="">{t('finishNewIssue')}</option>
            {linkedIssueId&&!linkedIssue?<option value={linkedIssueId} disabled>{t('finishExistingIssueUnavailable')}</option>:null}
            {matchingIssues.map((issue)=><option key={issue.id} value={issue.id}>{t(issueTypeLabels[issue.type])} · {issue.description}</option>)}
          </Combobox>
        </label>:null}
        <p className="text-muted">{t('finishProblemCreatesIssue')}</p>
      </>:null}
      <label className="field">
        <span>{t('finishItemNote')}</span>
        <textarea name={itemCheckFieldName(lineId, 'note')} rows={2} maxLength={itemNoteMaxLength}
          aria-invalid={error?.reason === 'note' || undefined} aria-describedby={error?.reason === 'note' ? `${id}-error` : undefined} />
      </label>
      {error ? <p id={`${id}-error`} className="field-error" role="alert">{error.reason === 'status'
        ? t('finishItemStatusRequired') : t('finishItemNoteTooLong', { count: itemNoteMaxLength })}</p> : null}
    </div>
  </details>;
}

export function FinishItems({ items, error, clearError, linePhotos, issues }: {
  items: VisitDetail['items'];
  error: QuantityError | ItemCheckError | IncompleteWorkError | null;
  clearError: () => void;
  linePhotos?:(sourceLineId:number)=>ReactNode;
  issues?:VisitDetail['issues'];
}) {
  const t = useTranslations('crew');
  const id = useId();
  if (!items.length) return null;

  const hasServiceWork = items.some((item) => item.serviceWork);
  const rows = items.map((item) => ({ item, fields: quantityFields(item).filter(({ limit }) => !item.serviceWork || limit > 0) }))
    .filter(({ item, fields }) => !item.serviceWork || fields.length > 0);

  return <div className="finish-quantities">
    <h3>{t(hasServiceWork ? 'finishWorkQuantities' : 'finishQuantities')}</h3>
    <p className="text-muted" id={`${id}-hint`}>{t(hasServiceWork ? 'finishWorkQuantityHint' : 'finishQuantityHint')}</p>
    <ul className="plain-list">
      {rows.map(({ item, fields }) => <li className="finish-quantity-item" key={item.sourceLineId}>
        <h4 className="field-label detail-list-head" id={`${id}-line-${item.sourceLineId}`}>
          <span>{item.name}</span>
          {item.orderName ? <span className="plate">{item.orderName}</span> : null}
          <span className="plate">{t('productLine', { line: item.sourceLineId })}</span>
        </h4>
        {fields.map((field) => <FinishOperation key={field.operation} item={item} field={field}
          headingId={`${id}-line-${item.sourceLineId}`} hintId={`${id}-hint`} clearError={clearError}
          error={error?.lineId === item.sourceLineId && error.field !== 'itemCheck' ? error : null} />)}
        <ItemCheckFields lineId={item.sourceLineId} itemHeading={`${id}-line-${item.sourceLineId}`} clearError={clearError}
          itemLabel={visitItemLabel(item,(line)=>t('productLine',{line}))}
          issues={issues}
          error={error?.field === 'itemCheck' && error.lineId === item.sourceLineId ? error : null} />
        {linePhotos?.(item.sourceLineId)}
      </li>)}
    </ul>
  </div>;
}
