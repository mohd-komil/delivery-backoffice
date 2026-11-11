import { randomBytes } from 'node:crypto';
import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Global, Inject, Injectable, Module, Post, Req, Res, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { z } from 'zod';
import { Database, rows } from '../database/database';
import { config } from '../config';
import type { OperatorActor } from '../domain/model';
import { CrewIdentity } from './crew-identity';
import { verifyLoginPassword } from './password';
import { header, LoginAttempts, sessionDigest, sessionToken } from './session';

export { hashPassword, verifyPassword } from './password';
export { header } from './session';

const BACKOFFICE_SESSION_COOKIE = 'backoffice_session';
const ActorSchema = z.object({id:z.string().uuid(),name:z.string(),role:z.enum(['admin','operator'])});
const UserSchema = ActorSchema.extend({password_hash:z.string()});
const actors = new WeakMap<object,OperatorActor>();
export function actor(request: unknown): OperatorActor {
  if (typeof request !== 'object' || request === null) throw new UnauthorizedException('Login required');
  const principal = actors.get(request);
  if (!principal) throw new UnauthorizedException('Login required');
  return principal;
}
export const Public = () => SetMetadata('public',true);
export const Admin = () => SetMetadata('admin',true);
export const CrewAccess = () => SetMetadata('crew', true);
@Injectable()
export class Identity {
  constructor(@Inject(Database) private readonly db:Database) {}
  async authenticate(request: unknown) {
    const token = sessionToken(request, BACKOFFICE_SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('Login required');
    const found = await rows(this.db.source.manager,ActorSchema,'SELECT u.id,u.name,u.role FROM app_session s JOIN app_user u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()',[sessionDigest(token)]);
    const principal = found[0];
    if (!principal) throw new UnauthorizedException('Session expired');
    if (typeof request === 'object' && request !== null) actors.set(request,principal);
    return principal;
  }
  private readonly attempts = new LoginAttempts();
  async login(input: unknown) {
    const value = z.object({email:z.string().email().max(254),password:z.string().min(1).max(256)}).strict().parse(input);
    const email = value.email.toLowerCase();
    this.attempts.assertAllowed(email);
    const users = await rows(this.db.source.manager,UserSchema,'SELECT id,name,role,password_hash FROM app_user WHERE email=$1',[email]);
    const user = users[0];
    const valid = await verifyLoginPassword(value.password, user?.password_hash);
    if (!user || !valid) {
      this.attempts.failed(email);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.attempts.succeeded(email);
    const token=randomBytes(32).toString('hex');
    await this.db.source.query('INSERT INTO app_session(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'8 hours\')',[sessionDigest(token),user.id]);
    return {token,user:ActorSchema.parse(user)};
  }
  async logout(request:unknown) {
    const token=sessionToken(request, BACKOFFICE_SESSION_COOKIE);
    if(token) await this.db.source.query('DELETE FROM app_session WHERE token_hash=$1',[sessionDigest(token)]);
  }
}
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Identity) private readonly identity:Identity,
    @Inject(CrewIdentity) private readonly crewIdentity:CrewIdentity,
    @Inject(Reflector) private readonly reflector:Reflector,
  ) {}
  async canActivate(context:ExecutionContext) {
    const request:unknown=context.switchToHttp().getRequest<unknown>();
    const endpoints=[context.getHandler(),context.getClass()];
    const crew=this.reflector.getAllAndOverride<boolean>('crew',endpoints);
    const method = typeof request==='object' && request!==null && 'method' in request ? request.method : undefined;
    const safeMethod=method==='GET'||method==='HEAD'||method==='OPTIONS';
    const origin=header(request,'origin');
    if(!safeMethod || (crew && origin!==undefined)) {
      const environment=config();
      const allowedOrigin=crew?environment.CREW_FRONTEND_ORIGIN:environment.FRONTEND_ORIGIN;
      if(origin!==allowedOrigin) throw new ForbiddenException('Request origin is not allowed');
    }
    if(!safeMethod && !(header(request,'content-type')??'').startsWith('application/json')) throw new ForbiddenException('JSON requests required');
    if(this.reflector.getAllAndOverride<boolean>('public',endpoints)) return true;
    if(crew) {
      await this.crewIdentity.authenticate(request);
      return true;
    }
    const principal=await this.identity.authenticate(request);
    if(this.reflector.getAllAndOverride<boolean>('admin',endpoints) && principal.role!=='admin') throw new ForbiddenException('Administrator permission required');
    return true;
  }
}
@Controller('auth')
export class IdentityController {
  constructor(@Inject(Identity) private readonly identity:Identity) {}
  @Public() @Post('login')
  async login(@Body() body:unknown,@Res({passthrough:true}) response:Response<unknown>) {
    const result=await this.identity.login(body);
    response.cookie(BACKOFFICE_SESSION_COOKIE,result.token,{httpOnly:true,sameSite:'strict',secure:false,path:'/api',maxAge:8*60*60*1000});
    return result.user;
  }
  @Get('me') me(@Req() request:unknown) { return actor(request); }
  @Post('logout') async logout(@Req() request:unknown,@Res({passthrough:true}) response:Response<unknown>) {
    await this.identity.logout(request); response.clearCookie(BACKOFFICE_SESSION_COOKIE,{path:'/api'}); return {ok:true};
  }
}
@Global()
@Module({providers:[Identity,CrewIdentity,AccessGuard],controllers:[IdentityController],exports:[Identity,CrewIdentity,AccessGuard]})
export class IdentityModule {}
