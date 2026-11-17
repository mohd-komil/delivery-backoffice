'use client';

import { Combobox } from './ui/combobox';


import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { applyTimeStandardSchema, canApplyTimeStandard, timeStandardsListSchema, type ApplyTimeStandard, type TimeStandard } from '@/lib/planning-time-standards';
import { savedWorkTimeSchema } from '@/lib/work-times';
import type { LineService } from '@/lib/contracts';
import { ActionForm, Empty, Field, Notice, textField } from './ui';
import { Button } from './ui/button';
import { PlanningReadState, usePlanningRead } from './planning-reference-common';
import { StandardSnapshot } from './planning-time-standards';

const StandardsContext = createContext<{ read: ReturnType<typeof usePlanningRead<TimeStandard[]>>; activate: () => void } | null>(null);
export function TimeStandardsProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const read = usePlanningRead('/planning/time-standards', timeStandardsListSchema, active);
  const activate = useCallback(() => setActive(true), []);
  return <StandardsContext.Provider value={{ read, activate }}>{children}</StandardsContext.Provider>;
}

export function DeliveryTimeStandard({ line, unit, version, apply }: { line: LineService; unit: string; version: number; apply: (input: ApplyTimeStandard) => Promise<number> }) {
  const t = useTranslations('planning'); const [open, setOpen] = useState(false);
  return <div className="mt-4 border-t border-border pt-3"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t('applyTitle')}</Button>
    {open ? <StandardSelection line={line} unit={unit} version={version} apply={apply} /> : null}</div>;
}
function StandardSelection({ line, unit, version, apply }: { line: LineService; unit: string; version: number; apply: (input: ApplyTimeStandard) => Promise<number> }) {
  const t = useTranslations('planning');
  const context = useContext(StandardsContext);
  if (!context) throw new Error('Time standards need the product-line catalogue provider.');
  const { read, activate } = context;
  useEffect(() => { activate(); }, [activate]);
  const [selected, setSelected] = useState<TimeStandard | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const choices = read.data?.filter((item) => canApplyTimeStandard(item, line.service, unit)) ?? [];
  const current = choices.find((item) => item.id === selected?.id);
  const stale = selected !== null && read.ready && current?.version !== selected.version;
  return <div className="mt-3 grid gap-2"><p className="text-xs text-muted-foreground">{t('applyHelp')} {t('noAutoChanges')}</p>
    <div><Button type="button" variant="ghost" size="sm" disabled={read.loading} onClick={read.refresh}>{t('refresh')}</Button></div><PlanningReadState data={read.data !== null} failure={read.failure} loading={read.loading} retry={read.refresh} />
    {read.data && choices.length === 0 ? <Empty title={t('noStandards')} /> : null}
    {stale ? <Notice>{t('stale')}<Button type="button" variant="outline" size="sm" onClick={() => setSelected(current ?? null)}>{t('latest')}</Button></Notice> : null}
    <ActionForm dataVersion={version} onResetDraft={() => setSelected(null)} submitDisabled={!read.ready || stale || !selected || !current} submitLabel={t('apply')} successMessage={t('applied')} onSubmit={async (data) => {
      if (!selected || !current || stale || !read.ready) throw new Error(t('stale'));
      const body = { version, sourceLineId: line.sourceLineId, standardId: selected.id, standardVersion: selected.version, reason: textField(data, 'standardReason') };
      const key = JSON.stringify(body); if (!request.current || request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
      return apply(applyTimeStandardSchema.parse({ ...body, requestId: request.current.id }));
    }}>
      <Field label={t('chooseStandard')}><Combobox value={selected?.id ?? ''} required onChange={(event) => setSelected(choices.find((item) => item.id === event.target.value) ?? null)}><option value="">{t('chooseStandard')}</option>{selected && !choices.some((item) => item.id === selected.id) ? <option value={selected.id} disabled>{selected.name} · v{selected.version}</option> : null}{choices.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</Combobox></Field>
      {selected ? <div className="rounded-md border border-border bg-background p-3"><StandardSnapshot item={selected} /></div> : null}
      <Field label={t('reason')} hint={t('reasonHelp')}><textarea name="standardReason" rows={2} required maxLength={2000} /></Field>
    </ActionForm>
  </div>;
}

const appliedEventSchema = z.object({ sourceLineId: z.number().int().positive(), reason: z.string(), saved: savedWorkTimeSchema });
export function TimeStandardHistory({ details }: { details: unknown }) {
  const t = useTranslations('planning'); const deliveryText = useTranslations('delivery');
  const parsed = appliedEventSchema.safeParse(details);
  if (!parsed.success || !parsed.data.saved.timeStandard) return null;
  return <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs"><p className="font-mono">{deliveryText('sourceLine', { id: parsed.data.sourceLineId })}</p><StandardSnapshot item={parsed.data.saved.timeStandard} /><p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><strong>{t('reason')}:</strong> {parsed.data.reason}</p></div>;
}
