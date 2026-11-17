'use client';

import { useLocale, useTranslations } from 'next-intl';
import { calendarDay } from '@/lib/time';
import { DatePicker } from './ui/date-picker';
import { calendarPeriodLabel, selectCalendarMonth, shiftCalendarAnchor, type CalendarMode } from '@/lib/calendar-period';

export function CalendarControls({ anchor, mode, onAnchorChange, onModeChange, onRefresh, refreshing, idPrefix, refreshLabel }: { anchor: string; mode: CalendarMode; onAnchorChange: (value: string) => void; onModeChange: (value: CalendarMode) => void; onRefresh: () => void; refreshing: boolean; idPrefix: string; refreshLabel: string }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const month = mode === 'month';
  const pickerId = `${idPrefix}-${month ? 'month' : 'date'}`;
  const pickerLabel = idPrefix === 'participant-calendar'
    ? t(month ? 'participantMonthPickerLabel' : 'participantDatePickerLabel')
    : t(month ? 'monthPickerLabel' : 'datePickerLabel');

  return <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 className="calendar-period-label text-base">{calendarPeriodLabel(anchor, mode, locale)}</h2>
      <p className="small muted">{t(`${mode}View`)}</p>
    </div>
    <div className="calendar-controls min-w-0 flex-wrap">
      <button className="button secondary small" onClick={() => onAnchorChange(shiftCalendarAnchor(anchor, mode, -1))}>{t(month ? 'previousMonth' : 'previous')}</button>
      <button className="button secondary small" onClick={() => onAnchorChange(calendarDay(new Date().toISOString()))}>{t('today')}</button>
      <button className="button secondary small" onClick={() => onAnchorChange(shiftCalendarAnchor(anchor, mode, 1))}>{t(month ? 'nextMonth' : 'next')}</button>
      <label className="sr-only" htmlFor={pickerId}>{pickerLabel}</label>
      <DatePicker id={pickerId} label={pickerLabel} type={month ? 'month' : 'date'} value={month ? anchor.slice(0, 7) : anchor} onValueChange={(value) => {

        if (value) onAnchorChange(month ? selectCalendarMonth(anchor, value) : value);
      }} />
      <div className="segmented">{(['day', 'week', 'month'] as const).map((value) => (
        <button key={value} className={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => onModeChange(value)}>{t(value)}</button>
      ))}</div>
      <button className="button secondary small" disabled={refreshing} onClick={onRefresh}>{refreshLabel}</button>
    </div>
  </div>;
}
