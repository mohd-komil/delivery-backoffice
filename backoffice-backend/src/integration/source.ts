import { readFileSync } from 'node:fs';
import { DataSource, type QueryRunner } from 'typeorm';
import { z } from 'zod';
import { config } from '../config';
import { rows, type Executor } from '../database/database';
import { SourceSchema, type SourceSnapshot } from '../domain/model';
import { Odoo18Snapshot } from './odoo18-snapshot';
import { SourceEvidenceReader, type SourceRead } from './source-evidence';

/** Historical synthetic source identity, retained for existing fixtures and snapshots. */
export const SOURCE_INSTANCE = 'odoo_mock';
export function sourceInstance(): string { return config().ODOO_SOURCE_INSTANCE; }

export interface SourceReader {
  qualifyingIds(): Promise<number[]>;
  picking(id: number): Promise<SourceSnapshot | null>;
  readPicking(id: number): Promise<SourceRead>;
}

/** Verify effective privileges; PostgreSQL read-only transactions remain a separate enforced boundary. */
export async function assertReadOnlyOdooRole(executor: Executor): Promise<void> {
  const permissionRows = await rows(executor, z.object({
    elevatedRole: z.boolean(), canCreateDatabaseObjects: z.boolean(), canCreatePublicObjects: z.boolean(),
    writableTables: z.boolean(), defaultReadOnly: z.boolean(), transactionReadOnly: z.boolean(),
  }), `
    SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS "elevatedRole",
      has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateDatabaseObjects",
      has_schema_privilege(current_user,'public','CREATE') AS "canCreatePublicObjects",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
            OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE'))
      ) AS "writableTables",
      current_setting('default_transaction_read_only')::boolean AS "defaultReadOnly",
      current_setting('transaction_read_only')::boolean AS "transactionReadOnly"
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  const permission = permissionRows[0];
  if (permissionRows.length !== 1 || !permission || permission.elevatedRole || permission.canCreateDatabaseObjects
    || permission.canCreatePublicObjects || permission.writableTables) {
    throw new Error('Odoo source reader has unapproved write or administrative privileges');
  }
  if (!permission.defaultReadOnly || !permission.transactionReadOnly) {
    throw new Error('Odoo source requires a read-only connection and transaction');
  }
}
const PAGE_SIZE = 100;
const MAX_PICKINGS = 5000;
const IdRow = z.object({ id: z.number().int().positive() });
const NullableString = z.string().nullable();
const PickingRow = z.object({
  pickingId: z.number().int().positive(), pickingName: z.string(),
  saleOrderId: z.number().int().positive().nullable(), saleOrderName: NullableString,
  sourceState: NullableString, salesTeam: NullableString,
  customerId: z.number().int().positive().nullable(), customerName: NullableString,
  address: NullableString, city: NullableString, country: NullableString,
  phone: NullableString, mobile: NullableString, email: NullableString, contact: NullableString,
  serviceType: NullableString, estimatedMinutes: z.number().int().nullable(), notes: NullableString,
});
const MoveRow = z.object({
  sourceLineId: z.number().int().positive(), productId: z.number().int().positive(),
  saleOrderId: z.number().int().positive(),
  name: z.string(), description: NullableString,
  quantity: z.string().regex(/^\d{1,7}(?:\.\d{1,3})?$/).transform(Number),
  uom: z.string(), configuration: NullableString, ambient: NullableString,
  notes: NullableString, photoUrl: NullableString,
});

/** Source access always stays read-only; explicit configuration selects the isolated mock or Odoo 18 mapping. */
export class OdooSource {
  private readonly dataSource: DataSource;
  private readonly mode: 'mock' | 'odoo18';
  constructor() {
    const environment = config();
    const url = environment.ODOO_DATABASE_URL;
    const parsed = new URL(url);
    this.mode = environment.ODOO_SOURCE_MODE;
    if (this.mode === 'mock' && (parsed.pathname !== '/odoo_mock' || parsed.username !== 'odoo_reader')) {
      throw new Error('The source adapter requires the isolated odoo_mock reader');
    }
    const realSourceOptions = this.mode === 'odoo18' ? {
      ssl: environment.ODOO_SOURCE_TRANSPORT === 'tls' ? {
        rejectUnauthorized: true,
        ...(environment.ODOO_SOURCE_CA_FILE === undefined ? {} : { ca: readFileSync(environment.ODOO_SOURCE_CA_FILE, 'utf8') }),
      } : false,
      // Startup options apply before the ORM's metadata reads. Source URL options are forbidden by config.
      extra: { connectionTimeoutMillis: 5000, statement_timeout: 15000, max: 2,
        options: '-c default_transaction_read_only=on -c search_path=public -c lock_timeout=2000 -c idle_in_transaction_session_timeout=30000' },
    } : {};
    this.dataSource = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, logging: false,
      extra: { connectionTimeoutMillis: 3000, statement_timeout: 15000, max: 2 },
      ...realSourceOptions,
    });
  }

  async snapshot<T>(read: (source: SourceReader) => Promise<T>): Promise<T> {
    let runner: QueryRunner | undefined;
    try {
      await this.dataSource.initialize();
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction('REPEATABLE READ');
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.query("SET LOCAL TIME ZONE 'UTC'");
      if (this.mode === 'odoo18') await assertReadOnlyOdooRole(runner.manager);
      const result = await read(this.mode === 'odoo18' ? new Odoo18Snapshot(runner.manager) : new OdooSnapshot(runner));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      if (runner && !runner.isReleased) await runner.release();
      if (this.dataSource.isInitialized) await this.dataSource.destroy();
    }
  }
}

export class OdooSnapshot {
  private readonly evidenceReader: SourceEvidenceReader;
  constructor(private readonly runner: QueryRunner) { this.evidenceReader = new SourceEvidenceReader(runner.manager, 'mock'); }

  async readPicking(id: number): Promise<SourceRead> {
    const source = await this.picking(id);
    return { source, evidence: await this.evidenceReader.read(id, source) };
  }

  async qualifyingIds(): Promise<number[]> {
    const ids: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = await rows(this.runner.manager, IdRow, `
        SELECT p.id
        FROM stock_picking p
        INNER JOIN stock_picking_type pt ON p.picking_type_id = pt.id
        INNER JOIN stock_location l ON p.location_dest_id = l.id
        INNER JOIN crm_team t ON p.team_id = t.id
        INNER JOIN sale_order s ON p.sale_id = s.id
        WHERE pt.code = 'outgoing' AND p.state = 'assigned'
          AND l.name <> 'My Company: Transit Location'
          AND s.magento_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stock_move m
            JOIN sale_order_line sl ON sl.id=m.sale_line_id
            JOIN sale_order related_order ON related_order.id=sl.order_id
            WHERE m.picking_id=p.id AND related_order.magento_id IS NOT NULL
          )
          AND t.name IN ('MOHD MESSINA','FRANCA MOLLURA','MOHD CATANIA','MOHD CATANIA 2')
          AND p.id > $1
        ORDER BY p.id LIMIT $2`, [cursor, PAGE_SIZE]);
      if (page.length === 0) return ids;
      ids.push(...page.map((record) => record.id));
      if (ids.length > MAX_PICKINGS) throw new Error('Source scan exceeds the documented 5000-picking demo limit');
      const last = page.at(-1);
      if (!last) return ids;
      cursor = last.id;
    }
  }

  async picking(id: number): Promise<SourceSnapshot | null> {
    const found = await rows(this.runner.manager, PickingRow, `
      SELECT p.id AS "pickingId", p.name AS "pickingName", p.sale_id AS "saleOrderId",
        s.name AS "saleOrderName", p.state AS "sourceState", t.name AS "salesTeam",
        c.id AS "customerId", c.name AS "customerName", c.street AS address,
        c.city, c.country_code AS country, c.phone, c.mobile, c.email, c.contact_name AS contact,
        p.demo_service_type AS "serviceType", p.demo_estimated_minutes AS "estimatedMinutes", p.demo_notes AS notes
      FROM stock_picking p
      LEFT JOIN sale_order s ON s.id = p.sale_id
      LEFT JOIN crm_team t ON t.id = p.team_id
      LEFT JOIN res_partner c ON c.id = p.partner_id
      WHERE p.id = $1`, [id]);
    const picking = found[0];
    if (!picking) return null;
    const salesOrders = await rows(this.runner.manager,
      z.object({ id: z.number().int().positive(), name: z.string() }), `
      SELECT s.id,s.name FROM sale_order s WHERE s.id IN (
        SELECT p.sale_id FROM stock_picking p WHERE p.id=$1
        UNION
        SELECT sl.order_id FROM stock_move m JOIN sale_order_line sl ON sl.id=m.sale_line_id WHERE m.picking_id=$1
      ) ORDER BY s.id LIMIT 101`, [id]);
    const itemRows = await rows(this.runner.manager, MoveRow, `
      SELECT m.id AS "sourceLineId", m.product_id AS "productId", m.name,
        sl.order_id AS "saleOrderId",
        pt.description, m.product_uom_qty::text AS quantity, m.product_uom AS uom,
        sl.demo_configuration AS configuration, sl.demo_ambient AS ambient,
        sl.demo_notes AS notes, pt.image_url AS "photoUrl"
      FROM stock_move m
      LEFT JOIN sale_order_line sl ON sl.id = m.sale_line_id
      LEFT JOIN product_product pp ON pp.id = m.product_id
      LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
      WHERE m.picking_id = $1 ORDER BY m.id LIMIT 501`, [id]);
    return SourceSchema.parse({
      pickingId: picking.pickingId, pickingName: picking.pickingName,
      saleOrderId: picking.saleOrderId, saleOrderName: picking.saleOrderName,
      salesOrders,
      sourceState: picking.sourceState, salesTeam: picking.salesTeam,
      customer: {
        id: picking.customerId, name: picking.customerName, address: picking.address,
        city: picking.city, country: picking.country,
        phones: [picking.phone, picking.mobile].filter((phone) => phone !== null && phone.trim() !== ''),
        email: picking.email, contact: picking.contact,
      },
      items: itemRows, serviceType: picking.serviceType,
      estimatedMinutes: picking.estimatedMinutes, notes: picking.notes,
    });
  }
}
