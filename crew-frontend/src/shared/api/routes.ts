import { request } from './client';
import { crewRouteSchema, crewRoutesSchema, routeActionSchema, routeReturnSchema } from './route-contracts';
import type { z } from 'zod';

export function getRoutes(signal: AbortSignal) {
  return request('/routes', crewRoutesSchema, { signal });
}

export function getRoute(id: string, signal: AbortSignal) {
  return request(`/routes/${encodeURIComponent(id)}`, crewRouteSchema, { signal });
}

export type RouteAction = 'depart' | 'returning' | 'return';
export type RouteCommand = z.infer<typeof routeActionSchema> | z.infer<typeof routeReturnSchema>;

export function sendRouteAction(id: string, action: RouteAction, command: RouteCommand) {
  const parsed = action === 'return' ? routeReturnSchema.safeParse(command) : routeActionSchema.safeParse(command);
  if (!parsed.success) return Promise.resolve({ ok: false, status: 400 } as const);
  return request(`/routes/${encodeURIComponent(id)}/${action}`, crewRouteSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data),
  });
}
