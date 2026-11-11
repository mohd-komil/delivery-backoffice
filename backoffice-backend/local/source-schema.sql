-- Teaching schema only. This is NOT a claim about the customer's Odoo schema.
BEGIN;
CREATE TABLE IF NOT EXISTS stock_picking_type (
    id integer PRIMARY KEY,
    code text
);
CREATE TABLE IF NOT EXISTS stock_location (
    id integer PRIMARY KEY,
    name text
);
CREATE TABLE IF NOT EXISTS crm_team (
    id integer PRIMARY KEY,
    name text,
    write_date timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS res_partner (
    id integer PRIMARY KEY,
    name text NOT NULL,
    street text,
    city text,
    country_code text,
    phone text,
    mobile text,
    email text,
    contact_name text
);
CREATE TABLE IF NOT EXISTS sale_order (
    id integer PRIMARY KEY,
    name text NOT NULL,
    magento_id text,
    partner_id integer REFERENCES res_partner(id),
    write_date timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stock_picking (
    id integer PRIMARY KEY,
    name text NOT NULL UNIQUE,
    state text,
    picking_type_id integer REFERENCES stock_picking_type(id),
    location_dest_id integer REFERENCES stock_location(id),
    team_id integer REFERENCES crm_team(id),
    sale_id integer REFERENCES sale_order(id),
    partner_id integer REFERENCES res_partner(id),
    scheduled_date timestamptz,
    write_date timestamptz NOT NULL DEFAULT now(),
    demo_service_type text,
    demo_estimated_minutes integer CHECK (demo_estimated_minutes > 0),
    demo_notes text
);
CREATE TABLE IF NOT EXISTS product_template (
    id integer PRIMARY KEY,
    name text NOT NULL,
    description text,
    image_url text
);
CREATE TABLE IF NOT EXISTS product_product (
    id integer PRIMARY KEY,
    product_tmpl_id integer NOT NULL REFERENCES product_template(id),
    default_code text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sale_order_line (
    id integer PRIMARY KEY,
    order_id integer NOT NULL REFERENCES sale_order(id),
    product_id integer NOT NULL REFERENCES product_product(id),
    name text NOT NULL,
    product_uom_qty numeric(12,3) NOT NULL CHECK (product_uom_qty > 0),
    product_uom text NOT NULL,
    demo_configuration text,
    demo_ambient text,
    demo_notes text
);
CREATE TABLE IF NOT EXISTS stock_move (
    id integer PRIMARY KEY,
    picking_id integer NOT NULL REFERENCES stock_picking(id),
    sale_line_id integer NOT NULL REFERENCES sale_order_line(id),
    product_id integer NOT NULL REFERENCES product_product(id),
    name text NOT NULL,
    product_uom_qty numeric(12,3) NOT NULL CHECK (product_uom_qty > 0),
    product_uom text NOT NULL,
    write_date timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_move_picking_id_idx ON stock_move(picking_id,id);
CREATE INDEX IF NOT EXISTS picking_sale_id_idx ON stock_picking(sale_id);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO odoo_reader;
COMMIT;
