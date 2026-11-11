import { proxyCrewRequest } from '@/_app/crew-api/proxy';

type Context = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxyCrewRequest(request, path);
}

export { forward as GET, forward as PATCH, forward as POST };
