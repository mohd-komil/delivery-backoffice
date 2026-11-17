import { Body, Controller, Get, Inject, Module, Param, Patch, Query, Req } from '@nestjs/common';
import { actor } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { DispatcherKeySchema } from './contracts';
import { DispatcherQueue } from './service';

@Controller('dispatcher')
class DispatcherController {
  constructor(@Inject(DispatcherQueue) private readonly queue: DispatcherQueue) {}
  @Get('owners') owners() { return this.queue.owners(); }
  @Get('queue') list(@Query() query: unknown, @Req() request: unknown) { return this.queue.list(query, actor(request)); }
  @Get('queue/:key') detail(@Param('key') key: string) { return this.queue.detail(DispatcherKeySchema.parse(key)); }
  @Patch('queue/:key') update(@Param('key') key: string, @Body() body: unknown, @Req() request: unknown) {
    return this.queue.update(DispatcherKeySchema.parse(key), body, actor(request));
  }
}

@Module({ imports: [OperationsModule], controllers: [DispatcherController], providers: [DispatcherQueue] })
export class DispatcherModule {}
