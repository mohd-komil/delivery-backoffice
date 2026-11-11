import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationUrl, config, parseEnvironment } from '../src/config';

function environment(host = '127.0.0.1') {
  const url = (name: string) => `postgresql://demo:synthetic-password@${host}:55432/${name}`;
  return { DATABASE_URL: url('delivery_backoffice'), TEST_DATABASE_URL: url('delivery_backoffice_test'), ODOO_DATABASE_URL: url('odoo_mock') };
}

void test('host runtime defaults to loopback and preserves permitted localhost targets and custom API ports', () => {
  const defaultHost = parseEnvironment(environment());
  assert.equal(defaultHost.BACKOFFICE_RUNTIME, 'host');
  assert.equal(defaultHost.HOST, '127.0.0.1');
  assert.equal(defaultHost.PORT, 3001);
  assert.equal(defaultHost.FRONTEND_ORIGIN, 'http://127.0.0.1:3000');
  const localhost = parseEnvironment({ ...environment('localhost'), BACKOFFICE_RUNTIME: 'host', PORT: '3007', HOST: '0.0.0.0' });
  assert.equal(localhost.HOST, '127.0.0.1', 'An arbitrary HOST variable must not widen the host runtime listener');
  assert.equal(localhost.PORT, 3007);
});

void test('Docker runtime is explicit and permits only its literal database service with the fixed API listener', () => {
  const docker = { ...environment('db'), BACKOFFICE_RUNTIME: 'docker' };
  const parsed = parseEnvironment({ ...docker, PORT: '3001', HOST: 'remote.example', FRONTEND_ORIGIN: 'http://localhost:3000' });
  assert.equal(parsed.BACKOFFICE_RUNTIME, 'docker');
  assert.equal(parsed.HOST, '0.0.0.0');
  assert.equal(parsed.PORT, 3001);
  assert.equal(parsed.FRONTEND_ORIGIN, 'http://localhost:3000');
  assert.throws(() => parseEnvironment(environment('db')), 'Docker service discovery must not implicitly activate Docker mode');
  assert.throws(() => parseEnvironment({ ...docker, PORT: '3002' }));
  assert.throws(() => parseEnvironment({ ...environment(), BACKOFFICE_RUNTIME: 'docker' }));
  assert.throws(() => parseEnvironment({ ...docker, TEST_DATABASE_URL: environment().TEST_DATABASE_URL }), 'Mixed Docker/host targets must fail closed');
});

void test('unknown runtime modes and unapproved database destinations never fall back to a permissive mode', () => {
  for (const runtime of ['', 'production', 'Docker', 'container', true, 1]) {
    assert.throws(() => parseEnvironment({ ...environment(), BACKOFFICE_RUNTIME: runtime }));
  }
  for (const host of ['remote.example', '0.0.0.0', '[::1]', 'host.docker.internal', 'db.example', 'db.']) {
    assert.throws(() => parseEnvironment(environment(host)));
    assert.throws(() => parseEnvironment({ ...environment(host), BACKOFFICE_RUNTIME: 'docker' }));
  }
});

void test('both local modes reject swapped named databases, wrong ports/protocols and connection-option redirects', () => {
  for (const host of ['127.0.0.1', 'db']) {
    const base = { ...environment(host), BACKOFFICE_RUNTIME: host === 'db' ? 'docker' : 'host' };
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ODOO_DATABASE_URL'] as const) {
      for (const value of [
        `postgresql://demo:synthetic-password@${host}:55432/other_database`,
        base[key].replace(':55432/', ':5432/'),
        base[key].replace('postgresql:', 'postgres:'),
        `${base[key]}?host=remote.example`,
        `${base[key]}?port=5432`,
        `${base[key]}#ignored-target`,
        `${base[key]}/`,
        'not a URL',
      ]) assert.throws(() => parseEnvironment({ ...base, [key]: value }), `${host}/${key}`);
    }
    assert.throws(() => parseEnvironment({ ...base, DATABASE_URL: base.ODOO_DATABASE_URL }));
    assert.throws(() => parseEnvironment({ ...base, TEST_DATABASE_URL: base.DATABASE_URL }));
    assert.throws(() => parseEnvironment({ ...base, ODOO_DATABASE_URL: base.TEST_DATABASE_URL }));
  }
});

void test('Docker mode does not broaden frontend origins or accept malformed API ports', () => {
  const docker = { ...environment('db'), BACKOFFICE_RUNTIME: 'docker' };
  for (const origin of ['*', 'http://0.0.0.0:3000', 'http://frontend:3000', 'https://remote.example', 'http://127.0.0.1:3000/']) {
    assert.throws(() => parseEnvironment({ ...docker, FRONTEND_ORIGIN: origin }));
  }
  for (const port of ['', 'not-a-port', 0, 80, 65536, 3001.5]) assert.throws(() => parseEnvironment({ ...docker, PORT: port }));
});

void test('publication browser-demo origin is available only in explicit test mode and publication is default-off', () => {
  const base = environment();
  assert.equal(parseEnvironment(base).ROUTE_PUBLICATION_ENABLED, false);
  assert.throws(() => parseEnvironment({ ...base, FRONTEND_ORIGIN: 'http://127.0.0.1:3010' }));
  assert.equal(parseEnvironment({ ...base, FRONTEND_ORIGIN: 'http://127.0.0.1:3010', BACKOFFICE_TEST: '1' }).FRONTEND_ORIGIN, 'http://127.0.0.1:3010');
  assert.throws(() => parseEnvironment({ ...base, ROUTE_PUBLICATION_ENABLED: 'yes' }));
});

void test('owned PostgreSQL schema isolation options remain valid without allowing destination shadowing', () => {
  for (const host of ['127.0.0.1', 'db']) {
    const base = { ...environment(host), BACKOFFICE_RUNTIME: host === 'db' ? 'docker' : 'host' };
    const isolated = new URL(base.ODOO_DATABASE_URL);
    isolated.searchParams.set('options', '-c search_path=importer_source_owned_fixture');
    assert.equal(parseEnvironment({ ...base, ODOO_DATABASE_URL: isolated.toString() }).ODOO_DATABASE_URL, isolated.toString());
    for (const [key, value] of [['host', 'remote.example'], ['port', '5432'], ['database', 'another_database'], ['user', 'another_user']]) {
      const overridden = new URL(isolated);
      assert.ok(key !== undefined && value !== undefined);
      overridden.searchParams.set(key, value);
      assert.throws(() => parseEnvironment({ ...base, ODOO_DATABASE_URL: overridden.toString() }));
    }
    isolated.searchParams.append('options', '-c search_path=another_schema');
    assert.throws(() => parseEnvironment({ ...base, ODOO_DATABASE_URL: isolated.toString() }));
  }
});

void test('config/applicationUrl share the explicitly selected Docker runtime without changing NODE_ENV policy', { concurrency: false }, () => {
  const values = { ...environment('db'), BACKOFFICE_RUNTIME: 'docker', PORT: '3001', FRONTEND_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'production' };
  const originals = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    assert.equal(config().HOST, '0.0.0.0');
    assert.equal(applicationUrl(), values.DATABASE_URL);
    assert.equal(applicationUrl(true), values.TEST_DATABASE_URL);
    assert.equal(process.env['NODE_ENV'], 'production', 'Selecting local Docker routing must not turn off production scenario restrictions');
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
