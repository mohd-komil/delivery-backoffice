import { z } from 'zod';
import { commonTranslations } from '@/i18n/common';
import { defaultLocale, formatLocale } from '@/i18n/config';

export const CALENDAR_ZONE = 'Europe/Rome';
const bookingInstantSchema = z.iso.datetime({ offset: true });

export function formatDateTime(value: string, locale: string = defaultLocale): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return commonTranslations(locale)('unknownDate');
  return new Intl.DateTimeFormat(formatLocale(locale), {
    timeZone: CALENDAR_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date) + ` UTC${romeOffset(value)}`;
}

export function romeOffset(value: string): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: CALENDAR_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(value)).find((entry) => entry.type === 'timeZoneName')?.value;
  const offset = part?.replace(/^GMT/, '') || '+00:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error('Unable to determine Rome offset.');
  return offset;
}

function dayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid calendar day.');
  let candidate = Date.parse(`${day}T00:00:00Z`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = Date.parse(`${day}T00:00:00${romeOffset(new Date(candidate).toISOString())}`);
    if (candidate === next) return next;
    candidate = next;
  }
  throw new Error('Unable to determine Rome midnight.');
}

export function calendarDayBounds(day: string) {
  const start = dayStart(day);
  const nextDay = new Date(`${day}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = dayStart(nextDay.toISOString().slice(0, 10));
  return { start, end, minutes: (end - start) / 60000 };
}

export function calendarHours(day: string, locale: string = defaultLocale) {
  const bounds = calendarDayBounds(day);
  return Array.from({ length: bounds.minutes / 60 }, (_, hour) => {
    const instant = new Date(bounds.start + hour * 60 * 60000).toISOString();
    const wallTime = new Intl.DateTimeFormat(formatLocale(locale), { timeZone: CALENDAR_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
    return { minute: hour * 60, label: bounds.minutes === 1440 ? wallTime : `${wallTime} ${romeOffset(instant)}` };
  });
}

export function calendarDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid calendar instant.');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CALENDAR_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function calendarMinutes(value: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CALENDAR_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (!hour || !minute) throw new Error('Invalid calendar instant.');
  return Number(hour) * 60 + Number(minute);
}

/** Explicit offsets avoid ambiguous or missing wall times around DST transitions. */
export function parseBookingInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Use an ISO date and time with an offset, for example 2026-11-05T09:00+01:00.');
  }
  const withSeconds = value.replace(/T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, 'T$1:00$2');
  const parsed = bookingInstantSchema.safeParse(withSeconds);
  if (!parsed.success) throw new Error('Enter a valid calendar date, time and UTC offset.');
  const date = new Date(parsed.data);
  if (!Number.isFinite(date.getTime())) throw new Error('Enter a valid appointment time.');
  return date.toISOString();
}

/** A timezone-free picker value expressed in Rome, retaining stored seconds. */
export function bookingLocalValue(instant: string): string {
  const date = new Date(parseBookingInstant(instant));
  const minutes = calendarMinutes(instant);
  const hour = Math.floor(minutes / 60).toString().padStart(2, '0');
  const minute = (minutes % 60).toString().padStart(2, '0');
  const second = date.getUTCSeconds().toString().padStart(2, '0');
  const fraction = date.getUTCMilliseconds() ? `.${date.getUTCMilliseconds().toString().padStart(3, '0')}` : '';
  return `${calendarDay(instant)}T${hour}:${minute}:${second}${fraction}`;
}

/** Return all actual Rome occurrences; gaps and invalid dates have none. */
export function bookingTimeOptions(localValue: string): { value: string; offset: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(localValue)) return [];
  const normalized = localValue.length === 16 ? `${localValue}:00` : localValue;
  const wall = bookingInstantSchema.safeParse(`${normalized}Z`);
  if (!wall.success) return [];
  const wallInstant = new Date(wall.data);
  if (!Number.isFinite(wallInstant.getTime())) return [];
  const canonicalWall = wallInstant.toISOString().slice(0, -1);
  const offsets = new Set<string>();
  try {
    for (const day of [-1, 0, 1]) offsets.add(romeOffset(new Date(wallInstant.getTime() + day * 86400000).toISOString()));
  } catch { return []; }
  const options: { value: string; offset: string }[] = [];
  for (const offset of offsets) {
    const value = parseBookingInstant(`${normalized}${offset}`);
    const actualLocal = bookingLocalValue(value);
    const actualWall = new Date(`${actualLocal}Z`).toISOString().slice(0, -1);
    if (actualWall === canonicalWall) options.push({ value, offset });
  }
  return options.sort((left, right) => left.value.localeCompare(right.value));
}

export function weekDays(anchor: string, mode: 'day' | 'week'): string[] {
  const date = new Date(`${anchor}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return [];
  if (mode === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return Array.from({ length: mode === 'day' ? 1 : 7 }, (_, index) => {
    const current = new Date(date);
    current.setUTCDate(current.getUTCDate() + index);
    return current.toISOString().slice(0, 10);
  });
}

export function calendarLayout(entries: readonly { id: string; startsAt: string; endsAt: string }[], day: string) {
  const bounds = calendarDayBounds(day);
  const ranges = entries.filter((entry) => Date.parse(entry.startsAt) < bounds.end && Date.parse(entry.endsAt) > bounds.start).map((entry) => ({
    id: entry.id,
    start: Math.max(0, (Date.parse(entry.startsAt) - bounds.start) / 60000),
    end: Math.min(bounds.minutes, (Date.parse(entry.endsAt) - bounds.start) / 60000),
  })).filter((entry) => entry.end > entry.start).sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
  const layout: { id: string; start: number; end: number; lane: number; lanes: number }[] = [];
  let group: typeof layout = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  function finishGroup() {
    layout.push(...group.map((entry) => ({ ...entry, lanes: laneEnds.length })));
    group = []; laneEnds = []; groupEnd = -1;
  }
  for (const range of ranges) {
    if (range.start >= groupEnd && group.length > 0) finishGroup();
    let lane = laneEnds.findIndex((end) => end <= range.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = range.end;
    groupEnd = Math.max(groupEnd, range.end);
    group.push({ ...range, lane, lanes: 1 });
  }
  finishGroup();
  return layout;
}
