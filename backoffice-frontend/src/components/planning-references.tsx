'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MotionConfig, motion } from 'motion/react';
import { PageHeadingTitle } from './page-help';
import { PlanningLocations } from './planning-locations';
import { PlanningCalendar } from './planning-calendar';
import { PlanningTimeStandards } from './planning-time-standards';

const tabs = ['calendar', 'locations', 'standards'] as const;
type Tab = typeof tabs[number];
export function PlanningReferences() {
  const t = useTranslations('planning'); const [tab, setTab] = useState<Tab>('calendar');
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set(['calendar']));
  function choose(next: Tab) { setTab(next); setOpened((current) => new Set([...current, next])); }
  return <MotionConfig reducedMotion="user" transition={{ duration: 0.15 }}>
    <div className="page-heading"><div><PageHeadingTitle title={t('title')} topic="planning" /><p className="subtitle">{t('subtitle')}</p></div></div>
    <nav className="mb-5 flex flex-wrap gap-1 rounded-lg border border-border bg-muted/25 p-1" aria-label={t('title')}>{tabs.map((value) => <button key={value} type="button" onClick={() => choose(value)} aria-pressed={tab === value}
      className={`min-h-10 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${tab === value ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{t(value)}</button>)}</nav>
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      {opened.has('calendar') ? <section hidden={tab !== 'calendar'}><PlanningCalendar active={tab === 'calendar'} /></section> : null}
      {opened.has('locations') ? <section hidden={tab !== 'locations'}><PlanningLocations active={tab === 'locations'} /></section> : null}
      {opened.has('standards') ? <section hidden={tab !== 'standards'}><PlanningTimeStandards active={tab === 'standards'} /></section> : null}
    </motion.div>
  </MotionConfig>;
}
