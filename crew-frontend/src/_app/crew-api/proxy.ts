import { z } from 'zod';

const authCookie = 'crew_session';
const noStore = { 'Cache-Control': 'private, no-store' };
const backendOrigin = z.enum(['http://127.0.0.1:3001', 'http://localhost:3001']);
const commandBodyLimit = 4096;
const attemptFailureBodyLimit = 16 * 1024; // Allow a 2,000-character reason with JSON escapes.
const finishBodyLimit = 32 * 1024 * 1024; // Base64 for 20 MiB of photos, plus line notes and signatures.
const issueBodyLimit = 7 * 1024 * 1024; // A 5 MiB photo encoded as base64 plus report fields.
const documentTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/plain']);

type CrewEndpoint = { path: string; bodyLimit?: number; document?: true };

function problem(status: number, message: string): Response {
  return Response.json({ statusCode: status, message }, { status, headers: noStore });
}

function endpoint(method: string, segments: string[]): CrewEndpoint | undefined {
  const [resource, key, action, item] = segments;
  if (resource === 'auth' && segments.length === 2) {
    if (method === 'GET' && key === 'me') return { path: '/api/crew/auth/me' };
    if (method === 'POST' && (key === 'login' || key === 'logout')) {
      return { path: `/api/crew/auth/${key}`, bodyLimit: commandBodyLimit };
    }
  }
  if (resource !== 'visits') return undefined;
  if (method === 'GET' && segments.length === 1) return { path: '/api/crew/visits' };
  if (!z.uuid().safeParse(key).success) return undefined;

  const visit = `/api/crew/visits/${key}`;
  if (method === 'GET' && segments.length === 2) return { path: visit };
  if (method === 'GET' && segments.length === 4 && action === 'documents' && z.uuid().safeParse(item).success) {
    return { path: `${visit}/documents/${item}`, document: true };
  }
  if (method === 'POST' && segments.length === 3) {
    if (action === 'start') return { path: `${visit}/start`, bodyLimit: commandBodyLimit };
    if (action === 'attempt-failure') return { path: `${visit}/attempt-failure`, bodyLimit: attemptFailureBodyLimit };
    if (action === 'finish') return { path: `${visit}/finish`, bodyLimit: finishBodyLimit };
    if (action === 'issues') return { path: `${visit}/issues`, bodyLimit: issueBodyLimit };
  }
  if (method === 'PATCH' && segments.length === 4 && action === 'checklist' && z.uuid().safeParse(item).success) {
    return { path: `${visit}/checklist/${item}`, bodyLimit: commandBodyLimit };
  }
  return undefined;
}

async function readJsonBody(request: Request, maxBodyBytes: number): Promise<string | Response> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return problem(415, 'JSON is required.');
  if (Number(request.headers.get('content-length')) > maxBodyBytes) return problem(413, 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) return problem(400, 'A JSON body is required.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        return problem(413, 'Request body is too large.');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return problem(400, 'The request body could not be read.');
  } finally {
    reader.releaseLock();
  }
}

export async function proxyCrewRequest(request: Request, segments: string[]): Promise<Response> {
  const target = endpoint(request.method, segments);
  if (!target) return problem(404, 'Crew endpoint not found.');
  const base = backendOrigin.safeParse(process.env.CREW_API_ORIGIN ?? 'http://127.0.0.1:3001');
  if (!base.success) return problem(503, 'Crew API is unavailable.');

  const headers = new Headers({ Accept: target.document ? '*/*' : 'application/json' });
  const origin = request.headers.get('origin');
  if (origin) headers.set('Origin', origin);
  const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${authCookie}=`));
  if (cookie) headers.set('Cookie', cookie);

  let body: string | undefined;
  if (target.bodyLimit !== undefined) {
    const read = await readJsonBody(request, target.bodyLimit);
    if (read instanceof Response) return read;
    body = read;
    headers.set('Content-Type', 'application/json');
  }

  try {
    const result = await fetch(new URL(target.path, base.data), {
      method: request.method, headers, body, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const outgoing = new Headers(noStore);
    const contentType = result.headers.get('content-type');
    if (contentType) outgoing.set('Content-Type', contentType);
    if (target.document) {
      const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
      outgoing.set('X-Content-Type-Options', 'nosniff');
      outgoing.set('Cross-Origin-Resource-Policy', 'same-origin');
      if (result.ok) {
        if (!mediaType || !documentTypes.has(mediaType)) return problem(502, 'Unsupported document type.');
        const disposition = result.headers.get('content-disposition');
        outgoing.set('Content-Disposition', disposition?.startsWith('attachment;') ? disposition : 'attachment');
      } else if (mediaType !== 'application/json') return problem(result.status, 'Document unavailable.');
    }
    const retryAfter = result.headers.get('retry-after');
    if (retryAfter) outgoing.set('Retry-After', retryAfter);
    for (const value of result.headers.getSetCookie()) {
      if (value.startsWith(`${authCookie}=`)) outgoing.append('Set-Cookie', value);
    }
    return new Response(result.body, { status: result.status, headers: outgoing });
  } catch {
    return problem(502, 'Crew API could not be reached.');
  }
}
