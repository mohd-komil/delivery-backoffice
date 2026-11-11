DO $$
DECLARE matched integer[];
BEGIN
 IF current_database() <> 'odoo_mock' THEN RAISE EXCEPTION 'Wrong source database'; END IF;
 IF (SELECT count(*) FROM stock_picking) <> 30 THEN RAISE EXCEPTION 'Expected 30 synthetic pickings'; END IF;
 IF (SELECT count(*) FROM res_partner) <> 12 THEN RAISE EXCEPTION 'Expected 12 synthetic partners'; END IF;
 IF (SELECT count(*) FROM sale_order) <> 31 THEN RAISE EXCEPTION 'Expected 31 synthetic sales orders'; END IF;
 IF (SELECT count(*) FROM stock_move) <> 61 THEN RAISE EXCEPTION 'Expected 61 synthetic picking lines'; END IF;
 SELECT array_agg(p.id ORDER BY p.id) INTO matched
 FROM stock_picking p
 INNER JOIN stock_picking_type pt ON p.picking_type_id=pt.id
 INNER JOIN stock_location l ON p.location_dest_id=l.id
 INNER JOIN crm_team t ON p.team_id=t.id
 INNER JOIN sale_order s ON p.sale_id=s.id
 WHERE pt.code='outgoing' AND p.state='assigned'
 AND l.name <> 'My Company: Transit Location' AND s.magento_id IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM stock_move m JOIN sale_order_line sl ON sl.id=m.sale_line_id
   JOIN sale_order related_order ON related_order.id=sl.order_id
   WHERE m.picking_id=p.id AND related_order.magento_id IS NOT NULL
 )
 AND t.name IN ('MOHD MESSINA','FRANCA MOLLURA','MOHD CATANIA','MOHD CATANIA 2');
 IF matched IS DISTINCT FROM ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20] THEN
  RAISE EXCEPTION 'Filter result changed; expected IDs 1..20, received %',matched;
 END IF;
 IF (SELECT count(*) FROM stock_picking WHERE sale_id=1) <> 2 THEN RAISE EXCEPTION 'Partial picking fixture missing'; END IF;
 IF (SELECT array_agg(id ORDER BY id) FROM stock_move WHERE picking_id=1) <> ARRAY[11,12] THEN RAISE EXCEPTION 'Picking 1 lines incorrect'; END IF;
 IF (SELECT array_agg(id ORDER BY id) FROM stock_move WHERE picking_id=2) <> ARRAY[21,22] THEN RAISE EXCEPTION 'Picking 2 lines incorrect'; END IF;
 IF (SELECT product_uom_qty FROM stock_move WHERE id=52) <> 1.500 THEN RAISE EXCEPTION 'Fractional quantity fixture missing'; END IF;
 IF (SELECT array_agg(DISTINCT sl.order_id ORDER BY sl.order_id) FROM stock_move m JOIN sale_order_line sl ON sl.id=m.sale_line_id WHERE m.picking_id=20) <> ARRAY[20,1001] THEN RAISE EXCEPTION 'Multi-order picking fixture missing'; END IF;
 IF has_table_privilege('odoo_reader','stock_picking','INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Reader unexpectedly has write rights'; END IF;
 IF has_schema_privilege('odoo_reader','public','CREATE') THEN RAISE EXCEPTION 'Reader unexpectedly has schema CREATE'; END IF;
END $$;
SELECT 'PASS: 30 pickings, 31 orders, 61 lines, exact IDs 1..20, multi-order picking 20, distinct partial shipments, decimals, read-only grants' AS verification;
