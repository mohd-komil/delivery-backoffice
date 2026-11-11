import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { GeoPointSchema, type SourceSnapshot } from '../domain/model';
import { GoogleRequestBudget, readBoundedGoogleJson } from './google-http';
import { readLocalGoogleMapsSettings } from './google-maps';
import { GoogleMapsKeySchema } from './google-routes';

const endpoint = 'https://geocode.googleapis.com/v4/geocode/address';
const fields = 'results.location,results.granularity,results.types';
const geocodingTimeoutMs = 8_000;
const maxResponseBytes = 64 * 1024;
const requestsPerMinute = 20;
const simultaneousRequests = 2;

type Destination = Pick<SourceSnapshot['customer'], 'address' | 'city' | 'country'>;

// These are public municipal sites. Only these literals, not the stored record, are sent to Google.
const publicDemoAddresses = [
  { address: 'Piazza della Scala, 2', city: 'Milano', postalCode: '20121', country: 'IT' },
  { address: 'Piazza Trento e Trieste', city: 'Monza', postalCode: '20900', country: 'IT' },
];

function comparisonText(text: string | null) {
  return text?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
}

function publicDemoAddress(destination: Destination) {
  const country = comparisonText(destination.country);
  if (!['it', 'italia', 'italy'].includes(country)) return undefined;
  return publicDemoAddresses.find((entry) =>
    comparisonText(entry.address) === comparisonText(destination.address)
    && comparisonText(entry.city) === comparisonText(destination.city));
}

const GeocodingKeySettingsSchema = z.object({
  geocodingKey: GoogleMapsKeySchema,
  browserKey: z.unknown().optional(),
  routesKey: z.unknown().optional(),
}).refine(({ geocodingKey, browserKey, routesKey }) => geocodingKey !== browserKey && geocodingKey !== routesKey);

const GeocodingResponseSchema = z.object({
  results: z.array(z.object({
    location: GeoPointSchema,
    granularity: z.string().max(64).optional(),
    types: z.array(z.string().max(96)).max(40).optional(),
  })).max(30).optional(),
}).strict();

const FoundSuggestionSchema = z.object({
  status: z.enum(['exact', 'approximate']),
  point: GeoPointSchema,
  source: z.enum(['google', 'source']),
});
const NoSuggestionSchema = z.object({
  status: z.enum(['ambiguous', 'not_found', 'unconfigured', 'unavailable', 'rate_limited', 'missing_address', 'outside_demo']),
  point: z.null(),
  source: z.null(),
});
export const GeocodeSuggestionSchema = z.discriminatedUnion('status', [FoundSuggestionSchema, NoSuggestionSchema]);
export type GeocodeSuggestion = z.infer<typeof GeocodeSuggestionSchema>;
type NoSuggestionStatus = z.infer<typeof NoSuggestionSchema>['status'];

export function noGeocodeSuggestion(status: NoSuggestionStatus): GeocodeSuggestion {
  return { status, point: null, source: null };
}

const googleGeocodingOptions = Symbol('GoogleGeocodingOptions');
type GoogleGeocodingOptions = {
  settings: unknown;
  fetch?: typeof fetch;
  now?: () => number;
};

@Injectable()
export class GoogleGeocoder {
  private readonly key: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly budget: GoogleRequestBudget;

  constructor(@Optional() @Inject(googleGeocodingOptions) options?: GoogleGeocodingOptions) {
    const settings = GeocodingKeySettingsSchema.safeParse(options ? options.settings : readLocalGoogleMapsSettings());
    this.key = settings.success ? settings.data.geocodingKey : undefined;
    this.fetch = options?.fetch ?? fetch;
    this.budget = new GoogleRequestBudget(requestsPerMinute, simultaneousRequests, options?.now ?? (() => performance.now()));
  }

  async suggest(destination: Destination): Promise<GeocodeSuggestion> {
    if (!destination.address?.trim()) return noGeocodeSuggestion('missing_address');
    if (!this.key) return noGeocodeSuggestion('unconfigured');
    const approved = publicDemoAddress(destination);
    if (!approved) return noGeocodeSuggestion('outside_demo');
    const release = this.budget.start();
    if (!release) return noGeocodeSuggestion('rate_limited');

    try {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        'address.addressLines': approved.address,
        'address.locality': approved.city,
        'address.postalCode': approved.postalCode,
        'address.regionCode': approved.country,
      }).toString();
      const response = await this.fetch(url, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fields },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(geocodingTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return noGeocodeSuggestion(response.status === 429 ? 'rate_limited' : 'unavailable');
      }
      const payload = GeocodingResponseSchema.safeParse(await readBoundedGoogleJson(response, maxResponseBytes));
      if (!payload.success) return noGeocodeSuggestion('unavailable');
      const candidates = payload.data.results ?? [];
      const [candidate] = candidates;
      if (!candidate) return noGeocodeSuggestion('not_found');
      if (candidates.length > 1) return noGeocodeSuggestion('ambiguous');
      const addressMatch = candidate.types?.some((type) => ['street_address', 'premise', 'subpremise'].includes(type));
      return {
        status: candidate.granularity === 'ROOFTOP' && addressMatch ? 'exact' : 'approximate',
        point: candidate.location,
        source: 'google',
      };
    } catch {
      return noGeocodeSuggestion('unavailable');
    } finally {
      release();
    }
  }
}
