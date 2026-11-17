import { z } from 'zod';
import { rows, type Executor } from '../database/database';
import { SourceSchema, type SourceSnapshot } from '../domain/model';
import { SourceEvidenceReader, type SourceRead } from './source-evidence';

const PAGE_SIZE = 100;
const MAX_PICKINGS = 5000;
const PositiveId = z.number().int().positive();
const NullableString = z.string().nullable();
const TEAM_NAME_SQL = "COALESCE(NULLIF(t.name->>'en_US', ''), NULLIF(t.name->>'it_IT', ''))";
// An unlinked physical move can belong to the sale through its procurement group.
// Do not infer a sale line from its SKU or attach an ambiguous mixed-order move to the header.
const RESOLVED_ORDER_SQL = `COALESCE(sl.order_id, CASE
  WHEN m.sale_line_id IS NULL AND g.sale_id=p.sale_id AND NOT EXISTS (
    SELECT 1 FROM stock_move other_move JOIN sale_order_line other_line ON other_line.id=other_move.sale_line_id
    WHERE other_move.picking_id=p.id AND other_move.state <> 'cancel' AND other_line.order_id <> p.sale_id
  ) THEN g.sale_id END)`;
const CUSTOMER_SELECT_SQL = `c.id AS "customerId", c.name AS "customerName",
  NULLIF(concat_ws(', ', NULLIF(btrim(c.street), ''), NULLIF(btrim(c.street2), '')), '') AS address,
  c.city, country.code AS country, c.zip AS "postalCode", province.code AS province,
  c.phone, c.mobile, NULLIF(btrim(c.email), '') AS email`;
const CustomerRow = z.object({
  customerId: PositiveId.nullable(), customerName: NullableString,
  address: NullableString, city: NullableString, country: NullableString,
  postalCode: NullableString, province: NullableString,
  phone: NullableString, mobile: NullableString, email: NullableString,
});
const PickingRow = z.object({
  pickingId: PositiveId, pickingName: z.string(),
  pickingPartnerId: PositiveId.nullable(),
  saleOrderId: PositiveId.nullable(), saleOrderName: NullableString,
  sourceState: NullableString, salesTeam: NullableString,
  ...CustomerRow.shape,
});
const MoveRow = z.object({
  sourceLineId: PositiveId, productId: PositiveId, saleOrderId: PositiveId,
  name: z.string(), description: NullableString,
  // Reject unsupported precision rather than silently rounding source demand.
  quantity: z.string().regex(/^\d{1,7}(?:\.\d{1,3})?$/).transform(Number),
  uomId: PositiveId, uom: z.string(), sku: NullableString,
  saleOrderLineId: PositiveId.nullable(), orderLinkBasis: z.enum(['sale_order_line', 'procurement_group']),
  movePartnerId: PositiveId.nullable(),
});

/** Odoo 18 mapping; the caller owns the repeatable-read, read-only transaction. */
export class Odoo18Snapshot {
  private readonly evidenceReader: SourceEvidenceReader;
  constructor(private readonly executor: Executor) { this.evidenceReader = new SourceEvidenceReader(executor, 'odoo18'); }

  async readPicking(id: number): Promise<SourceRead> {
    const source = await this.picking(id);
    return { source, evidence: await this.evidenceReader.read(id, source) };
  }

  async qualifyingIds(): Promise<number[]> {
    const ids: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = await rows(this.executor, z.object({ id: PositiveId }), `
        SELECT p.id
        FROM stock_picking p
        JOIN stock_picking_type pt ON pt.id=p.picking_type_id
        JOIN stock_location l ON l.id=p.location_dest_id
        JOIN crm_team t ON t.id=p.team_id
        JOIN sale_order s ON s.id=p.sale_id
        WHERE pt.code='outgoing' AND p.state='assigned'
          AND l.name <> 'My Company: Transit Location'
          AND s.magento_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stock_move m
            LEFT JOIN sale_order_line sl ON sl.id=m.sale_line_id
            LEFT JOIN procurement_group g ON g.id=m.group_id
            JOIN sale_order related_order ON related_order.id=COALESCE(sl.order_id, CASE WHEN m.sale_line_id IS NULL THEN g.sale_id END)
            WHERE m.picking_id=p.id AND related_order.magento_id IS NOT NULL
          )
          AND ${TEAM_NAME_SQL} IN ('MOHD MESSINA','FRANCA MOLLURA','MOHD CATANIA','MOHD CATANIA 2')
          AND p.id > $1
        ORDER BY p.id LIMIT $2`, [cursor, PAGE_SIZE]);
      if (page.length === 0) return ids;
      ids.push(...page.map((record) => record.id));
      if (ids.length > MAX_PICKINGS) throw new Error('Source scan exceeds the documented 5000-picking limit');
      const last = page.at(-1);
      if (!last) return ids;
      cursor = last.id;
    }
  }

  async picking(id: number): Promise<SourceSnapshot | null> {
    const found = await rows(this.executor, PickingRow, `
      SELECT p.id AS "pickingId", p.name AS "pickingName", p.partner_id AS "pickingPartnerId", p.sale_id AS "saleOrderId",
        s.name AS "saleOrderName", p.state AS "sourceState", ${TEAM_NAME_SQL} AS "salesTeam",
        ${CUSTOMER_SELECT_SQL}
      FROM stock_picking p
      LEFT JOIN sale_order s ON s.id=p.sale_id
      LEFT JOIN crm_team t ON t.id=p.team_id
      LEFT JOIN res_partner c ON c.id=p.partner_id
      LEFT JOIN res_country country ON country.id=c.country_id
      LEFT JOIN res_country_state province ON province.id=c.state_id
      WHERE p.id=$1`, [id]);
    const picking = found[0];
    if (!picking) return null;
    const salesOrders = await rows(this.executor, z.object({ id: PositiveId, name: z.string(), shippingPartnerId: PositiveId.nullable() }), `
      SELECT s.id,s.name,s.partner_shipping_id AS "shippingPartnerId" FROM sale_order s WHERE s.id IN (
        SELECT p.sale_id FROM stock_picking p WHERE p.id=$1
        UNION
        SELECT ${RESOLVED_ORDER_SQL} FROM stock_move m
        JOIN stock_picking p ON p.id=m.picking_id
        LEFT JOIN sale_order_line sl ON sl.id=m.sale_line_id
        LEFT JOIN procurement_group g ON g.id=m.group_id
        WHERE m.picking_id=$1 AND m.state <> 'cancel'
      ) ORDER BY s.id LIMIT 101`, [id]);
    const itemRows = await rows(this.executor, MoveRow, `
      SELECT m.id AS "sourceLineId", m.product_id AS "productId", ${RESOLVED_ORDER_SQL} AS "saleOrderId",
        m.sale_line_id AS "saleOrderLineId",
        CASE WHEN sl.order_id IS NOT NULL THEN 'sale_order_line' ELSE 'procurement_group' END AS "orderLinkBasis",
        m.partner_id AS "movePartnerId",
        COALESCE(NULLIF(pt.name->>'en_US', ''), NULLIF(pt.name->>'it_IT', '')) AS name,
        CASE WHEN sl.order_id IS NOT NULL THEN sl.name ELSE m.name END AS description,
        trim_scale(m.product_uom_qty)::text AS quantity,
        m.product_uom AS "uomId",
        COALESCE(NULLIF(u.name->>'en_US', ''), NULLIF(u.name->>'it_IT', '')) AS uom,
        pp.default_code AS sku
      FROM stock_move m
      JOIN stock_picking p ON p.id=m.picking_id
      LEFT JOIN sale_order_line sl ON sl.id=m.sale_line_id
      LEFT JOIN procurement_group g ON g.id=m.group_id
      LEFT JOIN product_product pp ON pp.id=m.product_id
      LEFT JOIN product_template pt ON pt.id=pp.product_tmpl_id
      LEFT JOIN uom_uom u ON u.id=m.product_uom
      WHERE m.picking_id=$1 AND m.state <> 'cancel'
      ORDER BY m.id LIMIT 501`, [id]);
    let customer = CustomerRow.parse(picking);
    let addressSource: 'picking' | 'move_order_shipping' = 'picking';
    if (picking.pickingPartnerId === null && customer.customerId === null && itemRows.length > 0) {
      const ordersById = new Map(salesOrders.map((order) => [order.id, order]));
      const shippingPartnerId = ordersById.get(itemRows[0]?.saleOrderId ?? 0)?.shippingPartnerId;
      if (shippingPartnerId !== null && shippingPartnerId !== undefined
        && ordersById.get(picking.saleOrderId ?? 0)?.shippingPartnerId === shippingPartnerId && itemRows.every((item) =>
        ordersById.get(item.saleOrderId)?.shippingPartnerId === shippingPartnerId && item.movePartnerId === shippingPartnerId)) {
        const recipients = await rows(this.executor, CustomerRow, `SELECT ${CUSTOMER_SELECT_SQL}
          FROM res_partner c
          LEFT JOIN res_country country ON country.id=c.country_id
          LEFT JOIN res_country_state province ON province.id=c.state_id
          WHERE c.id=$1`, [shippingPartnerId]);
        if (recipients[0]) {
          customer = recipients[0];
          addressSource = 'move_order_shipping';
        }
      }
    }
    return SourceSchema.parse({
      pickingId: picking.pickingId, pickingName: picking.pickingName,
      saleOrderId: picking.saleOrderId, saleOrderName: picking.saleOrderName,
      salesOrders: salesOrders.map(({ id: orderId, name }) => ({ id: orderId, name })),
      sourceState: picking.sourceState, salesTeam: picking.salesTeam,
      customer: {
        id: customer.customerId, name: customer.customerName, address: customer.address,
        city: customer.city, country: customer.country, postalCode: customer.postalCode, province: customer.province,
        phones: [...new Set([customer.phone, customer.mobile].filter((phone) => phone !== null && phone.trim() !== ''))],
        email: customer.email, contact: null, addressSource,
      },
      items: itemRows.map((item) => ({
        sourceLineId: item.sourceLineId, productId: item.productId, saleOrderId: item.saleOrderId,
        saleOrderLineId: item.saleOrderLineId, orderLinkBasis: item.orderLinkBasis,
        name: item.name, description: item.description, quantity: item.quantity,
        uomId: item.uomId, uom: item.uom, sku: item.sku,
        configuration: null, ambient: null, notes: null, photoUrl: null,
      })),
      serviceType: null, estimatedMinutes: null, notes: null,
    });
  }
}
