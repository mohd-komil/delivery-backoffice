import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { rows } from '../database/database';
import { destinationAddressKey } from '../domain/destination-address';
import { DeliverySchema, type Delivery, type OperatorActor } from '../domain/model';
import { DomainError } from '../domain/rules';
import { sourcePlanningBlocked } from '../domain/source-import';
import { DeliveryPoints } from '../operations/delivery-points';
import { DeliveryStore } from '../operations/store';
import { geoapifyAddressProblem } from '../routing/geoapify-client';
import { AddressGeocoding, type GeocodingResponse } from '../routing/geocoding';

export const IMPORT_GEOCODING_MAX_ADDRESSES = 20;
export const IMPORT_GEOCODING_BUDGET_MS = 30_000;

export type ImportGeocodingSummary = {
  deliveries: number; alreadyMapped: number; skippedInvalid: number; skippedReview: number; duplicateAddresses: number;
  cached: number; checkedAddresses: number; accepted: number; reviewRequired: number; notFound: number; failed: number; deferred: number;
  stopReason: 'complete' | 'batch_limit' | 'time_budget' | 'not_configured' | 'quota_exceeded' | 'rate_limited' | 'provider_unavailable' | 'internal_error';
};

export function importGeocodingDescription(result: ImportGeocodingSummary): string {
  return `Geocoding: ${result.accepted} accepted; ${result.reviewRequired} need review; ${result.notFound} not found; ${result.failed} failed; `
    + `${result.alreadyMapped} already mapped; ${result.cached} cached; ${result.skippedInvalid} invalid/placeholder; `
    + `${result.skippedReview} source review; ${result.duplicateAddresses} duplicate addresses; ${result.deferred} deferred. ${result.stopReason}.`;
}

function canRetry(response: GeocodingResponse, now: number): boolean {
  return response.status === 'not_requested'
    || ((response.status === 'failed' || response.status === 'not_found') && (response.retryAt === null || Date.parse(response.retryAt) <= now));
}

@Injectable()
export class ImportGeocoding {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(DeliveryPoints) private readonly points: DeliveryPoints,
    @Inject(AddressGeocoding) private readonly geocoding: Pick<AddressGeocoding, 'getMany' | 'locate'>,
  ) {}

  async run(sourceInstance: string, actor: OperatorActor): Promise<ImportGeocodingSummary> {
    const deadline = Date.now() + IMPORT_GEOCODING_BUDGET_MS;
    const result: ImportGeocodingSummary = { deliveries: 0, alreadyMapped: 0, skippedInvalid: 0, skippedReview: 0, duplicateAddresses: 0,
      cached: 0, checkedAddresses: 0, accepted: 0, reviewRequired: 0, notFound: 0, failed: 0, deferred: 0, stopReason: 'complete' };
    const found = await rows(this.store.db.source.manager, z.object({ data: DeliverySchema }),
      'SELECT data FROM delivery WHERE source_instance=$1 ORDER BY source_id,id LIMIT 5001', [sourceInstance]);
    if (found.length > 5000) throw new Error('Geocoding scan exceeds the local delivery limit');
    const deliveries = found.map(({ data }) => data);
    result.deliveries = deliveries.length;
    const effectivePoints = await this.points.effectiveFor(deliveries);
    const unique = new Map<string, Delivery>();
    for (const delivery of deliveries) {
      if (delivery.sourceReview || sourcePlanningBlocked(delivery)) { result.skippedReview++; continue; }
      if (geoapifyAddressProblem(delivery.source.customer)) { result.skippedInvalid++; continue; }
      if (effectivePoints.has(delivery.id)) { result.alreadyMapped++; continue; }
      const key = destinationAddressKey(delivery.source.customer);
      if (unique.has(key)) { result.duplicateAddresses++; continue; }
      unique.set(key, delivery);
    }
    const states = await this.geocoding.getMany([...unique.values()]);
    const pending: Delivery[] = [];
    for (const delivery of unique.values()) {
      const state = states.get(delivery.id);
      if (!state) throw new Error('Geocoding cache state is missing');
      if (state.status === 'not_configured') {
        result.deferred++;
        result.stopReason = 'not_configured';
      } else if (canRetry(state, Date.now())) pending.push(delivery);
      else result.cached++;
    }
    for (const [index, delivery] of pending.entries()) {
      const remaining = pending.length - index;
      if (result.checkedAddresses >= IMPORT_GEOCODING_MAX_ADDRESSES || Date.now() >= deadline) {
        result.stopReason = result.checkedAddresses >= IMPORT_GEOCODING_MAX_ADDRESSES ? 'batch_limit' : 'time_budget';
        result.deferred += remaining;
        break;
      }
      try {
        const input = { deliveryVersion: delivery.version, addressKey: destinationAddressKey(delivery.source.customer) };
        let response = await this.geocoding.locate(delivery.id, input, actor);
        // Reuse the persisted provider pacing rather than adding an independent in-memory rate limit.
        if (response.status === 'rate_limited' && response.retryAt) {
          const wait = Math.max(0, Date.parse(response.retryAt) - Date.now()) + 10;
          if (wait <= 1100 && Date.now() + wait < deadline) {
            await sleep(wait);
            response = await this.geocoding.locate(delivery.id, input, actor);
          }
        }
        if (response.status === 'quota_exceeded' || response.status === 'not_configured' || response.status === 'rate_limited') {
          result.stopReason = response.status;
          result.deferred += remaining;
          break;
        }
        result.checkedAddresses++;
        if (response.status === 'accepted') result.accepted++;
        else if (response.status === 'review_required') result.reviewRequired++;
        else if (response.status === 'not_found') result.notFound++;
        else if (response.status === 'failed') {
          result.failed++;
          result.stopReason = 'provider_unavailable';
          result.deferred += remaining - 1;
          break;
        } else if (response.status === 'invalid_address') result.skippedInvalid++;
        else result.cached++;
      } catch (error: unknown) {
        if (error instanceof NotFoundException || error instanceof DomainError && error.code === 'GEOCODING_ADDRESS_CHANGED') {
          result.deferred++;
          continue;
        }
        result.failed++;
        result.deferred += remaining - 1;
        result.stopReason = 'internal_error';
        break;
      }
    }
    return result;
  }
}
