import { crewTimeZone } from '@/shared/i18n/config';

const offsetFormat = new Intl.DateTimeFormat('en-GB', { timeZone: crewTimeZone, timeZoneName: 'longOffset' });
const minuteFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: crewTimeZone,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Find the Rome occurrences of an entered wall time without using the device timezone. */
export function actualStartOptions(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(local)) return [];
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) return [];

  const offsets = new Set<string>();
  for (const day of [-1, 0, 1]) {
    const label = offsetFormat.formatToParts(wall + day * 86_400_000).find((part) => part.type === 'timeZoneName')?.value;
    const offset = label?.match(/^GMT([+-]\d{2}:\d{2})$/u)?.[1];
    if (offset) offsets.add(offset);
  }

  return [...offsets].flatMap((offset) => {
    const instant = new Date(`${local}${offset}`);
    if (minuteFormat.format(instant).replace(' ', 'T') !== local) return [];
    return [{ value: instant.toISOString(), offset }];
  }).toSorted((a, b) => a.value.localeCompare(b.value));
}
