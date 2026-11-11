import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

// Frozen input contract: later application DTO changes must not alter an already-reviewed migration.
const LegacyText=z.string().trim().min(1).max(2000);
const LegacyPerson=z.object({id:z.string().uuid(),name:LegacyText,external:z.boolean()}).strict();
const LegacyCrew=z.object({id:z.string().uuid(),version:z.number().int().positive(),name:LegacyText,
  classification:z.enum(['indoor','outdoor']),area:LegacyText,enabled:z.boolean(),people:z.array(LegacyPerson).max(100),
}).strict().refine((crew)=>new Set(crew.people.map((person)=>person.id)).size===crew.people.length,'Duplicate legacy participant UUID');

/** Preserves the original crew JSON and every historical delivery aggregate. Never deduplicates by name. */
export class RelationalParticipants1793700100000 implements MigrationInterface {
  name='RelationalParticipants1793700100000';
  async up(runner:QueryRunner):Promise<void> {
    const target:unknown=await runner.query('SELECT current_database() AS name');
    z.array(z.object({name:z.enum(['delivery_backoffice','delivery_backoffice_test'])})).length(1).parse(target);
    const raw:unknown=await runner.query('SELECT id,version,data FROM crew ORDER BY version DESC,id');
    const legacy=z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),data:z.unknown()})).parse(raw).map((row)=>{
      const crew=LegacyCrew.parse(row.data);
      if(crew.id!==row.id||crew.version!==row.version) throw new Error('Legacy crew identity/version differs from its stored columns; review before migration');
      return crew;
    });
    const historicalRaw:unknown=await runner.query('SELECT data FROM delivery ORDER BY id');
    const assignment=z.object({people:z.array(LegacyPerson)});
    const historical=z.array(z.object({data:z.object({appointments:z.array(z.object({
      assignments:z.array(assignment),results:z.array(z.object({assignmentsSnapshot:z.array(assignment)})),
    }))})})).parse(historicalRaw);
    await runner.query(`
      CREATE TABLE person (
        id uuid PRIMARY KEY, version integer NOT NULL DEFAULT 1 CHECK(version>0),
        legacy_name text, first_name text, last_name text, preferred_name text,
        phone_number text, address text, login text, password_hash text,
        external boolean NOT NULL, enabled boolean NOT NULL DEFAULT true,
        CHECK((first_name IS NULL AND last_name IS NULL AND legacy_name IS NOT NULL)
          OR (first_name IS NOT NULL AND last_name IS NOT NULL)),
        CHECK(first_name IS NULL OR length(btrim(first_name)) BETWEEN 1 AND 2000),
        CHECK(last_name IS NULL OR length(btrim(last_name)) BETWEEN 1 AND 2000),
        CHECK(preferred_name IS NULL OR length(btrim(preferred_name)) BETWEEN 1 AND 2000),
        CHECK(login IS NULL OR (length(login) BETWEEN 3 AND 200 AND password_hash IS NOT NULL))
      );
      CREATE UNIQUE INDEX person_login_unique ON person(lower(login)) WHERE login IS NOT NULL;
      ALTER TABLE crew RENAME COLUMN data TO legacy_data;
      ALTER TABLE crew ALTER COLUMN legacy_data DROP NOT NULL;
      ALTER TABLE crew ADD COLUMN name text;
      ALTER TABLE crew ADD COLUMN classification text;
      ALTER TABLE crew ADD COLUMN area text;
      ALTER TABLE crew ADD COLUMN enabled boolean;
      CREATE TABLE crew_member (
        crew_id uuid NOT NULL REFERENCES crew(id), person_id uuid NOT NULL REFERENCES person(id),
        position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
        PRIMARY KEY(crew_id,person_id), UNIQUE(crew_id,position)
      );
      CREATE INDEX crew_member_person ON crew_member(person_id,crew_id);
    `);
    // The most recently revised crew supplies a canonical fallback if a UUID has old inconsistent labels.
    // Every original variant remains untouched in crew.legacy_data for review.
    const people=new Map<string,{name:string;external:boolean}>();
    for(const crew of legacy) for(const person of crew.people) if(!people.has(person.id)) people.set(person.id,person);
    for(const record of historical) for(const visit of record.data.appointments) {
      for(const snapshot of [...visit.assignments,...visit.results.flatMap((result)=>result.assignmentsSnapshot)]) {
        for(const person of snapshot.people) if(!people.has(person.id)) people.set(person.id,person);
      }
    }
    for(const [id,person] of people) await runner.query('INSERT INTO person(id,legacy_name,external) VALUES($1,$2,$3)',[id,person.name,person.external]);
    for(const crew of legacy) {
      await runner.query('UPDATE crew SET name=$2,classification=$3,area=$4,enabled=$5 WHERE id=$1',[crew.id,crew.name,crew.classification,crew.area,crew.enabled]);
      for(const [position,person] of crew.people.entries()) await runner.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,$3)',[crew.id,person.id,position]);
    }
    await runner.query(`
      ALTER TABLE crew ALTER COLUMN name SET NOT NULL;
      ALTER TABLE crew ALTER COLUMN classification SET NOT NULL;
      ALTER TABLE crew ALTER COLUMN area SET NOT NULL;
      ALTER TABLE crew ALTER COLUMN enabled SET NOT NULL;
      ALTER TABLE crew ADD CONSTRAINT crew_name_nonempty CHECK(length(btrim(name)) BETWEEN 1 AND 2000);
      ALTER TABLE crew ADD CONSTRAINT crew_area_nonempty CHECK(length(btrim(area)) BETWEEN 1 AND 2000);
      ALTER TABLE crew ADD CONSTRAINT crew_classification CHECK(classification IN ('indoor','outdoor'));
      ALTER TABLE crew ADD CONSTRAINT crew_version_positive CHECK(version>0);
    `);
  }
  down():Promise<void> {return Promise.reject(new Error('Participant normalization preserves archived data; use a reviewed recovery procedure instead of destructive automatic rollback'));}
}
