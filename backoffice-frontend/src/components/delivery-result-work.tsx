'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { Appointment } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { workOperations } from '@/lib/visit-work';
import { incompleteReasonLabels } from '@/lib/incomplete-work';
import { DetailIcon } from './delivery-detail-presentation';
import { DataTable } from './ui/data-table';

type VisitResult = Appointment['results'][number];

export function DeliveryResultWork({ result }: { result: VisitResult }) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const format = useFormatter();
  const scope = result.workScopeSnapshot;
  if (!scope) return <LegacyReportedQuantities result={result} />;

  const quantitiesByLine = new Map(result.quantities.map((entry) => [entry.sourceLineId, entry]));
  const reasonsByOperation = new Map(result.incompleteWork?.map((entry) => [`${entry.sourceLineId}:${entry.operation}`, entry]));
  return <section className="section-gap" aria-label={t('reportedVisitQuantities')}>
    <h5>{t('reportedVisitQuantities')}</h5>
    <p className="small muted mt-1">{t('visitWorkOutcomeHint')}</p>
    <DataTable caption={t('reportedVisitQuantities')} className="min-w-[760px]" resetKey={result.id}
      header={<tr><th scope="col">{workText('item')}</th><th scope="col">{t('visitWorkOperation')}</th><th scope="col">{t('visitWorkPlanned')}</th><th scope="col">{t('visitWorkDone')}</th><th scope="col">{t('visitWorkUnperformed')}</th><th scope="col">{t('visitWorkOutcome')}</th></tr>}
      rows={scope.lines.flatMap((line) => workOperations.filter((operation) => line[operation.key] > 0).map((operation) => {
        const planned = line[operation.key];
        const done = quantitiesByLine.get(line.sourceLineId)?.[operation.done] ?? 0;
        const unperformed = Math.max(0, planned - done);
        const reason = reasonsByOperation.get(`${line.sourceLineId}:${operation.label}`);
        const status = unperformed === 0 ? 'visitWorkCompleted' : done > 0 ? 'visitWorkPartial' : 'visitWorkNotPerformed';
        return <tr key={`${line.sourceLineId}:${operation.key}`}>
          <th scope="row" className="max-w-xs whitespace-normal text-xs font-medium normal-case">{sourceLineLabel(result.sourceSnapshot, line.sourceItem, locale)}<span className="cell-sub">{line.sourceItem.uom}</span></th>
          <td>{workText(operation.label)}</td>
          <td className="tabular-nums">{format.number(planned / 1000)}</td>
          <td className="tabular-nums">{format.number(done / 1000)}</td>
          <td className="tabular-nums">{format.number(unperformed / 1000)}</td>
          <td className="min-w-52 max-w-sm whitespace-normal">
            <span className={`badge ${unperformed === 0 ? 'success' : 'warning'}`}><DetailIcon name={unperformed === 0 ? 'check' : 'alert'} />{t(status)}</span>
            {unperformed > 0 ? reason ? <>
              <p className="mt-2 text-sm font-medium">{t(incompleteReasonLabels[reason.reason])}</p>
              {reason.note ? <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{reason.note}</p> : null}
            </> : <p className="small muted mt-2">{t(result.incompleteWork === undefined ? 'visitWorkLegacyReason' : 'visitWorkMissingReason')}</p> : null}
          </td>
        </tr>;
      }))} />
  </section>;
}

function LegacyReportedQuantities({ result }: { result: VisitResult }) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const format = useFormatter();
  const recorded = result.quantities.filter((quantity) => workOperations.some((operation) => (quantity[operation.done] ?? 0) > 0));
  return <section className="section-gap" aria-label={t('reportedVisitQuantities')}>
    <h5>{t('reportedVisitQuantities')}</h5>
    <p className="small muted">{t('visitWorkLegacyScope')}</p>
    {recorded.length === 0 ? <p className="small muted">{t('noReportedVisitQuantities')}</p> : <ul className="small">
      {recorded.map((quantity) => {
        const item = result.sourceSnapshot.items.find((entry) => entry.sourceLineId === quantity.sourceLineId);
        return <li key={quantity.sourceLineId}>
          {item ? sourceLineLabel(result.sourceSnapshot, item, locale) : t('sourceLine', { id: quantity.sourceLineId })}
          {workOperations.filter((operation) => (quantity[operation.done] ?? 0) > 0).map((operation) => <span key={operation.key}> · {workText(operation.label)} {format.number((quantity[operation.done] ?? 0) / 1000)} {item?.uom}</span>)}
        </li>;
      })}
    </ul>}
  </section>;
}
