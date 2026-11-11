import { z } from 'zod';
import { defaultLocale, formatLocale } from '@/i18n/config';
import { calendarDayBounds, weekDays } from './time';

export type CalendarMode = 'day' | 'week' | 'month';
export const DEFAULT_CALENDAR_MODE: CalendarMode = 'month';

const calendarDateSchema = z.iso.date();

function calendarDate(day: string): Date {
  return new Date(`${calendarDateSchema.parse(day)}T12:00:00Z`);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Full Monday–Sunday weeks, including the adjacent-month context cells. */
export function calendarPeriodDays(anchor: string, mode: CalendarMode): string[] {
  const first = calendarDate(anchor);
  if (mode !== 'month') return weekDays(anchor, mode);
  first.setUTCDate(1);
  const leadingDays = (first.getUTCDay() + 6) % 7;
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const cellCount = Math.ceil((leadingDays + last.getUTCDate()) / 7) * 7;
  first.setUTCDate(first.getUTCDate() - leadingDays);
  return Array.from({ length: cellCount }, (_, index) => {
    const day = new Date(first);
    day.setUTCDate(day.getUTCDate() + index);
    return dateKey(day);
  });
}

/** Keep the selected day where possible instead of overflowing a short month. */
export function selectCalendarMonth(anchor: string, month: string): string {
  const selectedDay = calendarDate(anchor).getUTCDate();
  const next = calendarDate(`${month}-01`);
  const last = new Date(next);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  next.setUTCDate(Math.min(selectedDay, last.getUTCDate()));
  return dateKey(next);
}

export function shiftCalendarAnchor(anchor: string, mode: CalendarMode, direction: -1 | 1): string {
  const next = calendarDate(anchor);
  if (mode !== 'month') {
    next.setUTCDate(next.getUTCDate() + direction * (mode === 'day' ? 1 : 7));
    return dateKey(next);
  }
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + direction);
  return selectCalendarMonth(anchor, dateKey(next).slice(0, 7));
}

export function calendarPeriodLabel(anchor: string, mode: CalendarMode, locale: string = defaultLocale): string {
  const date = calendarDate(anchor);
  const language = formatLocale(locale);
  if (mode === 'month') {
    return new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  }
  const dayLabel = new Intl.DateTimeFormat(language, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (mode === 'day') return dayLabel.format(date);
  const days = calendarPeriodDays(anchor, mode);
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new Error('The calendar period is empty.');
  return `${dayLabel.format(calendarDate(first))} – ${dayLabel.format(calendarDate(last))}`;
}

/** Query actual Rome midnights; DST changes elapsed duration, not calendar dates. */
export function calendarPeriodRange(days: readonly string[]): { from: string; to: string } {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new Error('The calendar period is empty.');
  calendarDate(first);
  calendarDate(last);
  return {
    from: new Date(calendarDayBounds(first).start).toISOString(),
    to: new Date(calendarDayBounds(last).end).toISOString(),
  };
}
