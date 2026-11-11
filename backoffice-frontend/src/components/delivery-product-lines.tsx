'use client';

import Image from 'next/image';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { serviceTypeSchema, type DeliveryDetail, type ServiceType } from '@/lib/contracts';
import { sourceLineLabel, sourceLineOrder } from '@/lib/source';
import { ActionForm, Field, textField } from './ui';
import { Button } from './ui/button';
import { DetailHeading, deliveryServiceLabel } from './delivery-detail-presentation';
import { WorkAvailabilityTable } from './visit-work';

type ServiceUpdate = { version: number } & (
  { defaultService: ServiceType } | { sourceLineId: number; service: ServiceType | null }
);

export function DeliveryProductLines({ detail, saveService }: {
  detail: DeliveryDetail;
  saveService: (update: ServiceUpdate) => Promise<number>;
}) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const format = useFormatter();
  const editorId = useId();
  const [editor, setEditor] = useState<'default' | number | null>(null);
  const { delivery, lineServices, deliveredQuantities } = detail;
  const { source, version } = delivery;
  const defaultService = delivery.servicePlan?.defaultService ?? null;
  const canEdit = delivery.completedAt === null && !delivery.appointments.some((visit) => visit.status === 'in_progress');
  const serviceByLine = new Map(lineServices?.map((line) => [line.sourceLineId, line]));
  const deliveredByLine = new Map(deliveredQuantities.map((line) => [line.sourceLineId, line.deliveredMilli]));
  const options = serviceTypeSchema.options.map((service) => <option key={service} value={service}>{deliveryServiceLabel(t, service)}</option>);

  return <section className="detail-section section-gap">
    <div className="section-title">
      <DetailHeading icon="package">{t('productLines')}</DetailHeading>
      <span className="badge neutral">{source.items.length}</span>
    </div>
    <p className="small muted">{t(lineServices ? 'lineServicesHint' : 'productLinesHint')}</p>
    {lineServices ? <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
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
      const lineEditorId = `${editorId}-${item.sourceLineId}`;
      const isEditing = editor === item.sourceLineId;
      const canEditLine = delivery.completedAt === null && line !== undefined && (line.service === null || (canEdit && !line.locked));
      const progress = line ? [
        { label: 'workDelivery', done: line.deliveredMilli, remaining: line.remainingDeliveryMilli },
        { label: 'workInstallation', done: line.installedMilli, remaining: line.remainingInstallationMilli },
        { label: 'workCollection', done: line.collectedMilli, remaining: line.remainingCollectionMilli },
      ] as const : [];

      return <article className={line ? 'product-row flex-wrap' : 'product-row'} key={item.sourceLineId}>
        <div className="product-photo">{item.photoUrl ? <Image unoptimized src={item.photoUrl} alt={item.name} width={72} height={72} /> : <span>{t('noPhoto')}</span>}</div>
        <div className="product-description">
          <h4>{item.name}</h4>
          <p>{item.description ?? t('descriptionMissing')}</p>
          <span className="cell-sub">{t('configuration')} {item.configuration ?? t('notProvided')} {t('ambient')} {item.ambient ?? t('notProvided')}</span>
          {item.notes ? <span className="cell-sub">{item.notes}</span> : null}
          <span className="cell-sub">{sourceLineOrder(source, item, locale)}</span>
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
              {line.locked && line.service !== null ? <span className="badge warning">{workText('reservationLocked')}</span> : null}
            </div>
            {canEditLine ? <Button type="button" size="sm" variant="outline" aria-expanded={isEditing} aria-controls={isEditing ? lineEditorId : undefined}
              aria-label={`${t(isEditing ? 'hideServiceEditor' : 'editLineService')} · ${sourceLineLabel(source, item, locale)}`}
              onClick={() => setEditor(isEditing ? null : item.sourceLineId)}>
              {t(isEditing ? 'hideServiceEditor' : 'editLineService')}
            </Button> : null}
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
            {progress.filter(({ done, remaining }) => done > 0 || remaining > 0).map(({ label, done, remaining }) => <div key={label}>
              <dt className="font-medium">{t(label)}</dt>
              <dd className="mt-1 text-muted-foreground">{t('workProgress', { done: format.number(done / 1000), remaining: format.number(remaining / 1000) })}</dd>
            </div>)}
          </dl>
          {canEditLine && isEditing ? <div className="mt-3" id={lineEditorId}>
            <ActionForm dataVersion={version} submitLabel={t('saveService')} secondary onSubmit={(data) => {
              const selected = textField(data, 'service');
              return saveService({ version, sourceLineId: item.sourceLineId, service: selected ? serviceTypeSchema.parse(selected) : null });
            }}>
              <Field label={t('lineService')}><select name="service" defaultValue={line.inherited ? '' : line.service ?? ''}>
                <option value="" disabled={defaultService === null}>{t('inheritDefaultService', { service: defaultService ? deliveryServiceLabel(t, defaultService) : workText('currentUnknown') })}</option>
                {options}
              </select></Field>
            </ActionForm>
          </div> : null}
        </div> : null}
      </article>;
    })}
    {lineServices ? <WorkAvailabilityTable source={source} lines={lineServices} /> : null}
  </section>;
}

function DefaultServiceForm({ detail, saveService }: { detail: DeliveryDetail; saveService: (update: ServiceUpdate) => Promise<number> }) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const current = detail.delivery.servicePlan?.defaultService ?? null;
  const [selected, setSelected] = useState<ServiceType | ''>(current ?? '');
  const lines = detail.lineServices ?? [];
  const affected = lines.filter((line) => line.inherited && (!line.locked || line.service === null) && line.service !== selected);
  const protectedLines = lines.filter((line) => !line.inherited || (line.locked && line.service !== null));
  const items = new Map(detail.delivery.source.items.map((item) => [item.sourceLineId, item]));
  return <ActionForm dataVersion={detail.delivery.version} submitLabel={t('saveService')} submitDisabled={!selected || selected === current} secondary
    onResetDraft={() => setSelected(current ?? '')} onSubmit={() => saveService({ version: detail.delivery.version, defaultService: serviceTypeSchema.parse(selected) })}>
    <Field label={t('defaultService')} hint={t('defaultServiceHint')}>
      <select name="service" required value={selected} onChange={(event) => setSelected(serviceTypeSchema.parse(event.target.value))}>
        <option value="" disabled>{workText('unknownService')}</option>
        {serviceTypeSchema.options.map((service) => <option key={service} value={service}>{deliveryServiceLabel(t, service)}</option>)}
      </select>
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
