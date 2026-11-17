import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { GeoPointSchema, type SourceSnapshot } from '../domain/model';
import { GeoapifyPrecisionSchema, type GeoapifyCandidate } from './geocoding-contracts';
import { readBoundedGoogleJson } from './google-http';
export { GeoapifyCandidateSchema, type GeoapifyCandidate } from './geocoding-contracts';

const endpoint = 'https://api.geoapify.com/v1/geocode/search';
const defaultDailyLimit = 100;
const highConfidence = 0.95;
const timeoutMs = 8_000;
const maxResponseBytes = 256 * 1024;
const maxSettingsBytes = 4096;

const SettingsSchema = z.object({
  apiKey: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
  dailyLimit: z.number().int().min(1).max(2900).default(defaultDailyLimit),
}).strict();

const ConfidenceSchema = z.number().min(0).max(1);

export type GeoapifyDestination = Pick<SourceSnapshot['customer'], 'address' | 'city' | 'country' | 'postalCode' | 'province'>;
export type GeoapifyLookupResult = {
  status: 'accepted' | 'review_required' | 'not_found' | 'failed';
  reason: string | null;
  candidate: GeoapifyCandidate | null;
};

const ResultSchema = z.object({
  lat: GeoPointSchema.shape.latitude,
  lon: GeoPointSchema.shape.longitude,
  formatted: z.string().trim().min(1).max(2000),
  result_type: GeoapifyPrecisionSchema.optional(),
  country_code: z.string().max(10).optional(),
  postcode: z.string().max(40).optional(),
  city: z.string().max(200).optional(),
  housenumber: z.string().max(80).optional(),
  rank: z.object({
    confidence: ConfidenceSchema.optional(),
    confidence_city_level: ConfidenceSchema.optional(),
    confidence_street_level: ConfidenceSchema.optional(),
    confidence_building_level: ConfidenceSchema.optional(),
    match_type: z.string().max(80).optional(),
  }).optional(),
  datasource: z.object({
    attribution: z.string().max(800).optional(),
    license: z.string().max(300).optional(),
    url: z.string().max(500).optional(),
  }).optional(),
});
const ResponseSchema = z.object({ results: z.array(ResultSchema).max(10) });
type ProviderResult = z.infer<typeof ResultSchema>;

function comparisonText(value: string | null | undefined): string {
  return value?.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ?? '';
}

function countryCode(value: string | null): string | null {
  const country = value?.trim().toLowerCase();
  if (country === 'italy' || country === 'italia') return 'it';
  return country && /^[a-z]{2}$/.test(country) ? country : null;
}

/** Missing and known synthetic addresses must never consume a provider request. */
export function geoapifyAddressProblem(destination: GeoapifyDestination): 'missing_address' | 'placeholder_address' | null {
  const { address, city, country } = destination;
  if (!address?.trim() || !city?.trim() || !country?.trim()) return 'missing_address';
  if (/\bstreet\s*example\b|\bvia\s*dimostrativa\b|\bdemo\b/i.test(address)) return 'placeholder_address';
  return null;
}

function houseNumber(address: string | null): string | null {
  if (!address) return null;
  // Only unambiguous end/start numbers are eligible for automatic acceptance.
  // Unusual civic numbers remain available for the dispatcher's review.
  const suffix = address.match(/(?:^|[\s,])(\d+[a-z]?(?:\s*[/\-]\s*[a-z0-9]+)?)\s*$/i)?.[1];
  const prefix = address.match(/^\s*(\d+[a-z]?(?:\s*[/\-]\s*[a-z0-9]+)?)\s+\p{L}/iu)?.[1];
  return suffix ?? prefix ?? null;
}

function houseComparison(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, '') ?? '';
}

function candidate(result: ProviderResult): GeoapifyCandidate {
  const source = result.datasource;
  const attribution = ['Powered by Geoapify', '© OpenStreetMap contributors', source?.attribution, source?.license, source?.url]
    .filter((value): value is string => Boolean(value)).join(' · ');
  return {
    point: { latitude: result.lat, longitude: result.lon },
    formattedAddress: result.formatted,
    precision: result.result_type ?? 'unknown',
    confidence: result.rank?.confidence ?? null,
    matchType: result.rank?.match_type ?? null,
    attribution,
  };
}

function acceptanceProblem(destination: GeoapifyDestination, result: ProviderResult): string | null {
  if (result.result_type !== 'building') return 'approximate_result';
  const rank = result.rank;
  if (!rank || [rank.confidence, rank.confidence_street_level, rank.confidence_city_level, rank.confidence_building_level]
    .some((confidence) => confidence === undefined || confidence < highConfidence)) return 'low_confidence';
  const requestedCountry = countryCode(destination.country);
  const requestedHouse = houseNumber(destination.address);
  if (!requestedCountry || result.country_code?.toLowerCase() !== requestedCountry
    || comparisonText(result.city) !== comparisonText(destination.city)
    || !requestedHouse || houseComparison(result.housenumber) !== houseComparison(requestedHouse)
    || (destination.postalCode?.trim() && comparisonText(result.postcode) !== comparisonText(destination.postalCode))) {
    return 'address_mismatch';
  }
  return null;
}

const geoapifyClientOptions = Symbol('GeoapifyClientOptions');
type GeoapifyClientOptions = { settings: unknown; fetch?: typeof fetch };

@Injectable()
export class GeoapifyClient {
  private readonly fetch: typeof fetch;

  constructor(@Optional() @Inject(geoapifyClientOptions) private readonly options?: GeoapifyClientOptions) {
    this.fetch = options?.fetch ?? fetch;
  }

  async getSettings(): Promise<{ configured: boolean; dailyLimit: number }> {
    const settings = await this.settings();
    return { configured: settings !== null, dailyLimit: settings?.dailyLimit ?? defaultDailyLimit };
  }

  async lookup(destination: GeoapifyDestination): Promise<GeoapifyLookupResult> {
    const addressProblem = geoapifyAddressProblem(destination);
    if (addressProblem) return { status: 'failed', reason: addressProblem, candidate: null };
    const settings = await this.settings();
    if (!settings) return { status: 'failed', reason: 'unconfigured', candidate: null };
    try {
      const url = new URL(endpoint);
      const text = [destination.address, destination.city, destination.province, destination.postalCode, destination.country]
        .map((value) => value?.trim()).filter(Boolean).join(', ');
      const country = countryCode(destination.country);
      url.search = new URLSearchParams({
        text, format: 'json', limit: '2', bias: 'countrycode:none', apiKey: settings.apiKey,
        ...(country ? { filter: `countrycode:${country}` } : {}),
      }).toString();
      const response = await this.fetch(url, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: 'failed', reason: response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable', candidate: null };
      }
      const parsed = ResponseSchema.safeParse(await readBoundedGoogleJson(response, maxResponseBytes));
      if (!parsed.success) return { status: 'failed', reason: 'invalid_response', candidate: null };
      const [result] = parsed.data.results;
      if (!result) return { status: 'not_found', reason: null, candidate: null };
      if (parsed.data.results.some((entry) => entry.lat === 0 && entry.lon === 0)) {
        return { status: 'failed', reason: 'invalid_response', candidate: null };
      }
      const reason = parsed.data.results.length > 1 ? 'ambiguous_results' : acceptanceProblem(destination, result);
      return { status: reason ? 'review_required' : 'accepted', reason, candidate: candidate(result) };
    } catch {
      // Errors from fetch/JSON may contain the request URL, address or API key.
      return { status: 'failed', reason: 'provider_unavailable', candidate: null };
    }
  }

  private async settings(): Promise<z.infer<typeof SettingsSchema> | null> {
    let value: unknown;
    if (this.options) value = this.options.settings;
    else {
      try {
        const path = process.env['GEOAPIFY_SETTINGS_FILE'] || resolve(process.cwd(), '.local/maps/geoapify.json');
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(maxSettingsBytes + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > maxSettingsBytes) return null;
          value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
    }
    const parsed = SettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
