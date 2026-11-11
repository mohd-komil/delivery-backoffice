import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Adds only the default-roster constraint. Existing ambiguous memberships require an explicit prior decision. */
export class UniqueDefaultCrew1793700200000 implements MigrationInterface {
  name='UniqueDefaultCrew1793700200000';
  async up(runner:QueryRunner):Promise<void> {
    const target:unknown=await runner.query('SELECT current_database() AS name,inet_server_port() AS port');
    z.array(z.object({name:z.enum(['delivery_backoffice','delivery_backoffice_test']),port:z.literal(55432)})).length(1).parse(target);
    if(!runner.isTransactionActive) throw new Error('Run the default-roster migration inside the reviewed migration transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query('LOCK TABLE crew_member IN SHARE ROW EXCLUSIVE MODE');
    const raw:unknown=await runner.query(`SELECT p.id AS "personId",
      COALESCE(p.preferred_name,NULLIF(concat_ws(' ',p.first_name,p.last_name),''),p.legacy_name) AS "personName",
      jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) ORDER BY c.id) AS crews
      FROM person p JOIN crew_member m ON m.person_id=p.id JOIN crew c ON c.id=m.crew_id
      GROUP BY p.id HAVING count(*)>1 ORDER BY p.id`);
    const duplicates=z.array(z.object({personId:z.string().uuid(),personName:z.string(),crews:z.array(z.object({id:z.string().uuid(),name:z.string()}))})).parse(raw);
    if(duplicates.length) throw new Error('Default-roster migration requires an explicit membership decision; no rows changed: '+JSON.stringify(duplicates));
    await runner.query('ALTER TABLE crew_member ADD CONSTRAINT crew_member_person_unique UNIQUE(person_id)');
  }
  down():Promise<void> {return Promise.reject(new Error('Do not remove the one-default-crew invariant automatically; use a reviewed recovery procedure'));}
}
