import type { RouteAction, RouteCommand } from '@/shared/api/routes';

export type PendingRouteCommand = { key: string; command: RouteCommand };

/** An uncertain response must retry the original return time and request ID. */
export function prepareRouteCommand(previous: PendingRouteCommand | null, action: RouteAction, version: number, note: string,
  createId: () => string, now: () => string): PendingRouteCommand {
  const trimmed = action === 'return' ? note.trim() : '';
  const key = JSON.stringify({ action, version, note: trimmed });
  if (previous?.key === key) return previous;
  return { key, command: {
    version, requestId: createId(),
    ...(action === 'return' ? { actualReturnedAt: now(), ...(trimmed ? { note: trimmed } : {}) } : {}),
  } };
}
