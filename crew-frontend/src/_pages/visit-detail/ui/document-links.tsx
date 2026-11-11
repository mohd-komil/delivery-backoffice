'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { VisitDetail } from '@/shared/api/contracts';
import { formatVisitDate } from '@/shared/lib/visit-display';
import { Icon } from '@/shared/ui/icon';

const purposeLabels={general:'documentGeneral',instruction:'documentInstruction',drawing:'documentDrawing'} as const;

export function DocumentLinks({visitId,documents}:{visitId:string;documents:NonNullable<VisitDetail['documents']>}) {
  const t=useTranslations('crew');
  const locale=useLocale();
  return <ul className="plain-list grid gap-2">
    {documents.map((document)=><li key={document.id} className="min-w-0 rounded-md border border-border bg-[var(--muted-surface)] p-2.5">
      <a className="inline-flex min-h-8 items-center gap-1.5 wrap-anywhere text-sm underline underline-offset-4"
        href={`/api/crew/visits/${encodeURIComponent(visitId)}/documents/${encodeURIComponent(document.id)}`} target="_blank" rel="noreferrer">
        <Icon name="note" size={15}/>{document.name}
      </a>
      <p className="text-muted text-xs">{t(document.documentPurpose?purposeLabels[document.documentPurpose]:'documentPurposeUnknown')}
        {' · '}{document.documentVersion===null?t('documentVersionUnknown'):t('documentVersion',{version:document.documentVersion})}</p>
      <p className="text-muted text-xs">{t(document.documentSource==='local_upload'?'documentLocalUpload':'documentSourceUnknown')}
        {' · '}{formatVisitDate(document.createdAt,locale,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
        {document.uploadedBy?` · ${document.uploadedBy.name}`:null}</p>
    </li>)}
  </ul>;
}
