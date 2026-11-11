import { Body, ConflictException, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { destinationAddressKey, DestinationAddressKeySchema } from '../domain/destination-address';
import { IdSchema } from '../domain/model';
import { DeliveryStore } from '../operations/store';
import { GeocodeSuggestionSchema, GoogleGeocoder, noGeocodeSuggestion } from './google-geocoder';

export const AddressSuggestionInputSchema = z.object({ addressKey: DestinationAddressKeySchema }).strict();
export const AddressSuggestionResponseSchema = z.intersection(
  z.object({ addressKey: DestinationAddressKeySchema }),
  GeocodeSuggestionSchema,
);

@Controller('deliveries/:id/entrance')
export class AddressSuggestionController {
  constructor(
    @Inject(DeliveryStore) private readonly store: DeliveryStore,
    @Inject(GoogleGeocoder) private readonly geocoder: GoogleGeocoder,
  ) {}

  @Post('suggestion')
  @HttpCode(200)
  async suggest(@Param('id') id: string, @Body() body: unknown): Promise<z.infer<typeof AddressSuggestionResponseSchema>> {
    const { addressKey } = AddressSuggestionInputSchema.parse(body);
    const delivery = await this.store.get(IdSchema.parse(id));
    const destination = delivery.source.customer;
    if (addressKey !== destinationAddressKey(destination)) {
      throw new ConflictException('Delivery address changed. Refresh it before requesting a suggestion.');
    }
    if (!destination.address?.trim()) return { addressKey, ...noGeocodeSuggestion('missing_address') };
    if (delivery.routePoint && !delivery.sourceReview) {
      return { addressKey, status: 'approximate', point: delivery.routePoint, source: 'source' };
    }
    return { addressKey, ...await this.geocoder.suggest(destination) };
  }
}
