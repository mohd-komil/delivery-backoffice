import type { VisitSummary } from '@/shared/api/contracts';
import { crewTimeZone, formatLocale } from '@/shared/i18n/config';

export function visitStatus(visit: VisitSummary) {
  if (visit.status === 'completed') return { label: 'completed', tone: 'neutral', icon: 'check' } as const;
  if (visit.status === 'failed') return { label: 'attemptFailureTitle', tone: 'warning', icon: 'alert' } as const;
  if (visit.status === 'in_progress') return { label: 'inProgress', tone: 'info', icon: 'clock' } as const;
  if (visit.confirmationStatus === 'customer_confirmed') return { label: 'confirmed', tone: 'success', icon: 'check' } as const;
  if (visit.confirmationStatus === 'awaiting_customer_confirmation') return { label: 'awaiting', tone: 'warning', icon: 'clock' } as const;
  return { label: 'booked', tone: 'neutral', icon: 'calendar' } as const;
}

export function formatVisitDate(value: string, locale: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(formatLocale(locale), { ...options, timeZone: crewTimeZone }).format(new Date(value));
}

const romeDayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: crewTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

export function romeDay(value: string | number) {
  return romeDayFormat.format(new Date(value));
}

export function formatVisitWindow(visit: VisitSummary, locale: string) {
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const sameDay = romeDay(visit.startsAt) === romeDay(visit.endsAt);
  const crossesOffset = offset(visit.startsAt) !== offset(visit.endsAt);
  const day: Intl.DateTimeFormatOptions = sameDay ? {} : { day: 'numeric', month: 'short' };
  const zone: Intl.DateTimeFormatOptions = crossesOffset ? { timeZoneName: 'shortOffset' } : {};
  const formatter = new Intl.DateTimeFormat(formatLocale(locale), { ...time, ...day, ...zone, timeZone: crewTimeZone });
  return `${formatter.format(new Date(visit.startsAt))} – ${formatter.format(new Date(visit.endsAt))}`;
}

const offsetFormat = new Intl.DateTimeFormat('en', { timeZone: crewTimeZone, timeZoneName: 'shortOffset' });

function offset(value: string) {
  return offsetFormat.formatToParts(new Date(value)).find((part) => part.type === 'timeZoneName')?.value;
}

export function destinationLabel(destination: VisitSummary['destination']) {
  return [destination.address, destination.city, destination.country].filter(Boolean).join(', ');
}
