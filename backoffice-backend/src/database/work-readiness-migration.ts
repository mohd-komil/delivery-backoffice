import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

/** Adds operational readiness beside historical reports; never rewrites a signed result. */
export class WorkReadiness1793701000000 implements MigrationInterface {
  name = 'WorkReadiness1793701000000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the work readiness migration inside a transaction');
    await runner.query('SELECT pg_advisory_xact_lock(7041001)');
    await runner.query(`WITH results AS (
      SELECT d.id AS delivery_id, v->>'id' AS appointment_id, r AS result
      FROM delivery d CROSS JOIN LATERAL jsonb_array_elements(d.data->'appointments') v
      CROSS JOIN LATERAL jsonb_array_elements(v->'results') r
      WHERE d.data->>'completedAt' IS NULL
    ), damage_results AS (
      SELECT DISTINCT r.delivery_id, r.appointment_id, r.result,
        (w->>'sourceLineId')::integer AS line_id,
        (SELECT link->>'issueId' FROM jsonb_array_elements(COALESCE(r.result->'issueLinks','[]'::jsonb)) link
         WHERE link->>'sourceLineId'=w->>'sourceLineId' LIMIT 1) AS issue_id
      FROM results r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.result->'incompleteWork','[]'::jsonb)) w
      WHERE w->>'reason'='damage' AND NOT EXISTS (
        SELECT 1 FROM results later WHERE later.delivery_id=r.delivery_id AND later.result->>'supersedesResultId'=r.result->>'id'
      )
    ), candidates AS (
      SELECT delivery_id,line_id,jsonb_strip_nulls(jsonb_build_object(
        'id',gen_random_uuid(),
        'sourceLineId',line_id,'reason','damage','appointmentId',appointment_id,'resultId',result->>'id','issueId',issue_id,
        'createdAt',result->>'receivedAt','createdBy',jsonb_build_object('id',result->'actor'->>'id','name',result->'actor'->>'name')
      )) AS hold FROM damage_results
      UNION ALL
      SELECT d.id,(item.value)::integer,jsonb_strip_nulls(jsonb_build_object(
        'id',gen_random_uuid(),
        'sourceLineId',(item.value)::integer,'reason','damage','appointmentId',issue->>'appointmentId','issueId',issue->>'id',
        'createdAt',issue->>'createdAt','createdBy',jsonb_build_object('id',issue->>'authorId','name',issue->>'authorName')
      )) FROM delivery d CROSS JOIN LATERAL jsonb_array_elements(d.data->'issues') issue
      CROSS JOIN LATERAL jsonb_array_elements_text(issue->'itemIds') item(value)
      WHERE d.data->>'completedAt' IS NULL AND issue->>'type'='damage' AND issue->>'status'='open'
        AND NOT EXISTS (SELECT 1 FROM damage_results r WHERE r.delivery_id=d.id AND r.issue_id=issue->>'id' AND r.line_id=item.value::integer)
    ), pending AS (
      SELECT c.delivery_id,jsonb_agg(c.hold ORDER BY c.hold->>'id') AS holds
      FROM candidates c JOIN delivery d ON d.id=c.delivery_id
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(d.data->'source'->'items') item WHERE item->>'sourceLineId'=c.line_id::text)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'workHolds','[]'::jsonb)) h
          WHERE h->>'sourceLineId'=c.line_id::text AND (
            (c.hold ? 'resultId' AND h->>'resultId'=c.hold->>'resultId') OR
            (c.hold ? 'issueId' AND h->>'issueId'=c.hold->>'issueId') OR h->>'id'=c.hold->>'id'))
      GROUP BY c.delivery_id
    ), updated AS (
      UPDATE delivery d SET version=d.version+1,
        data=jsonb_set(d.data||jsonb_build_object('workHolds',COALESCE(d.data->'workHolds','[]'::jsonb)||p.holds),'{version}',to_jsonb(d.version+1))
      FROM pending p WHERE d.id=p.delivery_id RETURNING d.id,d.version
    ) INSERT INTO audit(id,delivery_id,actor_id,actor_name,action,details)
      SELECT gen_random_uuid(),u.id,'00000000-0000-4000-8000-000000000001'::uuid,'Damage readiness migration','work.readiness_backfilled',
        jsonb_build_object('migration','WorkReadiness1793701000000','version',u.version,'holdIds',
          (SELECT jsonb_agg(h->'id') FROM jsonb_array_elements(p.holds) h),
          'note','Existing damage remains blocked until an operator explicitly confirms readiness. Signed reports were preserved.')
      FROM updated u JOIN pending p ON p.delivery_id=u.id`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve damage holds and dispatcher release history'));
  }
}
