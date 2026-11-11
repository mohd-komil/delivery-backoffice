'use client';

import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { API_URL } from '@/lib/api';
import type { Appointment } from '@/lib/contracts';
import { sourceLineLabel } from '@/lib/source';
import { DetailIcon, deliveryStatusLabel } from './delivery-detail-presentation';

type VisitResult = Appointment['results'][number];
type Evidence = VisitResult['evidence'][number];

function PhotoList({ photos, deliveryId, label }: { photos: Evidence[]; deliveryId: string; label: 'itemCheckPhoto' | 'completionPhoto' }) {
  const t = useTranslations('delivery');
  return <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
    {photos.map((photo, index) => {
      const url = `${API_URL}/deliveries/${deliveryId}/files/${photo.id}`;
      return <li key={photo.id}>
        <a className="block rounded-md border border-border bg-background p-2 text-sm" href={url} target="_blank" rel="noreferrer">
          <Image unoptimized crossOrigin="use-credentials" src={url} alt="" width={160} height={100} className="mb-2 aspect-[8/5] w-full rounded-sm bg-muted object-contain" />
          {t(label, { number: index + 1 })} ↗
        </a>
      </li>;
    })}
  </ul>;
}

export function groupResultPhotos(result: Pick<VisitResult, 'sourceSnapshot' | 'evidence'>) {
  const knownLines = new Set(result.sourceSnapshot.items.map((item) => item.sourceLineId));
  const photosByLine = new Map<number, Evidence[]>();
  const generalPhotos: Evidence[] = [];
  const seenPhotos = new Set<string>();

  for (const entry of result.evidence) {
    if (entry.type !== 'photo' || seenPhotos.has(entry.id)) continue;
    seenPhotos.add(entry.id);
    const [lineId] = entry.itemIds;
    if (entry.itemIds.length !== 1 || lineId === undefined || !knownLines.has(lineId)) {
      generalPhotos.push(entry);
      continue;
    }
    const photos = photosByLine.get(lineId);
    if (photos) photos.push(entry);
    else photosByLine.set(lineId, [entry]);
  }
  return { photosByLine, generalPhotos };
}

export function DeliveryResultEvidence({ result, deliveryId }: { result: VisitResult; deliveryId: string }) {
  const t = useTranslations('delivery');
  const locale = useLocale();
  const snapshot = result.sourceSnapshot;
  const checksByLine = new Map(result.itemChecks?.map((check) => [check.sourceLineId, check]));
  const { photosByLine, generalPhotos } = groupResultPhotos(result);
  const otherEvidence = result.evidence.filter((entry) => entry.type !== 'photo');
  const checkedItems = snapshot.items.filter((item) => checksByLine.has(item.sourceLineId) || photosByLine.has(item.sourceLineId));
  return <>
    {checkedItems.length > 0 ? <section className="section-gap" aria-label={t('itemChecksHeading')}>
      <h5>{t('itemChecksHeading')}</h5>
      <ul className="mt-2 space-y-2">
        {checkedItems.map((item) => {
          const check = checksByLine.get(item.sourceLineId);
          const photos = photosByLine.get(item.sourceLineId);
          const problem = check?.status === 'problem';
          return <li key={item.sourceLineId} className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h6 className="min-w-0 break-words font-medium">{sourceLineLabel(snapshot, item, locale)}</h6>
              {check ? <span className={`badge ${problem ? 'warning' : 'success'}`}>
                <DetailIcon name={problem ? 'alert' : 'check'} />{t(problem ? 'itemCheckProblem' : 'itemCheckOk')}
              </span> : null}
            </div>
            {check?.note ? <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{check.note}</p> : null}
            {photos ? <PhotoList photos={photos} deliveryId={deliveryId} label="itemCheckPhoto" /> : null}
          </li>;
        })}
      </ul>
    </section> : null}
    {generalPhotos.length > 0 ? <section className="section-gap" aria-label={t('completionPhotos')}>
      <h5>{t('completionPhotos')}</h5>
      <PhotoList photos={generalPhotos} deliveryId={deliveryId} label="completionPhoto" />
    </section> : null}
    {otherEvidence.length > 0 ? <details><summary>{t('linkedEvidence')}</summary>
      <ul>{otherEvidence.map((entry) => <li key={entry.id}>
        <a href={`${API_URL}/deliveries/${deliveryId}/files/${entry.id}`} target="_blank" rel="noreferrer">{deliveryStatusLabel(t, entry.type)} ↗</a>
        {entry.itemIds.length ? ` · ${t('productLinesList', { ids: entry.itemIds.join(', ') })}` : ''}
      </li>)}</ul>
    </details> : null}
  </>;
}
