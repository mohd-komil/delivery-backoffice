'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'motion/react';
import { Dialog } from 'radix-ui';
import type { CrewRoute } from '@/shared/api/route-contracts';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { Button } from '@/shared/ui/button';
import { Icon } from '@/shared/ui/icon';
import type { RouteActions } from '../model/actions';

export function RouteActionPanel({ route, actions }: { route: CrewRoute; actions: RouteActions }) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const reduceMotion = useReducedMotion();
  const reasonId = useId();
  const noteHintId = useId();
  const [note, setNote] = useState('');
  const [returnConfirmed, setReturnConfirmed] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const capabilities = route.capabilities;
  const busy = actions.busy !== null;

  if (route.status === 'cancelled' || route.status === 'closed') return null;
  if (route.status === 'returned') return <motion.section initial={false} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} className="panel detail-section border-[var(--warning-fg)]">
    <h2><Icon name="check" size={18} />{t('returnedSuccess')}</h2><p>{t('pendingReview')}</p><p className="text-muted">{t('warehouseSeparate')}</p>
  </motion.section>;

  const published = route.status === 'published';
  const returning = route.status === 'returning';
  const blocker = published ? capabilities.departBlockerCode : capabilities.returnBlockerCode;
  const responsibleLabel = route.resources.driver.kind === 'participant' ? 'responsibleOnly' : 'routeResponsibleOnly';
  const blockerLabel = routeBlockerLabel(blocker);
  const reason = returning
    ? capabilities.canMarkReturned ? null : t(responsibleLabel)
    : blocker ? t(blockerLabel === 'responsibleOnly' ? responsibleLabel : blockerLabel) : null;
  const command = published ? 'depart' : 'returning';
  const commandLabel = published ? 'depart' : 'beginReturn';
  const returnTrigger = <Dialog.Trigger asChild>
    <Button variant={returning ? 'primary' : 'secondary'} disabled={busy || !capabilities.canMarkReturned}
      aria-describedby={returning && reason ? reasonId : undefined}>
      {t('recordReturn')}<Icon name="pin" size={16} />
    </Button>
  </Dialog.Trigger>;

  async function recordReturn() {
    if (!capabilities.canMarkReturned || !returnConfirmed) return;
    if (await actions.run('return', route.version, note)) {
      setReturnOpen(false);
      setReturnConfirmed(false);
    }
  }

  return <Dialog.Root open={returnOpen} onOpenChange={setReturnOpen}>
    {route.status === 'in_progress' && capabilities.canMarkReturned ? <div className="justify-self-start">{returnTrigger}</div> : null}
    <div className="visit-action-bar" data-route-action-bar>
      {reason ? <p id={reasonId} className="visit-action-bar-blocker"><Icon name="alert" size={17} />{reason}</p> : null}
      <div className="visit-action-bar-controls">
        {returning ? returnTrigger : <Button disabled={busy || !(published ? capabilities.canDepart : capabilities.canReturn)}
          aria-describedby={reason ? reasonId : undefined} onClick={() => void actions.run(command, route.version, '')}>
          {actions.busy === command ? common('loading') : t(commandLabel)}<Icon name="arrowRight" size={16} />
        </Button>}
      </div>
    </div>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
      <Dialog.Content className="route-return-dialog panel detail-section">
        <Dialog.Title asChild><h2><span className="section-icon"><Icon name="pin" /></span>{t('recordReturn')}</h2></Dialog.Title>
        <Dialog.Description className="text-muted">{t('returnedHint')}</Dialog.Description>
        <p className="rounded-lg bg-[var(--info-bg)] p-3 text-[var(--info-fg)]">{t('warehouseSeparate')}</p>
        {capabilities.canMarkReturned ? <>
          <label className="field"><span>{t('optionalNote')}</span><textarea value={note} maxLength={2000} rows={3} disabled={busy}
            onChange={(event) => setNote(event.currentTarget.value)} aria-describedby={noteHintId} /></label>
          <p id={noteHintId} className="text-muted">{t('noteHint')}</p>
          <label className="checklist-item"><input type="checkbox" checked={returnConfirmed} disabled={busy} onChange={(event) => setReturnConfirmed(event.currentTarget.checked)} />{t('returnConfirmation')}</label>
        </> : <p className="text-muted">{t(responsibleLabel)}</p>}
        <div className="route-return-dialog-buttons">
          <Dialog.Close asChild><Button variant="secondary">{t('cancelReturnConfirmation')}</Button></Dialog.Close>
          <Button disabled={busy || !capabilities.canMarkReturned || !returnConfirmed} onClick={() => void recordReturn()}>
            {actions.busy === 'return' ? common('loading') : t('recordReturn')}<Icon name="check" size={16} />
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
