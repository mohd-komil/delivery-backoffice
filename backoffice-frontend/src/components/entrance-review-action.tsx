'use client';

import { useCallback } from 'react';
import { ApiError, apiRequest, mutate } from '@/lib/api';
import { entranceReviewSchema, type EntranceReviewData, type EntranceReviewSave } from '@/lib/delivery-entrance';
import { deliveryGeocodingSchema, entranceSuggestionFromGeocoding } from '@/lib/delivery-geocoding';
import { DeliveryEntranceReview } from './delivery-entrance-review';

export function EntranceReviewAction({ deliveryId, onSaved, onLocated }: {
  deliveryId: string;
  onSaved?: (value: EntranceReviewData) => void;
  onLocated?: () => void;
}) {
  const resource = `/deliveries/${encodeURIComponent(deliveryId)}/entrance`;
  const load = useCallback((signal: AbortSignal) => apiRequest(resource, entranceReviewSchema, { signal }), [resource]);
  const geocodingResource = `/deliveries/${encodeURIComponent(deliveryId)}/geocoding`;
  const suggest = useCallback(async (addressKey: string, signal: AbortSignal) => {
    const record = await apiRequest(geocodingResource, deliveryGeocodingSchema, { signal });
    if (record.addressKey !== addressKey) throw new ApiError(409, 'Destination address changed');
    return entranceSuggestionFromGeocoding(record);
  }, [geocodingResource]);
  async function find(addressKey: string, signal: AbortSignal) {
    const current = await apiRequest(geocodingResource, deliveryGeocodingSchema, { signal });
    if (current.addressKey !== addressKey) throw new ApiError(409, 'Destination address changed');
    const record = await apiRequest(geocodingResource, deliveryGeocodingSchema, {
      method: 'POST', body: JSON.stringify({ addressKey, deliveryVersion: current.deliveryVersion }), signal,
    });
    if (record.status === 'accepted') onLocated?.();
    return entranceSuggestionFromGeocoding(record);
  }
  async function save(input: EntranceReviewSave) {
    const value = await mutate(resource, entranceReviewSchema, input, 'PATCH');
    onSaved?.(value);
    return value;
  }
  return <DeliveryEntranceReview load={load} suggest={suggest} find={find} save={save} />;
}
