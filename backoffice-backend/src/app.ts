import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Inject, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config } from './config';
import { Database, DatabaseModule } from './database/database';
import { AccessGuard, IdentityModule, Public } from './identity/identity';
import { IdSchema } from './domain/model';
import { DomainError } from './domain/rules';
import { OperationsModule } from './operations/module';
import { OperationsController } from './operations/controller';
import { Importer } from './integration/importer';
import { apiDocument } from './openapi';
import { CrewModule } from './crew/controller';
import { CREW_FINISH_JSON_MAX_BYTES } from './crew/contracts';
import { RoutingModule } from './routing/module';

export { OperationsModule } from './operations/module';

@Catch()
class Errors implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse<Response<unknown>>();
    if(error instanceof ZodError) {response.status(400).json({code:'INVALID_INPUT',message:error.issues.map((issue)=>issue.path.join('.')+': '+issue.message).join('; ')});return;}
    if(error instanceof DomainError) {response.status(error.status).json({code:error.code,message:error.message,details:error.details});return;}
    // Parser adapters may construct their own exception instance; accept only these known names/statuses.
    // Never reflect parser messages, which can contain fragments of the submitted body.
    if(error instanceof Error && 'status' in error) {
      if(['BadRequestException','HttpException'].includes(error.name) && error.status===400) {
        response.status(400).json({code:'INVALID_REQUEST',message:'Request input is malformed or does not meet the operation requirements'});return;
      }
      if(['PayloadTooLargeException','HttpException'].includes(error.name) && error.status===413) {
        response.status(413).json({code:'PAYLOAD_TOO_LARGE',message:'Request body exceeds the allowed size'});return;
      }
    }
    if(error instanceof HttpException) {response.status(error.getStatus()).json({code:'HTTP_'+String(error.getStatus()),message:error.message});return;}
    console.error('Request failed:',error instanceof Error?error.name:'Unknown error');
    response.status(500).json({code:'INTERNAL_ERROR',message:'Operation failed. Check local diagnostics and try again.'});
  }
}
@Controller()
class SystemController {
  constructor(@Inject(Database) private readonly db:Database) {}
  @Public() @Get('health') async health() {await this.db.source.query('SELECT 1');return {status:'ok',database:'delivery_backoffice',sourceModel:'synthetic Odoo teaching model'};}
  @Get('openapi.json') openapi() {return apiDocument();}
}
@Module({imports:[OperationsModule],providers:[Importer],exports:[Importer]})
export class IntegrationModule {}
@Module({imports:[DatabaseModule,IdentityModule,OperationsModule,IntegrationModule,CrewModule,RoutingModule],controllers:[SystemController,OperationsController],providers:[{provide:APP_GUARD,useClass:AccessGuard}]})
export class AppModule {}

function isCrewFinishJson(request: IncomingMessage): boolean {
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return false;
  const path = request.url?.split('?')[0] ?? '';
  const visitId = /^\/api\/crew\/visits\/([^/]+)\/finish\/?$/i.exec(path)?.[1];
  return IdSchema.safeParse(visitId).success;
}

export function configureApplication(app:NestExpressApplication) {
  app.setGlobalPrefix('api');
  app.use(['/api/crew', '/api/deliveries', '/api/routes', '/api/participants', '/api/crews', '/api/templates'], (_request: unknown, response: Response<unknown>, next: NextFunction) => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  // The separate frontend and API use different loopback ports but the same site.
  app.use(helmet({crossOriginResourcePolicy:{policy:'same-site'}}));
  app.useBodyParser('json', { limit: CREW_FINISH_JSON_MAX_BYTES, type: isCrewFinishJson });
  app.useBodyParser('json',{limit:'8mb'});
  const backofficeCors = {origin:config().FRONTEND_ORIGIN,credentials:true,methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type']};
  app.enableCors((request: Request, callback) => {
    // Crew requests use a same-origin proxy. Cookies on loopback can span ports.
    const crew = /^\/api\/crew(?:\/|$)/i.test(request.path);
    callback(null, crew ? { origin: false } : backofficeCors);
  });
  app.useGlobalFilters(new Errors());
  return app;
}
export async function createApp(quiet=false) {
  const app=await NestFactory.create<NestExpressApplication>(AppModule,{logger:quiet?false:['error','warn','log'],bodyParser:false});
  configureApplication(app);
  app.enableShutdownHooks();
  return app;
}
