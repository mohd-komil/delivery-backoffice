'use client';

import type { ComponentProps } from 'react';
import { DayPicker } from 'react-day-picker';
import { cn } from '@/lib/utils';

/** shadcn Calendar composition, styled with the application's Geist tokens. */
export function Calendar({ className, classNames, ...props }: ComponentProps<typeof DayPicker>) {
  return <DayPicker showOutsideDays weekStartsOn={1} className={cn('w-fit p-3 text-foreground', className)}
    classNames={{
      root: 'relative', months: 'relative', month: 'space-y-3',
      nav: 'absolute inset-x-3 top-3 flex justify-between',
      button_previous: 'inline-flex size-8 items-center justify-center rounded-md border border-input bg-background hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40',
      button_next: 'inline-flex size-8 items-center justify-center rounded-md border border-input bg-background hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40',
      chevron: 'size-4 fill-current', month_caption: 'flex h-8 items-center justify-center px-10 text-sm font-semibold',
      month_grid: 'w-full border-collapse', weekdays: 'flex', weekday: 'w-9 border-0 bg-transparent p-0 text-center text-xs font-normal tracking-normal text-muted-foreground normal-case',
      week: 'mt-1 flex', day: 'relative size-9 border-0 p-0 text-center text-sm',
      day_button: 'inline-flex size-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
      selected: '[&>button]:bg-primary [&>button]:text-primary-foreground',
      today: '[&>button]:border [&>button]:border-ring', outside: 'text-muted-foreground opacity-50',
      disabled: 'opacity-30', hidden: 'invisible', ...classNames,
    }} {...props} />;
}
