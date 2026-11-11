import type { CrewRoute } from '@/shared/api/route-contracts';
import { romeDay } from '@/shared/lib/visit-display';

export function groupRoutes(routes: CrewRoute[], now: string) {
  const groups: { active: CrewRoute[]; upcoming: CrewRoute[]; history: CrewRoute[] } = { active: [], upcoming: [], history: [] };
  const today = romeDay(now);
  for (const route of routes) {
    if (route.status === 'returned' || route.status === 'closed' || route.status === 'cancelled') groups.history.push(route);
    else if (route.status === 'published' && romeDay(route.draft.departAt) > today) groups.upcoming.push(route);
    else groups.active.push(route);
  }
  groups.active.sort((a, b) => Date.parse(a.draft.departAt) - Date.parse(b.draft.departAt));
  groups.upcoming.sort((a, b) => Date.parse(a.draft.departAt) - Date.parse(b.draft.departAt));
  groups.history.sort((a, b) => Date.parse(b.draft.departAt) - Date.parse(a.draft.departAt));
  return groups;
}
