import { DataSource, type QueryRunner } from 'typeorm';
import { z } from 'zod';
import { config } from '../config';
import { rows } from '../database/database';
import { SourceSchema, type SourceSnapshot } from '../domain/model';

export const SOURCE_INSTANCE = 'odoo_mock';
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

/** Read-only teaching adapter. It makes no customer-schema compatibility claim. */
export class OdooSource {
  private readonly dataSource: DataSource;
  constructor() {
    const url = config().ODOO_DATABASE_URL;
    const parsed = new URL(url);
    if (parsed.pathname !== '/odoo_mock' || parsed.username !== 'odoo_reader') {
      throw new Error('The source adapter requires the isolated odoo_mock reader');
    }
    this.dataSource = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, logging: false,
      extra: { connectionTimeoutMillis: 3000, statement_timeout: 15000, max: 2 },
    });
  }

  async snapshot<T>(read: (source: OdooSnapshot) => Promise<T>): Promise<T> {
    let runner: QueryRunner | undefined;
    try {
      await this.dataSource.initialize();
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction('REPEATABLE READ');
      await runner.query('SET TRANSACTION READ ONLY');
      const result = await read(new OdooSnapshot(runner));
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
  constructor(private readonly runner: QueryRunner) {}

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
