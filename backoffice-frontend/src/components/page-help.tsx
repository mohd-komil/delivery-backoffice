'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Tooltip } from 'radix-ui';
import type { PageHelpTopic } from '@/i18n/messages/page-help';
import { Button } from './ui/button';

type PageHelpProps = { title: string; topic: PageHelpTopic };

export function PageHelp({ title, topic }: PageHelpProps) {
  const t = useTranslations('pageHelp');
  const [open, setOpen] = useState(false);
  const openBeforePress = useRef(false);

  return <Tooltip.Provider delayDuration={220}>
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 min-h-8 shrink-0"
          aria-label={t('label', { title })}
          onPointerDown={() => { openBeforePress.current = open; }}
          onClick={(event) => {
            // Radix closes on pointer down. Use the prior state so a tap can toggle the help.
            event.preventDefault();
            setOpen(!(event.detail === 0 ? open : openBeforePress.current));
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 7.2v3.6" />
            <circle cx="8" cy="5" r=".7" fill="currentColor" stroke="none" />
          </svg>
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="z-[60] w-72 max-w-[var(--radix-tooltip-content-available-width)] rounded-md border border-border bg-popover px-3 py-2 text-sm leading-5 text-popover-foreground shadow-md"
      >
        {t(topic)}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>;
}

export function PageHeadingTitle({ title, topic, children }: PageHelpProps & { children?: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
    <h1>{title}{children}</h1>
    <PageHelp title={title} topic={topic} />
  </div>;
}
