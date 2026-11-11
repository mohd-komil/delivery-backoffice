-- Original plan filters plus the conservative multi-order extension (2026-11-04).
-- Every order represented by a picking's moves must have no Magento link.
SELECT p.id, p.name, p.sale_id, p.state, t.name AS sales_team
FROM stock_picking p
INNER JOIN stock_picking_type pt ON p.picking_type_id = pt.id
INNER JOIN stock_location l ON p.location_dest_id = l.id
INNER JOIN crm_team t ON p.team_id = t.id
INNER JOIN sale_order s ON p.sale_id = s.id
WHERE pt.code = 'outgoing'
  AND p.state = 'assigned'
  AND l.name <> 'My Company: Transit Location'
  AND s.magento_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM stock_move m
    JOIN sale_order_line sl ON sl.id=m.sale_line_id
    JOIN sale_order related_order ON related_order.id=sl.order_id
    WHERE m.picking_id=p.id AND related_order.magento_id IS NOT NULL
  )
  AND t.name IN ('MOHD MESSINA','FRANCA MOLLURA','MOHD CATANIA','MOHD CATANIA 2')
ORDER BY p.id;
