import { Body, Controller, Get, Inject, Module, Param, Patch, Post, Req } from '@nestjs/common';
import { IdSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { TimeStandards } from './time-standards';

@Controller()
class TimeStandardsController {
  constructor(@Inject(TimeStandards) private readonly standards: TimeStandards) {}
  @Get('planning/time-standards') list() { return this.standards.list(); }
  @Get('planning/time-standards/:id') detail(@Param('id') id: string) { return this.standards.detail(IdSchema.toLowerCase().parse(id)); }
  @Post('planning/time-standards') create(@Body() body: unknown, @Req() request: unknown) { return this.standards.create(body, actor(request)); }
  @Patch('planning/time-standards/:id') update(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) { return this.standards.update(IdSchema.toLowerCase().parse(id), body, actor(request)); }
  @Post('deliveries/:id/work-times/standard') apply(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) { return this.standards.apply(IdSchema.parse(id), body, actor(request)); }
}

@Module({ imports: [OperationsModule], controllers: [TimeStandardsController], providers: [TimeStandards] })
export class TimeStandardsModule {}
