'use client';

import { Combobox } from './ui/combobox';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { dispatcherContentText, dispatcherValueKey } from '@/i18n/dispatcher';
import { apiRequest, errorMessage, mutate } from '@/lib/api';
import { dispatcherDetailSchema, dispatcherUpdateSchema, type DispatcherCase, type DispatcherChange, type DispatcherDetail, type DispatcherFacts, type DispatcherOwner } from '@/lib/dispatcher';
import { formatDateTime } from '@/lib/time';
import { sourceStateLabel } from '@/lib/source';
import { ActionForm, Empty, Field, Notice, Pending, textField } from './ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, useDialogClose } from './ui/dialog';

type CoordinationValues = { coordinator: string; nextAction: string; note: string };
function initialValues(item: DispatcherCase): CoordinationValues { return { coordinator: item.owner?.id ?? '', nextAction: item.nextAction ?? '', note: '' }; }

export function DispatcherCaseDialog({ caseKey, refreshKey, owners, active = true, onClose, onSaved, onOpenOriginal }: {
  caseKey: string; refreshKey: string; owners: readonly DispatcherOwner[]; active?: boolean; onClose: () => void; onSaved: () => void; onOpenOriginal: (item: DispatcherCase) => void;
}) {
  const t = useTranslations('dispatcher');
  const dialog = useDialogClose(onClose);
  const locale = useLocale();
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'facts' | 'history'>('facts');
  const [loaded, setLoaded] = useState<{ key: string; detail: DispatcherDetail } | null>(null);
  const [draft, setDraft] = useState<DispatcherCase | null>(null);
  const [values, setValues] = useState<CoordinationValues | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const pendingRead = useRef<AbortController | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const key = `${caseKey}:${refreshKey}:${revision}`;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); pendingRead.current = controller;
    void apiRequest(`/dispatcher/queue/${caseKey}`, dispatcherDetailSchema, { signal: controller.signal }).then((detail) => {
      if (controller.signal.aborted) return;
      setLoaded({ key, detail }); setDraft((previous) => previous ?? detail.item); setValues((previous) => previous ?? initialValues(detail.item)); setFailure(null);
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [caseKey, key, active]);
  const data = loaded?.detail;
  const item = data?.item;
  const ready = loaded?.key === key && failure === null;
  const staleFacts = draft !== null && item !== undefined && (draft.fingerprint !== item.fingerprint || draft.version !== item.version);
  function latest() { if (ready && item) { setDraft(item); setValues(initialValues(item)); } }
  async function save(body: DispatcherChange) {
    setSaving(true);
    try {
    const requestKey = JSON.stringify(body);
    if (!request.current || request.current.key !== requestKey) request.current = { key: requestKey, id: crypto.randomUUID() };
    const input = dispatcherUpdateSchema.parse({ ...body, requestId: request.current.id });
    const updated = await mutate(`/dispatcher/queue/${caseKey}`, dispatcherDetailSchema, input, 'PATCH');
    pendingRead.current?.abort(); setLoaded({ key, detail: updated }); setDraft(updated.item); setValues(initialValues(updated.item)); setFailure(null); onSaved();
    return updated.item.version;
    } finally { setSaving(false); }
  }
  const canOpen = item !== undefined && (item.target.section === 'routes' ? item.target.routeId !== null : item.target.deliveryId !== null);
  const targetLabel = item?.target.section === 'routes' ? 'openRoute' : item?.target.tab === 'issues' ? 'openIssues' : item?.target.tab === 'history' ? 'openHistory' : item?.target.tab === 'visits' ? 'openVisits' : 'openDelivery';
  return <Dialog open={active && dialog.open} onOpenChange={(open) => { if (!open) dialog.close(); }}><DialogContent className="dialog max-h-[85vh] overflow-y-auto sm:max-w-4xl" aria-describedby={undefined}>
    <div className="section-title"><DialogTitle>{t('details')}</DialogTitle><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={!ready && failure === null} onClick={() => { setFailure(null); setRevision((value) => value + 1); }}>{t('refresh')}</Button><Button type="button" variant="ghost" size="icon" aria-label={t('close')} onClick={dialog.close}>×</Button></div></div>
    {failure ? <Notice tone="error">{errorMessage(failure, locale)} <Button type="button" variant="outline" size="sm" onClick={() => { setFailure(null); setRevision((value) => value + 1); }}>{t('retry')}</Button></Notice> : null}
    {!data && !failure ? <Pending>{t('loading')}</Pending> : null}
    {item && data ? <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><span className={`badge ${item.status === 'open' ? 'warning' : 'success'}`}>{t(item.status)}</span><p className="mt-2 font-medium">{t(item.kind)} · {item.pickingName ?? item.customerName ?? item.title}</p></div>
        <Button type="button" variant="outline" disabled={!ready || !canOpen || saving} onClick={() => onOpenOriginal(item)}>{canOpen ? t(targetLabel) : t('unavailableTarget')}</Button></div>
      <p className="text-xs text-muted-foreground">{t('derivedHelp')}</p>
      <nav className="tabbar" aria-label={t('details')}>{(['facts', 'history'] as const).map((value) => <button key={value} type="button" className={tab === value ? 'active' : ''} aria-pressed={tab === value} onClick={() => setTab(value)}>{t(value)}</button>)}</nav>
      <div hidden={tab !== 'facts'} className="space-y-4">
        <DispatcherFactsReadout item={item} />
        {item.coordinationStale ? <Notice>{t('coordinationStale')}</Notice> : null}
        {item.status === 'resolved' ? <Notice tone="success">{t('resolvedHelp')}</Notice> : null}
        {staleFacts ? <Notice>{t('stale')}{ready ? <Button type="button" variant="outline" size="sm" className="ml-2" disabled={saving} onClick={latest}>{t('latest')}</Button> : null}</Notice> : null}
        {draft && values ? <CoordinationForm key={`${draft.version}:${draft.fingerprint}`} draft={draft} current={item} owners={owners} values={values} onValues={setValues}
          ready={ready && !staleFacts} onUseLatest={latest} save={save} /> : null}
      </div>
      <div hidden={tab !== 'history'}>{data.history.length ? <ol className="grid gap-4">{data.history.map((entry) => <li key={entry.version} className="rounded-md border border-border p-3">
        <h3 className="text-sm font-medium">{t('revision', { version: entry.version })}</h3><p className="mt-1 text-xs text-muted-foreground">{t('recordedBy', { name: entry.actor.name, date: formatDateTime(entry.at, locale) })}</p>
        <dl className="my-3 grid gap-2 text-xs"><div><dt className="font-medium">{t('coordinator')}</dt><dd>{entry.owner?.name ?? t('unassigned')}</dd></div><div><dt className="font-medium">{t('nextAction')}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.nextAction}</dd></div><div><dt className="font-medium">{t('note')}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.note}</dd></div></dl>
        <details><summary className="cursor-pointer text-xs">{t('snapshot')}</summary><div className="mt-3"><DispatcherFactsReadout item={entry.snapshot} /></div></details>
      </li>)}</ol> : <Empty title={t('noHistory')} />}</div>
    </> : null}
  </DialogContent></Dialog>;
}

function CoordinationForm({ draft, current, owners, values, onValues, ready, onUseLatest, save }: {
  draft: DispatcherCase; current: DispatcherCase; owners: readonly DispatcherOwner[]; values: CoordinationValues; onValues: (values: CoordinationValues) => void;
  ready: boolean; onUseLatest: () => void; save: (body: DispatcherChange) => Promise<number>;
}) {
  const t = useTranslations('dispatcher');
  const closed = current.status === 'resolved';
  return <ActionForm dataVersion={draft.version} onResetDraft={onUseLatest} disabled={closed} submitDisabled={!ready}
    submitLabel={t('save')} successMessage={t('saved')} onSubmit={(data) => {
      const body = { version: draft.version, fingerprint: draft.fingerprint, ownerUserId: textField(data, 'coordinator') || null,
        nextAction: textField(data, 'nextAction'), note: textField(data, 'coordinationNote') };
      return save(body);
    }}>
    <Field label={t('coordinator')} hint={t('ownerHelp')}><Combobox name="coordinator" value={values.coordinator} onChange={(event) => onValues({ ...values, coordinator: event.target.value })}>
      <option value="">{t('unassigned')}</option>{draft.owner && !owners.some((owner) => owner.id === draft.owner?.id) ? <option value={draft.owner.id}>{draft.owner.name}</option> : null}
      {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
    </Combobox></Field>
    <Field label={t('nextAction')} hint={t('nextActionHelp')}><textarea name="nextAction" rows={2} required maxLength={2000} value={values.nextAction} onChange={(event) => onValues({ ...values, nextAction: event.target.value })} /></Field>
    <Field label={t('note')} hint={t('noteHelp')}><textarea name="coordinationNote" rows={3} required maxLength={2000} value={values.note} onChange={(event) => onValues({ ...values, note: event.target.value })} /></Field>
  </ActionForm>;
}

function DispatcherFactsReadout({ item }: { item: DispatcherFacts }) {
  const t = useTranslations('dispatcher');
  const refusalText = useTranslations('signatureRefusal');
  const format = useFormatter();
  const locale = useLocale();
  return <div className="grid gap-3 text-xs [overflow-wrap:anywhere]">
    <p>{dispatcherContentText(item.description, locale)}</p><p className="font-medium">{[item.orderName, item.productName].filter(Boolean).join(' · ')}</p>
    {item.origin.sourceLineId ? <p className="font-mono text-muted-foreground">{t('line', { id: item.origin.sourceLineId })}</p> : null}
    {item.quantityMilli !== null ? <p className="font-mono">{format.number(item.quantityMilli / 1000)} {item.uom}</p> : null}
    {item.reasons.length ? <ul className="list-disc space-y-1 pl-4">{item.reasons.map((reason) => <li key={reason}>{dispatcherContentText(reason, locale)}</li>)}</ul> : null}
    {item.sourceOwner || item.sourceAction ? <dl className="grid gap-2 rounded-md border border-border bg-muted/30 p-3"><div><dt className="font-medium">{t('sourceOwner')}</dt><dd>{item.sourceOwner?.name ?? t('unassigned')}</dd></div><div><dt className="font-medium">{t('sourceAction')}</dt><dd className="whitespace-pre-wrap">{item.sourceAction ?? t('notProvided')}</dd></div></dl> : null}
    <dl className="grid gap-2 sm:grid-cols-2">{item.facts.map((fact, index) => {
      const valueKey = ['cargo_location', 'customer_signature', 'crew_signature'].includes(fact.label) ? dispatcherValueKey(fact.value) : undefined;
      let value = fact.value;
      if (valueKey) value = t(valueKey);
      else if (fact.label === 'source_status') value = sourceStateLabel(fact.value, locale);
      else if (fact.label === 'issue_status' && (fact.value === 'open' || fact.value === 'resolved')) value = t(fact.value);
      else if (fact.label === 'review_decision' && (fact.value === 'approved' || fact.value === 'corrected')) value = refusalText(fact.value);
      else if (fact.label === 'reviewed_at') value = formatDateTime(fact.value, locale);
      return <div key={`${fact.label}:${index}`}><dt className="font-medium">{dispatcherContentText(fact.label, locale)}</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{value || t('notProvided')}</dd></div>;
    })}</dl>
  </div>;
}
