'use client';

import { useCallback } from 'react';
import { apiRequest, mutate } from '@/lib/api';
import { entranceReviewSchema, entranceSuggestionSchema, type EntranceReviewData, type EntranceReviewSave } from '@/lib/delivery-entrance';
import { DeliveryEntranceReview } from './delivery-entrance-review';

export function EntranceReviewAction({ deliveryId, onSaved }: {
  deliveryId: string;
  onSaved?: (value: EntranceReviewData) => void;
}) {
  const resource = `/deliveries/${encodeURIComponent(deliveryId)}/entrance`;
  const load = useCallback((signal: AbortSignal) => apiRequest(resource, entranceReviewSchema, { signal }), [resource]);
  const suggest = useCallback((addressKey: string, signal: AbortSignal) =>
    apiRequest(`${resource}/suggestion`, entranceSuggestionSchema, {
      method: 'POST', body: JSON.stringify({ addressKey }), signal,
    }), [resource]);
  async function save(input: EntranceReviewSave) {
    const value = await mutate(resource, entranceReviewSchema, input, 'PATCH');
    onSaved?.(value);
    return value;
  }
  return <DeliveryEntranceReview load={load} suggest={suggest} save={save} />;
}
