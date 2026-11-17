import 'dotenv/config';
import { isIP } from 'node:net';
import { z } from 'zod';

function isInternalLanHost(hostname: string) {
  if (isIP(hostname) === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  return hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(hostname);
}

function parseUrl(value: string) {
  try { return new URL(value); } catch { return undefined; }
}

const Environment = z.object({
  BACKOFFICE_RUNTIME: z.enum(['host', 'docker']).default('host'),
  BACKOFFICE_TEST: z.enum(['0', '1']).default('0'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url(),
  ODOO_DATABASE_URL: z.string().url(),
  ODOO_SOURCE_MODE: z.enum(['mock', 'odoo18']).default('mock'),
  ODOO_SOURCE_INSTANCE: z.string().regex(/^[a-z][a-z0-9_-]{2,79}$/).default('odoo_mock'),
  ODOO_SOURCE_ALLOWED_ENDPOINT: z.string().url().optional(),
  ODOO_SOURCE_USER: z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_$-]*$/).optional(),
  ODOO_SOURCE_TRANSPORT: z.enum(['tls', 'internal-lan']).default('tls'),
  ODOO_SOURCE_CA_FILE: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  ROUTE_PUBLICATION_ENABLED: z.enum(['false', 'true']).default('false').transform((value) => value === 'true'),
  FRONTEND_ORIGIN: z.enum([
    'http://127.0.0.1:3000', 'http://localhost:3000',
    'http://127.0.0.1:3010', 'http://localhost:3010',
    'http://127.0.0.1:3030', 'http://localhost:3030',
  ]).default('http://127.0.0.1:3000'),
  CREW_FRONTEND_ORIGIN: z.enum([
    'http://127.0.0.1:3002', 'http://localhost:3002',
    'https://127.0.0.1:3002', 'https://localhost:3002',
    'http://127.0.0.1:3012', 'http://localhost:3012',
    'http://127.0.0.1:3032', 'http://localhost:3032',
  ]).default('http://127.0.0.1:3002'),
}).superRefine((environment, context) => {
  if (environment.FRONTEND_ORIGIN.endsWith(':3010') && environment.BACKOFFICE_TEST !== '1') {
    context.addIssue({ code: 'custom', path: ['FRONTEND_ORIGIN'], message: 'The publication browser-demo origin requires the isolated test runtime' });
  }
  if (environment.CREW_FRONTEND_ORIGIN.endsWith(':3012') && environment.BACKOFFICE_TEST !== '1') {
    context.addIssue({ code: 'custom', path: ['CREW_FRONTEND_ORIGIN'], message: 'The route Crew browser-demo origin requires the isolated test runtime' });
  }
  for (const [key, port] of [['FRONTEND_ORIGIN', ':3030'], ['CREW_FRONTEND_ORIGIN', ':3032']] as const) {
    if (environment[key].endsWith(port) && environment.ODOO_SOURCE_MODE !== 'odoo18') {
      context.addIssue({ code: 'custom', path: [key], message: 'The source integration browser origin requires explicit Odoo 18 mode' });
    }
  }
  const targets = [
    ['DATABASE_URL', environment.DATABASE_URL, '/delivery_backoffice'],
    ['TEST_DATABASE_URL', environment.TEST_DATABASE_URL, '/delivery_backoffice_test'],
    ['ODOO_DATABASE_URL', environment.ODOO_DATABASE_URL, '/odoo_mock'],
  ] as const;
  for (const [key, value, pathname] of targets) {
    if (key === 'ODOO_DATABASE_URL' && environment.ODOO_SOURCE_MODE === 'odoo18') continue;
    let url: URL;
    try { url = new URL(value); } catch { continue; } // The URL field already reports malformed input.
    const allowedHost = environment.BACKOFFICE_RUNTIME === 'docker' ? url.hostname === 'db' : ['127.0.0.1', 'localhost'].includes(url.hostname);
    // Preserve the source-test search_path option without accepting pg query keys that override the destination.
    const allowedOptions = [...url.searchParams.keys()].every((option) => option === 'options') && url.searchParams.getAll('options').length <= 1;
    if (url.protocol !== 'postgresql:' || !allowedHost || url.port !== '55432' || url.pathname !== pathname || !allowedOptions || url.hash !== '') {
      context.addIssue({ code: 'custom', path: [key], message: 'Use the named isolated database on port 55432 and the host permitted by BACKOFFICE_RUNTIME, without URL destination overrides' });
    }
  }
  if (environment.ODOO_SOURCE_MODE === 'mock') {
    if (environment.ODOO_SOURCE_INSTANCE !== 'odoo_mock') {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_INSTANCE'], message: 'Mock mode uses the existing odoo_mock source identity' });
    }
    if (environment.ODOO_SOURCE_ALLOWED_ENDPOINT !== undefined || environment.ODOO_SOURCE_USER !== undefined || environment.ODOO_SOURCE_CA_FILE !== undefined || environment.ODOO_SOURCE_TRANSPORT !== 'tls') {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_MODE'], message: 'External source settings require explicit Odoo 18 mode' });
    }
  } else {
    if (environment.ODOO_SOURCE_INSTANCE === 'odoo_mock') {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_INSTANCE'], message: 'Odoo 18 requires a stable source identity distinct from odoo_mock' });
    }
    const endpoint = environment.ODOO_SOURCE_ALLOWED_ENDPOINT === undefined ? undefined : parseUrl(environment.ODOO_SOURCE_ALLOWED_ENDPOINT);
    const source = parseUrl(environment.ODOO_DATABASE_URL);
    const endpointHostValid = endpoint !== undefined && (isIP(endpoint.hostname) !== 0 || (endpoint.hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(endpoint.hostname)));
    if (endpoint === undefined || endpoint.toString() !== environment.ODOO_SOURCE_ALLOWED_ENDPOINT || endpoint.protocol !== 'postgresql:' || !endpointHostValid || endpoint.port === '' || Number(endpoint.port) < 1 || !/^\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$/.test(endpoint.pathname) || /[@?#]/.test(environment.ODOO_SOURCE_ALLOWED_ENDPOINT ?? '')) {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_ALLOWED_ENDPOINT'], message: 'Provide the exact approved postgresql://hostname:port/database endpoint without credentials, query or fragment' });
    }
    if (environment.ODOO_SOURCE_USER === undefined) {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_USER'], message: 'Explicitly identify the approved read-only source user' });
    }
    if (source !== undefined) {
      if (endpoint === undefined || source.toString() !== environment.ODOO_DATABASE_URL || source.protocol !== endpoint.protocol || source.hostname !== endpoint.hostname || source.port !== endpoint.port || source.pathname !== endpoint.pathname || /[?#]/.test(environment.ODOO_DATABASE_URL)) {
        context.addIssue({ code: 'custom', path: ['ODOO_DATABASE_URL'], message: 'The source must match the approved endpoint exactly, without URL options or fragments' });
      }
      if (source.username !== environment.ODOO_SOURCE_USER || source.password === '') {
        context.addIssue({ code: 'custom', path: ['ODOO_DATABASE_URL'], message: 'The source must use the explicitly approved reader and a password' });
      }
      if (['/delivery_backoffice', '/delivery_backoffice_test', '/odoo_mock'].includes(source.pathname)) {
        context.addIssue({ code: 'custom', path: ['ODOO_DATABASE_URL'], message: 'Odoo 18 cannot target a local application, test or mock database' });
      }
      if (environment.ODOO_SOURCE_TRANSPORT === 'internal-lan' && !isInternalLanHost(source.hostname)) {
        context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_TRANSPORT'], message: 'Explicit internal LAN transport is limited to RFC1918 IPv4 addresses or .local hostnames' });
      }
    }
    if (environment.ODOO_SOURCE_TRANSPORT === 'internal-lan' && environment.ODOO_SOURCE_CA_FILE !== undefined) {
      context.addIssue({ code: 'custom', path: ['ODOO_SOURCE_CA_FILE'], message: 'A CA file applies only to verified TLS transport' });
    }
  }
  if (environment.BACKOFFICE_RUNTIME === 'docker' && environment.PORT !== 3001) {
    context.addIssue({ code: 'custom', path: ['PORT'], message: 'Docker local mode requires API port 3001' });
  }
}).transform((environment) => ({ ...environment, HOST: environment.BACKOFFICE_RUNTIME === 'docker' ? '0.0.0.0' : '127.0.0.1' }));

/** Validates isolated application targets and an explicitly approved source without connecting. */
export function parseEnvironment(input: unknown) { return Environment.parse(input); }
export function config() { return parseEnvironment(process.env); }
export function applicationUrl(test = false) {
  const environment = config();
  const value = test ? environment.TEST_DATABASE_URL : environment.DATABASE_URL;
  const expected = test ? '/delivery_backoffice_test' : '/delivery_backoffice';
  if (new URL(value).pathname !== expected) throw new Error('Wrong application database target');
  return value;
}
