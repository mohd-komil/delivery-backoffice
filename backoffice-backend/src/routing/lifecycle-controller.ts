import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../domain/model';
import { CrewAccess, actor } from '../identity/identity';
import { crewActor } from '../identity/crew-identity';
import { RouteLifecycle } from './lifecycle';

@Controller('routes')
export class RouteLifecycleController {
  constructor(@Inject(RouteLifecycle) private readonly routes: RouteLifecycle) {}
  @Get('reconciliation-owners') owners() { return this.routes.owners(); }
  @Get(':id/operations') get(@Param('id') id: string, @Req() request: unknown) { return this.routes.get(IdSchema.parse(id).toLowerCase(), actor(request)); }
  @Get(':id/timing') timing(@Param('id') id: string, @Req() request: unknown) { return this.routes.timing(IdSchema.parse(id).toLowerCase(), actor(request)); }
  @Get(':id/revisions/:version') revision(@Param('id') id: string, @Param('version') version: string) {
    return this.routes.revision(IdSchema.parse(id).toLowerCase(), z.coerce.number().int().positive().parse(version));
  }
  @Post(':id/depart') @HttpCode(200) depart(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.depart(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/amend-review') @HttpCode(200) review(@Param('id') id: string, @Body() input: unknown) { return this.routes.amendReview(IdSchema.parse(id).toLowerCase(), input); }
  @Post(':id/amend') @HttpCode(200) amend(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.amend(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.cancel(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/abort') @HttpCode(200) abort(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.abort(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/returning') @HttpCode(200) returning(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.returning(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/return') @HttpCode(200) returned(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.returned(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/reconcile') @HttpCode(200) reconcile(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.reconcile(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/warehouse-receipts') @HttpCode(200) warehouseReceipt(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.warehouseReceipt(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/close') @HttpCode(200) close(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.close(IdSchema.parse(id).toLowerCase(), input, actor(request)); }
  @Post(':id/stops/:appointmentId/skip') @HttpCode(200) skip(@Param('id') id: string, @Param('appointmentId') appointmentId: string, @Body() input: unknown, @Req() request: unknown) {
    return this.routes.skip(IdSchema.parse(id).toLowerCase(), IdSchema.parse(appointmentId).toLowerCase(), input, actor(request));
  }
}

@CrewAccess()
@Controller('crew/routes')
export class CrewRoutesController {
  constructor(@Inject(RouteLifecycle) private readonly routes: RouteLifecycle) {}
  @Get() list(@Req() request: unknown) { return this.routes.list(crewActor(request)); }
  @Get(':id') get(@Param('id') id: string, @Req() request: unknown) { return this.routes.get(IdSchema.parse(id).toLowerCase(), crewActor(request)); }
  @Post(':id/depart') @HttpCode(200) depart(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.depart(IdSchema.parse(id).toLowerCase(), input, crewActor(request), request); }
  @Post(':id/returning') @HttpCode(200) returning(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.returning(IdSchema.parse(id).toLowerCase(), input, crewActor(request), request); }
  @Post(':id/return') @HttpCode(200) returned(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) { return this.routes.returned(IdSchema.parse(id).toLowerCase(), input, crewActor(request), request); }
}
