'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { toast } from 'sonner';
import { ThemeSelector } from './theme-provider';
import { LanguageSelector } from './language-selector';
import { Card } from './ui/card';
import { DataTable } from './ui/data-table';
import { z } from 'zod';
import { Input } from './ui/input';
import { apiRequest, ApiError, errorMessage, mutate } from '@/lib/api';
import { logoutSchema, deliveryListSchema, importSchema, userSchema, views, type DeliveryFocus, type DeliveryList, type DeliveryTab, type ImportRun, type User, type View, type WorkspaceSection } from '@/lib/contracts';
import { formatDateTime } from '@/lib/time';
import { ActionForm, Empty, Field, Notice, Pending, textField } from './ui';
import { DeliveryPanel } from './delivery-panel';
import { InboxGeographyFilters, inboxGeographyQuery, selectSoleGeographyOptions, type InboxGeography } from './inbox-geography-filters';
import { InboxDeliveryMap } from './inbox-delivery-map';
import { appendInboxMapArea, type InboxMapArea } from '@/lib/inbox-map-area';
import { DeliveryListTable } from './delivery-list-table';
import { DeliveryFilters } from './delivery-view-filters';
import { deliveryViewFilterQuery, deliveryViewScopeQuery, emptyDeliveryViewFilters, type DeliveryFilterView, type DeliveryViewFilters } from '@/lib/delivery-view-filters';
import { Button } from './ui/button';
import { PageHeadingTitle, PageHelp } from './page-help';
import { Directory } from './directory';
import { Calendar } from './calendar';
import { Staffing } from './staffing';
import { RouteDrafts } from './route-drafts';
import { ParticipantCalendar } from './participant-calendar';
import { SkillsDirectory } from './skills-directory';
import { VehiclesDirectory } from './vehicles-directory';
import { DispatcherQueue } from './dispatcher-queue';
import { PlanningReferences } from './planning-references';
import { WorkspaceNav, WorkspaceShell } from './workspace-shell';
import { useWorkspaceSource, workspaceSourceMessages, type WorkspaceSource } from '@/lib/workspace-source';

type Section = WorkspaceSection | 'participant-calendar';

function inboxFilterQuery(geography: InboxGeography, area: InboxMapArea | null) {
  const query = new URLSearchParams(inboxGeographyQuery(geography));
  appendInboxMapArea(query, area);
  return query.toString();
}

export function Backoffice({ participantId, initialSection = 'deliveries', initialView = 'inbox', initialDirectoryTab = 'crews' }: { participantId?: string; initialSection?: WorkspaceSection; initialView?: View; initialDirectoryTab?: 'crews' | 'participants' } = {}) {
  const t = useTranslations('workspace');
  const filterText = useTranslations('deliveryFilters');
  const geographyText = useTranslations('inboxGeography');
  const mapText = useTranslations('inboxMap');
  const locale = useLocale();
  const workspaceSource = useWorkspaceSource();
  const sourceMessages = workspaceSourceMessages[workspaceSource];
  const [auth, setAuth] = useState<{ status: 'loading' } | { status: 'anonymous'; error: unknown } | { status: 'ready'; user: User }>({ status: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const [section, setSection] = useState<Section>(() => participantId ? 'participant-calendar' : initialSection);
  const [decisionsOpened, setDecisionsOpened] = useState(initialSection === 'decisions');
  const [view, setView] = useState<View>(initialView);
  const [page, setPage] = useState(1);
  const [geography, setGeography] = useState<InboxGeography>({});
  const [area, setArea] = useState<InboxMapArea | null>(null);
  const [filtersByView, setFiltersByView] = useState<Partial<Record<DeliveryFilterView, DeliveryViewFilters>>>({});
  const pendingGeographySelection = useRef<{ view: View; query: string; filters: InboxGeography } | null>(null);
  const [inboxDisplay, setInboxDisplay] = useState<'list' | 'map'>('list');
  const [mapOpened, setMapOpened] = useState(false);
  const showMap = view === 'inbox' && inboxDisplay === 'map';
  const viewFilters = view === 'inbox' ? emptyDeliveryViewFilters : filtersByView[view] ?? emptyDeliveryViewFilters;
  const geographyQuery = inboxGeographyQuery(view === 'inbox' ? geography : viewFilters.geography);
  const filterQuery = view === 'inbox' ? inboxFilterQuery(geography, area) : deliveryViewFilterQuery(viewFilters);
  const facetScope = view === 'inbox' ? inboxFilterQuery({}, area) : deliveryViewScopeQuery(viewFilters);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<DeliveryTab>('overview');
  const [selectedFocus, setSelectedFocus] = useState<DeliveryFocus | undefined>(undefined);
  const [routeDraftId, setRouteDraftId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [listSnapshot, setListSnapshot] = useState<{ data: DeliveryList; view: View; geographyQuery: string; filterQuery: string; facetScope: string } | null>(null);
  const data = listSnapshot?.data;
  const viewSnapshot = listSnapshot?.view === view ? listSnapshot : null;
  const viewData = viewSnapshot?.data;
  const geographyFacetsQuery = viewSnapshot?.facetScope === facetScope ? viewSnapshot.geographyQuery : null;
  const [listState, setListState] = useState<{ busy: boolean; error: unknown }>({ busy: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest('/auth/me', userSchema, { signal: controller.signal }).then(
      (user) => { if (!controller.signal.aborted) setAuth({ status: 'ready', user }); },
      (failure: unknown) => { if (!controller.signal.aborted) setAuth({ status: 'anonymous', error: failure instanceof ApiError && failure.status === 401 ? null : failure }); },
    );
    return () => controller.abort();
  }, []);

  const ready = auth.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void apiRequest(`/deliveries?view=${view}&page=${page}${filterQuery ? `&${filterQuery}` : ''}`, deliveryListSchema, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        const pending = pendingGeographySelection.current;
        let selecting = false;
        if (pending?.view === view && pending.query === filterQuery) {
          pendingGeographySelection.current = null;
          const completed = selectSoleGeographyOptions(pending.filters, result.matchingGeographyFacets, result.geographyFacets);
          selecting = inboxGeographyQuery(completed) !== geographyQuery;
          if (selecting) {
            if (view === 'inbox') setGeography(completed);
            else setFiltersByView((current) => ({
              ...current,
              [view]: { ...current[view], geography: completed },
            }));
          }
        }
        setListSnapshot({ data: result, view, geographyQuery, filterQuery, facetScope });
        setListState({ busy: selecting, error: null });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) setAuth({ status: 'anonymous', error: new ApiError(401, 'Your session expired. Please sign in again.') });
        setListState({ busy: false, error: failure });
      },
    );
    return () => controller.abort();
  }, [ready, view, page, refreshKey, geographyQuery, filterQuery, facetScope]);

  const refresh = useCallback(() => { setListState({ busy: true, error: null }); setRefreshKey((value) => value + 1); }, []);

  function chooseView(next: View) {
    pendingGeographySelection.current = null;
    setListState({ busy: true, error: null }); setView(next); setSection('deliveries'); setPage(1); setSelected(null); setRefreshKey((value) => value + 1);
  }
  function changeGeography(filters: InboxGeography, changed?: keyof InboxGeography) {
    pendingGeographySelection.current = changed && filters[changed] !== undefined
      ? { view: 'inbox', query: inboxFilterQuery(filters, area), filters } : null;
    setGeography(filters); setPage(1); setListState({ busy: true, error: null });
  }
  function changeViewFilters(filters: DeliveryViewFilters, changed?: keyof InboxGeography) {
    if (view === 'inbox') return;
    const query = deliveryViewFilterQuery(filters);
    if (query === filterQuery) return;
    pendingGeographySelection.current = changed && filters.geography[changed] !== undefined
      ? { view, query, filters: filters.geography } : null;
    setFiltersByView((current) => ({ ...current, [view]: filters }));
    setPage(1); setListState({ busy: true, error: null });
  }
  function changeArea(next: InboxMapArea | null) {
    if (inboxFilterQuery({}, area) === inboxFilterQuery({}, next)) return;
    pendingGeographySelection.current = null;
    setArea(next); setPage(1); setListState({ busy: true, error: null });
  }
  function chooseSection(next: Section) { if (next === 'decisions') setDecisionsOpened(true); setSection(next); setSelected(null); }
  function openRouteDraft(id: string) { setRouteDraftId(id); setSelected(null); setSection('routes'); }
  function openDelivery(id: string, tab: DeliveryTab = 'overview', focus?: DeliveryFocus) { setSelectedFocus(focus); setSelectedTab(tab); setSelected(id); }

  async function signOut() {
    setSigningOut(true);
    try {
      await mutate('/auth/logout', logoutSchema, {});
      setAuth({ status: 'anonymous', error: null });
      toast.success(t('signedOut'));
    } catch (failure) {
      toast.error(errorMessage(failure, locale));
    } finally {
      setSigningOut(false);
    }
  }

  if (auth.status === 'loading') return <main className="session-check"><Pending>{t('checkingSession')}</Pending></main>;
  if (auth.status === 'anonymous') return <Login error={auth.error} workspaceSource={workspaceSource} onLogin={(user) => { setAuth({ status: 'ready', user }); refresh(); }} />;

  const activeViewLabel = t(view);
  const hasFilters = filterQuery !== '';
  return <WorkspaceShell navigation={<>
      <Link href="/" className="brand" aria-label={t('brandHome')}><span className="brand-mark">m</span><span className="brand-copy">MOHD<span className="brand-sub">{t('brandSubtitle')}</span></span></Link>
      <div className="workspace-label"><span className="status-dot" />{t(sourceMessages.workspace)}</div>
      <p className="nav-label">{t('workspaceNav')}</p>
      <nav aria-label={t('sections')}>
        <WorkspaceNav href={participantId ? '/?section=deliveries' : undefined} className={section === 'deliveries' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('deliveries')} icon="▤" label={t('deliveries')} count={data ? Object.entries(data.counts).filter(([key]) => !['issues', 'return_required'].includes(key)).reduce((sum, [, count]) => sum + count, 0) : '—'} />
        <WorkspaceNav href={participantId ? '/?section=calendar' : undefined} className={section === 'calendar' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('calendar')} icon="▦" label={t('calendar')} />
        <WorkspaceNav href={participantId ? '/?section=routes' : undefined} className={section === 'routes' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('routes')} icon="↪" label={t('routes')} />
        <WorkspaceNav href={participantId ? '/?section=decisions' : undefined} className={section === 'decisions' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('decisions')} icon="◇" label={t('decisions')} />
        <WorkspaceNav href={participantId ? '/?section=staffing' : undefined} className={section === 'staffing' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('staffing')} icon="♧" label={t('staffing')} />
        <WorkspaceNav href={participantId ? '/?section=directory&tab=participants' : undefined} className={section === 'directory' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('directory')} icon="♧" label={t('directory')} />
        <WorkspaceNav href={participantId ? '/?section=imports' : undefined} className={section === 'imports' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('imports')} icon="⇄" label={t('imports')} />
      </nav>
      <p className="nav-label spaced">{t('deliveryViewsTitle')}</p>
      <nav className="delivery-view-nav" aria-label={t('deliveryViews')}>{views.map((entry) => <WorkspaceNav href={participantId ? `/?view=${entry.id}` : undefined} key={entry.id} onClick={() => chooseView(entry.id)} className={section === 'deliveries' && view === entry.id ? 'view-nav active' : 'view-nav'} icon={entry.icon} label={t(entry.id)} count={data?.counts[entry.id] ?? '—'} />)}</nav>
      <p className="nav-label spaced">{t('catalogTitle')}</p><nav aria-label={t('catalogNav')}><WorkspaceNav href={participantId ? '/?section=skills' : undefined} className={section === 'skills' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('skills')} icon="✧" label={t('skills')} /><WorkspaceNav href={participantId ? '/?section=vehicles' : undefined} className={section === 'vehicles' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('vehicles')} icon="▱" label={t('vehicles')} /><WorkspaceNav href={participantId ? '/?section=planning' : undefined} className={section === 'planning' ? 'nav-item selected' : 'nav-item'} onClick={() => chooseSection('planning')} icon="▦" label={t('planning')} /></nav>
      <div className="sidebar-bottom"><div className="demo-stamp">{t(sourceMessages.badge)}</div><p>{t(sourceMessages.description)}<br />{t('calendarZone')}</p><div className="profile"><span className="avatar" title={auth.user.name}>{auth.user.name.slice(0, 1)}</span><span className="profile-copy"><strong>{auth.user.name}</strong><small>{t(auth.user.role === 'admin' ? 'administrator' : 'operator')}</small></span><button title={t('signOut')} aria-label={t('signOut')} disabled={signingOut} onClick={() => { void signOut(); }}>↗</button></div></div>
    </>} header={<><div className="workspace-breadcrumb"><span className="breadcrumb">{t('workspace')}</span><span className="breadcrumb-divider">/</span><strong>{t(section === 'participant-calendar' ? 'participantCalendar' : section)}</strong></div><AppearanceControls /></>}>
      <div className="page-content">
        {section === 'deliveries' ? <>
          <div className="page-heading"><div><p className="eyebrow">{t('deliveryManagement')}</p><PageHeadingTitle title={activeViewLabel} topic={view}><span className="heading-count">{data?.counts[view] ?? '—'}</span></PageHeadingTitle><p className="subtitle">{t('deliverySubtitle')}</p></div><button className="button secondary" onClick={refresh} disabled={listState.busy}>↻ &nbsp; {t('refresh')}</button></div>
          <Card className="summary-strip"><div><span className="metric-label">{t('toPlan')}</span><strong>{data?.counts.inbox ?? '—'}</strong><span>{t('awaitingVisit')}</span></div><div><span className="metric-label">{t('workInProgress')}</span><strong>{data?.counts.in_progress ?? '—'}</strong><span>{t('workUnderWay')}</span></div><div><span className="metric-label">{t('needsAttention')}</span><strong>{data?.counts.issues ?? '—'}</strong><span>{t('openIssues')}</span></div><div><span className="metric-label">{t('workCompleted')}</span><strong>{data?.counts.completed ?? '—'}</strong><span>{t('verifiedClosed')}</span></div></Card>
          {view === 'inbox'
            ? <InboxGeographyFilters filters={geography} facets={viewData?.geographyFacets} facetsQuery={geographyFacetsQuery} failed={listState.error !== null} onChange={changeGeography} />
            : <DeliveryFilters key={view} view={view} filters={viewFilters} facets={viewData?.filterFacets} geographyFacets={viewData?.geographyFacets}
              geographyFacetsQuery={geographyFacetsQuery} onChange={changeViewFilters} />}
          <div className="list-toolbar mt-4 flex-wrap gap-y-3"><div className="toolbar-title"><span className="status-dot" />{activeViewLabel}<span className="muted">{viewData ? t('results', { count: viewData.total }) : ''}</span></div>
            {view === 'inbox' ? <div role="group" aria-label={mapText('viewLabel')} className="ml-auto inline-grid shrink-0 grid-cols-2 items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
              <Button className="min-w-16" size="sm" variant={showMap ? 'ghost' : 'default'} aria-pressed={!showMap} onClick={() => setInboxDisplay('list')}>{mapText('list')}</Button>
              <Button className="min-w-16" size="sm" variant={showMap ? 'default' : 'ghost'} aria-pressed={showMap} onClick={() => { setMapOpened(true); setInboxDisplay('map'); }}>{mapText('map')}</Button>
            </div> : <span className="muted small">{t('viewOverlap')}</span>}
          </div>
          {view === 'inbox' && mapOpened ? <InboxDeliveryMap query={filterQuery} refreshKey={refreshKey} visible={showMap} onOpen={openDelivery} area={area} onAreaChange={changeArea} /> : null}
          <div hidden={showMap}>
          {view === 'inbox' && area ? <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div><p className="font-medium">{mapText('areaActive')}</p>
              {listSnapshot?.filterQuery === filterQuery && data?.area && data.area.excludedMissingCoordinates > 0 ? <p className="mt-1 text-muted-foreground">{mapText('excludedMissing', { count: data.area.excludedMissingCoordinates })}</p> : null}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => changeArea(null)}>{mapText('clearArea')}</Button>
          </div> : null}
          <div className="mb-3 flex h-10 items-center gap-3 text-xs" aria-live="polite" role="status">
            {listState.error ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{errorMessage(listState.error, locale)}{viewData ? ` ${t('staleDeliveries')}` : ''}</span><button className="text-button" disabled={listState.busy} onClick={refresh}>{t('retry')}</button></> : <span className="text-muted-foreground">{listState.busy && viewData ? t('refreshingDeliveries') : ''}</span>}
          </div>
          {!viewData && listState.busy ? <Pending>{t('loadingDeliveries')}</Pending> : null}
          {viewData?.items.length === 0 ? <Empty title={hasFilters ? geographyText('empty') : t('emptyView')}>{hasFilters ? view === 'inbox' ? geographyText('emptyHelp') : filterText('emptyHelp') : t('emptyViewHelp')}</Empty> : null}
          {data && data.items.length > 0 ? <div hidden={!viewSnapshot}>
            <DeliveryListTable items={data.items} selected={selected} onOpen={openDelivery} view={view}
              includeHistory={Boolean(viewFilters.crew || viewFilters.dateFrom || viewFilters.dateTo)}
              pagination={{ page: data.page, pageSize: data.pageSize, total: data.total, disabled: listState.busy, onPageChange: (next) => { setListState({ busy: true, error: null }); setPage(next); } }} />
          </div> : null}
          </div>
        </> : section === 'participant-calendar' && participantId ? <ParticipantCalendar participantId={participantId} refreshKey={refreshKey} onOpen={openDelivery} /> : section === 'calendar' ? <Calendar refreshKey={refreshKey} onOpen={openDelivery} /> : section === 'routes' ? <RouteDrafts initialDraftId={routeDraftId} onOpenDelivery={openDelivery} /> : section === 'planning' ? <PlanningReferences /> : section === 'decisions' ? null : section === 'staffing' ? <Staffing onOpen={openDelivery} /> : section === 'directory' ? <Directory user={auth.user} initialTab={initialDirectoryTab} /> : section === 'skills' ? <SkillsDirectory user={auth.user} /> : section === 'vehicles' ? <VehiclesDirectory user={auth.user} /> : <Imports onChanged={refresh} workspaceSource={workspaceSource} />}
        {decisionsOpened ? <div hidden={section !== 'decisions'}><DispatcherQueue active={section === 'decisions' && selected === null} refreshKey={refreshKey} onOpenDelivery={openDelivery} onOpenRouteDraft={openRouteDraft} /></div> : null}
        <footer className="page-footer">{t('metadataTitle')} <span>{t('footer')}</span></footer>
      </div>
    {selected ? <DeliveryPanel key={`${selected}:${selectedTab}`} id={selected} initialTab={selectedTab} initialFocus={selectedFocus} user={auth.user} refreshKey={refreshKey} onClose={() => setSelected(null)} onChanged={refresh} onOpenRouteDraft={section === 'deliveries' && view === 'inbox' ? openRouteDraft : undefined} /> : null}
  </WorkspaceShell>;
}

function AppearanceControls() {
  return <div className="appearance-controls"><LanguageSelector /><ThemeSelector /></div>;
}

function Login({ error, onLogin, workspaceSource }: { error: unknown; onLogin: (user: User) => void; workspaceSource: WorkspaceSource }) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  return <main className="login-page">
    <section className="login-story">
      <div className="brand light"><span className="brand-mark">m</span><span>MOHD<span className="brand-sub">{t('brandSubtitle')}</span></span></div>
      <div><p className="eyebrow">{t('loginEyebrow')}</p><h1>{t('loginHeadlineFirst')}<br />{t('loginHeadlineSecond')}</h1><p>{t('loginStory')}</p></div>
      <span className="login-foot">{t(workspaceSourceMessages[workspaceSource].login)}</span>
    </section>
    <section className="login-form"><div className="login-form-inner">
      <AppearanceControls />
      <p className="eyebrow">{t('welcomeBack')}</p>
      <div className="flex flex-wrap items-center gap-x-1.5"><h2>{t('signInTitle')}</h2><PageHelp title={t('signInTitle')} topic="login" /></div><p className="subtitle">{t('signInSubtitle')}</p>
      {error ? <Notice tone="error">{errorMessage(error, locale)}</Notice> : null}
      <ActionForm submitLabel={t('signIn')} successMessage={t('signedIn')} onSubmit={async (data) => {
        const user = await mutate('/auth/login', userSchema, { email: textField(data, 'email'), password: z.string().min(1).parse(data.get('password')) });
        onLogin(user);
      }}>
        <Field label={t('email')}><Input type="email" name="email" required autoComplete="username" placeholder="you@example.test" /></Field>
        <Field label={t('password')}><Input type="password" name="password" required autoComplete="current-password" /></Field>
      </ActionForm>
      <p className="login-help">{t('loginHelp')}</p>
    </div></section>
  </main>;
}

function Imports({ onChanged, workspaceSource }: { onChanged: () => void; workspaceSource: WorkspaceSource }) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [settledRevision, setSettledRevision] = useState<number | null>(null);
  const refreshing = settledRevision !== revision;
  function refreshHistory() { setRevision((value) => value + 1); }
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest('/imports', z.array(importSchema), { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) { setRuns(result); setError(null); setSettledRevision(revision); } },
      (failure: unknown) => { if (!controller.signal.aborted) { setError(failure); setSettledRevision(revision); } },
    );
    return () => controller.abort();
  }, [revision]);
  async function runImport() {
    setBusy(true);
    try {
      const run = await mutate('/imports', importSchema, {});
      refreshHistory();
      onChanged();
      switch (run.status) {
        case 'succeeded': toast.success(t('importCompletedToast')); break;
        case 'partial': toast.warning(t('importPartialToast')); break;
        case 'failed': toast.error(t('importFailedToast')); break;
        case 'running': toast.info(t('importRunningToast')); break;
        default: toast.info(t('importUpdatedToast'));
      }
    } catch (failure) {
      toast.error(errorMessage(failure, locale));
    } finally {
      setBusy(false);
    }
  }

  function importStatus(status: string) {
    switch (status) {
      case 'succeeded': return t('importSucceeded');
      case 'partial': return t('importPartial');
      case 'failed': return t('importFailed');
      case 'running': return t('importRunning');
      default: return status;
    }
  }

  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('integrationMonitor')}</p><PageHeadingTitle title={t('imports')} topic="imports" /><p className="subtitle">{t('importSubtitle')}</p></div><div className="flex flex-wrap items-center gap-2"><button className="button secondary" disabled={refreshing || busy} onClick={refreshHistory}>{t('refreshHistory')}</button><button className="button" disabled={busy || refreshing} onClick={() => { void runImport(); }}>{t(busy ? 'importing' : 'runImport')}</button></div></div>
    <Notice>{t(workspaceSourceMessages[workspaceSource].imports)}</Notice>
    <div className="mb-3 flex h-10 items-center gap-3 text-xs" aria-live="polite" role="status">
      {error && !refreshing ? <><span className="max-h-10 flex-1 overflow-y-auto text-destructive">{errorMessage(error, locale)}{runs ? ` ${t('staleHistory')}` : ''}</span><button className="text-button" disabled={busy} onClick={refreshHistory}>{t('retryHistory')}</button></> : <span className="text-muted-foreground">{refreshing && runs ? t('refreshingHistory') : ''}</span>}
    </div>
    {!runs ? refreshing ? <Pending /> : <Empty title={t('historyUnavailable')}>{t('historyUnavailableHelp')}</Empty> : runs.length === 0 ? <Empty title={t('noImports')}>{t('noImportsHelp')}</Empty> : <DataTable caption={t('imports')} className="min-w-[760px]" containerClassName="table-wrap relative imports-table-region"
      header={<tr><th scope="col">{t('started')}</th><th scope="col">{t('finished')}</th><th scope="col">{t('status')}</th><th scope="col">{t('processed')}</th><th scope="col">{t('diagnostics')}</th></tr>}
      rows={runs.map((run) => <tr key={run.id}>
        <td>{formatDateTime(run.startedAt, locale)}</td>
        <td>{run.finishedAt ? formatDateTime(run.finishedAt, locale) : t('in_progress')}</td>
        <td><span className={run.error ? 'badge danger' : 'badge success'}>{importStatus(run.status)}</span></td>
        <td>{run.processed}</td>
        <td>{run.error ?? '—'}<details><summary>{t('runDetails')}</summary><pre>{JSON.stringify(run.details, null, 2)}</pre></details></td>
      </tr>)} />}
  </>;
}




