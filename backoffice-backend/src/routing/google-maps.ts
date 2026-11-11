import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { RoutePointCoordinates } from './contracts';
import { computeRoadRoute, GoogleMapsKeySchema, RoadRouteError } from './google-routes';
import { GoogleRequestBudget } from './google-http';

const settingsPath = resolve(process.cwd(), '.local/google-maps.json');
const requestsPerMinute = 30;
const simultaneousRequests = 2;

const GoogleMapsSettingsSchema = z.object({
  browserKey: GoogleMapsKeySchema,
  routesKey: GoogleMapsKeySchema,
  mapId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  // Geocoding is validated by its own provider so a bad optional key cannot disable Routes.
  geocodingKey: z.unknown().optional(),
}).strict().refine(({ browserKey, routesKey }) => browserKey !== routesKey);
type GoogleMapsSettings = z.infer<typeof GoogleMapsSettingsSchema>;

export function readLocalGoogleMapsSettings(): unknown {
  try {
    const value: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return value;
  } catch {
    return null;
  }
}

const googleRoadsOptions = Symbol('GoogleRoadsOptions');
type GoogleRoadsOptions = {
  settings: unknown;
  compute?: typeof computeRoadRoute;
  now?: () => number;
};

@Injectable()
export class GoogleRoads {
  private readonly settings: GoogleMapsSettings | null;
  private readonly computeRoute: typeof computeRoadRoute;
  private readonly budget: GoogleRequestBudget;

  constructor(@Optional() @Inject(googleRoadsOptions) options?: GoogleRoadsOptions) {
    const settings = GoogleMapsSettingsSchema.safeParse(options ? options.settings : readLocalGoogleMapsSettings());
    this.settings = settings.success ? settings.data : null;
    this.computeRoute = options?.compute ?? computeRoadRoute;
    this.budget = new GoogleRequestBudget(requestsPerMinute, simultaneousRequests, options?.now ?? (() => performance.now()));
  }

  get configured(): boolean {
    return this.settings !== null;
  }

  get browserConfig(): { key: string; mapId?: string } | null {
    if (!this.settings) return null;
    const { browserKey, mapId } = this.settings;
    return { key: browserKey, ...(mapId ? { mapId } : {}) };
  }

  async compute(points: readonly RoutePointCoordinates[], signal?: AbortSignal) {
    if (!this.settings) throw new RoadRouteError('not_configured');
    const release = this.budget.start();
    if (!release) throw new RoadRouteError('rate_limited');
    try {
      return await this.computeRoute(this.settings.routesKey, points, { signal });
    } finally {
      release();
    }
  }
}
