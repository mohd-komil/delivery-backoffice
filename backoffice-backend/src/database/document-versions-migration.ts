import type { MigrationInterface, QueryRunner } from 'typeorm';
import { z } from 'zod';

export class DocumentVersions1793700900000 implements MigrationInterface {
  name = 'DocumentVersions1793700900000';

  async up(runner: QueryRunner): Promise<void> {
    const target: unknown = await runner.query('SELECT current_database() AS name, inet_server_port() AS port');
    z.array(z.object({ name: z.enum(['delivery_backoffice', 'delivery_backoffice_test']), port: z.literal(55432) })).length(1).parse(target);
    if (!runner.isTransactionActive) throw new Error('Run the document version migration inside a transaction');
    // Existing uploads have no recorded purpose/version/source. Preserve that uncertainty.
    await runner.query(`ALTER TABLE file_record
      ADD COLUMN document_purpose text CHECK (document_purpose IN ('general','instruction','drawing')),
      ADD COLUMN document_version integer CHECK (document_version > 0),
      ADD COLUMN document_source text CHECK (document_source = 'local_upload'),
      ADD COLUMN supersedes_file_id uuid REFERENCES file_record(id),
      ADD CONSTRAINT document_metadata_kind CHECK (kind = 'document' OR
        (document_purpose IS NULL AND document_version IS NULL AND document_source IS NULL AND supersedes_file_id IS NULL)),
      ADD CONSTRAINT document_not_self_replacement CHECK (supersedes_file_id IS DISTINCT FROM id);
      CREATE UNIQUE INDEX file_record_current_replacement ON file_record(supersedes_file_id)
        WHERE supersedes_file_id IS NOT NULL AND status IN ('pending','ready');`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use a reviewed recovery procedure to preserve document version history'));
  }
}
