import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Additive capability catalogue; existing templates, participants and signed aggregates are never rewritten. */
export class ParticipantSkills1793700300000 implements MigrationInterface {
  name='ParticipantSkills1793700300000';
  async up(runner:QueryRunner):Promise<void> {
    const target:unknown=await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({name:z.enum(['delivery_backoffice','delivery_backoffice_test']),port:z.literal(55432)})).length(1).parse(target);
    if(!runner.isTransactionActive) throw new Error('Run the skill migration inside the reviewed migration transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query(`CREATE TABLE skill (
      id uuid PRIMARY KEY,version integer NOT NULL DEFAULT 1 CHECK(version>0),
      name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 200),
      description text CHECK(description IS NULL OR (description=btrim(description) AND length(description)<=2000)),
      enabled boolean NOT NULL DEFAULT true
    );
    CREATE UNIQUE INDEX skill_name_unique ON skill(lower(name));
    CREATE TABLE participant_skill (
      person_id uuid NOT NULL REFERENCES person(id),skill_id uuid NOT NULL REFERENCES skill(id),
      PRIMARY KEY(person_id,skill_id)
    );
    CREATE INDEX participant_skill_skill ON participant_skill(skill_id,person_id);`);
  }
  down():Promise<void> {return Promise.reject(new Error('Skill history has no automatic destructive rollback; use a reviewed recovery procedure'));}
}
