import { z, type ZodType } from 'zod';
import { crewUserSchema, signedOutSchema, visitDetailSchema, visitsSchema } from './contracts';

export type ApiError = { ok: false; status: number; code?: string };
export type ApiResult<T> = { ok: true; data: T } | ApiError;
const errorCodeSchema = z.object({ code: z.string().max(100) });

export async function request<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/api/crew${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      const parsed = errorCodeSchema.safeParse(error);
      return parsed.success ? { ok: false, status: response.status, code: parsed.data.code } : { ok: false, status: response.status };
    }
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502 };
  } catch {
    return { ok: false, status: 0 };
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export function signIn(login: string, password: string) {
  return request('/auth/login', crewUserSchema, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ login, password }),
  });
}

export function signOut() {
  return request('/auth/logout', signedOutSchema, { method: 'POST', headers: jsonHeaders, body: '{}' });
}

export function getCrewUser(signal: AbortSignal) {
  return request('/auth/me', crewUserSchema, { signal });
}

export function getVisits(signal: AbortSignal) {
  return request('/visits', visitsSchema, { signal });
}

export function getVisit(id: string, signal: AbortSignal) {
  return request(`/visits/${encodeURIComponent(id)}`, visitDetailSchema, { signal });
}
