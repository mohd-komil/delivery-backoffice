'use client';

import { Combobox } from './ui/combobox';


import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { apiRequest, errorMessage } from '@/lib/api';
import { detailSchema, type Appointment } from '@/lib/contracts';
import type { RouteLineStatus, ReconciliationLineInput } from '@/lib/route-operations';
import { formatDateTime } from '@/lib/time';
import { Field } from './ui';
import { Button } from './ui/button';

/** Only an existing visit with this exact line/operation may own the already-planned remainder. */
export function RouteFollowUpSelect({ line, operation, value, onChange }: {
  line: RouteLineStatus; operation: ReconciliationLineInput['nextActions'][number]['operation']; value: string | null; onChange: (value: string | null) => void;
}) {
  const t = useTranslations('routeOperations');
  const locale = useLocale();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest(`/deliveries/${line.deliveryId}`, detailSchema, { signal: controller.signal }).then((detail) => {
      if (!controller.signal.aborted) { setAppointments(detail.delivery.appointments); setFailure(null); }
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error); });
    return () => controller.abort();
  }, [line.deliveryId, retry]);
  const quantity = operation === 'delivery' ? 'deliveryMilli' : operation === 'installation' ? 'installationMilli' : 'collectionMilli';
  const eligible = appointments.filter((appointment) => appointment.id !== line.appointmentId && ['booked', 'in_progress'].includes(appointment.status) && appointment.workScope?.lines.some((item) => item.sourceLineId === line.sourceLineId && item[quantity] > 0));
  return <div><Field label={t('followUp')}><Combobox required value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}><option value="">—</option>
    {value && !eligible.some((appointment) => appointment.id === value) ? <option value={value} disabled>{t('stale')}</option> : null}
    {eligible.map((appointment) => <option key={appointment.id} value={appointment.id}>{formatDateTime(appointment.startsAt, locale)} – {formatDateTime(appointment.endsAt, locale)}</option>)}
  </Combobox></Field>{failure ? <p className="text-xs text-destructive">{errorMessage(failure, locale)} <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button></p> : null}</div>;
}
