'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'motion/react';
import type { CrewRoute } from '@/shared/api/route-contracts';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { Button } from '@/shared/ui/button';
import { Icon } from '@/shared/ui/icon';
import type { RouteActions } from '../model/actions';

export function RouteActionPanel({ route, actions }: { route: CrewRoute; actions: RouteActions }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const reduceMotion = useReducedMotion();
  const [note, setNote] = useState('');
  const [returnConfirmed, setReturnConfirmed] = useState(false);
  const capabilities = route.capabilities;
  const busy = actions.busy !== null;

  if (route.status === 'cancelled' || route.status === 'closed') return null;
  if (route.status === 'returned') return <motion.section initial={false} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} className="panel detail-section border-[var(--warning-fg)]">
    <h2><Icon name="check" size={18} />{t('returnedSuccess')}</h2><p>{t('pendingReview')}</p><p className="text-muted">{t('warehouseSeparate')}</p>
  </motion.section>;

  const blocker = route.status === 'published' ? capabilities.departBlockerCode : capabilities.returnBlockerCode;
  return <section className="panel detail-section border-[var(--info-border)]" aria-label={t('nextStop')}>
    {route.status === 'published' ? <>
      <h2><span className="section-icon"><Icon name="truck" /></span>{t('depart')}</h2>
      <p className="text-muted">{t('departHint')}</p>
      {blocker ? <p id="route-action-reason" className="rounded-lg bg-[var(--warning-bg)] p-3 text-[var(--warning-fg)]">{t(routeBlockerLabel(blocker))}</p> : null}
      <Button className="justify-self-start" disabled={busy || !capabilities.canDepart} aria-describedby={blocker ? 'route-action-reason' : undefined}
        onClick={() => void actions.run('depart', route.version, '')}>{actions.busy === 'depart' ? common('loading') : t('depart')}<Icon name="arrowRight" size={16} /></Button>
    </> : <>
      {route.status === 'in_progress' ? <div className="grid gap-3">
        <h2><span className="section-icon"><Icon name="truck" /></span>{t('beginReturn')}</h2>
        <p className="text-muted">{t('beginReturnHint')}</p>
        {blocker ? <p id="route-return-reason" className="rounded-lg bg-[var(--warning-bg)] p-3 text-[var(--warning-fg)]">{t(routeBlockerLabel(blocker))}</p> : null}
        <Button variant="secondary" className="justify-self-start" disabled={busy || !capabilities.canReturn} aria-describedby={blocker ? 'route-return-reason' : undefined}
          onClick={() => void actions.run('returning', route.version, '')}>{actions.busy === 'returning' ? common('loading') : t('beginReturn')}</Button>
      </div> : null}
      <div className={route.status === 'in_progress' ? 'sub-section mt-2' : 'grid gap-3'}>
        <h2><span className="section-icon"><Icon name="pin" /></span>{t('recordReturn')}</h2>
        <p className="text-muted">{t('returnedHint')}</p>
        <p className="rounded-lg bg-[var(--info-bg)] p-3 text-[var(--info-fg)]">{t('warehouseSeparate')}</p>
        {capabilities.canMarkReturned ? <>
          <label className="field"><span>{t('optionalNote')}</span><textarea value={note} maxLength={2000} rows={3} disabled={busy}
            onChange={(event) => setNote(event.currentTarget.value)} aria-describedby="route-note-hint" /></label>
          <p id="route-note-hint" className="text-muted">{t('noteHint')}</p>
          <label className="checklist-item"><input type="checkbox" checked={returnConfirmed} disabled={busy} onChange={(event) => setReturnConfirmed(event.currentTarget.checked)} />{t('returnConfirmation')}</label>
          <Button className="justify-self-start" disabled={busy || !returnConfirmed} onClick={() => void actions.run('return', route.version, note)}>
            {actions.busy === 'return' ? common('loading') : t('recordReturn')}<Icon name="check" size={16} />
          </Button>
        </> : <p className="text-muted">{t('responsibleOnly')}</p>}
      </div>
    </>}
  </section>;
}
