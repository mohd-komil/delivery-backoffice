import { z } from 'zod';
import { commonTranslations } from '@/i18n/common';
import { defaultLocale, resolveLocale } from '@/i18n/config';
import { workPlanErrorMessage } from '@/i18n/work-plan';
import { sourceReviewErrorMessage } from '@/i18n/source-review';
import * as signatureRefusal from '@/i18n/messages/signature-refusal';

const rawApiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001/api';
const parsedApiUrl = z.url().parse(rawApiUrl);
const apiOrigin = new URL(parsedApiUrl);
if (!['http:', 'https:'].includes(apiOrigin.protocol) || apiOrigin.username || apiOrigin.password) {
  throw new Error('NEXT_PUBLIC_API_URL must be an HTTP URL without credentials.');
}
export const API_URL = parsedApiUrl.replace(/\/$/, '');

const errorSchema = z.object({ message: z.union([z.string(), z.array(z.string())]).optional(), code: z.string().optional() });

const signatureRefusalErrors = new Map<string, keyof typeof signatureRefusal.en>([
  ['SIGNATURE_REFUSAL_ALREADY_REVIEWED', 'alreadyReviewed'],
  ['SIGNATURE_REFUSAL_NOT_FOUND', 'reportNotFound'],
  ['SIGNATURE_REFUSAL_CORRECTION_INVALID', 'correctionInvalid'],
  ['SIGNATURE_REFUSAL_CARGO_CONFLICT', 'cargoConflict'],
  ['CORRECTION_CONFLICTS_WITH_PLANNING', 'planningConflict'],
]);

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function responseError(response: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = response.status === 409
    ? 'This record changed or conflicts with another booking. Refresh and review before trying again.'
    : response.status === 403
      ? 'Your account does not have permission for this action.'
      : response.status === 401
        ? 'Please sign in to continue.'
        : `The request failed (${response.status}).`;
  try {
    const raw: unknown = await response.json();
    const parsed = errorSchema.safeParse(raw);
    if (parsed.success) {
      code = parsed.data.code;
      if (parsed.data.message) message = Array.isArray(parsed.data.message) ? parsed.data.message.join('. ') : parsed.data.message;
    }
  } catch {
    // A network/proxy response can have no JSON body. The status remains useful.
  }
  return new ApiError(response.status, message, code);
}

export async function apiRequest<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (!response.ok) throw await responseError(response);
  const raw: unknown = response.status === 204 ? null : await response.json();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(502, 'The backend returned an unexpected response. Refresh after checking API versions.');
  return parsed.data;
}

export function mutate<T>(path: string, schema: z.ZodType<T>, body: unknown, method = 'POST'): Promise<T> {
  return apiRequest(path, schema, { method, body: JSON.stringify(body) });
}

export function errorMessage(error: unknown, language: string = defaultLocale): string {
  const locale = resolveLocale(language);
  const t = commonTranslations(locale);
  if (!(error instanceof Error)) return t('actionFailed');
  if (locale === defaultLocale) return error.message;
  if (error instanceof z.ZodError) return t('invalidInput');
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return t('network');
  if (!(error instanceof ApiError)) return error.message;
  const refusalMessage = error.code ? signatureRefusalErrors.get(error.code) : undefined;
  if (refusalMessage) return signatureRefusal[locale][refusalMessage];
  const workMessage = workPlanErrorMessage(error.message, locale);
  if (workMessage) return workMessage;
  const sourceMessage = sourceReviewErrorMessage(error.message, locale);
  if (sourceMessage) return sourceMessage;

  if (error.status === 401) {
    if (error.message === 'Invalid email or password') return t('invalidLogin');
    if (error.message === 'Session expired' || error.message === 'Your session expired. Please sign in again.') return t('sessionExpired');
    if (error.message.startsWith('Too many attempts')) return t('tooManyAttempts');
    return t('loginRequired');
  }
  if (error.status === 403) return t('forbidden');
  if (error.status === 404) return t('notFound');
  if (error.status === 502 && error.message.startsWith('The backend returned an unexpected response')) return t('unexpectedResponse');

  // Keep actionable details from the backend when it supplies a domain reason.
  const summary = error.status === 409 ? t('conflict') : error.status === 400 ? t('invalidInput') : t('requestFailed', { status: error.status });
  return `${summary} ${error.message}`;
}

