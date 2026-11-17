import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { config } from '../src/config';
import { rows } from '../src/database/database';
import { Odoo18Snapshot } from '../src/integration/odoo18-snapshot';
import { assertReadOnlyOdooRole } from '../src/integration/source';
import { revisionCoverage, compareSourceEvidence } from '../src/domain/source-import';

// A deliberately small Odoo 18-shaped fixture, not a copy of customer data.
const fixtureSql = `
  CREATE TABLE stock_picking_type(id integer PRIMARY KEY,code varchar);
  CREATE TABLE stock_location(id integer PRIMARY KEY,name varchar);
  CREATE TABLE crm_team(id integer PRIMARY KEY,name jsonb);
  CREATE TABLE res_country(id integer PRIMARY KEY,code varchar);
  CREATE TABLE res_country_state(id integer PRIMARY KEY,code varchar);
  CREATE TABLE res_partner(id integer PRIMARY KEY,name varchar,street varchar,street2 varchar,
    city varchar,zip varchar,state_id integer,country_id integer,phone varchar,mobile varchar,email varchar);
  CREATE TABLE sale_order(id integer PRIMARY KEY,name varchar,magento_id varchar,partner_id integer,partner_shipping_id integer DEFAULT 2);
  CREATE TABLE procurement_group(id integer PRIMARY KEY,sale_id integer);
  CREATE TABLE sale_order_line(id integer PRIMARY KEY,order_id integer,name text);
  CREATE TABLE product_template(id integer PRIMARY KEY,name jsonb);
  CREATE TABLE product_product(id integer PRIMARY KEY,product_tmpl_id integer,default_code varchar);
  CREATE TABLE uom_uom(id integer PRIMARY KEY,name jsonb);
  CREATE TABLE stock_picking(id integer PRIMARY KEY,name varchar,state varchar,picking_type_id integer,
    location_dest_id integer,team_id integer,sale_id integer,partner_id integer);
  CREATE TABLE stock_move(id integer PRIMARY KEY,picking_id integer,product_id integer,sale_line_id integer,
    product_uom integer,product_uom_qty numeric,quantity numeric,state varchar,group_id integer,name varchar,partner_id integer);
  INSERT INTO stock_picking_type VALUES(1,'outgoing'),(2,'incoming');
  INSERT INTO stock_location VALUES(1,'Customers'),(2,'My Company: Transit Location');
  INSERT INTO crm_team VALUES(1,'{"en_US":"MOHD MESSINA","it_IT":"MOHD MESSINA"}'),
    (2,'{"it_IT":"MOHD CATANIA"}'),(3,'{"en_US":"Other team"}');
  INSERT INTO res_country VALUES(1,'IT');
  INSERT INTO res_country_state VALUES(1,'ME'),(2,'CT');
  INSERT INTO res_partner VALUES
    (1,'Fixture buyer','Via Esempio 1',NULL,'Messina','098121',1,1,'+39090000001','+39090000001','buyer@example.test'),
    (2,'Fixture recipient',' Via Esempio 2 ','Entrance B','Catania','095121',2,1,NULL,NULL,'');
  INSERT INTO sale_order(id,name,magento_id,partner_id) VALUES(10,'FIXTURE/SO/10',NULL,1),(11,'FIXTURE/SO/11',NULL,1),
    (12,'FIXTURE/SO/12','external-12',1);
  INSERT INTO procurement_group VALUES(1,10),(2,11),(3,12),(4,NULL);
  INSERT INTO sale_order_line VALUES(101,10,'Table: first order configuration'),
    (102,11,'Table: second order configuration'),(103,12,'External order');
  INSERT INTO product_template VALUES(1,'{"en_US":"Fixture table","it_IT":"Tavolo di prova"}');
  INSERT INTO product_product VALUES(1,1,'SAME-SKU');
  INSERT INTO uom_uom VALUES(1,'{"it_IT":"Unità"}');
  INSERT INTO stock_picking VALUES
    (1,'FIXTURE/OUT/1','assigned',1,1,1,10,2),
    (2,'FIXTURE/OUT/2','assigned',1,1,2,11,1),
    (3,'FIXTURE/IN/3','assigned',2,1,1,10,1),
    (4,'FIXTURE/OUT/4','done',1,1,1,10,1),
    (5,'FIXTURE/OUT/5','assigned',1,2,1,10,1),
    (6,'FIXTURE/OUT/6','assigned',1,1,3,10,1),
    (7,'FIXTURE/OUT/7','assigned',1,1,1,12,1),
    (8,'FIXTURE/OUT/8','assigned',1,1,1,10,1);
  INSERT INTO stock_move(id,picking_id,product_id,sale_line_id,product_uom,product_uom_qty,quantity,state) VALUES
    (1001,1,1,101,1,2.00000,1.00000,'assigned'),
    (1002,1,1,102,1,1.50000,0.50000,'assigned'),
    (1003,1,1,101,1,99,0,'cancel'),
    (2001,2,1,102,1,3,3,'assigned'),
    (8001,8,1,103,1,1,0,'cancel');
`;

void test('Odoo 18 adapter: isolated PostgreSQL mappings, line identity, bounds, and read-only reads', async (context) => {
  const schema = `odoo18_source_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^odoo18_source_[0-9a-f]{32}$/);
  const environment = config();
  const readerUrl = new URL(environment.ODOO_DATABASE_URL);
  assert.equal(readerUrl.protocol, 'postgresql:');
  assert.equal(readerUrl.pathname, '/odoo_mock', 'Adapter tests must never target the real Odoo database');
  assert.equal(readerUrl.username, 'odoo_reader');
  assert.equal(readerUrl.port, '55432');
  assert.ok((environment.BACKOFFICE_RUNTIME === 'docker' ? ['db'] : ['127.0.0.1', 'localhost']).includes(readerUrl.hostname));
  const Password = z.string().length(48).regex(/^[0-9a-f]{48}$/);
  let ownerPassword: string;
  if (environment.BACKOFFICE_RUNTIME === 'docker') {
    ownerPassword = Password.parse(await readFile('/run/secrets/source_owner_password', 'utf8'));
  } else {
    const credentials: unknown = JSON.parse(await readFile('.local/postgres-credentials.json', 'utf8'));
    ownerPassword = z.object({ sourceOwner: Password }).parse(credentials).sourceOwner;
  }
  const ownerUrl = new URL(readerUrl);
  ownerUrl.username = 'odoo_seed';
  ownerUrl.password = ownerPassword;
  ownerUrl.search = '';
  readerUrl.search = '';
  const owner = new DataSource({ type: 'postgres', url: ownerUrl.toString(), entities: [], synchronize: false, logging: false,
    extra: { options: `-c search_path=${schema}`, statement_timeout: 15000 } });
  const reader = new DataSource({ type: 'postgres', url: readerUrl.toString(), entities: [], synchronize: false, logging: false,
    extra: { options: `-c search_path=${schema} -c default_transaction_read_only=on`, statement_timeout: 15000 } });
  let created = false;

  async function readSnapshot<T>(read: (snapshot: Odoo18Snapshot) => Promise<T>): Promise<T> {
    const runner = reader.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction('REPEATABLE READ');
      await runner.query('SET TRANSACTION READ ONLY');
      return await read(new Odoo18Snapshot(runner.manager));
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  }

  try {
    await owner.initialize();
    assert.equal((await rows(owner.manager, z.object({ name: z.literal('odoo_mock') }), 'SELECT current_database() AS name')).length, 1);
    // The validated random identifier belongs solely to this test. Public fixture tables remain untouched.
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    assert.deepEqual(await rows(owner.manager, z.object({ name: z.literal(schema) }), 'SELECT current_schema() AS name'), [{ name: schema }]);
    await owner.query(fixtureSql);
    await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO odoo_reader`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO odoo_reader`);
    await reader.initialize();

    await context.test('filters outgoing assigned pickings and all linked Magento orders, including cancelled moves', async () => {
      assert.deepEqual(await readSnapshot((snapshot) => snapshot.qualifyingIds()), [1, 2]);
      assert.equal(await readSnapshot((snapshot) => snapshot.picking(999)), null);
    });

    await context.test('missing source clocks remain unavailable and payload/evidence share one repeatable-read snapshot', async () => {
      await readSnapshot(async (snapshot) => {
        const before = await snapshot.readPicking(1);
        assert.ok(before.source);
        assert.equal(before.evidence.readComplete, true);
        assert.equal(revisionCoverage(before.evidence), 'unavailable');
        assert.ok(before.evidence.rows.every(({ writeDate }) => writeDate === null));
        await owner.query('UPDATE stock_move SET product_uom_qty=3 WHERE id=1001');
        try {
          const concurrent = await snapshot.readPicking(1);
          assert.deepEqual(concurrent, before, 'The metadata cannot observe a different revision than its source payload');
        } finally {
          await owner.query('UPDATE stock_move SET product_uom_qty=2 WHERE id=1001');
        }
      });
      const before = await readSnapshot((snapshot) => snapshot.readPicking(1));
      await owner.query('UPDATE res_partner SET street=$1 WHERE id=2', ['A source without revision metadata']);
      try {
        const changed = await readSnapshot((snapshot) => snapshot.readPicking(1));
        assert.equal(compareSourceEvidence(before.evidence, changed.evidence), 'unverified');
        assert.equal(revisionCoverage(changed.evidence), 'unavailable');
      } finally {
        await owner.query('UPDATE res_partner SET street=$1 WHERE id=2', [' Via Esempio 2 ']);
      }
    });

    await context.test('same SKU keeps distinct stock-move and order identities, source demand, UoM and descriptions', async () => {
      const result = await readSnapshot((snapshot) => snapshot.picking(1));
      assert.ok(result);
      assert.deepEqual(result.salesOrders, [{ id: 10, name: 'FIXTURE/SO/10' }, { id: 11, name: 'FIXTURE/SO/11' }]);
      assert.deepEqual(result.items.map((item) => ({ id: item.sourceLineId, order: item.saleOrderId,
        quantity: item.quantity, product: item.productId, sku: item.sku, uomId: item.uomId, uom: item.uom, description: item.description })), [
        { id: 1001, order: 10, quantity: 2, product: 1, sku: 'SAME-SKU', uomId: 1, uom: 'Unità', description: 'Table: first order configuration' },
        { id: 1002, order: 11, quantity: 1.5, product: 1, sku: 'SAME-SKU', uomId: 1, uom: 'Unità', description: 'Table: second order configuration' },
      ]);
      assert.equal(result.items[0]?.name, 'Fixture table');
      assert.equal(result.items[0]?.saleOrderLineId, 101);
      assert.equal(result.items[0]?.orderLinkBasis, 'sale_order_line');
      assert.equal(result.serviceType, null);
      assert.equal(result.estimatedMinutes, null);
      assert.equal(result.notes, null);
      assert.equal(result.items[0]?.configuration, null);
      assert.equal(result.items[0]?.ambient, null);
      assert.equal(result.items[0]?.photoUrl, null);
      assert.deepEqual(await readSnapshot((snapshot) => snapshot.picking(1)), result);
      assert.equal((await readSnapshot((snapshot) => snapshot.picking(2)))?.items[0]?.sourceLineId, 2001);
    });

    await context.test('shipping recipient and geography come from picking partner; country and translated team are resolved', async () => {
      assert.deepEqual((await readSnapshot((snapshot) => snapshot.picking(1)))?.customer, {
        id: 2, name: 'Fixture recipient', address: 'Via Esempio 2, Entrance B', city: 'Catania', country: 'IT',
        postalCode: '095121', province: 'CT', phones: [], email: null, contact: null, addressSource: 'picking',
      });
      const second = await readSnapshot((snapshot) => snapshot.picking(2));
      assert.equal(second?.salesTeam, 'MOHD CATANIA');
      assert.deepEqual(second?.customer.phones, ['+39090000001']);
      assert.equal(second?.customer.postalCode, '098121');
    });

    await context.test('missing order ownership or customer rejects the complete snapshot without guessing', async () => {
      try {
        await owner.query('UPDATE stock_move SET sale_line_id=NULL WHERE id=$1', [1002]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
      } finally {
        await owner.query('UPDATE stock_move SET sale_line_id=$1 WHERE id=$2', [102, 1002]);
      }
      try {
        await owner.query('UPDATE stock_picking SET partner_id=NULL WHERE id=$1', [1]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
      } finally {
        await owner.query('UPDATE stock_picking SET partner_id=$1 WHERE id=$2', [2, 1]);
      }
    });

    await context.test('an unlinked physical move resolves its order through an agreeing procurement group without inventing a sale line', async () => {
      try {
        await owner.query('UPDATE stock_move SET sale_line_id=NULL,group_id=$1,name=$2 WHERE id=$3', [2, 'Physical item added to the outgoing picking', 2001]);
        const result = await readSnapshot((snapshot) => snapshot.picking(2));
        assert.ok(result);
        assert.deepEqual(result.salesOrders, [{ id: 11, name: 'FIXTURE/SO/11' }]);
        assert.equal(result.items[0]?.sourceLineId, 2001);
        assert.equal(result.items[0]?.productId, 1);
        assert.equal(result.items[0]?.quantity, 3);
        assert.equal(result.items[0]?.saleOrderId, 11);
        assert.equal(result.items[0]?.saleOrderLineId, null);
        assert.equal(result.items[0]?.orderLinkBasis, 'procurement_group');
        assert.equal(result.items[0]?.description, 'Physical item added to the outgoing picking');
        assert.deepEqual(await readSnapshot((snapshot) => snapshot.qualifyingIds()), [1, 2]);
        await owner.query('UPDATE stock_picking SET partner_id=NULL WHERE id=$1', [2]);
        await owner.query('UPDATE stock_move SET partner_id=$1 WHERE id=$2', [2, 2001]);
        const recovered = await readSnapshot((snapshot) => snapshot.picking(2));
        assert.equal(recovered?.customer.id, 2);
        assert.equal(recovered?.customer.addressSource, 'move_order_shipping');
        assert.deepEqual(recovered?.customer.phones, []);
        assert.equal(recovered?.customer.email, null);
        assert.equal(recovered?.items[0]?.orderLinkBasis, 'procurement_group');
      } finally {
        await owner.query('UPDATE stock_move SET sale_line_id=$1,group_id=NULL,name=NULL,partner_id=NULL WHERE id=$2', [102, 2001]);
        await owner.query('UPDATE stock_picking SET partner_id=$1 WHERE id=$2', [1, 2]);
      }
    });

    await context.test('missing/conflicting groups and ambiguous mixed-order group fallback reject the picking; Magento groups remain excluded', async () => {
      try {
        await owner.query('UPDATE stock_move SET sale_line_id=NULL,group_id=$1 WHERE id=$2', [4, 2001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(2)), z.ZodError);
        await owner.query('UPDATE stock_move SET group_id=$1 WHERE id=$2', [1, 2001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(2)), z.ZodError);
        await owner.query('UPDATE stock_move SET group_id=$1 WHERE id=$2', [999, 2001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(2)), z.ZodError);
        await owner.query('UPDATE stock_move SET group_id=$1,sale_line_id=$2 WHERE id=$3', [2, 999, 2001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(2)), z.ZodError);
        await owner.query('UPDATE stock_move SET sale_line_id=NULL WHERE id=$1', [2001]);
        await owner.query('UPDATE stock_move SET group_id=$1 WHERE id=$2', [3, 2001]);
        assert.deepEqual(await readSnapshot((snapshot) => snapshot.qualifyingIds()), [1]);
        await owner.query('UPDATE stock_move SET group_id=$1 WHERE id=$2', [2, 2001]);
        await owner.query(`INSERT INTO stock_move(id,picking_id,product_id,sale_line_id,product_uom,product_uom_qty,quantity,state,group_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [2002, 2, 1, null, 1, 1, 0, 'cancel', 3]);
        assert.deepEqual(await readSnapshot((snapshot) => snapshot.qualifyingIds()), [1]);
        assert.equal((await readSnapshot((snapshot) => snapshot.picking(2)))?.items.length, 1);
        await owner.query('UPDATE stock_move SET sale_line_id=$1,state=$2,group_id=NULL WHERE id=$3', [101, 'assigned', 2002]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(2)), z.ZodError);
      } finally {
        await owner.query('DELETE FROM stock_move WHERE id=$1', [2002]);
        await owner.query('UPDATE stock_move SET sale_line_id=$1,group_id=NULL WHERE id=$2', [102, 2001]);
      }
    });

    await context.test('explicit line order remains authoritative for ordinary multi-order pickings', async () => {
      try {
        await owner.query('UPDATE stock_move SET group_id=$1 WHERE id=$2', [2, 1001]);
        const result = await readSnapshot((snapshot) => snapshot.picking(1));
        assert.deepEqual(result?.items.map((item) => [item.sourceLineId, item.saleOrderId, item.saleOrderLineId, item.orderLinkBasis]), [
          [1001, 10, 101, 'sale_order_line'], [1002, 11, 102, 'sale_order_line'],
        ]);
      } finally {
        await owner.query('UPDATE stock_move SET group_id=NULL WHERE id=$1', [1001]);
      }
    });

    await context.test('missing picking recipient requires unanimous move and order shipping addresses, including the primary order', async () => {
      try {
        await owner.query('UPDATE stock_picking SET partner_id=NULL WHERE id=$1', [1]);
        await owner.query('UPDATE stock_move SET partner_id=$1 WHERE id IN ($2,$3)', [2, 1001, 1002]);
        const recovered = await readSnapshot((snapshot) => snapshot.picking(1));
        assert.equal(recovered?.customer.id, 2);
        assert.equal(recovered?.customer.address, 'Via Esempio 2, Entrance B');
        assert.equal(recovered?.customer.addressSource, 'move_order_shipping');
        await owner.query('UPDATE stock_move SET partner_id=NULL WHERE id=$1', [1002]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE stock_move SET partner_id=$1 WHERE id=$2', [1, 1002]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE stock_move SET partner_id=$1 WHERE id=$2', [2, 1002]);
        await owner.query('UPDATE sale_order SET partner_shipping_id=NULL WHERE id=$1', [11]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE sale_order SET partner_shipping_id=$1 WHERE id=$2', [1, 11]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE sale_order SET partner_shipping_id=$1 WHERE id=$2', [2, 11]);
        await owner.query('UPDATE sale_order SET partner_shipping_id=$1 WHERE id=$2', [1, 10]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE sale_order SET partner_shipping_id=$1 WHERE id=$2', [2, 10]);
        await owner.query('UPDATE stock_picking SET partner_id=$1 WHERE id=$2', [999, 1]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
      } finally {
        await owner.query('UPDATE stock_picking SET partner_id=$1 WHERE id=$2', [2, 1]);
        await owner.query('UPDATE stock_move SET partner_id=NULL WHERE id IN ($1,$2)', [1001, 1002]);
        await owner.query('UPDATE sale_order SET partner_shipping_id=$1 WHERE id IN ($2,$3)', [2, 10, 11]);
      }
    });

    await context.test('unsupported precision and unresolved UoM reject instead of rounding or inventing units', async () => {
      try {
        await owner.query('UPDATE stock_move SET product_uom_qty=$1 WHERE id=$2', ['0.0001', 1001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
        await owner.query('UPDATE stock_move SET product_uom_qty=$1,product_uom=$2 WHERE id=$3', ['2.000000', 999, 1001]);
        await assert.rejects(readSnapshot((snapshot) => snapshot.picking(1)), z.ZodError);
      } finally {
        await owner.query('UPDATE stock_move SET product_uom_qty=$1,product_uom=$2 WHERE id=$3', ['2.000000', 1, 1001]);
      }
    });

    await context.test('source role cannot change data and transaction is explicitly read-only', async () => {
      const runner = reader.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction('REPEATABLE READ');
        await runner.query('SET TRANSACTION READ ONLY');
        await assertReadOnlyOdooRole(runner.manager);
        assert.deepEqual(await rows(runner.manager, z.object({ transaction_read_only: z.literal('on') }), 'SHOW transaction_read_only'), [{ transaction_read_only: 'on' }]);
        assert.deepEqual(await rows(runner.manager, z.object({ canWrite: z.literal(false) }),
          'SELECT has_table_privilege(current_user,$1,\'INSERT,UPDATE,DELETE,TRUNCATE\') AS "canWrite"', [`${schema}.stock_picking`]), [{ canWrite: false }]);
        await assert.rejects(runner.query('UPDATE stock_picking SET state=$1 WHERE id=$2', ['done', 1]),
          (error: unknown) => z.object({ code: z.literal('25006') }).safeParse(error).success);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
      assert.equal((await readSnapshot((snapshot) => snapshot.picking(1)))?.sourceState, 'assigned');
    });

    await context.test('source guard refuses an owner even inside a read-only transaction', async () => {
      const runner = owner.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction('REPEATABLE READ');
        await runner.query('SET TRANSACTION READ ONLY');
        await runner.query('SET LOCAL default_transaction_read_only=on');
        await assert.rejects(assertReadOnlyOdooRole(runner.manager), /unapproved write or administrative privileges/);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    });

    await context.test('keyset pages remain ordered and a complete scan above the safety limit fails explicitly', async () => {
      await owner.query(`INSERT INTO stock_picking(id,name,state,picking_type_id,location_dest_id,team_id,sale_id,partner_id)
        SELECT id,'FIXTURE/OUT/' || id,'assigned',1,1,1,10,1 FROM generate_series(1000,1101) id`);
      const pageIds = await readSnapshot((snapshot) => snapshot.qualifyingIds());
      assert.equal(pageIds.length, 104);
      assert.deepEqual(pageIds.slice(0, 3), [1, 2, 1000]);
      assert.equal(pageIds.at(-1), 1101);
      assert.equal(new Set(pageIds).size, 104);
      await owner.query(`INSERT INTO stock_picking(id,name,state,picking_type_id,location_dest_id,team_id,sale_id,partner_id)
        SELECT id,'FIXTURE/OUT/' || id,'assigned',1,1,1,10,1 FROM generate_series(1102,6000) id`);
      await assert.rejects(readSnapshot((snapshot) => snapshot.qualifyingIds()), /5000-picking limit/);
    });
  } finally {
    if (reader.isInitialized) await reader.destroy();
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (owner.isInitialized) await owner.destroy();
  }
});
