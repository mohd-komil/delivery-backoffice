import type { VisitSummary } from '@/shared/api/contracts';
import { romeDay } from '@/shared/lib/visit-display';

export function groupVisits(visits: VisitSummary[], now: string) {
  const today = romeDay(now);
  const grouped: { today: VisitSummary[]; upcoming: VisitSummary[]; past: VisitSummary[] } = {
    today: [],
    upcoming: [],
    past: [],
  };
  const ordered = visits.toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  for (const visit of ordered) {
    if (visit.status === 'completed' || visit.status === 'failed') grouped.past.push(visit);
    else if (romeDay(visit.startsAt) > today) grouped.upcoming.push(visit);
    else if (romeDay(Date.parse(visit.endsAt) - 1) < today) grouped.past.push(visit);
    else grouped.today.push(visit);
  }

  grouped.past.reverse();
  return grouped;
}
