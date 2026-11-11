import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Separate participant sessions with credential revocation for every update path. */
export class CrewSession1793700500000 implements MigrationInterface {
  name = 'CrewSession1793700500000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the crew session migration inside the reviewed migration transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query(`
      CREATE TABLE crew_session (
        token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        person_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX crew_session_person ON crew_session(person_id);
      CREATE INDEX crew_session_expiry ON crew_session(expires_at);

      CREATE FUNCTION revoke_crew_sessions() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $crew_session$
      BEGIN
        DELETE FROM crew_session WHERE person_id = NEW.id;
        RETURN NEW;
      END;
      $crew_session$;

      CREATE TRIGGER person_revoke_crew_sessions
      AFTER UPDATE OF login, password_hash, enabled ON person
      FOR EACH ROW
      WHEN (OLD.login IS DISTINCT FROM NEW.login
        OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
        OR OLD.enabled IS DISTINCT FROM NEW.enabled)
      EXECUTE FUNCTION revoke_crew_sessions();
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to remove crew sessions'));
  }
}
