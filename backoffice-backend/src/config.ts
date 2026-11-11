import 'dotenv/config';
import { z } from 'zod';

const Environment = z.object({
  BACKOFFICE_RUNTIME: z.enum(['host', 'docker']).default('host'),
  BACKOFFICE_TEST: z.enum(['0', '1']).default('0'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url(),
  ODOO_DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  ROUTE_PUBLICATION_ENABLED: z.enum(['false', 'true']).default('false').transform((value) => value === 'true'),
  FRONTEND_ORIGIN: z.enum(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:3010', 'http://localhost:3010']).default('http://127.0.0.1:3000'),
  CREW_FRONTEND_ORIGIN: z.enum([
    'http://127.0.0.1:3002', 'http://localhost:3002',
    'https://127.0.0.1:3002', 'https://localhost:3002',
    'http://127.0.0.1:3012', 'http://localhost:3012',
  ]).default('http://127.0.0.1:3002'),
}).superRefine((environment, context) => {
  if (environment.FRONTEND_ORIGIN.endsWith(':3010') && environment.BACKOFFICE_TEST !== '1') {
    context.addIssue({ code: 'custom', path: ['FRONTEND_ORIGIN'], message: 'The publication browser-demo origin requires the isolated test runtime' });
  }
  if (environment.CREW_FRONTEND_ORIGIN.endsWith(':3012') && environment.BACKOFFICE_TEST !== '1') {
    context.addIssue({ code: 'custom', path: ['CREW_FRONTEND_ORIGIN'], message: 'The route Crew browser-demo origin requires the isolated test runtime' });
  }
  const targets = [
    ['DATABASE_URL', environment.DATABASE_URL, '/delivery_backoffice'],
    ['TEST_DATABASE_URL', environment.TEST_DATABASE_URL, '/delivery_backoffice_test'],
    ['ODOO_DATABASE_URL', environment.ODOO_DATABASE_URL, '/odoo_mock'],
  ] as const;
  for (const [key, value, pathname] of targets) {
    let url: URL;
    try { url = new URL(value); } catch { continue; } // The URL field already reports malformed input.
    const allowedHost = environment.BACKOFFICE_RUNTIME === 'docker' ? url.hostname === 'db' : ['127.0.0.1', 'localhost'].includes(url.hostname);
    // Preserve the source-test search_path option without accepting pg query keys that override the destination.
    const allowedOptions = [...url.searchParams.keys()].every((option) => option === 'options') && url.searchParams.getAll('options').length <= 1;
    if (url.protocol !== 'postgresql:' || !allowedHost || url.port !== '55432' || url.pathname !== pathname || !allowedOptions || url.hash !== '') {
      context.addIssue({ code: 'custom', path: [key], message: 'Use the named isolated database on port 55432 and the host permitted by BACKOFFICE_RUNTIME, without URL destination overrides' });
    }
  }
  if (environment.BACKOFFICE_RUNTIME === 'docker' && environment.PORT !== 3001) {
    context.addIssue({ code: 'custom', path: ['PORT'], message: 'Docker local mode requires API port 3001' });
  }
}).transform((environment) => ({ ...environment, HOST: environment.BACKOFFICE_RUNTIME === 'docker' ? '0.0.0.0' : '127.0.0.1' }));

/** Validates local runtime targets without connecting or performing startup side effects. */
export function parseEnvironment(input: unknown) { return Environment.parse(input); }
export function config() { return parseEnvironment(process.env); }
export function applicationUrl(test = false) {
  const environment = config();
  const value = test ? environment.TEST_DATABASE_URL : environment.DATABASE_URL;
  const expected = test ? '/delivery_backoffice_test' : '/delivery_backoffice';
  if (new URL(value).pathname !== expected) throw new Error('Wrong application database target');
  return value;
}
