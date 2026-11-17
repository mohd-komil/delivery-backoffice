import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Module, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { AddressSuggestionController } from './address-suggestion';
import { RouteCreateInputSchema, RoutePreviewInputSchema, RouteSuggestInputSchema, RouteUpdateInputSchema } from './contracts';
import { EntranceController } from './entrance-controller';
import { DestinationEntrances } from './entrances';
import { GoogleGeocoder } from './google-geocoder';
import { GoogleRoads } from './google-maps';
import { RouteDrafts } from './service';
import { DeliveryMap } from './delivery-map';
import { RoutePublication } from './publication';
import { RouteLifecycle } from './lifecycle';
import { CrewRoutesController, RouteLifecycleController } from './lifecycle-controller';
import { GeoapifyClient } from './geoapify-client';
import { AddressGeocoding } from './geocoding';
import { GeocodingController } from './geocoding-controller';
import { PlanningLocationsModule } from '../planning/locations-module';
import { PlanningCalendarModule } from '../planning/calendar-module';

@Controller('routes')
class RouteController {
  constructor(@Inject(RouteDrafts) private readonly routes: RouteDrafts, @Inject(RoutePublication) private readonly publication: RoutePublication) {}

  @Get()
  list() {
    return this.routes.list();
  }

  @Get('jobs')
  jobs(@Query() query: unknown) {
    return this.routes.jobs(query);
  }

  @Get('publication-capability')
  publicationCapability() { return this.publication.capability(); }

  @Get(':id/publication')
  async published(@Param('id') id: string, @Res() response: Response<unknown>) {
    // Nest's default null reply is an empty 200; this endpoint promises a JSON nullable document.
    response.status(200).json(await this.publication.get(IdSchema.parse(id).toLowerCase()));
  }

  @Post(':id/publication-review')
  @HttpCode(200)
  publicationReview(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.publication.review(IdSchema.parse(id).toLowerCase(), input, actor(request));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.publication.publish(IdSchema.parse(id).toLowerCase(), input, actor(request));
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body() input: unknown) {
    const { useGoogleRoads, ...draft } = RoutePreviewInputSchema.parse(input);
    return this.routes.preview(draft, useGoogleRoads);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.routes.get(IdSchema.parse(id));
  }

  @Post('suggest-order')
  @HttpCode(200)
  suggest(@Body() input: unknown) {
    const { objective, useGoogleRoads, ...draft } = RouteSuggestInputSchema.parse(input);
    if (useGoogleRoads) throw new BadRequestException('Stop-order comparison does not call a road provider; use comparable local or manual estimates');
    return this.routes.suggest(draft, objective);
  }

  @Post()
  create(@Body() input: unknown, @Req() request: unknown) {
    const { requestId, ...draft } = RouteCreateInputSchema.parse(input);
    return this.routes.create(requestId, draft, actor(request));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    const { version, ...draft } = RouteUpdateInputSchema.parse(input);
    return this.routes.update(IdSchema.parse(id), version, draft, actor(request));
  }
}

@Module({
  imports: [OperationsModule, PlanningLocationsModule, PlanningCalendarModule],
  controllers: [RouteLifecycleController, CrewRoutesController, RouteController, EntranceController, AddressSuggestionController, GeocodingController],
  providers: [RouteDrafts, RoutePublication, RouteLifecycle, GoogleRoads, DestinationEntrances, GoogleGeocoder, DeliveryMap, GeoapifyClient, AddressGeocoding],
  exports: [DeliveryMap, AddressGeocoding],
})
export class RoutingModule {}
