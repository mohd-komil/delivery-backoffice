import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationUrl, config, parseEnvironment } from '../src/config';

function environment(host = '127.0.0.1') {
  const url = (name: string) => `postgresql://demo:synthetic-password@${host}:55432/${name}`;
  return { DATABASE_URL: url('delivery_backoffice'), TEST_DATABASE_URL: url('delivery_backoffice_test'), ODOO_DATABASE_URL: url('odoo_mock') };
}

function odooEnvironment(host = 'source.example.test', database = 'customer_snapshot') {
  return {
    ...environment(),
    ODOO_SOURCE_MODE: 'odoo18',
    ODOO_SOURCE_INSTANCE: 'customer-test-202611',
    ODOO_SOURCE_ALLOWED_ENDPOINT: `postgresql://${host}:15433/${database}`,
    ODOO_SOURCE_USER: 'source_reader',
    ODOO_DATABASE_URL: `postgresql://source_reader:synthetic-password@${host}:15433/${database}`,
  };
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
  assert.throws(() => parseEnvironment({ ...base, CREW_FRONTEND_ORIGIN: 'http://127.0.0.1:3012' }));
  assert.equal(parseEnvironment({ ...base, CREW_FRONTEND_ORIGIN: 'http://127.0.0.1:3012', BACKOFFICE_TEST: '1' }).CREW_FRONTEND_ORIGIN, 'http://127.0.0.1:3012');
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

void test('Odoo 18 is explicitly selected and scoped to a separate source identity, destination and reader', () => {
  const defaults = parseEnvironment(environment());
  assert.equal(defaults.ODOO_SOURCE_MODE, 'mock');
  assert.equal(defaults.ODOO_SOURCE_INSTANCE, 'odoo_mock');
  const source = odooEnvironment();
  const parsed = parseEnvironment(source);
  assert.equal(parsed.ODOO_SOURCE_INSTANCE, 'customer-test-202611');
  assert.equal(parsed.ODOO_SOURCE_TRANSPORT, 'tls');
  assert.equal(parsed.ODOO_SOURCE_CA_FILE, undefined);
  assert.equal(parseEnvironment({ ...source, ODOO_SOURCE_CA_FILE: 'C:/certificates/test-source-ca.pem' }).ODOO_SOURCE_CA_FILE, 'C:/certificates/test-source-ca.pem');
  for (const key of ['ODOO_SOURCE_MODE', 'ODOO_SOURCE_INSTANCE', 'ODOO_SOURCE_ALLOWED_ENDPOINT', 'ODOO_SOURCE_USER'] as const) {
    assert.throws(() => parseEnvironment({ ...source, [key]: undefined }), `Missing ${key} must not implicitly enable an external source`);
    assert.throws(() => parseEnvironment({ ...source, [key]: '' }));
  }
  for (const mode of ['production', 'odoo', 'ODOO18', true]) assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_MODE: mode }));
  for (const instance of ['odoo_mock', 'source/one', ' source ', '../source', 'a'.repeat(81)]) assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_INSTANCE: instance }));
  assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_USER: 'other_reader' }));
  assert.throws(() => parseEnvironment({ ...source, ODOO_DATABASE_URL: source.ODOO_DATABASE_URL.replace(':synthetic-password', '') }));
  assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_CA_FILE: ' ' }));
});

void test('Odoo 18 rejects source redirects and malformed or credential-bearing endpoint approvals', () => {
  const source = odooEnvironment();
  for (const url of [
    source.ODOO_DATABASE_URL.replace('source.example.test', 'another.example.test'),
    source.ODOO_DATABASE_URL.replace(':15433/', ':15434/'),
    source.ODOO_DATABASE_URL.replace('/customer_snapshot', '/another_snapshot'),
    source.ODOO_DATABASE_URL.replace('postgresql:', 'postgres:'),
    `${source.ODOO_DATABASE_URL}?host=another.example.test`,
    `${source.ODOO_DATABASE_URL}?options=-c%20search_path=another_schema`,
    `${source.ODOO_DATABASE_URL}?sslmode=disable`,
    `${source.ODOO_DATABASE_URL}#fragment`,
    `${source.ODOO_DATABASE_URL}?`,
    `${source.ODOO_DATABASE_URL}#`,
  ]) assert.throws(() => parseEnvironment({ ...source, ODOO_DATABASE_URL: url }), url);
  for (const endpoint of [
    source.ODOO_DATABASE_URL,
    'postgresql://reader@source.example.test:15433/customer_snapshot',
    'postgresql://source.example.test/customer_snapshot',
    'postgresql://source.example.test:0/customer_snapshot',
    'postgresql://source.example.test:15433/',
    'postgresql://source.example.test:15433/customer_snapshot/other',
    'postgresql://source.example.test:15433/customer%2Fsnapshot',
    'postgresql://source.example.test:15433/customer_snapshot?sslmode=disable',
    'postgresql://source.example.test:15433/customer_snapshot#fragment',
    'postgresql://source.example.test:15433/customer_snapshot?',
    'postgresql://source.example.test:15433/customer_snapshot#',
    'postgresql://@source.example.test:15433/customer_snapshot',
  ]) assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_ALLOWED_ENDPOINT: endpoint }));
});

void test('the source opt-in cannot redirect application/test databases or use reserved database names', () => {
  const source = odooEnvironment();
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL'] as const) {
    assert.throws(() => parseEnvironment({ ...source, [key]: source.ODOO_DATABASE_URL }));
    assert.throws(() => parseEnvironment({ ...source, [key]: source[key].replace(':55432/', ':5432/') }));
    assert.throws(() => parseEnvironment({ ...source, [key]: `${source[key]}?host=source.example.test` }));
  }
  for (const name of ['delivery_backoffice', 'delivery_backoffice_test', 'odoo_mock']) {
    assert.throws(() => parseEnvironment(odooEnvironment('source.example.test', name)));
  }
  const docker = parseEnvironment({ ...source, ...environment('db'), ODOO_DATABASE_URL: source.ODOO_DATABASE_URL, BACKOFFICE_RUNTIME: 'docker' });
  assert.equal(docker.HOST, '0.0.0.0');
  assert.equal(docker.DATABASE_URL, environment('db').DATABASE_URL);
  assert.equal(docker.ODOO_DATABASE_URL, source.ODOO_DATABASE_URL);
});

void test('internal LAN transport requires explicit selection and an exact private destination', () => {
  for (const host of ['source.example.local', 'SOURCE.local', '10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.2']) {
    const source = odooEnvironment(host);
    assert.equal(parseEnvironment(source).ODOO_SOURCE_TRANSPORT, 'tls', 'LAN hostnames must not silently disable TLS');
    assert.equal(parseEnvironment({ ...source, ODOO_SOURCE_TRANSPORT: 'internal-lan' }).ODOO_SOURCE_TRANSPORT, 'internal-lan');
    assert.throws(() => parseEnvironment({ ...source, ODOO_SOURCE_TRANSPORT: 'internal-lan', ODOO_SOURCE_CA_FILE: '/certs/source-ca.pem' }));
  }
  for (const host of ['source.example.test', 'localhost', 'db', 'host.docker.internal', 'local', 'source.local.example', 'source.local.', '127.0.0.1', '169.254.169.254', '172.15.1.1', '172.32.1.1', '192.169.1.1', '8.8.8.8', '10.0.0.999', '[::1]', '[fd00::1]']) {
    assert.throws(() => parseEnvironment({ ...odooEnvironment(host), ODOO_SOURCE_TRANSPORT: 'internal-lan' }), host);
  }
  for (const transport of ['false', 'disable', '', 'production', true]) assert.throws(() => parseEnvironment({ ...odooEnvironment(), ODOO_SOURCE_TRANSPORT: transport }));
});

void test('mock mode cannot accidentally accept partial external-source settings', () => {
  const external = odooEnvironment();
  for (const key of ['ODOO_SOURCE_INSTANCE', 'ODOO_SOURCE_ALLOWED_ENDPOINT', 'ODOO_SOURCE_USER'] as const) {
    assert.throws(() => parseEnvironment({ ...environment(), [key]: external[key] }));
  }
  assert.throws(() => parseEnvironment({ ...environment(), ODOO_SOURCE_TRANSPORT: 'internal-lan' }));
  assert.throws(() => parseEnvironment({ ...environment(), ODOO_SOURCE_CA_FILE: '/certs/source-ca.pem' }));
});

void test('separate integration UI origins are exact loopback origins available only in Odoo 18 mode', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const frontend = `http://${host}:3030`;
    const crew = `http://${host}:3032`;
    const parsed = parseEnvironment({ ...odooEnvironment(), FRONTEND_ORIGIN: frontend, CREW_FRONTEND_ORIGIN: crew });
    assert.equal(parsed.FRONTEND_ORIGIN, frontend);
    assert.equal(parsed.CREW_FRONTEND_ORIGIN, crew);
    assert.throws(() => parseEnvironment({ ...environment(), FRONTEND_ORIGIN: frontend, BACKOFFICE_TEST: '1' }));
    assert.throws(() => parseEnvironment({ ...environment(), CREW_FRONTEND_ORIGIN: crew, BACKOFFICE_TEST: '1' }));
  }
  for (const origin of ['http://remote.example:3030', 'http://127.0.0.1:3030/', 'http://127.0.0.1:3032', '*']) assert.throws(() => parseEnvironment({ ...odooEnvironment(), FRONTEND_ORIGIN: origin }));
  assert.throws(() => parseEnvironment({ ...odooEnvironment(), CREW_FRONTEND_ORIGIN: 'http://remote.example:3032' }));
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
