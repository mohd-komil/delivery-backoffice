import { Body, Controller, Get, Inject, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IdSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { PlanningCalendar } from './calendar';

@Controller('planning/calendar')
class PlanningCalendarController {
  constructor(@Inject(PlanningCalendar) private readonly calendar: PlanningCalendar) {}
  @Get() list(@Query() query: unknown) { return this.calendar.list(query); }
  @Get(':id') detail(@Param('id') id: string) { return this.calendar.detail(IdSchema.parse(id).toLowerCase()); }
  @Post() create(@Body() body: unknown, @Req() request: unknown) { return this.calendar.save(null, body, actor(request)); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.calendar.save(IdSchema.parse(id).toLowerCase(), body, actor(request));
  }
}

@Module({ imports: [OperationsModule], controllers: [PlanningCalendarController], providers: [PlanningCalendar], exports: [PlanningCalendar] })
export class PlanningCalendarModule {}
