import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { IdSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { ConfirmEntranceInputSchema, DestinationEntrances } from './entrances';
import { GoogleRoads } from './google-maps';

@Controller('deliveries/:id/entrance')
export class EntranceController {
  constructor(
    @Inject(DestinationEntrances) private readonly entrances: DestinationEntrances,
    @Inject(GoogleRoads) private readonly googleRoads: GoogleRoads,
  ) {}

  @Get()
  async get(@Param('id') id: string) {
    const entrance = await this.entrances.get(IdSchema.parse(id));
    return { ...entrance, mapConfig: this.googleRoads.browserConfig };
  }

  @Patch()
  async confirm(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    const entrance = await this.entrances.confirm(IdSchema.parse(id), ConfirmEntranceInputSchema.parse(body), actor(request));
    return { ...entrance, mapConfig: this.googleRoads.browserConfig };
  }
}
