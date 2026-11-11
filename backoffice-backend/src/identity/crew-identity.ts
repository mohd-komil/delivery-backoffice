import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import type { EntityManager } from 'typeorm';
import { CrewLoginInput, CrewProfileSchema, type CrewProfile } from '../crew/contracts';
import { Database, rows } from '../database/database';
import { PERSON_NAME_SQL } from '../database/person-name';
import { verifyLoginPassword } from './password';
import { LoginAttempts, sessionDigest, sessionToken } from './session';

export const CREW_SESSION_COOKIE = 'crew_session';
export const CREW_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const PersonProfile = CrewProfileSchema.omit({ role: true });
const Credentials = PersonProfile.extend({ passwordHash: z.string() });
const crewActors = new WeakMap<object, CrewProfile>();

export function crewActor(request: unknown): CrewProfile {
  const principal = typeof request === 'object' && request !== null ? crewActors.get(request) : undefined;
  if (!principal) throw new UnauthorizedException('Crew login required');
  return principal;
}

@Injectable()
export class CrewIdentity {
  private readonly attempts = new LoginAttempts();
  private activeLogins = 0;

  constructor(@Inject(Database) private readonly db: Database) {}

  async login(input: unknown) {
    const value = CrewLoginInput.parse(input);
    const login = value.login.toLowerCase();
    this.attempts.assertAllowed(login);
    // Bound the memory used by simultaneous scrypt calls even with many different logins.
    if (this.activeLogins >= 2) throw new HttpException('Too many simultaneous attempts; try again later', HttpStatus.TOO_MANY_REQUESTS);
    this.activeLogins++;
    try {
      const [person] = await rows(this.db.source.manager, Credentials, `
        SELECT p.id, ${PERSON_NAME_SQL} AS name, p.password_hash AS "passwordHash"
        FROM person p WHERE lower(p.login) = $1 AND p.enabled AND p.password_hash IS NOT NULL`, [login]);
      const valid = await verifyLoginPassword(value.password, person?.passwordHash);
      if (!person || !valid) {
        this.attempts.failed(login);
        throw new UnauthorizedException('Invalid login or password');
      }

      const token = randomBytes(32).toString('hex');
      const profile = await this.db.source.transaction(async (manager) => {
        // Credential edits take the same row lock and revoke sessions in their transaction.
        const [current] = await rows(manager, PersonProfile, `
          SELECT p.id, ${PERSON_NAME_SQL} AS name FROM person p
          WHERE p.id = $1 AND lower(p.login) = $2 AND p.password_hash = $3 AND p.enabled FOR UPDATE`,
        [person.id, login, person.passwordHash]);
        if (!current) throw new UnauthorizedException('Invalid login or password');
        await manager.query(`INSERT INTO crew_session(token_hash, person_id, expires_at)
          VALUES ($1, $2, now() + $3 * interval '1 millisecond')`,
        [sessionDigest(token), person.id, CREW_SESSION_DURATION_MS]);
        return CrewProfileSchema.parse({ ...current, role: 'crew' });
      });
      this.attempts.succeeded(login);
      return { token, profile };
    } finally {
      this.activeLogins--;
    }
  }

  async authenticate(request: unknown, transaction?: EntityManager) {
    const token = sessionToken(request, CREW_SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('Crew login required');
    const lock = transaction ? ' FOR SHARE OF p, s' : '';
    const [person] = await rows(transaction ?? this.db.source.manager, PersonProfile, `
      SELECT p.id, ${PERSON_NAME_SQL} AS name FROM person p JOIN crew_session s ON s.person_id = p.id
      WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp() AND p.enabled
        AND p.login IS NOT NULL AND p.password_hash IS NOT NULL${lock}`, [sessionDigest(token)]);
    if (!person) throw new UnauthorizedException('Crew session expired');
    const principal = CrewProfileSchema.parse({ ...person, role: 'crew' });
    if (typeof request === 'object' && request !== null) crewActors.set(request, principal);
    return principal;
  }

  async logout(request: unknown) {
    const token = sessionToken(request, CREW_SESSION_COOKIE);
    if (token) await this.db.source.query('DELETE FROM crew_session WHERE token_hash = $1', [sessionDigest(token)]);
  }
}
