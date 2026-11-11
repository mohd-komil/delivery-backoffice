'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { motion } from 'motion/react';
import type { Delivery, LineService } from '@/lib/contracts';
import { formatDateTime } from '@/lib/time';
import { initialWorkDrafts, validateWorkDrafts } from '@/lib/visit-work';
import { DateTimeFields, dateTimeField } from './date-time-fields';
import { ActionForm, Field, Notice, textField } from './ui';
import { DetailHeading } from './delivery-detail-presentation';
import { WorkScopeFields } from './visit-work';

export function AppointmentBookingForm({ delivery, lineServices, command }: {
  delivery: Delivery;
  lineServices: LineService[] | undefined;
  command: (path: string, body: unknown) => Promise<number>;
}) {
  const t = useTranslations('delivery');
  const workText = useTranslations('workPlan');
  const locale = useLocale();
  const purposeName = useId();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [purpose, setPurpose] = useState<'regular' | 'return'>('regular');
  const [returnId, setReturnId] = useState('');
  const [workDrafts, setWorkDrafts] = useState(() => initialWorkDrafts(lineServices ?? []));
  const requests = delivery.returnRequests.filter((request) => request.status === 'requested');
  const selectedRequest = requests.find((request) => request.id === returnId);
  const origin = selectedRequest ? delivery.appointments.find((visit) => visit.id === selectedRequest.originAppointmentId) : undefined;

  function resetPurpose() { setPurpose('regular'); setReturnId(''); }

  return <section className="section-gap inset-card appointment-booking">
    <DetailHeading icon="calendar">{t('bookHeading')}</DetailHeading>
    {delivery.sourceReview || delivery.completedAt ? <Notice>{t('bookBlocked')}</Notice> : <>
      <p className="small muted">{t('bookingIntro')}</p>
      <ActionForm dataVersion={delivery.version} onResetDraft={() => { setRequestId(crypto.randomUUID()); resetPurpose(); setWorkDrafts(initialWorkDrafts(lineServices ?? [])); }} submitLabel={t('book')} submitDisabled={!lineServices} onSubmit={async (data) => {
        const startsAt = dateTimeField(data, 'startsAt', t);
        const endsAt = dateTimeField(data, 'endsAt', t);
        if (endsAt <= startsAt) throw new Error(t('endAfterStart'));
        const returnRequestId = textField(data, 'returnRequestId');
        if (purpose === 'return' && !requests.some((request) => request.id === returnRequestId)) throw new Error(t('bookingChooseReturn'));
        const work = validateWorkDrafts(workDrafts, lineServices ?? []);
        if (work.error) throw new Error(workText(work.error));
        const savedVersion = await command('/appointments', { version: delivery.version, requestId, startsAt, endsAt, workLines: work.lines, ...(returnRequestId ? { returnRequestId } : {}) });
        setRequestId(crypto.randomUUID());
        resetPurpose();
        setWorkDrafts((drafts) => drafts.map((draft) => ({ ...draft, deliveryMilli: '0', installationMilli: '0', collectionMilli: '0', customerStockConfirmed: false })));
        return savedVersion;
      }}>
        <fieldset className="booking-section">
          <legend className="booking-legend"><span aria-hidden="true">1</span>{t('bookingPurpose')}</legend>
          <div className="booking-purpose-grid">
            <label className="booking-purpose-option">
              <input type="radio" name={purposeName} value="regular" checked={purpose === 'regular'} onChange={() => setPurpose('regular')} />
              <span><strong>{t('regularVisit')}</strong><small>{t('bookingRegularHint')}</small></span>
            </label>
            <label className="booking-purpose-option" aria-disabled={requests.length === 0}>
              <input type="radio" name={purposeName} value="return" checked={purpose === 'return'} disabled={requests.length === 0} onChange={() => { setPurpose('return'); if (!selectedRequest) setReturnId(requests.length === 1 ? requests[0]?.id ?? '' : ''); }} />
              <span><strong>{t('bookingReturnVisit')}</strong><small>{requests.length ? t('bookingReturnCount', { count: requests.length }) : t('bookingNoReturns')}</small></span>
            </label>
          </div>
          {purpose === 'return' ? <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Field label={t('returnRequest')}><select name="returnRequestId" required value={returnId} onChange={(event) => setReturnId(event.target.value)}>
              <option value="">{t('bookingChooseReturn')}</option>
              {requests.map((request) => <option value={request.id} key={request.id}>{request.reason}</option>)}
            </select></Field>
            {selectedRequest ? <div className="booking-return-preview">
              <h4>{t('remainingWork')}</h4><p className="whitespace-pre-wrap break-words">{selectedRequest.remainingWork}</p>
              {origin ? <p className="small muted">{t('bookingOrigin', { date: formatDateTime(origin.startsAt, locale) })}</p> : null}
              {selectedRequest.notes ? <p className="small whitespace-pre-wrap break-words">{selectedRequest.notes}</p> : null}
            </div> : null}
          </motion.div> : <input type="hidden" name="returnRequestId" value="" />}
        </fieldset>
        <fieldset className="booking-section">
          <legend className="booking-legend"><span aria-hidden="true">2</span>{workText('scopeTitle')}</legend>
          <p className="small muted mb-3">{workText('repeatHint')}</p>
          {lineServices ? <WorkScopeFields source={delivery.source} lines={lineServices} drafts={workDrafts} onChange={setWorkDrafts} /> : <Notice>{workText('unavailable')}</Notice>}
        </fieldset>
        <fieldset className="booking-section">
          <legend className="booking-legend"><span aria-hidden="true">3</span>{t('bookingSchedule')}</legend>
          <DateTimeFields />
        </fieldset>
        <p className="small muted">{t('bookingNextStep')}</p>
      </ActionForm>
    </>}
  </section>;
}
