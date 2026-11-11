import type { MigrationInterface, QueryRunner } from 'typeorm';

// Additive initial schema, reviewed for the task-owned local databases only.
export class InitialSchema1793700000000 implements MigrationInterface {
  name = 'InitialSchema1793700000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE app_user (
        id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
        role text NOT NULL CHECK(role IN ('admin','operator')), password_hash text NOT NULL
      );
      CREATE TABLE app_session (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX session_expiry ON app_session(expires_at);
      CREATE TABLE delivery (
        id uuid PRIMARY KEY, source_instance text NOT NULL, source_id integer NOT NULL,
        version integer NOT NULL CHECK(version > 0), data jsonb NOT NULL,
        UNIQUE(source_instance,source_id), CHECK(jsonb_typeof(data)='object')
      );
      CREATE TABLE crew (id uuid PRIMARY KEY, version integer NOT NULL, data jsonb NOT NULL);
      CREATE TABLE task_template (id uuid PRIMARY KEY, version integer NOT NULL, data jsonb NOT NULL);
      CREATE TABLE appointment (
        id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES delivery(id),
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
        status text NOT NULL CHECK(status IN ('booked','in_progress','completed','cancelled')),
        CHECK(ends_at > starts_at)
      );
      CREATE INDEX appointment_delivery ON appointment(delivery_id);
      CREATE INDEX appointment_time ON appointment(starts_at,ends_at);
      CREATE TABLE reservation (
        appointment_id uuid NOT NULL REFERENCES appointment(id),
        resource text NOT NULL, PRIMARY KEY(appointment_id,resource)
      );
      CREATE INDEX reservation_resource ON reservation(resource);
      CREATE TABLE audit (
        id uuid PRIMARY KEY, delivery_id uuid REFERENCES delivery(id),
        actor_id uuid NOT NULL, actor_name text NOT NULL, action text NOT NULL,
        at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL
      );
      CREATE INDEX audit_delivery ON audit(delivery_id,at,id);
      CREATE TABLE import_run (
        id uuid PRIMARY KEY, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz, processed integer NOT NULL DEFAULT 0,
        error text, details jsonb NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE file_record (
        id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES delivery(id),
        actor_id uuid NOT NULL,
        name text NOT NULL, mime text NOT NULL, size integer NOT NULL CHECK(size > 0),
        kind text NOT NULL CHECK(kind IN ('document','photo','evidence')),
        appointment_id uuid REFERENCES appointment(id), item_id integer, issue_id uuid,
        status text NOT NULL CHECK(status IN ('pending','ready','failed')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX file_delivery ON file_record(delivery_id,created_at);
      CREATE TABLE command_receipt (
        delivery_id uuid NOT NULL REFERENCES delivery(id), request_id uuid NOT NULL,
        fingerprint text NOT NULL, PRIMARY KEY(delivery_id,request_id)
      );
    `);
  }
  down(): Promise<void> {
    return Promise.reject(new Error('Initial migration has no automatic destructive rollback. Restore a task-owned backup.'));
  }
}
