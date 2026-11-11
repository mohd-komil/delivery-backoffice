'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatLocale } from '@/i18n/config';
import { CALENDAR_ZONE, calendarDay, calendarDayBounds, calendarHours, calendarLayout, formatDateTime } from '@/lib/time';
import type { Appointment } from '@/lib/contracts';
import type { VisitConfirmationState } from '@/lib/visit-confirmation';
import { Notice } from './ui';
import { VisitConfirmationBadge } from './visit-confirmation-badge';

export type CalendarBlock = {
  id: string;
  deliveryId: string;
  startsAt: string;
  endsAt: string;
  status: Appointment['status'];
  confirmationState: VisitConfirmationState | null;
  title: string;
  subtitle: string;
  detail: string;
};
export function calendarEventTimeFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { timeZone: CALENDAR_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function calendarBlockInterval(startsAt: string, endsAt: string, eventTime: Intl.DateTimeFormat): string {
  return `${eventTime.format(new Date(startsAt))}–${eventTime.format(new Date(endsAt))}`;
}

export function CalendarTimeGrid({ days, entries, onOpen }: { days: string[]; entries: CalendarBlock[]; onOpen: (deliveryId: string) => void }) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const locale = useLocale();
  const language = formatLocale(locale);
  const eventTime = calendarEventTimeFormatter(language);
  const weekdayLabel = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' });
  const dayNumber = new Intl.NumberFormat(language, { minimumIntegerDigits: 2, useGrouping: false });
  const today = calendarDay(new Date().toISOString());
  const columns = days.map((day) => ({ day, minutes: calendarDayBounds(day).minutes }));
  const axisMinutes = Math.max(...columns.map(({ minutes }) => minutes), 0);
  const gridTemplateColumns = `58px repeat(${days.length}, minmax(100px, 1fr))`;

  return <>
    {columns.some(({ minutes }) => minutes !== 1440) ? <Notice>{t('daylightSaving')}</Notice> : null}
    <div className="calendar-shell">
      <div className="calendar-head" style={{ gridTemplateColumns }}>
        <div>{t('elapsed')}</div>
        {days.map((day) => (
          <div key={day} className={day === today ? 'today' : ''}>
            <span>{weekdayLabel.format(new Date(`${day}T12:00Z`))}</span>
            <strong>{dayNumber.format(Number(day.slice(8)))}</strong>
          </div>
        ))}
      </div>
      <div className="calendar-scroll">
        <div className="calendar-grid" style={{ gridTemplateColumns, minHeight: axisMinutes }}>
          <div className="hours" style={{ minHeight: axisMinutes }}>
            {Array.from({ length: Math.ceil(axisMinutes / 60) }, (_, hour) => (
              <span key={hour} style={{ top: hour * 60 }}>{t('elapsedHours', { hours: dayNumber.format(hour) })}</span>
            ))}
          </div>
          {columns.map(({ day, minutes }) => (
            <div className="calendar-day" key={day} style={{ minHeight: axisMinutes }}>
              {calendarHours(day, locale).map((tick) => (
                <span className="calendar-hour-label" key={tick.minute} style={{ top: tick.minute }}>{tick.label}</span>
              ))}
              {minutes < axisMinutes ? <div className="calendar-day-ended" style={{ top: minutes, height: axisMinutes - minutes }}>{t('dayEnded')}</div> : null}
              {calendarLayout(entries, day).map((layout) => {
                const entry = entries.find((candidate) => candidate.id === layout.id);
                if (!entry) return null;
                const width = 100 / layout.lanes;
                const confirmation = entry.confirmationState ? ` · ${common(entry.confirmationState)}` : '';
                return <button
                  key={entry.id}
                  className={`calendar-event ${entry.status}${entry.status === 'cancelled' ? ' opacity-60' : ''}`}
                  style={{ top: layout.start, minHeight: Math.max(38, layout.end - layout.start - 3), width: `calc(${width}% - 5px)`, left: `calc(${width * Math.max(layout.lane, 0)}% + 3px)` }}
                  onClick={() => onOpen(entry.deliveryId)}
                  title={`${entry.title} · ${entry.subtitle} · ${formatDateTime(entry.startsAt, locale)} → ${formatDateTime(entry.endsAt, locale)} · ${t(entry.status)}${confirmation}`}
                >
                  <small className="calendar-event-time font-mono tabular-nums">{calendarBlockInterval(entry.startsAt, entry.endsAt, eventTime)}</small>
                  <strong>{entry.title}</strong>
                  <VisitConfirmationBadge state={entry.confirmationState} className="inline-block truncate px-1 py-0.5 !whitespace-nowrap" />
                  <span>{entry.subtitle}</span>
                  <small>{entry.detail}</small>
                </button>;
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  </>;
}


