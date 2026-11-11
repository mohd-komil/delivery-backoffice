import { Body, Controller, Get, Inject, Module, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { config } from '../config';
import { sendPrivateDownload } from '../evidence/download-response';
import { CREW_SESSION_COOKIE, CREW_SESSION_DURATION_MS, CrewIdentity, crewActor } from '../identity/crew-identity';
import { CrewAccess, Public } from '../identity/identity';
import { OperationsModule } from '../operations/module';
import { CrewLogoutInput, CrewLogoutResult } from './contracts';
import { CrewExecution } from './execution';
import { CrewVisits } from './visits';

function sessionCookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure: config().CREW_FRONTEND_ORIGIN.startsWith('https:'), path: '/api/crew' };
}

@CrewAccess()
@Controller('crew/auth')
export class CrewAuthController {
  constructor(@Inject(CrewIdentity) private readonly identity: CrewIdentity) {}

  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response<unknown>) {
    const { token, profile } = await this.identity.login(body);
    response.cookie(CREW_SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: CREW_SESSION_DURATION_MS });
    return profile;
  }

  @Get('me')
  me(@Req() request: unknown) { return crewActor(request); }

  @Post('logout')
  async logout(@Body() body: unknown, @Req() request: unknown, @Res({ passthrough: true }) response: Response<unknown>) {
    CrewLogoutInput.parse(body);
    await this.identity.logout(request);
    response.clearCookie(CREW_SESSION_COOKIE, sessionCookieOptions());
    return CrewLogoutResult.parse({ ok: true });
  }
}

@CrewAccess()
@Controller('crew/visits')
export class CrewVisitsController {
  constructor(@Inject(CrewVisits) private readonly visits: CrewVisits, @Inject(CrewExecution) private readonly execution: CrewExecution) {}

  @Get()
  list(@Req() request: unknown) { return this.visits.list(crewActor(request)); }

  @Get(':id')
  detail(@Param('id') id: string, @Req() request: unknown) { return this.visits.detail(id, crewActor(request)); }

  @Get(':id/documents/:fileId')
  async document(@Param('id') id: string, @Param('fileId') fileId: string, @Req() request: unknown, @Res() response: Response<unknown>) {
    sendPrivateDownload(response, await this.visits.downloadDocument(id, fileId, crewActor(request)));
  }

  @Post(':id/start')
  start(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.execution.start(id, input, request);
  }

  @Patch(':id/checklist/:checklistId')
  checklist(@Param('id') id: string, @Param('checklistId') checklistId: string, @Body() input: unknown, @Req() request: unknown) {
    return this.execution.checklist(id, checklistId, input, request);
  }

  @Post(':id/issues')
  issue(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.execution.issue(id, input, request);
  }

  @Post(':id/finish')
  finish(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.execution.finish(id, input, request);
  }

  @Post(':id/attempt-failure')
  attemptFailure(@Param('id') id: string, @Body() input: unknown, @Req() request: unknown) {
    return this.execution.attemptFailure(id, input, request);
  }
}

@Module({ imports: [OperationsModule], controllers: [CrewAuthController, CrewVisitsController], providers: [CrewVisits, CrewExecution] })
export class CrewModule {}
