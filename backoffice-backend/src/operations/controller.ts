import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdSchema, SourceItemSchema } from '../domain/model';
import { actor } from '../identity/identity';
import { Operations } from './operations';
import { DeliveryStore } from './store';
import { Files } from '../evidence/files';
import { sendPrivateDownload } from '../evidence/download-response';
import { Importer } from '../integration/importer';
import { DeliveryMap } from '../routing/delivery-map';
import { SourceReview } from '../integration/source-review';

@Controller()
export class OperationsController {
  constructor(@Inject(Operations) private readonly operations:Operations,@Inject(DeliveryStore) private readonly store:DeliveryStore,@Inject(Files) private readonly files:Files,@Inject(Importer) private readonly importer:Importer,@Inject(DeliveryMap) private readonly deliveryMap:DeliveryMap,@Inject(SourceReview) private readonly sourceReview:SourceReview) {}
  @Get('deliveries') list(@Query() query:unknown) { return this.operations.list(query); }
  @Get('deliveries/map') map(@Query() query:unknown) { return this.deliveryMap.get(query); }
  @Get('deliveries/:id') detail(@Param('id') id:string) { return this.store.detail(IdSchema.parse(id)); }
  @Get('deliveries/:id/source-review') sourceReviewDetail(@Param('id') id:string) { return this.sourceReview.get(IdSchema.parse(id)); }
  @Post('deliveries/:id/source-review') sourceReviewDecision(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.sourceReview.decide(IdSchema.parse(id),body,actor(request)); }
  @Patch('deliveries/:id/instructions') instructions(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.instructions(IdSchema.parse(id),body,actor(request)); }
  @Patch('deliveries/:id/services') services(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.services(IdSchema.parse(id), body, actor(request));
  }
  @Patch('deliveries/:id/work-times') workTimes(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.workTimes(IdSchema.parse(id), body, actor(request));
  }
  @Patch('deliveries/:id/work-time-adjustments') workTimeAdjustments(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.workTimeAdjustments(IdSchema.parse(id), body, actor(request));
  }
  @Patch('deliveries/:id/work-quantities') workQuantities(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.workQuantities(IdSchema.parse(id), body, actor(request));
  }
  @Patch('deliveries/:id/prior-work') priorWork(@Param('id') id: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.priorWork(IdSchema.parse(id), body, actor(request));
  }
  @Post('deliveries/:id/appointments') book(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.book(IdSchema.parse(id),body,actor(request)); }
  @Patch('deliveries/:id/appointments/:appointmentId/work-scope')
  workScope(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) {
    return this.operations.workScope(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request));
  }
  @Post('deliveries/:id/appointments/:appointmentId/assign') assign(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.assign(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request)); }
  @Post('deliveries/:id/appointments/:appointmentId/confirm-customer')
  confirmCustomer(@Param('id') id: string, @Param('appointmentId') appointmentId: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.confirmCustomer(IdSchema.parse(id), IdSchema.parse(appointmentId), body, actor(request));
  }
  @Patch('deliveries/:id/appointments/:appointmentId/responsible')
  selectResponsible(@Param('id') id: string, @Param('appointmentId') appointmentId: string, @Body() body: unknown, @Req() request: unknown) {
    return this.operations.selectResponsible(IdSchema.parse(id), IdSchema.parse(appointmentId), body, actor(request));
  }
  @Get('deliveries/:id/appointments/:appointmentId/transport/availability') transportAvailability(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Query() query:unknown) {return this.operations.transportAvailability(IdSchema.parse(id),IdSchema.parse(appointmentId),query);}
  @Post('deliveries/:id/appointments/:appointmentId/transport') allocateTransport(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) {return this.operations.allocateTransport(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request));}
  @Post('deliveries/:id/appointments/:appointmentId/transport/:allocationId/replace') replaceTransport(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Param('allocationId') allocationId:string,@Body() body:unknown,@Req() request:unknown) {return this.operations.replaceTransport(IdSchema.parse(id),IdSchema.parse(appointmentId),IdSchema.parse(allocationId),body,actor(request));}
  @Post('deliveries/:id/appointments/:appointmentId/transport/:allocationId/cancel') cancelTransport(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Param('allocationId') allocationId:string,@Body() body:unknown,@Req() request:unknown) {return this.operations.cancelTransport(IdSchema.parse(id),IdSchema.parse(appointmentId),IdSchema.parse(allocationId),body,actor(request));}
  @Get('deliveries/:id/appointments/:appointmentId/participants') availability(@Param('id') id:string,@Param('appointmentId') appointmentId:string) { return this.operations.participantAvailability(IdSchema.parse(id),IdSchema.parse(appointmentId)); }
  @Patch('deliveries/:id/appointments/:appointmentId/participants') staffing(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.updateParticipants(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request)); }
  @Patch('deliveries/:id/appointments/:appointmentId') move(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.move(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request)); }
  @Post('deliveries/:id/appointments/:appointmentId/cancel') cancel(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.cancel(IdSchema.parse(id),IdSchema.parse(appointmentId),body,actor(request)); }
  @Post('deliveries/:id/appointments/:appointmentId/checklist/:checklistId/waive') waive(@Param('id') id:string,@Param('appointmentId') appointmentId:string,@Param('checklistId') checklistId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.waive(IdSchema.parse(id),IdSchema.parse(appointmentId),IdSchema.parse(checklistId),body,actor(request)); }
  @Post('deliveries/:id/appointments/:appointmentId/results/:resultId/signature-refusal-review')
  reviewSignatureRefusal(@Param('id') id: string, @Param('appointmentId') appointmentId: string, @Param('resultId') resultId: string,
    @Body() body: unknown, @Req() request: unknown) {
    return this.operations.reviewSignatureRefusal(IdSchema.parse(id), IdSchema.parse(appointmentId).toLowerCase(),
      IdSchema.parse(resultId).toLowerCase(), body, actor(request));
  }
  @Post('deliveries/:id/issues') issue(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.issue(IdSchema.parse(id),body,actor(request)); }
  @Post('deliveries/:id/issues/:issueId/resolve') resolveIssue(@Param('id') id:string,@Param('issueId') issueId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.resolveIssue(IdSchema.parse(id),IdSchema.parse(issueId),body,actor(request)); }
  @Patch('deliveries/:id/work-readiness/:sourceLineId') releaseDamagedWork(@Param('id') id:string,@Param('sourceLineId') sourceLineId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.releaseDamagedWork(IdSchema.parse(id),SourceItemSchema.shape.sourceLineId.parse(Number(sourceLineId)),body,actor(request)); }
  @Patch('deliveries/:id/issues/:issueId/notes') issueNotes(@Param('id') id:string,@Param('issueId') issueId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.issueNotes(IdSchema.parse(id),IdSchema.parse(issueId),body,actor(request)); }
  @Post('deliveries/:id/returns') requestReturn(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.requestReturn(IdSchema.parse(id),body,actor(request)); }
  @Post('deliveries/:id/returns/:returnId/resolve') resolveReturn(@Param('id') id:string,@Param('returnId') returnId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.resolveReturn(IdSchema.parse(id),IdSchema.parse(returnId),body,actor(request)); }
  @Patch('deliveries/:id/returns/:returnId/notes') returnNotes(@Param('id') id:string,@Param('returnId') returnId:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.returnNotes(IdSchema.parse(id),IdSchema.parse(returnId),body,actor(request)); }
  @Post('deliveries/:id/complete') complete(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.complete(IdSchema.parse(id),body,actor(request)); }
  @Post('deliveries/:id/reopen') reopen(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.reopen(IdSchema.parse(id),body,actor(request)); }
  @Get('crews') crews() { return this.operations.crews(); }
  @Get('crews/:id') crew(@Param('id') id:string) { return this.operations.crew(IdSchema.parse(id)); }
  @Delete('crews/:id') deleteCrew(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.deleteDirectory('crew',IdSchema.parse(id),body,actor(request)); }
  @Get('participants') participants() { return this.operations.participants(); }
  @Get('participants/:id') participant(@Param('id') id:string) { return this.operations.participant(IdSchema.parse(id)); }
  @Delete('participants/:id') deleteParticipant(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.deleteDirectory('participant',IdSchema.parse(id),body,actor(request)); }
  @Get('participants/:id/calendar') participantCalendar(@Param('id') id:string,@Query() query:unknown) { return this.operations.participantCalendar(IdSchema.parse(id),query); }
  @Post('participants') saveParticipant(@Body() body:unknown,@Req() request:unknown) { return this.operations.saveParticipant(null,body,actor(request)); }
  @Patch('participants/:id') updateParticipant(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.saveParticipant(IdSchema.parse(id),body,actor(request)); }
  @Patch('participants/:id/skills') updateParticipantSkills(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.saveParticipantSkills(IdSchema.parse(id),body,actor(request)); }
  @Get('skills') skills() { return this.operations.skills(); }
  @Get('skills/:id') skill(@Param('id') id:string) { return this.operations.skill(IdSchema.parse(id)); }
  @Delete('skills/:id') deleteSkill(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.deleteDirectory('skill',IdSchema.parse(id),body,actor(request)); }
  @Post('skills') createSkill(@Body() body:unknown,@Req() request:unknown) { return this.operations.saveSkill(null,body,actor(request)); }
  @Patch('skills/:id') updateSkill(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.saveSkill(IdSchema.parse(id),body,actor(request)); }
  @Get('vehicles') vehicles() {return this.operations.vehicles();}
  @Get('vehicles/:id') vehicle(@Param('id') id:string) {return this.operations.vehicle(IdSchema.parse(id));}
  @Delete('vehicles/:id') deleteVehicle(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) {return this.operations.deleteDirectory('vehicle',IdSchema.parse(id),body,actor(request));}
  @Post('vehicles') createVehicle(@Body() body:unknown,@Req() request:unknown) {return this.operations.saveVehicle(null,body,actor(request));}
  @Patch('vehicles/:id') updateVehicle(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) {return this.operations.saveVehicle(IdSchema.parse(id),body,actor(request));}
  @Post('crews') saveCrew(@Body() body:unknown,@Req() request:unknown) { return this.operations.saveCrew(null,body,actor(request)); }
  @Patch('crews/:id') updateCrew(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.saveCrew(IdSchema.parse(id),body,actor(request)); }
  @Get('templates') templates() { return this.operations.templates(); }
  @Get('templates/:id') template(@Param('id') id:string) { return this.operations.template(IdSchema.parse(id)); }
  @Delete('templates/:id') deleteTemplate(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.deleteDirectory('template',IdSchema.parse(id),body,actor(request)); }
  @Post('templates') saveTemplate(@Body() body:unknown,@Req() request:unknown) { return this.operations.saveTemplate(null,body,actor(request)); }
  @Patch('templates/:id') updateTemplate(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.operations.saveTemplate(IdSchema.parse(id),body,actor(request)); }
  @Get('calendar/filter-options') calendarFilterOptions(@Query() query:unknown) { return this.operations.calendarFilterOptions(query); }
  @Get('calendar') calendar(@Query() query:unknown) { return this.operations.calendar(query); }
  @Get('imports') imports() { return this.importer.list(); }
  @Post('imports') runImport(@Req() request:unknown) { return this.importer.run(actor(request)); }
  @Post('deliveries/:id/files') upload(@Param('id') id:string,@Body() body:unknown,@Req() request:unknown) { return this.files.upload(IdSchema.parse(id),body,actor(request)); }
  @Get('deliveries/:id/files/:fileId') async download(@Param('id') id:string,@Param('fileId') fileId:string,@Res() response:Response<unknown>) {
    const result=await this.files.download(IdSchema.parse(id),IdSchema.parse(fileId));
    sendPrivateDownload(response, result);
  }
}
