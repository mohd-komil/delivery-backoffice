'use client';

import { Combobox } from './ui/combobox';


import Image from 'next/image';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { serviceTypeSchema, type DeliveryDetail, type ServiceType } from '@/lib/contracts';
import { sourceLineLabel, sourceLineOrder } from '@/lib/source';
import { ActionForm, Field, textField } from './ui';
import { Button } from './ui/button';
import { deliveryServiceLabel } from './delivery-detail-presentation';
import { DeliveryDetailCard } from './delivery-detail-card';
import { WorkAvailabilityTable } from './visit-work';
import { DeliveryWorkTime } from './delivery-work-time';
import type { WorkTimesUpdate } from '@/lib/work-times';
import type { PriorWorkUpdate } from '@/lib/prior-work';
import type { ApplyTimeStandard } from '@/lib/planning-time-standards';
import { DeliveryPriorWork } from './delivery-prior-work';
import { TimeStandardsProvider } from './delivery-time-standard';
import { EditWorkQuantities, WorkQuantitySummary } from './delivery-work-quantities';
import type { WorkQuantitiesUpdate } from '@/lib/work-quantities';

type ServiceUpdate = { version: number } & (
  { defaultService: ServiceType } | { sourceLineId: number; service: ServiceType | null }
);

export function DeliveryProductLines({ detail, saveService, saveWorkTimes, savePriorWork, applyTimeStandard, saveWorkQuantities }: {
  detail: DeliveryDetail;
  saveService: (update: ServiceUpdate) => Promise<number>;
  saveWorkTimes?: (update: WorkTimesUpdate) => Promise<number>;
  savePriorWork?: (update: PriorWorkUpdate) => Promise<number>;
  applyTimeStandard?: (update: ApplyTimeStandard) => Promise<number>;
  saveWorkQuantities?: (update: WorkQuantitiesUpdate) => Promise<number>;
}) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const timeText = useTranslations('workTimes');
  const quantityText = useTranslations('workQuantities');
  const locale = useLocale();
  const format = useFormatter();
  const editorId = useId();
  const [editor, setEditor] = useState<'default' | number | null>(null);
  const { delivery, lineServices, deliveredQuantities } = detail;
  const { source, version } = delivery;
  const defaultService = delivery.servicePlan?.defaultService ?? null;
  const canEdit = delivery.completedAt === null && !delivery.appointments.some((visit) => visit.status === 'in_progress');
  const serviceByLine = new Map(lineServices?.map((line) => [line.sourceLineId, line]));
  const workTimesByLine = new Map(detail.lineWorkTimes?.map((line) => [line.sourceLineId, line]));
  const priorWorkByLine = new Map(detail.priorWork?.lines.map((line) => [line.sourceLineId, line]));
  const deliveredByLine = new Map(deliveredQuantities.map((line) => [line.sourceLineId, line.deliveredMilli]));
  const options = serviceTypeSchema.options.map((service) => <option key={service} value={service}>{deliveryServiceLabel(t, service)}</option>);

  return <TimeStandardsProvider><DeliveryDetailCard title={t('productLines')} icon="package" badge={source.items.length}>
    <p className="small muted">{t(lineServices ? 'lineServicesHint' : 'productLinesHint')}</p>
    {detail.lineWorkTimes ? <p className="mt-2 text-xs text-muted-foreground">{timeText('intro')}</p> : null}
    {lineServices ? <div className="overview-default-service">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <h4 className="font-medium">{t('defaultService')}</h4>
          <p className="small muted mt-1">{defaultService ? deliveryServiceLabel(t, defaultService) : workText('currentUnknown')}</p>
        </div>
        {canEdit ? <Button type="button" size="sm" variant="outline" aria-expanded={editor === 'default'} aria-controls={editor === 'default' ? editorId : undefined}
          onClick={() => setEditor(editor === 'default' ? null : 'default')}>
          {t(editor === 'default' ? 'hideServiceEditor' : 'editDefaultService')}
        </Button> : null}
      </div>
      {canEdit && editor === 'default' ? <div className="mt-3" id={editorId}>
        <DefaultServiceForm detail={detail} saveService={saveService} />
      </div> : null}
      {!canEdit ? <p className="small muted mt-2">{delivery.completedAt === null && lineServices.some((line) => line.service === null) ? workText('missingServiceReview') : t('servicePlanLocked')}</p> : null}
    </div> : null}
    {source.items.map((item) => {
      const line = serviceByLine.get(item.sourceLineId);
      const workTime = workTimesByLine.get(item.sourceLineId);
      const priorWork = priorWorkByLine.get(item.sourceLineId);
      const lineEditorId = `${editorId}-${item.sourceLineId}`;
      const isEditing = editor === item.sourceLineId;
      const canEditLine = delivery.completedAt === null && line !== undefined && !line.requiredQuantitiesCustomized && (line.service === null || (canEdit && !line.locked));
      const lineLabel = sourceLineLabel(source, item, locale);

      return <article id={`product-line-${item.sourceLineId}`} tabIndex={-1} className={line ? 'product-row flex-wrap' : 'product-row'} key={item.sourceLineId}>
        <div className="product-photo">{item.photoUrl ? <Image unoptimized src={item.photoUrl} alt={item.name} width={72} height={72} /> : <span>{t('noPhoto')}</span>}</div>
        <div className="product-description">
          <h4>{item.name}</h4>
          <p>{item.description ?? t('descriptionMissing')}</p>
          <span className="cell-sub">{t('configuration')} {item.configuration ?? t('notProvided')} {t('ambient')} {item.ambient ?? t('notProvided')}</span>
          {item.notes ? <span className="cell-sub">{item.notes}</span> : null}
          <span className="cell-sub">{sourceLineOrder(source, item, locale)}</span>
          {item.sku ? <span className="cell-sub font-mono">SKU: {item.sku}</span> : null}
          <span className="mono small muted">{t('sourceLine', { id: item.sourceLineId })}</span>
        </div>
        <div className="product-quantity">
          <strong>{format.number(item.quantity)} {item.uom}</strong>
          {!line ? <span className="cell-sub">{t('deliveredAmount', { amount: format.number((deliveredByLine.get(item.sourceLineId) ?? 0) / 1000) })}</span> : null}
        </div>
        {line ? <div className="w-full min-w-0 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="badge info">{line.service ? deliveryServiceLabel(t, line.service) : workText('unknownService')}</span>
              <span className="small muted">{t(line.inherited ? 'inheritedService' : 'customService')}</span>
              {line.serviceOrigin ? <span className="small muted">{timeText(line.serviceOrigin === 'local' ? 'serviceLocal' : line.serviceOrigin === 'source' ? 'serviceSource' : 'serviceUnknown')}</span> : null}
              {line.locked && line.service !== null ? <span className="badge warning">{workText('reservationLocked')}</span> : null}
              {line.requiredQuantitiesCustomized ? <span className="badge info">{quantityText('customized')}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {canEditLine ? <Button type="button" size="sm" variant="outline" aria-expanded={isEditing} aria-controls={isEditing ? lineEditorId : undefined}
                aria-label={`${t(isEditing ? 'hideServiceEditor' : 'editLineService')} · ${lineLabel}`}
                onClick={() => setEditor(isEditing ? null : item.sourceLineId)}>
                {t(isEditing ? 'hideServiceEditor' : 'editLineService')}
              </Button> : null}
              {saveWorkQuantities && line.canEditRequiredQuantities !== undefined && line.service ? <EditWorkQuantities line={line} item={item} label={lineLabel} version={version} save={saveWorkQuantities} /> : null}
            </div>
          </div>
          {line.requiredQuantitiesCustomized && line.canEditRequiredQuantities && !line.locked ? <p className="mt-2 text-xs text-muted-foreground">{quantityText('restoreBeforeService')}</p> : null}
          <WorkQuantitySummary line={line} unit={item.uom} />
          {canEditLine && isEditing ? <div className="mt-3" id={lineEditorId}>
            <ActionForm dataVersion={version} submitLabel={t('saveService')} secondary onSubmit={(data) => {
              const selected = textField(data, 'service');
              return saveService({ version, sourceLineId: item.sourceLineId, service: selected ? serviceTypeSchema.parse(selected) : null });
            }}>
              <Field label={t('lineService')}><Combobox name="service" defaultValue={line.inherited ? '' : line.service ?? ''}>
                <option value="" disabled={defaultService === null}>{t('inheritDefaultService', { service: defaultService ? deliveryServiceLabel(t, defaultService) : workText('currentUnknown') })}</option>
                {options}
              </Combobox></Field>
            </ActionForm>
          </div> : null}
          {workTime && saveWorkTimes ? <DeliveryWorkTime line={line} estimate={workTime} unit={item.uom}
            label={lineLabel} version={version} save={saveWorkTimes} applyStandard={applyTimeStandard}
            standard={delivery.servicePlan?.timeEstimates?.find((value) => value.sourceLineId === item.sourceLineId)?.timeStandard} /> : null}
          {priorWork && savePriorWork ? <DeliveryPriorWork line={line} history={priorWork} unit={item.uom}
            label={lineLabel} version={version} save={savePriorWork} /> : null}
        </div> : null}
      </article>;
    })}
    {lineServices ? <WorkAvailabilityTable source={source} lines={lineServices} /> : null}
  </DeliveryDetailCard></TimeStandardsProvider>;
}

function DefaultServiceForm({ detail, saveService }: { detail: DeliveryDetail; saveService: (update: ServiceUpdate) => Promise<number> }) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const current = detail.delivery.servicePlan?.defaultService ?? null;
  const [selected, setSelected] = useState<ServiceType | ''>(current ?? '');
  const lines = detail.lineServices ?? [];
  const isProtected = (line: (typeof lines)[number]) => !line.inherited || line.requiredQuantitiesCustomized || (line.locked && line.service !== null);
  const affected = lines.filter((line) => !isProtected(line) && line.service !== selected);
  const protectedLines = lines.filter(isProtected);
  const items = new Map(detail.delivery.source.items.map((item) => [item.sourceLineId, item]));
  return <ActionForm dataVersion={detail.delivery.version} submitLabel={t('saveService')} submitDisabled={!selected || selected === current} secondary
    onResetDraft={() => setSelected(current ?? '')} onSubmit={() => saveService({ version: detail.delivery.version, defaultService: serviceTypeSchema.parse(selected) })}>
    <Field label={t('defaultService')} hint={t('defaultServiceHint')}>
      <Combobox name="service" required value={selected} onChange={(event) => setSelected(serviceTypeSchema.parse(event.target.value))}>
        <option value="" disabled>{workText('unknownService')}</option>
        {serviceTypeSchema.options.map((service) => <option key={service} value={service}>{deliveryServiceLabel(t, service)}</option>)}
      </Combobox>
    </Field>
    {selected && selected !== current ? <section className="mt-3 rounded-md border border-border bg-background p-3" aria-live="polite">
      <h4 className="font-medium">{workText('defaultPreview')}</h4>
      <h5 className="mt-3 text-sm font-medium">{workText('affected', { count: affected.length })}</h5>
      {affected.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{affected.map((line) => {
        const item = items.get(line.sourceLineId);
        return item ? <li key={line.sourceLineId}>{workText('previewLine', { line: sourceLineLabel(detail.delivery.source, item, locale), before: line.service ? deliveryServiceLabel(t, line.service) : workText('currentUnknown'), after: deliveryServiceLabel(t, selected) })}</li> : null;
      })}</ul> : <p className="small muted">{workText('noAffected')}</p>}
      <h5 className="mt-3 text-sm font-medium">{workText('protected', { count: protectedLines.length })}</h5>
      <p className="small muted">{workText('protectedHint')}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{protectedLines.map((line) => {
        const item = items.get(line.sourceLineId);
        return item ? <li key={line.sourceLineId}>{sourceLineLabel(detail.delivery.source, item, locale)} · {line.service ? deliveryServiceLabel(t, line.service) : workText('currentUnknown')}</li> : null;
      })}</ul>
    </section> : null}
  </ActionForm>;
}
