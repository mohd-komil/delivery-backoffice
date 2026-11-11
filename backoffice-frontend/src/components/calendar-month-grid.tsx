'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatLocale } from '@/i18n/config';
import { calendarDay, calendarDayBounds, formatDateTime } from '@/lib/time';
import { calendarBlockInterval, calendarEventTimeFormatter, type CalendarBlock } from './calendar-time-grid';
import { VisitConfirmationBadge } from './visit-confirmation-badge';

export function CalendarMonthGrid({ anchor, days, entries, onOpen, onChooseDay }: { anchor: string; days: string[]; entries: CalendarBlock[]; onOpen: (deliveryId: string) => void; onChooseDay: (day: string) => void }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const language = formatLocale(locale);
  const eventTime = calendarEventTimeFormatter(language);
  const weekdayLabel = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' });
  const dateLabel = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayNumber = new Intl.NumberFormat(language, { useGrouping: false });
  const today = calendarDay(new Date().toISOString());
  const weeks = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7));

  return <div className="calendar-month-scroll relative overflow-x-auto rounded-lg border border-border bg-card">
    <table className="calendar-month min-w-[840px] table-fixed">
      <caption className="sr-only">{t('monthCaption')}</caption>
      <thead><tr>{days.slice(0, 7).map((day) => (
        <th key={day} scope="col" className="w-[14.2857%]">{weekdayLabel.format(new Date(`${day}T12:00Z`))}</th>
      ))}</tr></thead>
      <tbody>{weeks.map((week) => <tr key={week[0]}>{week.map((day) => {
        const bounds = calendarDayBounds(day);
        const visits = entries.filter((entry) => Date.parse(entry.startsAt) < bounds.end && Date.parse(entry.endsAt) > bounds.start)
          .toSorted((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt) || left.id.localeCompare(right.id));
        const adjacent = day.slice(0, 7) !== anchor.slice(0, 7);
        const date = locale === 'en' ? day : dateLabel.format(new Date(`${day}T12:00Z`));
        return <td key={day} data-date={day} className={`h-40 !whitespace-normal !p-2 !align-top ${adjacent ? 'bg-muted/30 text-muted-foreground' : ''}`}>
          <button
            aria-label={t('viewDay', { date })}
            aria-current={day === today ? 'date' : undefined}
            className={`mb-2 inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${day === today ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}`}
            onClick={() => onChooseDay(day)}
          >{dayNumber.format(Number(day.slice(8)))}</button>
          <div className="space-y-1">
            {visits.slice(0, 3).map((entry) => (
              <button
                key={entry.id}
                className={`calendar-month-event block w-full min-w-0 rounded-md border border-border p-1.5 text-left text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.status === 'in_progress' ? 'bg-[var(--warning)] text-[var(--warning-foreground)] hover:brightness-95' : entry.status === 'completed' ? 'bg-[var(--success)] text-[var(--success-foreground)] hover:brightness-95' : 'bg-accent/60 hover:bg-accent'} ${entry.status === 'cancelled' ? 'opacity-60' : ''}`}
                onClick={() => onOpen(entry.deliveryId)}
                title={`${entry.title} · ${entry.subtitle} · ${formatDateTime(entry.startsAt, locale)} → ${formatDateTime(entry.endsAt, locale)} · ${entry.detail}`}
              >
                <span className="calendar-event-time block font-mono tabular-nums">{calendarBlockInterval(entry.startsAt, entry.endsAt, eventTime)}</span>
                <strong className="block truncate text-[11px]">{entry.title}</strong>
                <span className="block truncate">{entry.subtitle}</span>
                <span className="line-clamp-2 [overflow-wrap:anywhere]">{entry.detail}</span>
                <span className="block text-[9px] text-muted-foreground">{t(entry.status)}</span>
                <VisitConfirmationBadge state={entry.confirmationState} className="mt-1 px-1 py-0.5 text-[9px]" />
              </button>
            ))}
            {visits.length > 3 ? (
              <button className="text-button text-[11px]" aria-label={t('showAllVisits', { date })} onClick={() => onChooseDay(day)}>
                {t('moreVisits', { count: visits.length - 3 })}
              </button>
            ) : null}
          </div>
        </td>;
      })}</tr>)}</tbody>
    </table>
  </div>;
}


