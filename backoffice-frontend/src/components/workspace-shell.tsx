'use client';

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Tooltip } from 'radix-ui';
import { motion, MotionConfig } from 'motion/react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

const preferenceKey = 'backoffice.sidebar.collapsed';
const NavigationContext = createContext({ compact: false, onNavigate: () => {} });

function savedCollapsed() {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(preferenceKey) === 'true'; }
  catch { return false; }
}

/** Mounted only after Backoffice's client-side session check completes. */
export function WorkspaceShell({ navigation, header, children }: { navigation: ReactNode; header: ReactNode; children: ReactNode }) {
  const t = useTranslations('workspace');
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const desktopTrigger = useRef<HTMLButtonElement>(null);
  const sidebarId = useId();
  const mobileId = useId();

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia('(min-width: 801px)');
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(preferenceKey, String(next)); }
    catch { /* The control remains usable when browser storage is unavailable. */ }
  }

  return <MotionConfig reducedMotion="user" transition={{ duration: 0.16, ease: 'easeOut' }}>
    <Tooltip.Provider delayDuration={180}>
      <div className="workspace" data-sidebar-collapsed={collapsed}>
        <aside id={sidebarId} className="sidebar desktop-sidebar" aria-label={t('navigationTitle')}>
          <div className="sidebar-controls"><Button ref={desktopTrigger} type="button" variant="ghost" size="icon" onClick={toggleSidebar}
            aria-label={t(collapsed ? 'expandNavigation' : 'collapseNavigation')} title={t(collapsed ? 'expandNavigation' : 'collapseNavigation')}
            aria-expanded={!collapsed} aria-controls={sidebarId}>
            <motion.span aria-hidden="true" className="inline-flex" animate={{ rotate: collapsed ? 180 : 0 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m14 6-6 6 6 6" /></svg></motion.span>
          </Button></div>
          <NavigationContext.Provider value={{ compact: collapsed, onNavigate: () => {} }}>{navigation}</NavigationContext.Provider>
        </aside>
        <main className="main">
          <header className="topbar"><Button ref={menuTrigger} type="button" className="hidden shrink-0 max-[800px]:inline-flex" variant="outline" size="icon"
            onClick={() => setMobileOpen(true)} aria-label={t('openNavigation')} aria-expanded={mobileOpen} aria-controls={mobileId}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </Button>{header}</header>
          {children}
        </main>
        <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
          <DialogContent id={mobileId} asChild className="navigation-drawer" aria-describedby={undefined} onCloseAutoFocus={(event) => {
            event.preventDefault();
            const isDesktop = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 801px)').matches;
            (isDesktop ? desktopTrigger : menuTrigger).current?.focus();
          }}>
            <motion.div initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }}>
              <div className="mb-4 flex items-center justify-between gap-3"><DialogTitle className="text-sm font-semibold">{t('navigationTitle')}</DialogTitle>
                <Button type="button" variant="ghost" size="icon" aria-label={t('closeNavigation')} onClick={() => setMobileOpen(false)}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></Button>
              </div>
              <NavigationContext.Provider value={{ compact: false, onNavigate: () => setMobileOpen(false) }}>{navigation}</NavigationContext.Provider>
            </motion.div>
          </DialogContent>
        </Dialog>
      </div>
    </Tooltip.Provider>
  </MotionConfig>;
}

export function WorkspaceNav({ href, onClick, className, label, icon, count }: {
  href: string | undefined; onClick: () => void; className: string; label: string; icon: string; count?: number | string;
}) {
  const { compact, onNavigate } = useContext(NavigationContext);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const selected = className.split(' ').some((name) => name === 'selected' || name === 'active');
  const content = <><span aria-hidden="true">{icon}</span><span className="nav-text">{label}</span>{count !== undefined ? <span className="nav-end">{count}</span> : null}</>;
  return <Tooltip.Root open={compact && tooltipOpen} onOpenChange={setTooltipOpen}>
    <Tooltip.Trigger asChild>{href
      ? <Link href={href} className={className} aria-label={label} aria-current={selected ? 'page' : undefined} onClick={onNavigate}>{content}</Link>
      : <button type="button" className={className} aria-label={label} aria-current={selected ? 'page' : undefined} onClick={() => { onClick(); onNavigate(); }}>{content}</button>}
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content side="right" sideOffset={10} collisionPadding={8} className="z-[60] max-w-64 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">{label}{count !== undefined ? ` · ${count}` : ''}</Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>;
}
