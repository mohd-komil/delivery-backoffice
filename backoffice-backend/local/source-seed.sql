-- Stable, non-destructive seed. Existing source scenario changes are preserved.
-- To obtain a clean fixture, create a separate task-owned cluster; never reset shared data.
BEGIN;
INSERT INTO stock_picking_type(id,code) VALUES (1,'outgoing'),(2,'incoming'),(3,NULL) ON CONFLICT(id) DO NOTHING;
INSERT INTO stock_location(id,name) VALUES (1,'Customer'),(2,'My Company: Transit Location'),(3,NULL) ON CONFLICT(id) DO NOTHING;
INSERT INTO crm_team(id,name,write_date) VALUES
 (1,'MOHD MESSINA','2026-11-01T08:00:00Z'),
 (2,'FRANCA MOLLURA','2026-11-01T08:00:00Z'),
 (3,'MOHD CATANIA','2026-11-01T08:00:00Z'),
 (4,'MOHD CATANIA 2','2026-11-01T08:00:00Z'),
 (5,'DEMO OTHER TEAM','2026-11-01T08:00:00Z'),
 (6,NULL,'2026-11-01T08:00:00Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO res_partner(id,name,street,city,country_code,phone,mobile,email,contact_name)
SELECT n,'DEMO Customer ' || lpad(n::text,2,'0'),
 CASE WHEN n=12 THEN NULL ELSE 'Via Dimostrativa ' || n END,
 CASE WHEN n%2=0 THEN 'Messina' ELSE 'Catania' END,'IT',
 CASE WHEN n=12 THEN NULL ELSE '+39 000 000 ' || lpad(n::text,4,'0') END,
 CASE WHEN n%3=0 THEN NULL ELSE '+39 000 100 ' || lpad(n::text,4,'0') END,
 CASE WHEN n=12 THEN NULL ELSE 'customer' || n || '@example.invalid' END,
 CASE WHEN n=12 THEN NULL ELSE 'DEMO Contact ' || n END
FROM generate_series(1,12) n ON CONFLICT(id) DO NOTHING;
INSERT INTO sale_order(id,name,magento_id,partner_id,write_date)
SELECT n,'DEMO/SO/'||lpad(n::text,4,'0'),CASE WHEN n=24 THEN 'DEMO-MAGENTO-24' ELSE NULL END,
 ((n-1)%12)+1,'2026-11-01T08:00:00Z'::timestamptz
FROM generate_series(1,30) n ON CONFLICT(id) DO NOTHING;
INSERT INTO stock_picking(id,name,state,picking_type_id,location_dest_id,team_id,sale_id,partner_id,scheduled_date,write_date,demo_service_type,demo_estimated_minutes,demo_notes)
SELECT n,'DEMO/OUT/'||lpad(n::text,4,'0'),
 CASE WHEN n=22 THEN 'done' ELSE 'assigned' END,
 CASE WHEN n=21 THEN 2 WHEN n=29 THEN NULL ELSE 1 END,
 CASE WHEN n=23 THEN 2 WHEN n=26 THEN 3 WHEN n=30 THEN NULL ELSE 1 END,
 CASE WHEN n=25 THEN 5 WHEN n=27 THEN NULL ELSE ((n-1)%4)+1 END,
 CASE WHEN n=2 THEN 1 WHEN n=28 THEN NULL ELSE n END,
 CASE WHEN n=2 THEN 1 ELSE ((n-1)%12)+1 END,
 CASE WHEN n=12 THEN NULL ELSE '2026-11-04T08:00:00Z'::timestamptz + (n-1)*interval '1 day' END,
 '2026-11-01T08:00:00Z'::timestamptz,
 CASE WHEN n=12 THEN NULL WHEN n%2=0 THEN 'delivery_and_assembly' ELSE 'delivery' END,
 CASE WHEN n=12 THEN NULL ELSE 90 END,
 'DEMO synthetic data; not a real customer or validated Odoo extension'
FROM generate_series(1,30) n ON CONFLICT(id) DO NOTHING;
INSERT INTO product_template(id,name,description,image_url) VALUES
 (1,'DEMO Modular table','Fictional table used to demonstrate distinct configurations',NULL),
 (2,'DEMO Chair','Fictional chair; product photo intentionally unavailable',NULL),
 (3,'DEMO Fabric','Fictional fabric with fractional quantity in metres',NULL)
ON CONFLICT(id) DO NOTHING;
INSERT INTO product_product(id,product_tmpl_id,default_code) VALUES
 (1,1,'DEMO-TABLE-OAK'),(2,1,'DEMO-TABLE-WALNUT'),(3,2,'DEMO-CHAIR'),(4,3,'DEMO-FABRIC')
ON CONFLICT(id) DO NOTHING;
INSERT INTO sale_order_line(id,order_id,product_id,name,product_uom_qty,product_uom,demo_configuration,demo_ambient,demo_notes)
SELECT p.id*10+s,
 COALESCE(p.sale_id,p.id),
 CASE WHEN s=1 AND p.id%2=1 THEN 1 WHEN s=1 THEN 2 WHEN p.id=5 THEN 4 ELSE 3 END,
 CASE WHEN s=1 THEN 'DEMO Modular table' WHEN p.id=5 THEN 'DEMO Fabric' ELSE 'DEMO Chair' END,
 CASE WHEN s=1 THEN 1.000 WHEN p.id=5 THEN 1.500 ELSE 2.000 END,
 CASE WHEN s=2 AND p.id=5 THEN 'm' ELSE 'unit' END,
 CASE WHEN s=1 AND p.id%2=1 THEN 'DEMO Oak / 180 cm' WHEN s=1 THEN 'DEMO Walnut / 220 cm' ELSE NULL END,
 CASE WHEN p.id=12 THEN NULL WHEN s=1 THEN 'DEMO Dining room' ELSE 'DEMO Living room' END,
 NULL
FROM stock_picking p CROSS JOIN generate_series(1,2) s WHERE p.id BETWEEN 1 AND 30
ON CONFLICT(id) DO NOTHING;
INSERT INTO stock_move(id,picking_id,sale_line_id,product_id,name,product_uom_qty,product_uom,write_date)
SELECT p.id*10+s,p.id,l.id,l.product_id,l.name,l.product_uom_qty,l.product_uom,'2026-11-01T08:00:00Z'::timestamptz
FROM stock_picking p CROSS JOIN generate_series(1,2) s JOIN sale_order_line l ON l.id=p.id*10+s
WHERE p.id BETWEEN 1 AND 30 ON CONFLICT(id) DO NOTHING;
-- One picking can contain lines from several sales orders (user clarification, 2026-11-04).
-- Keep every old order/line untouched; add one distinct line for the same delivery destination.
INSERT INTO sale_order(id,name,magento_id,partner_id,write_date)
VALUES(1001,'DEMO/SO/1001',NULL,8,'2026-11-04T14:00:00Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO sale_order_line(id,order_id,product_id,name,product_uom_qty,product_uom,demo_configuration,demo_ambient,demo_notes)
VALUES(20001,1001,3,'DEMO Additional chair',1.000,'unit',NULL,'DEMO Living room','Separate sales order in the same picking')
ON CONFLICT(id) DO NOTHING;
INSERT INTO stock_move(id,picking_id,sale_line_id,product_id,name,product_uom_qty,product_uom,write_date)
VALUES(20001,20,20001,3,'DEMO Additional chair',1.000,'unit','2026-11-04T14:00:00Z') ON CONFLICT(id) DO NOTHING;
COMMIT;
