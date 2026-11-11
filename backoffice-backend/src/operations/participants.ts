import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { PERSON_NAME_SQL } from '../database/person-name';
import { IdSchema, TextSchema, type OperatorActor } from '../domain/model';
import { hashPassword } from '../identity/identity';
import { CreateParticipantInput, CrewCreateInput, CrewSchema, CrewUpdateInput, ParticipantSchema, ParticipantSkillsInput, UpdateParticipantInput, type Participant } from './contracts';
import { DeliveryStore } from './store';
import { replaceParticipantSkills, validateSkillSelection } from './skills';
import { assertRouteResourceMutable, assertRouteSkillsRetained } from './route-reservations';

export { PERSON_NAME_SQL } from '../database/person-name';
const PersonRowSchema=ParticipantSchema.extend({legacyName:z.string().nullable()});
const PersonSelect=`SELECT p.id,p.version,${PERSON_NAME_SQL} AS name,p.legacy_name AS "legacyName",
  p.first_name AS "firstName",p.last_name AS "lastName",p.preferred_name AS "preferredName",
  p.phone_number AS "phoneNumber",p.address,p.login,p.external,p.enabled,(p.password_hash IS NOT NULL) AS "hasPassword",
  COALESCE((SELECT jsonb_agg(ps.skill_id ORDER BY ps.skill_id) FROM participant_skill ps WHERE ps.person_id=p.id),'[]'::jsonb) AS "skillIds" FROM person p`;

function requireAdmin(actor:OperatorActor):void {if(actor.role!=='admin') throw new ForbiddenException('Administrator permission required');}
export function distinctParticipants(ids:string[]):void {
  if(new Set(ids).size!==ids.length) throw new BadRequestException('A participant can appear only once in this selection');
}

@Injectable()
export class Participants {
  constructor(@Inject(DeliveryStore) private readonly store:DeliveryStore) {}

  async list(manager:EntityManager=this.store.db.source.manager):Promise<Participant[]> {
    const records=await rows(manager,PersonRowSchema,`${PersonSelect} ORDER BY name,p.id LIMIT 5001`);
    if(records.length>5000) throw new ConflictException('The participant directory exceeds the 5000-record local demo limit');
    return records.map((record)=>ParticipantSchema.strip().parse(record));
  }

  async selected(manager:EntityManager,ids:string[]):Promise<Participant[]> {
    distinctParticipants(ids);
    if(ids.length===0) return [];
    const records=await rows(manager,PersonRowSchema,`${PersonSelect} WHERE p.id=ANY($1::uuid[])`,[ids]);
    if(records.length!==ids.length) throw new NotFoundException('A selected participant does not exist');
    const byId=new Map(records.map((record)=>[record.id,record]));
    return ids.map((id)=>{
      const record=byId.get(id);
      if(!record) throw new NotFoundException('Participant not found');
      return ParticipantSchema.strip().parse(record);
    });
  }

  async crews(manager:EntityManager=this.store.db.source.manager,ids?:string[]) {
    const found=await rows(manager,CrewSchema,`SELECT c.id,c.version,c.name,c.classification,c.area,c.enabled,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',${PERSON_NAME_SQL},'external',p.external) ORDER BY m.position,p.id)
        FROM crew_member m JOIN person p ON p.id=m.person_id WHERE m.crew_id=c.id),'[]'::jsonb) AS people
      FROM crew c ${ids?'WHERE c.id=ANY($1::uuid[])':''} ORDER BY c.name,c.id LIMIT 5001`,ids?[ids]:[]);
    if(found.length>5000) throw new ConflictException('The crew directory exceeds the 5000-record local demo limit');
    return found;
  }

  async save(id:string|null,input:unknown,actor:OperatorActor):Promise<Participant> {
    requireAdmin(actor);
    const command=id?UpdateParticipantInput.parse(input):CreateParticipantInput.parse(input);
    const personId=id?IdSchema.parse(id).toLowerCase():randomUUID();
    const passwordHash=command.password===undefined?null:await hashPassword(command.password);
    try {
      return await this.store.db.source.transaction(async(manager)=>{
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const previous=id?(await rows(manager,PersonRowSchema,`${PersonSelect} WHERE p.id=$1 FOR UPDATE`,[personId]))[0]:undefined;
        if(id&&!previous) throw new NotFoundException('Participant not found');
        if(previous&&(!('version' in command)||command.version!==previous.version)) throw new ConflictException('Participant changed. Reload before editing.');
        const skillIds=await validateSkillSelection(manager,command.skillIds??previous?.skillIds??[],previous?.skillIds??[]);
        if(previous) {
          if(!command.enabled) await assertRouteResourceMutable(manager,`person:${personId}`);
          await assertRouteSkillsRetained(manager,previous.skillIds.filter((skillId)=>!skillIds.includes(skillId)),personId);
        }
        if(command.firstName===null||command.lastName===null) {
          const preservedLegacy=previous!==undefined&&previous.firstName===null&&previous.lastName===null&&previous.legacyName!==null;
          if(command.firstName!==null||command.lastName!==null||!preservedLegacy) throw new BadRequestException('First and last name are required; complete profiles cannot be cleared');
        }
        if(command.firstName!==null&&command.lastName!==null&&(command.firstName.length+command.lastName.length+1)>2000) throw new BadRequestException('The combined participant name exceeds 2000 characters');
        const login=command.login?.toLowerCase()??null;
        if(login!==null&&login.length>200) throw new BadRequestException('The normalized participant login exceeds 200 characters');
        if(login!==null&&(!previous||previous.login===null||!previous.hasPassword)&&passwordHash===null) throw new BadRequestException('Set a password when configuring a new participant login');
        if(login!==null) {
          const duplicate=await rows(manager,z.object({id:IdSchema}),'SELECT id FROM person WHERE lower(login)=lower($1) AND id<>$2',[login,personId]);
          if(duplicate.length) throw new ConflictException('Participant login is already in use');
        }
        const version=previous?previous.version+1:1;
        if(previous) {
          await manager.query(`UPDATE person SET version=$2,first_name=$3,last_name=$4,preferred_name=$5,phone_number=$6,address=$7,login=$8,
            external=$9,enabled=$10,password_hash=CASE WHEN $11::text IS NULL THEN password_hash ELSE $11 END WHERE id=$1`,
          [personId,version,command.firstName,command.lastName,command.preferredName,command.phoneNumber,command.address,login,command.external,command.enabled,passwordHash]);
        }else{
          await manager.query(`INSERT INTO person(id,version,first_name,last_name,preferred_name,phone_number,address,login,external,enabled,password_hash)
            VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [personId,command.firstName,command.lastName,command.preferredName,command.phoneNumber,command.address,login,command.external,command.enabled,passwordHash]);
        }
        if(command.skillIds!==undefined||!previous) await replaceParticipantSkills(manager,personId,skillIds);
        await this.store.audit(manager,actor,previous?'participant.updated':'participant.created',
          {id:personId,version,enabled:command.enabled,loginConfigured:login!==null,passwordChanged:passwordHash!==null,skillIds});
        const result=(await this.selected(manager,[personId]))[0];
        if(!result) throw new Error('Saved participant readback failed');
        return result;
      });
    }catch(error:unknown){
      const driver:unknown=error instanceof QueryFailedError?error.driverError:null;
      if(z.object({code:z.literal('23505'),constraint:z.literal('person_login_unique')}).safeParse(driver).success) throw new ConflictException('Participant login is already in use');
      throw error;
    }
  }

  async saveSkills(id:string,input:unknown,actor:OperatorActor):Promise<Participant> {
    requireAdmin(actor);
    const command=ParticipantSkillsInput.parse(input);
    const personId=IdSchema.parse(id).toLowerCase();
    return this.store.db.source.transaction(async(manager)=>{
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const previous=(await rows(manager,PersonRowSchema,`${PersonSelect} WHERE p.id=$1 FOR UPDATE`,[personId]))[0];
      if(!previous) throw new NotFoundException('Participant not found');
      if(previous.version!==command.version) throw new ConflictException('Participant changed. Reload before editing.');
      const skillIds=await validateSkillSelection(manager,command.skillIds,previous.skillIds);
      await assertRouteSkillsRetained(manager,previous.skillIds.filter((skillId)=>!skillIds.includes(skillId)),personId);
      await replaceParticipantSkills(manager,personId,skillIds);
      await manager.query('UPDATE person SET version=version+1 WHERE id=$1',[personId]);
      await this.store.audit(manager,actor,'participant.skills_updated',{id:personId,version:previous.version+1,previousSkillIds:previous.skillIds,skillIds});
      const result=(await this.selected(manager,[personId]))[0];
      if(!result) throw new Error('Saved participant skills readback failed');
      return result;
    });
  }

  private async rosterConflict(manager:EntityManager,participantIds:string[],crewId:string) {
    return (await rows(manager,z.object({personName:TextSchema,crewName:TextSchema}),`SELECT ${PERSON_NAME_SQL} AS "personName",c.name AS "crewName"
      FROM crew_member m JOIN person p ON p.id=m.person_id JOIN crew c ON c.id=m.crew_id
      WHERE m.person_id=ANY($1::uuid[]) AND m.crew_id<>$2 ORDER BY m.person_id,c.id LIMIT 1`,[participantIds,crewId]))[0];
  }

  async saveCrew(id:string|null,input:unknown,actor:OperatorActor) {
    requireAdmin(actor);
    const command=id?CrewUpdateInput.parse(input):CrewCreateInput.parse(input);
    const participantIds=command.participantIds.map((personId)=>personId.toLowerCase());
    distinctParticipants(participantIds);
    const crewId=id?IdSchema.parse(id).toLowerCase():randomUUID();
    const conflictError=(conflict:{personName:string;crewName:string})=>new ConflictException(`Participant "${conflict.personName}" already belongs to crew "${conflict.crewName}". Remove them from that default roster first.`);
    try{return await this.store.db.source.transaction(async(manager)=>{
      await manager.query('SELECT pg_advisory_xact_lock(7041001)');
      const previous=id?(await rows(manager,z.object({id:IdSchema,version:z.number().int().positive()}),'SELECT id,version FROM crew WHERE id=$1 FOR UPDATE',[crewId]))[0]:undefined;
      if(id&&!previous) throw new NotFoundException('Crew not found');
      if(previous&&(!('version' in command)||command.version!==previous.version)) throw new ConflictException('Crew changed. Reload before editing.');
      if(previous && !command.enabled) await assertRouteResourceMutable(manager,`crew:${crewId}`);
      await this.selected(manager,participantIds);
      const conflict=await this.rosterConflict(manager,participantIds,crewId);
      if(conflict) throw conflictError(conflict);
      const version=previous?previous.version+1:1;
      if(previous) await manager.query('UPDATE crew SET version=$2,name=$3,classification=$4,area=$5,enabled=$6 WHERE id=$1',
        [crewId,version,command.name,command.classification,command.area,command.enabled]);
      else await manager.query('INSERT INTO crew(id,version,name,classification,area,enabled) VALUES($1,1,$2,$3,$4,$5)',
        [crewId,command.name,command.classification,command.area,command.enabled]);
      await manager.query('DELETE FROM crew_member WHERE crew_id=$1',[crewId]);
      for(const [position,personId] of participantIds.entries()) await manager.query('INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,$3)',[crewId,personId,position]);
      await this.store.audit(manager,actor,'crew.saved',{id:crewId,version,enabled:command.enabled,participantIds});
      const saved=(await this.crews(manager,[crewId]))[0];
      if(!saved) throw new Error('Saved crew readback failed');
      return saved;
    });}catch(error:unknown){
      const driver:unknown=error instanceof QueryFailedError?error.driverError:null;
      if(z.object({code:z.literal('23505'),constraint:z.literal('crew_member_person_unique')}).safeParse(driver).success) {
        const conflict=await this.rosterConflict(this.store.db.source.manager,participantIds,crewId);
        if(conflict) throw conflictError(conflict);
        throw new ConflictException('A participant already belongs to another crew. Refresh the default rosters before editing.');
      }
      throw error;
    }
  }
}
