import assert from 'node:assert/strict';
import { act, createElement, type ReactNode } from 'react';
import { LocaleProvider } from '../src/components/locale-provider';
import { Toaster } from '../src/components/ui/sonner';
import { defaultLocale, type Locale } from '../src/i18n/config';
import { messagesForLocale } from '../src/i18n/messages';
import type { DispatcherDetail, DispatcherList, DispatcherOwner } from '../src/lib/dispatcher';
import type { Root } from 'react-dom/client';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  detailSchema, deliveryListSchema, userSchema,
  type AvailableParticipant, type CalendarEntry, type CalendarFilterCatalog, type Crew, type DeliveryDetail, type DeliveryList, type ImportRun, type Participant, type Skill, type TaskTemplate, type Vehicle, type TransportAvailability,
} from '../src/lib/contracts';

export const deliveryId = '50000000-0000-4000-8000-000000000001';
export const user = userSchema.parse({ id: '50000000-0000-4000-8000-000000000002', name: 'DEMO operator', role: 'operator' });

export function detailFixture(version = 1, customerName = 'DEMO original customer'): DeliveryDetail {
  return detailSchema.parse({
    delivery: {
      id: deliveryId, version,
      source: {
        pickingId: 1, pickingName: 'DEMO/OUT/REFRESH', saleOrderId: 1, saleOrderName: 'DEMO/SO/REFRESH', sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
        customer: { id: 1, name: customerName, address: 'Synthetic Street 1', city: 'Messina', country: 'IT', phones: ['+390000000001'], email: 'demo@example.test', contact: null },
        items: [{ sourceLineId: 10, productId: 1, name: 'DEMO table', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
        serviceType: null, estimatedMinutes: null, notes: null,
      },
      sourceReview: false, sourceChanged: false, sourceWarnings: [],
      instructions: { floor: null, elevator: 'unknown', access: null, parking: null, restrictions: null, notes: 'Saved server instructions' },
      appointments: [], issues: [], returnRequests: [], completions: [], completedAt: null,
    },
    views: ['inbox'], progress: 'inbox', coverage: { assigned: 0, total: 0 }, deliveredQuantities: [{ sourceLineId: 10, deliveredMilli: 0 }],
    lineServices: [{ sourceLineId: 10, service: 'delivery_only', inherited: true, locked: false,
      deliveredMilli: 0, installedMilli: 0, collectedMilli: 0,
      remainingDeliveryMilli: 1000, remainingInstallationMilli: 0, remainingCollectionMilli: 0,
      totalDeliveryMilli: 1000, totalInstallationMilli: 0, totalCollectionMilli: 0,
      reservedDeliveryMilli: 0, reservedInstallationMilli: 0, reservedCollectionMilli: 0,
      availableDeliveryMilli: 1000, availableInstallationMilli: 0, availableCollectionMilli: 0, planningBlockedReason: null }],
    appointmentPlanning: [],
    closureBlockers: ['Remaining quantity: DEMO table (1 unit)'], files: [], history: [],
  });
}

export function listFixture(pickingName = 'DEMO/OUT/REFRESH'): DeliveryList {
  const detail = detailFixture();
  detail.delivery.source.pickingName = pickingName;
  return deliveryListSchema.parse({ items: [detail.delivery], total: 1, page: 1, pageSize: 10,
    counts: { inbox: 1, planned: 0, assigned: 0, in_progress: 0, partially_completed: 0, return_required: 0, issues: 0, completed: 0 } });
}

export type FetchCall = { pathname: string; search: string; method: string; body: unknown; signal: AbortSignal | null };
type PlannedResponse = { pathname: string; method: string; search: string | undefined; promise: Promise<Response>; resolve: (response: Response) => void; called: boolean };

export class ApiFixture {
  readonly calls: FetchCall[] = [];
  private readonly plans: PlannedResponse[] = [];
  detail = detailFixture();
  list = listFixture();
  calendar: CalendarEntry[] = [];
  calendarFilterCatalog: CalendarFilterCatalog | null = null;
  crews: Crew[] = [];
  templates: TaskTemplate[] = [];
  participants: Participant[] = [];
  skills: Skill[] = [];
  vehicles: Vehicle[] = [];
  transportAvailability: TransportAvailability = { vehicles: [], people: [] };
  readonly participantCalendars = new Map<string, unknown>();
  availableParticipants: AvailableParticipant[] = [];
  imports: ImportRun[] = [];
  dispatcherList: DispatcherList | null = null;
  dispatcherOwners: DispatcherOwner[] = [];
  readonly dispatcherDetails = new Map<string, DispatcherDetail>();

  defer(pathname: string, method = 'GET', search?: string) {
    const listeners: Array<(response: Response) => void> = [];
    const promise = new Promise<Response>((resolve) => { listeners.push(resolve); });
    const plan: PlannedResponse = { pathname, method, search, promise, called: false, resolve: (response) => {
      const resolve = listeners[0];
      if (!resolve) throw new Error('Deferred response was not initialized');
      resolve(response);
    } };
    this.plans.push(plan);
    return {
      get called() { return plan.called; },
      reply: (body: unknown, status = 200) => plan.resolve(Response.json(body, { status })),
    };
  }

  readonly fetch: typeof fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const rawBody: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    const call: FetchCall = { pathname: url.pathname.replace(/^\/api/, ''), search: url.search, method, body: rawBody, signal: options?.signal ?? null };
    this.calls.push(call);
    const plan = this.plans.find((candidate) => !candidate.called && candidate.pathname === call.pathname && candidate.method === method &&
      (candidate.search === undefined || candidate.search === call.search));
    // Deliberately complete even aborted requests: stale-response guards must protect UI state independently.
    if (plan) { plan.called = true; return plan.promise; }
    if (method !== 'GET') throw new Error(`Unexpected test mutation: ${method} ${call.pathname}`);
    if (call.pathname === '/auth/me') return Response.json(user);
    if (call.pathname === '/dispatcher/queue' && this.dispatcherList) return Response.json(this.dispatcherList);
    if (call.pathname === '/dispatcher/owners') return Response.json(this.dispatcherOwners);
    if (call.pathname.startsWith('/dispatcher/queue/') && this.dispatcherDetails.has(call.pathname)) return Response.json(this.dispatcherDetails.get(call.pathname));
    if (call.pathname === '/health') return Response.json({ status: 'ok', sourceKind: 'synthetic' });
    if (/^\/deliveries\/[0-9a-f-]+\/source-review$/u.test(call.pathname)) return Response.json({
      deliveryVersion: this.detail.delivery.version, status: 'current', revisionCoverage: 'unavailable', documentCoverage: 'not_mapped',
      acceptedHash: 'a'.repeat(64), candidate: null, canAccept: false, canKeepAccepted: false, blockers: [],
    });
    if (/^\/deliveries\/[0-9a-f-]+\/geocoding$/u.test(call.pathname)) return Response.json({
      provider: 'geoapify', configured: false, addressKey: '1'.repeat(64), deliveryVersion: this.detail.delivery.version,
      recordVersion: null, status: 'not_configured', reason: 'unconfigured', retryAt: null, candidate: null, acceptance: null,
    });
    if (call.pathname === '/deliveries') return Response.json(this.list);
    if (call.pathname === `/deliveries/${deliveryId}`) return Response.json(this.detail);
    if (call.pathname === '/crews') return Response.json(this.crews);
    if (call.pathname === '/templates') return Response.json(this.templates);
    if (call.pathname === '/routes/publication-capability') return Response.json({ enabled: false, reason: 'Lifecycle controls are not enabled on this stand' });
    if (/^\/routes\/[0-9a-f-]+\/publication$/u.test(call.pathname)) return Response.json(null);
    if (/^\/routes\/[0-9a-f-]+\/operations$/u.test(call.pathname)) return Response.json({ message: 'Not found' }, { status: 404 });
    if (call.pathname === '/participants') return Response.json(this.participants);
    if (call.pathname === '/skills') return Response.json(this.skills);
    if (call.pathname === '/vehicles') return Response.json(this.vehicles);
    if (call.pathname.startsWith(`/deliveries/${deliveryId}/appointments/`) && call.pathname.endsWith('/transport/availability')) return Response.json(this.transportAvailability);
    if (/^\/participants\/[^/]+\/calendar$/.test(call.pathname) && this.participantCalendars.has(call.pathname)) return Response.json(this.participantCalendars.get(call.pathname));
    if (call.pathname.startsWith(`/deliveries/${deliveryId}/appointments/`) && call.pathname.endsWith('/participants')) return Response.json({ people: this.availableParticipants });
    if (call.pathname === '/calendar') return Response.json(this.calendar);
    if (call.pathname === '/calendar/filter-options') {
      // Compatibility fixture for older Calendar tests; feature tests provide an independent global catalog.
      if (this.calendarFilterCatalog) return Response.json(this.calendarFilterCatalog);
      const crews = new Map<string, CalendarFilterCatalog['crews'][number]>();
      for (const entry of this.calendar) for (const assignment of entry.appointment.assignments) {
        crews.set(assignment.crewId, { id: assignment.crewId, name: assignment.crewName, enabled: true });
      }
      for (const crew of this.crews) crews.set(crew.id, { id: crew.id, name: crew.name, enabled: crew.enabled });
      return Response.json({ destinations: this.calendar.map((entry) => ({ city: entry.geography?.city ?? null,
        province: entry.geography?.province ?? null, postalCode: entry.geography?.postalCode ?? null, count: 1 })), crews: [...crews.values()] } satisfies CalendarFilterCatalog);
    }
    if (call.pathname === '/imports') return Response.json(this.imports);
    throw new Error(`Unexpected test request: ${method} ${call.pathname}`);
  };
}

export async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

export async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await settle();
  }
}

export async function click(button: HTMLButtonElement): Promise<void> {
  assert.equal(button.disabled, false, `Cannot click disabled button: ${button.textContent}`);
  await act(async () => { button.click(); });
}

/** Uses the native setter so React's controlled-input change tracking sees the same event as user input. */
export async function editInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

export function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === text || candidate.textContent?.trim().replace(/\s+/g, ' ') === text);
  assert.ok(found, `Button not found: ${text}`);
  return found;
}

export function hasToast(scope: ParentNode, title: string, type: 'success' | 'warning' | 'error' | 'info' = 'success'): boolean {
  return Array.from(scope.querySelectorAll(`[data-sonner-toast][data-type="${type}"] [data-title]`)).some((element) => element.textContent === title);
}

export async function domHarness(api: ApiFixture) {
  const virtualConsole = new VirtualConsole();
  const errors: Error[] = [];
  virtualConsole.on('jsdomError', (error: Error) => { errors.push(error); });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3000/', pretendToBeVisual: true, virtualConsole,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const values: Record<string, unknown> = {
    window: dom.window, self: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLFormElement: dom.window.HTMLFormElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Node: dom.window.Node, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment,
    NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), FormData: dom.window.FormData, File: dom.window.File,
    FileReader: dom.window.FileReader, fetch: api.fetch, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  let root: Root | undefined;
  return {
    dom, errors, container,
    async render(node: ReactNode, locale: Locale = defaultLocale) {
      const { createRoot } = await import('react-dom/client');
      root ??= createRoot(container);
      await act(async () => { root?.render(createElement(LocaleProvider, { locale, messages: messagesForLocale(locale) }, node, createElement(Toaster))); });
      await settle();
    },
    async close() {
      try {
        await act(async () => { root?.unmount(); });
        assert.equal(dom.window.location.href, 'http://127.0.0.1:3000/', 'Refresh must not navigate');
        const navigation = errors.filter((error) => /navigation|reload/i.test(error.message));
        assert.deepEqual(navigation.map((error) => error.message), [], 'Refresh must not request a document reload');
      } finally {
        dom.window.close();
        for (const [name, original] of originals) {
          if (original) Object.defineProperty(globalThis, name, original);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}
