'use client';

import { Combobox } from './ui/combobox';


import Image from 'next/image';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { API_URL } from '@/lib/api';
import type { DeliveryDetail, Appointment } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { formatDateTime } from '@/lib/time';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { ActionForm, Empty, Field, optionalText, textField } from './ui';
import { DetailIcon, deliveryStatusLabel, type DeliveryText } from './delivery-detail-presentation';
import { DeliveryDetailCard } from './delivery-detail-card';

type Command = (path: string, body: unknown, method?: string) => Promise<number>;
type StoredFile = DeliveryDetail['files'][number];
type Document = NonNullable<Appointment['results'][number]['documentSnapshot']>[number];

function DocumentMetadata({ document }: { document: Document }) {
  const t = useTranslations('operationsFlow');
  const locale = useLocale();
  return <>
    <p className="small muted">{t(document.documentPurpose ?? 'unknown')} · {document.documentVersion === null ? t('unknown') : t('version', { version: document.documentVersion })}</p>
    <p className="small muted">{t(document.documentSource === 'local_upload' ? 'localUpload' : 'unknown')} · {formatDateTime(document.createdAt, locale)}{document.uploadedBy ? ` · ${document.uploadedBy.name}` : ''}</p>
  </>;
}

export function DeliveryResultDocuments({ result, deliveryId }: { result: Appointment['results'][number]; deliveryId: string }) {
  const t = useTranslations('operationsFlow');
  const lineText = useTranslations('delivery');
  const locale = useLocale();
  const items = new Map(result.sourceSnapshot.items.map((item) => [item.sourceLineId, item]));
  return <details className="section-gap rounded-lg border border-border bg-background p-4"><summary className="cursor-pointer font-medium">{t('reportDocuments')}</summary>
    {result.documentSnapshot === undefined ? <p className="small muted">{t('noSnapshot')}</p>
      : result.documentSnapshot.length === 0 ? <p className="small muted">{lineText('noFiles')}</p>
        : <ul className="mt-3 grid gap-2">{result.documentSnapshot.map((document) => {
          const item = document.itemId === null ? undefined : items.get(document.itemId);
          return <li key={document.id} className="rounded-md border border-border bg-background p-3">
            <p className="small">{item ? sourceLineLabel(result.sourceSnapshot, item, locale) : document.itemId === null ? t('generalDocuments') : lineText('productLineId', { id: document.itemId })}</p>
            <a className="underline underline-offset-4" href={`${API_URL}/deliveries/${deliveryId}/files/${document.id}`} target="_blank" rel="noreferrer">{document.name} ↗</a>
            <DocumentMetadata document={document} />
          </li>;
        })}</ul>}
  </details>;
}

function FileCard({ file, detail, canReplace, replaced, onReplace }: {
  file: StoredFile; detail: DeliveryDetail; canReplace: boolean; replaced: boolean; onReplace: () => void;
}) {
  const t = useTranslations('delivery');
  const docs = useTranslations('operationsFlow');
  const locale = useLocale();
  const format = useFormatter();
  const item = detail.delivery.source.items.find((entry) => entry.sourceLineId === file.itemId);
  const url = `${API_URL}/deliveries/${detail.delivery.id}/files/${file.id}`;
  return <article className="file-card bg-background shadow-xs">
    {file.mime.startsWith('image/') && file.status === 'ready' ? <Image unoptimized crossOrigin="use-credentials" width={120} height={90} src={url} alt={file.name} /> : <span className="file-icon" aria-hidden="true"><DetailIcon name="file" /></span>}
    <div className="min-w-0 space-y-1">
      <h4 className="break-words font-semibold">{file.name}</h4>
      <p className="small muted">{deliveryStatusLabel(t, file.kind)} · {format.number(file.size / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB</p>
      <p className="small muted">{file.appointmentId ? t('visitNumber', { number: detail.delivery.appointments.findIndex((visit) => visit.id === file.appointmentId) + 1 }) : t('delivery')}
        {item ? ` · ${sourceLineLabel(detail.delivery.source, item, locale)}` : file.itemId ? ` · ${t('productLineId', { id: file.itemId })}` : ''}{file.issueId ? ` · ${t('linkedIssue')}` : ''}</p>
      {file.kind === 'document' ? <DocumentMetadata document={file} /> : <p className="small muted">{formatDateTime(file.createdAt, locale)}</p>}
      <div className="flex flex-wrap gap-1.5"><span className={file.status === 'ready' ? 'badge success' : 'badge warning'}>{deliveryStatusLabel(t, file.status)}</span>
        {file.kind === 'document' && file.status === 'ready' ? <span className="badge neutral">{docs(replaced ? 'replaced' : 'current')}</span> : null}</div>
    </div>
    <div className="flex flex-wrap gap-2">
      {file.status === 'ready' ? <a className="button secondary small" href={url} target="_blank" rel="noreferrer">{t('openFile')} ↗</a> : <span className="small muted">{t('fileUnavailable')}</span>}
      {canReplace ? <Button variant="outline" size="sm" onClick={onReplace}>{docs('replace')}</Button> : null}
    </div>
  </article>;
}

export function DeliveryFiles({ detail, command }: { detail: DeliveryDetail; command: Command }) {
  const t = useTranslations('delivery');
  const docs = useTranslations('operationsFlow');
  const locale = useLocale();
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const uploadSection = useRef<HTMLElement>(null);
  const replaced = new Set(detail.files.filter((file) => file.status === 'ready').flatMap((file) => file.supersedesFileId ? [file.supersedesFileId] : []));
  const replacing = new Set(detail.files.filter((file) => file.status !== 'failed').flatMap((file) => file.supersedesFileId ? [file.supersedesFileId] : []));
  const documents = detail.files.filter((file) => file.kind === 'document');
  const groups = new Map<number | null, StoredFile[]>();
  for (const document of documents) groups.set(document.itemId, [...(groups.get(document.itemId) ?? []), document]);
  const generalDocuments = groups.get(null) ?? [];
  const productGroups = [...groups].flatMap(([lineId, files]) => lineId === null ? [] : [{ lineId, files }])
    .sort((left, right) => left.lineId - right.lineId);
  const evidence = detail.files.filter((file) => file.kind !== 'document');
  const replacement = detail.files.find((file) => file.id === replacementId);
  function renderFiles(files: StoredFile[]) {
    return <div className="file-list">{files.map((file) => <FileCard key={file.id} file={file} detail={detail} replaced={replaced.has(file.id)}
      canReplace={!detail.delivery.completedAt && file.kind === 'document' && file.status === 'ready' && !replacing.has(file.id)}
      onReplace={() => { setReplacementId(file.id); uploadSection.current?.scrollIntoView({ block: 'start' }); }} />)}</div>;
  }
  return <>
    <DeliveryDetailCard title={docs('generalDocuments')} icon="file" badge={t('privateStorage')}>
      <p className="small muted">{t('filesHint')}</p>
      {generalDocuments.length ? renderFiles(generalDocuments) : <Empty title={t('noFiles')} />}
    </DeliveryDetailCard>
    <DeliveryDetailCard title={docs('documents')} icon="instructions" badge={documents.length - generalDocuments.length}>
      {productGroups.length ? <div className="space-y-5">{productGroups.map(({ lineId, files }) => {
        const item = detail.delivery.source.items.find((entry) => entry.sourceLineId === lineId);
        return <section className="rounded-lg border border-border bg-muted/30 p-4" key={lineId}>
          <h4 className="text-sm font-semibold [overflow-wrap:anywhere]">{item ? sourceLineLabel(detail.delivery.source, item, locale) : t('productLineId', { id: lineId })}</h4>{renderFiles(files)}
        </section>;
      })}</div> : <Empty title={t('noFiles')} />}
    </DeliveryDetailCard>
    <DeliveryDetailCard title={t('linkedEvidence')} icon="shield" badge={evidence.length}>
      {evidence.length ? renderFiles(evidence) : <Empty title={t('noFiles')} />}
    </DeliveryDetailCard>
    {!detail.delivery.completedAt ? <section ref={uploadSection} className="scroll-mt-4">
      <DeliveryDetailCard title={replacement ? docs('replace') : t('attachFile')} icon="file">
      <Field label={docs('replace')}><Combobox value={replacement?.id ?? ''} onChange={(event) => setReplacementId(event.currentTarget.value || null)}>
        <option value="">{docs('newFile')}</option>{documents.filter((file) => file.status === 'ready' && !replacing.has(file.id)).map((file) => <option key={file.id} value={file.id}>{file.name} · {file.itemId === null ? docs('generalDocuments') : t('productLineId', { id: file.itemId })}</option>)}
      </Combobox></Field>
      {replacement ? <p className="small muted">{docs('replaceHelp')}</p> : null}
      <UploadForm key={replacement?.id ?? 'new'} detail={detail} command={command} replacement={replacement} onUploaded={() => setReplacementId(null)} />
      </DeliveryDetailCard>
    </section> : null}
  </>;
}

function UploadForm({ detail, command, replacement, onUploaded }: { detail: DeliveryDetail; command: Command; replacement: StoredFile | undefined; onUploaded: () => void }) {
  const t = useTranslations('delivery');
  const docs = useTranslations('operationsFlow');
  const locale = useLocale();
  const [kind, setKind] = useState('document');
  const uploadReceipt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  return <ActionForm submitLabel={t('uploadFile')} onSubmit={async (data) => {
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error(t('chooseFile'));
    if (file.size > 5 * 1024 * 1024) throw new Error(t('uploadLimit'));
    if (!['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].includes(file.type)) throw new Error(t('uploadMime'));
    const base64 = await readBase64(file, t);
    const itemId = replacement ? replacement.itemId : optionalText(data, 'itemId');
    const payload = { name: file.name, base64, kind, appointmentId: replacement ? replacement.appointmentId : optionalText(data, 'appointmentId'),
      itemId: itemId === null ? null : z.coerce.number().int().positive().parse(itemId), issueId: replacement ? replacement.issueId : optionalText(data, 'issueId'),
      ...(kind === 'document' ? { documentPurpose: z.enum(['general', 'instruction', 'drawing']).parse(textField(data, 'documentPurpose')) } : {}),
      ...(replacement ? { supersedesFileId: replacement.id } : {}),
    };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (uploadReceipt.current?.fingerprint !== fingerprint) uploadReceipt.current = { fingerprint, requestId: crypto.randomUUID() };
    await command('/files', { ...payload, requestId: uploadReceipt.current.requestId });
    uploadReceipt.current = null;
    onUploaded();
  }}>
    <Field label={t('file')} hint={t('fileHint')}><Input type="file" name="file" accept="application/pdf,image/png,image/jpeg,text/plain" required /></Field>
    <Field label={t('kind')}><Combobox name="kind" value={kind} disabled={Boolean(replacement)} onChange={(event) => setKind(event.currentTarget.value)}><option value="document">{t('operatorDocument')}</option><option value="photo">{t('operatorPhoto')}</option></Combobox></Field>
    {kind === 'document' ? <Field label={docs('purpose')}><Combobox name="documentPurpose" defaultValue={replacement?.documentPurpose ?? 'general'}><option value="general">{docs('general')}</option><option value="instruction">{docs('instruction')}</option><option value="drawing">{docs('drawing')}</option></Combobox></Field> : null}
    <Field label={t('relatedVisit')}><Combobox name="appointmentId" disabled={Boolean(replacement)} defaultValue={replacement?.appointmentId ?? ''}><option value="">{t('deliveryOnly')}</option>{detail.delivery.appointments.map((visit, index) => <option key={visit.id} value={visit.id}>{t('visitNumber', { number: index + 1 })} · {formatDateTime(visit.startsAt, locale)}</option>)}</Combobox></Field>
    <div className="form-grid"><Field label={t('relatedProduct')}><Combobox name="itemId" disabled={Boolean(replacement)} defaultValue={replacement?.itemId ?? ''}><option value="">{t('none')}</option>{detail.delivery.source.items.map((item) => <option key={item.sourceLineId} value={item.sourceLineId}>{sourceLineLabel(detail.delivery.source, item, locale)}</option>)}</Combobox></Field>
      <Field label={t('relatedIssue')}><Combobox name="issueId" disabled={Boolean(replacement)} defaultValue={replacement?.issueId ?? ''}><option value="">{t('none')}</option>{detail.delivery.issues.map((issue) => <option key={issue.id} value={issue.id}>{deliveryStatusLabel(t, issue.type)} · {issue.description.slice(0, 40)}</option>)}</Combobox></Field></div>
  </ActionForm>;
}

function readBase64(file: File, t: DeliveryText): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('readFileError')));
    reader.onabort = () => reject(new Error(t('uploadInterrupted')));
    reader.onload = () => { const result = reader.result; if (typeof result !== 'string') reject(new Error(t('invalidFile'))); else resolve(result.slice(result.indexOf(',') + 1)); };
    reader.readAsDataURL(file);
  });
}
