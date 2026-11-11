import { z } from 'zod';
import { RoutePointCoordinatesSchema, type RoutePointCoordinates } from './contracts';
import { readBoundedGoogleJson } from './google-http';

export const MAX_GOOGLE_ROUTE_STOPS = 25;
const routeTimeoutMs = 8_000;
const maxRouteResponseBytes = 256 * 1024;
const maxLegSeconds = 7 * 24 * 60 * 60;
const endpoint = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const fields = 'routes.legs.duration,routes.polyline.encodedPolyline';

export const GoogleMapsKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const OrderedPointsSchema = z.array(RoutePointCoordinatesSchema.strip()).min(2).max(MAX_GOOGLE_ROUTE_STOPS + 2);
const RoutesResponseSchema = z.object({
  routes: z.array(z.object({
    legs: z.array(z.object({ duration: z.string().regex(/^\d{1,12}(?:\.\d{1,9})?s$/) })).max(MAX_GOOGLE_ROUTE_STOPS + 1),
    polyline: z.object({ encodedPolyline: z.string().min(1).max(maxRouteResponseBytes).regex(/^[?-~]+$/) }),
  })).max(1).optional(),
}).strict();

type RoadRouteFailure = 'invalid_input' | 'unsupported_waypoints' | 'unavailable' | 'no_route' | 'not_configured' | 'rate_limited';

export class RoadRouteError extends Error {
  constructor(readonly reason: RoadRouteFailure) {
    super('Google road routing could not be completed');
    this.name = 'RoadRouteError';
  }
}

function waypoint(point: RoutePointCoordinates) {
  return { location: { latLng: point } };
}

type RoadRouteOptions = { signal?: AbortSignal; fetch?: typeof fetch };

export async function computeRoadRoute(apiKey: string, points: readonly RoutePointCoordinates[], options: RoadRouteOptions = {}) {
  if (points.length > MAX_GOOGLE_ROUTE_STOPS + 2) throw new RoadRouteError('unsupported_waypoints');
  const coordinates = OrderedPointsSchema.safeParse(points);
  const key = GoogleMapsKeySchema.safeParse(apiKey);
  if (!coordinates.success || !key.success) throw new RoadRouteError('invalid_input');
  const origin = coordinates.data[0];
  const destination = coordinates.data.at(-1);
  if (!origin || !destination) throw new RoadRouteError('invalid_input');

  const timeout = AbortSignal.timeout(routeTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const request = options.fetch ?? fetch;
  let payload: unknown;
  try {
    signal.throwIfAborted();
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key.data,
        'X-Goog-FieldMask': fields,
      },
      body: JSON.stringify({
        origin: waypoint(origin),
        destination: waypoint(destination),
        intermediates: coordinates.data.slice(1, -1).map(waypoint),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        optimizeWaypointOrder: false,
        polylineEncoding: 'ENCODED_POLYLINE',
        polylineQuality: 'OVERVIEW',
      }),
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RoadRouteError('unavailable');
    }
    payload = await readBoundedGoogleJson(response, maxRouteResponseBytes);
  } catch {
    // Provider errors can contain request details. Do not return or log them.
    throw new RoadRouteError('unavailable');
  }
  const result = RoutesResponseSchema.safeParse(payload);
  if (!result.success) throw new RoadRouteError('unavailable');
  const route = result.data.routes?.[0];
  if (!route) throw new RoadRouteError('no_route');
  if (route.legs.length !== coordinates.data.length - 1) throw new RoadRouteError('unavailable');
  const legSeconds = route.legs.map(({ duration }) => Number(duration.slice(0, -1)));
  if (legSeconds.some((seconds) => seconds > maxLegSeconds)) throw new RoadRouteError('unavailable');
  return { legSeconds, encodedPolyline: route.polyline.encodedPolyline };
}
