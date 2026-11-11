'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { sendRouteAction, type RouteAction } from '@/shared/api/routes';
import type { CrewRoute } from '@/shared/api/route-contracts';
import { routeBlockerLabel } from '@/shared/lib/route-display';
import { prepareRouteCommand, type PendingRouteCommand } from './command';

const success = { depart: 'departSuccess', returning: 'returningSuccess', return: 'returnedSuccess' } as const;

export function useRouteActions(routeId: string, publish: (route: CrewRoute) => void, revalidate: () => Promise<void>) {
  const t = useTranslations('routes');
  const common = useTranslations('crew');
  const locked = useRef(false);
  const pending = useRef<PendingRouteCommand | null>(null);
  const [busy, setBusy] = useState<RouteAction | null>(null);

  async function run(action: RouteAction, version: number, note: string) {
    if (locked.current) return false;
    const prepared = prepareRouteCommand(pending.current, action, version, note, () => crypto.randomUUID(), () => new Date().toISOString());
    pending.current = prepared;
    locked.current = true;
    setBusy(action);
    try {
      const result = await sendRouteAction(routeId, action, prepared.command);
      if (result.ok) {
        pending.current = null;
        publish(result.data);
        toast.success(t(success[action]), { id: 'crew-route-action' });
        return true;
      }
      if (result.status === 401) window.location.replace('/login');
      else if (result.status === 429) toast.error(common('rateLimited'), { id: 'crew-route-action' });
      else if (result.status === 403 || result.status === 404) toast.error(t('actionUnavailable'), { id: 'crew-route-action' });
      else if (result.status === 409) toast.error(t(result.code ? routeBlockerLabel(result.code) : 'routeConflict'), { id: 'crew-route-action' });
      else toast.error(t('actionFailed'), { id: 'crew-route-action' });
      if ([401, 403, 404, 409].includes(result.status)) {
        pending.current = null;
        await revalidate();
      }
      return false;
    } catch {
      toast.error(t('actionFailed'), { id: 'crew-route-action' });
      return false;
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }
  return { run, busy };
}

export type RouteActions = ReturnType<typeof useRouteActions>;
