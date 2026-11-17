import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { IdSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { AddressGeocoding, GeocodingAcceptInputSchema, GeocodingInputSchema } from './geocoding';

@Controller('deliveries/:id/geocoding')
export class GeocodingController {
  constructor(@Inject(AddressGeocoding) private readonly geocoding: AddressGeocoding) {}

  @Get()
  get(@Param('id') id: string) { return this.geocoding.get(IdSchema.parse(id)); }

  @Post()
  @HttpCode(200)
  locate(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.geocoding.locate(IdSchema.parse(id), GeocodingInputSchema.parse(body), actor(request));
  }

  @Post('accept')
  @HttpCode(200)
  accept(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.geocoding.accept(IdSchema.parse(id), GeocodingAcceptInputSchema.parse(body), actor(request));
  }
}
