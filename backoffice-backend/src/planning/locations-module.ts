import { Body, Controller, Get, Inject, Module, Param, Patch, Post, Req } from '@nestjs/common';
import { actor } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { PlanningLocationIdSchema } from './location-contracts';
import { PlanningLocations } from './locations';

@Controller('planning/locations')
class PlanningLocationsController {
  constructor(@Inject(PlanningLocations) private readonly locations: PlanningLocations) {}
  @Get() list() { return this.locations.list(); }
  @Get(':id') detail(@Param('id') id: string) { return this.locations.detail(PlanningLocationIdSchema.parse(id)); }
  @Post() create(@Body() input: unknown, @Req() request: unknown) { return this.locations.create(input, actor(request)); }
  @Patch(':id') update(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.locations.update(PlanningLocationIdSchema.parse(id), input, actor(request));
  }
}

@Module({ imports: [OperationsModule], controllers: [PlanningLocationsController], providers: [PlanningLocations], exports: [PlanningLocations] })
export class PlanningLocationsModule {}
