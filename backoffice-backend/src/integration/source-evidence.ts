import { rows, type Executor } from '../database/database';
import { z } from 'zod';
import { SourceEvidenceSchema, SourceRevisionRowSchema, type SourceEvidence, type SourceSnapshot } from '../domain/model';

export interface SourceRead { source: SourceSnapshot | null; evidence: SourceEvidence }

/** SQL structures are application-owned. A row hash contains no source values and detects equal-clock edits. */
function revisionSelect(entity: string, predicate: string, fields: readonly string[], clockTables: ReadonlySet<string>): string {
  return `SELECT '${entity}' AS entity,r.id,
    ${clockTables.has(entity) ? `to_char(r.write_date::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : 'NULL::text'} AS "writeDate",
    encode(sha256(convert_to(jsonb_build_array(${fields.map((field) => `r.${field}`).join(',')})::text,'UTF8')),'hex') AS "rowHash" FROM ${entity} r WHERE ${predicate}`;
}

/** Must use the same repeatable-read transaction as the payload. No missing clock is replaced with read time. */
export class SourceEvidenceReader {
  private clockTables: ReadonlySet<string> | undefined;
  constructor(private readonly executor: Executor, private readonly mode: 'mock' | 'odoo18') {}
  async read(pickingId: number, source: SourceSnapshot | null): Promise<SourceEvidence> {
  const { executor, mode } = this;
  if (source === null) return { rows: [], readComplete: true };
  const tables = ['stock_picking', 'stock_move', 'sale_order_line', 'sale_order', 'res_partner', 'product_product', 'product_template',
    'crm_team', 'stock_picking_type', 'stock_location', ...(mode === 'odoo18' ? ['procurement_group', 'uom_uom', 'res_country', 'res_country_state'] : [])];
  if (!this.clockTables) {
    const clocks = await rows(executor, z.object({ name: z.string() }), `SELECT name FROM unnest($1::text[]) name
      WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(name) AND a.attname='write_date' AND NOT a.attisdropped)`, [tables]);
    this.clockTables = new Set(clocks.map(({ name }) => name));
  }
  const clockTables = this.clockTables;
  const select = (entity: string, predicate: string, fields: readonly string[]) => revisionSelect(entity, predicate, ['id', ...fields], clockTables);
  const common = [
    select('stock_picking', 'r.id=$1', ['name','sale_id','partner_id','state','team_id','picking_type_id','location_dest_id',
      ...(mode === 'mock' ? ['demo_service_type','demo_estimated_minutes','demo_notes'] : [])]),
    select('stock_move', 'r.picking_id=$1', ['picking_id','product_id','sale_line_id','name','product_uom_qty','product_uom',
      ...(mode === 'odoo18' ? ['state','group_id','partner_id'] : [])]),
    select('sale_order_line', 'r.id IN (SELECT sale_line_id FROM moves)', ['order_id','name', ...(mode === 'mock' ? ['demo_configuration','demo_ambient','demo_notes'] : [])]),
    select('sale_order', mode === 'odoo18'
      ? 'r.id IN (SELECT sale_id FROM picking UNION SELECT order_id FROM lines UNION SELECT sale_id FROM groups)'
      : 'r.id IN (SELECT sale_id FROM picking UNION SELECT order_id FROM lines)', ['name','magento_id', ...(mode === 'odoo18' ? ['partner_shipping_id'] : [])]),
    select('res_partner', 'r.id=$2 OR r.id IN (SELECT partner_id FROM picking)', ['name','street','city','phone','mobile','email',
      ...(mode === 'odoo18' ? ['street2','zip','country_id','state_id'] : ['country_code','contact_name'])]),
    select('product_product', 'r.id IN (SELECT product_id FROM moves)', ['product_tmpl_id','default_code']),
    select('product_template', 'r.id IN (SELECT product_tmpl_id FROM product_product WHERE id IN (SELECT product_id FROM moves))',
      mode === 'odoo18' ? ['name'] : ['description','image_url']),
    select('crm_team', 'r.id IN (SELECT team_id FROM picking)', ['name']),
    select('stock_picking_type', 'r.id IN (SELECT picking_type_id FROM picking)', ['code']),
    select('stock_location', 'r.id IN (SELECT location_dest_id FROM picking)', ['name']),
  ];
  if (mode === 'odoo18') common.push(
    select('procurement_group', 'r.id IN (SELECT group_id FROM moves)', ['sale_id']),
    select('uom_uom', 'r.id IN (SELECT product_uom FROM moves)', ['name']),
    select('res_country', 'r.id IN (SELECT country_id FROM res_partner WHERE id=$2 OR id IN (SELECT partner_id FROM picking))', ['code']),
    select('res_country_state', 'r.id IN (SELECT state_id FROM res_partner WHERE id=$2 OR id IN (SELECT partner_id FROM picking))', ['code']),
  );
  const result = await rows(executor, SourceRevisionRowSchema, `WITH picking AS (SELECT * FROM stock_picking WHERE id=$1),
    moves AS (SELECT * FROM stock_move WHERE picking_id=$1), lines AS (SELECT * FROM sale_order_line WHERE id IN (SELECT sale_line_id FROM moves))
    ${mode === 'odoo18' ? ', groups AS (SELECT * FROM procurement_group WHERE id IN (SELECT group_id FROM moves))' : ''}
    SELECT * FROM (${common.join(' UNION ALL ')}) versions ORDER BY entity,id LIMIT 10001`, [pickingId, source.customer.id]);
  return SourceEvidenceSchema.parse({ rows: result, readComplete: true });
  }
}
