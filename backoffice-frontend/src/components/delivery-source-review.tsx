'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { sourceReviewMessageKey } from '@/i18n/source-review';
import { apiRequest, errorMessage } from '@/lib/api';
import { sourceSchema, type Delivery } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { sourceChangeSchema, sourceChangeValue, sourceReviewInputSchema, sourceReviewSchema, type SourceReview, type SourceReviewUpdate } from '@/lib/source-review';
import { formatDateTime } from '@/lib/time';
import { ActionForm, ChoiceGroup, Field, Notice, textField } from './ui';
import { Button } from './ui/button';
import { DataTable } from './ui/data-table';
import { Input } from './ui/input';
import { DetailHeading } from './delivery-detail-presentation';

type Candidate = NonNullable<SourceReview['candidate']>;
type ReviewDraft = { version: number; candidate: Candidate };

export function DeliverySourceReview({ delivery, refreshKey, save, onRefreshDelivery }: {
  delivery: Delivery; refreshKey: string; save: (input: SourceReviewUpdate) => Promise<number>; onRefreshDelivery?: () => void;
}) {
  const t = useTranslations('sourceReview');
  const locale = useLocale();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: SourceReview } | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const key = `${delivery.id}:${delivery.version}:${refreshKey}:${revision}`;
  useEffect(() => {
    const controller = new AbortController(); pendingRead.current = controller;
    void apiRequest(`/deliveries/${delivery.id}/source-review`, sourceReviewSchema, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setLoaded((previous) => previous && previous.value.deliveryVersion > value.deliveryVersion ? { ...previous, key } : { key, value });
      setDraft((previous) => previous ?? (value.candidate ? { version: value.deliveryVersion, candidate: value.candidate } : null));
      setFailure(null);
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [delivery.id, key]);
  const data = loaded?.value;
  const deliveryStale = data !== undefined && data.deliveryVersion !== delivery.version;
  const ready = loaded?.key === key && failure === null && !deliveryStale;
  const candidate = draft?.candidate ?? data?.candidate;
  const staleCandidate = draft !== null && (draft.candidate.id !== data?.candidate?.id || draft.candidate.hash !== data?.candidate?.hash);
  function useLatest() {
    if (!ready || !data) return;
    setDraft(data.candidate ? { version: data.deliveryVersion, candidate: data.candidate } : null);
  }
  async function commit(input: SourceReviewUpdate) {
    const nextVersion = await save(input);
    pendingRead.current?.abort();
    setDraft(null); setRevision((value) => value + 1);
    return nextVersion;
  }
  return <section className="detail-section section-gap" aria-label={t('title')}>
    <div className="section-title"><DetailHeading icon="history">{t('title')}</DetailHeading>
      {data ? <span className={`badge ${data.status === 'current' ? 'neutral' : 'warning'}`}>{t(data.status)}</span> : null}</div>
    {loaded?.key !== key && !failure ? <p className="mt-2 text-xs text-muted-foreground" role="status">{t('loading')}</p> : null}
    {deliveryStale ? <Notice>{t('deliveryChanged')}{onRefreshDelivery ? <Button type="button" variant="outline" size="sm" className="ml-2" onClick={onRefreshDelivery}>{t('refreshDelivery')}</Button> : null}</Notice> : null}
    {failure ? <div className="mt-2 grid gap-2"><Notice tone="error">{t('unavailable')} {errorMessage(failure, locale)}</Notice><Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button></div> : null}
    {data ? <>
      <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">{t(data.revisionCoverage === 'unavailable' ? 'unavailableCoverage' : data.revisionCoverage)}</summary>
        <div className="mt-2 grid gap-2 text-muted-foreground"><p>{t('clockHelp')}</p><p>{t('documents')}</p><p className="font-mono [overflow-wrap:anywhere]">{t('accepted')}: {data.acceptedHash}</p></div>
      </details>
      {candidate ? <div className="mt-3 grid gap-3">
        <p className="text-xs text-muted-foreground">{t('help')}</p><p className="text-xs text-muted-foreground">{t('inProgress')}</p>
        {staleCandidate ? <Notice>{t('stale')}{ready && data.deliveryVersion === draft?.version ? <Button type="button" variant="outline" size="sm" className="ml-2" onClick={useLatest}>{t('latest')}</Button> : null}</Notice> : null}
        <p className="text-xs text-muted-foreground">{t('candidate')} · {t('firstSeen', { date: formatDateTime(candidate.firstSeenAt, locale) })} · <span className="font-mono">{candidate.hash.slice(0, 12)}</span></p>
        <p className="text-xs text-muted-foreground">{t(candidate.revisionCoverage === 'unavailable' ? 'unavailableCoverage' : candidate.revisionCoverage)}</p>
        {candidate.reasons.length > 0 ? <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{candidate.reasons.map((reason) => {
          const label = sourceReviewMessageKey(reason); return <li key={reason}>{label ? t(label) : reason}</li>;
        })}</ul> : null}
        {!candidate.qualifies ? <Notice tone="error">{t('notQualified')}</Notice> : null}
        {!candidate.readComplete ? <Notice>{t('incomplete')}</Notice> : null}
        <SourceChanges changes={candidate.changes} acceptedSource={delivery.source} proposedSource={candidate.source ?? undefined} resetKey={candidate.id} />
        {candidate.changes.some((change) => change.kind === 'service') ? <Notice>{t('serviceChangeHelp')}</Notice> : null}
        {!staleCandidate && data.blockers.length > 0 ? <section className="rounded-md border border-warning-foreground/25 bg-warning/30 p-3"><h4 className="text-xs font-medium">{t('blockers')}</h4><ul className="mt-2 grid list-disc gap-1 pl-4 text-xs">{data.blockers.map((blocker, index) => {
          const label = sourceReviewMessageKey(blocker.code);
          return <li key={`${blocker.code}:${index}`}>{label ? t(label) : blocker.message}{blocker.sourceLineId ? ` · ${t('line', { id: blocker.sourceLineId })}` : ''}</li>;
        })}</ul></section> : null}
        {draft ? <SourceDecision key={`${draft.version}:${draft.candidate.id}:${draft.candidate.hash}`} draft={draft} data={data}
          ready={ready && !staleCandidate} useLatest={useLatest} save={commit} /> : null}
      </div> : null}
    </> : null}
  </section>;
}

function SourceDecision({ draft, data, ready, useLatest, save }: {
  draft: ReviewDraft; data: SourceReview; ready: boolean; useLatest: () => void; save: (input: SourceReviewUpdate) => Promise<number>;
}) {
  const t = useTranslations('sourceReview');
  const [action, setAction] = useState<SourceReviewUpdate['action'] | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const allowed = action === 'accept' ? data.canAccept : action === 'keep_accepted' ? data.canKeepAccepted : false;
  return <ActionForm dataVersion={data.deliveryVersion} onResetDraft={useLatest} submitDisabled={!ready || !allowed}
    submitLabel={t('save')} successMessage={t('saved')} onSubmit={(form) => {
      const body = { version: draft.version, candidateId: draft.candidate.id, candidateHash: draft.candidate.hash, action, reason: textField(form, 'sourceDecisionReason') };
      const key = JSON.stringify(body);
      if (!request.current || request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
      return save(sourceReviewInputSchema.parse({ ...body, requestId: request.current.id }));
    }}>
    <ChoiceGroup label={t('action')}><div className="grid gap-2">{(['accept', 'keep_accepted'] as const).map((value) => <label key={value} className="flex items-start gap-2 text-sm">
      <Input type="radio" name="sourceDecisionAction" value={value} required checked={action === value}
        disabled={value === 'accept' ? !data.canAccept : !data.canKeepAccepted} onChange={() => setAction(value)} />{t(value === 'accept' ? 'accept' : 'keep')}
    </label>)}</div></ChoiceGroup>
    <p className="text-xs text-muted-foreground">{t('actionHelp')}</p>
    <Field label={t('reason')}><textarea name="sourceDecisionReason" required maxLength={2000} rows={3} /></Field>
  </ActionForm>;
}

function SourceChanges({ changes, acceptedSource, proposedSource, resetKey }: {
  changes: Candidate['changes']; acceptedSource?: Delivery['source']; proposedSource?: Delivery['source']; resetKey?: string;
}) {
  const t = useTranslations('sourceReview');
  const locale = useLocale();
  return <DataTable caption={t('changes')} header={<tr><th>{t('field')}</th><th>{t('before')}</th><th>{t('after')}</th></tr>}
    resetKey={resetKey} emptyRow={<tr><td colSpan={3}>{t('noChanges')}</td></tr>}
    rows={changes.map((change, index) => {
      const proposedItem = proposedSource?.items.find((line) => line.sourceLineId === change.sourceLineId);
      const source = proposedItem ? proposedSource : acceptedSource;
      const item = proposedItem ?? acceptedSource?.items.find((line) => line.sourceLineId === change.sourceLineId);
      const label = sourceReviewMessageKey(change.kind);
      return <tr key={`${change.kind}:${change.sourceLineId}:${index}`}><td className="whitespace-normal [overflow-wrap:anywhere]">{label ? t(label) : change.kind}
        {source && item ? <span className="cell-sub">{sourceLineLabel(source, item, locale)}</span> : change.sourceLineId ? <span className="cell-sub">{t('line', { id: change.sourceLineId })}</span> : null}</td>
        <td className="max-w-72 whitespace-pre-wrap [overflow-wrap:anywhere]">{change.before === null ? t('missing') : sourceChangeValue(change.before)}</td><td className="max-w-72 whitespace-pre-wrap [overflow-wrap:anywhere]">{change.after === null ? t('missing') : sourceChangeValue(change.after)}</td></tr>;
    })} />;
}

const sourceHistorySchema = z.object({ reason: z.string().optional(), changes: z.array(sourceChangeSchema).optional(),
  previousSource: sourceSchema.optional(), proposedSource: sourceSchema.nullable().optional() });
export function SourceReviewHistory({ details }: { details: unknown }) {
  const t = useTranslations('sourceReview');
  const parsed = sourceHistorySchema.safeParse(details);
  if (!parsed.success) return null;
  return <div className="mt-2 grid gap-2 text-xs">{parsed.data.reason ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><strong>{t('reason')}: </strong>{parsed.data.reason}</p> : null}
    {parsed.data.changes ? <SourceChanges changes={parsed.data.changes} acceptedSource={parsed.data.previousSource} proposedSource={parsed.data.proposedSource ?? undefined} /> : null}</div>;
}
