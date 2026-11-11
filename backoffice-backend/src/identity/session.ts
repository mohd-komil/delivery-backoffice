import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

export function header(request: unknown, name: string): string | undefined {
  if (typeof request !== 'object' || request === null || !('headers' in request)) return undefined;
  const parsed = z.record(z.string(), z.unknown()).safeParse(request.headers);
  if (!parsed.success) return undefined;
  const value = parsed.data[name];
  return typeof value === 'string' ? value : undefined;
}

export function sessionToken(request: unknown, cookieName: string) {
  const prefix = cookieName + '=';
  const cookie = header(request, 'cookie') ?? '';
  const value = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function sessionDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

/** Per-login throttling for the isolated workspace. Session credentials are never retained here. */
export class LoginAttempts {
  private readonly attempts = new Map<string, { count: number; until: number }>();

  assertAllowed(login: string) {
    const previous = this.attempts.get(login);
    if (previous && previous.until > Date.now() && previous.count >= 8) {
      throw new UnauthorizedException('Too many attempts; try again later');
    }
  }

  failed(login: string) {
    const now = Date.now();
    const previous = this.attempts.get(login);
    this.attempts.set(login, { count: previous && previous.until > now ? previous.count + 1 : 1, until: now + 900000 });
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value ?? '');
  }

  succeeded(login: string) {
    this.attempts.delete(login);
  }
}
