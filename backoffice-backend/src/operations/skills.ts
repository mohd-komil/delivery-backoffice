import { randomUUID } from 'node:crypto';
import { assertRouteSkillsRetained } from './route-reservations';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { rows } from '../database/database';
import { IdSchema, SkillIdsSchema, type OperatorActor, type PersonSnapshot, type SkillSnapshot } from '../domain/model';
import { SkillCreateInput, SkillSchema, SkillUpdateInput, type Participant, type Skill } from './contracts';
import { DeliveryStore } from './store';

const SkillSelect='SELECT id,version,name,description,enabled FROM skill';

async function readSkills(manager:EntityManager,ids:string[]):Promise<Skill[]> {
  if(ids.length===0) return [];
  return rows(manager,SkillSchema,`${SkillSelect} WHERE id=ANY($1::uuid[]) ORDER BY id`,[ids]);
}

/** Shared by profile edits, dedicated grants and task requirements; omission is resolved by the caller. */
export async function validateSkillSelection(manager:EntityManager,input:unknown,retainedIds:string[]):Promise<string[]> {
  const ids=SkillIdsSchema.parse(input).map((id)=>id.toLowerCase());
  const records=await readSkills(manager,ids);
  if(records.length!==ids.length) throw new NotFoundException('A selected skill does not exist');
  const retained=new Set(retainedIds.map((id)=>id.toLowerCase()));
  const disabled=records.find((skill)=>!skill.enabled&&!retained.has(skill.id));
  if(disabled) throw new ConflictException(`Disabled skill "${disabled.name}" cannot be newly granted or required`);
  return ids;
}

export async function replaceParticipantSkills(manager:EntityManager,personId:string,skillIds:string[]):Promise<void> {
  await manager.query('DELETE FROM participant_skill WHERE person_id=$1',[personId]);
  for(const skillId of skillIds) await manager.query('INSERT INTO participant_skill(person_id,skill_id) VALUES($1,$2)',[personId,skillId]);
}

@Injectable()
export class Skills {
  constructor(@Inject(DeliveryStore) private readonly store:DeliveryStore) {}

  async list():Promise<Skill[]> {
    const found=await rows(this.store.db.source.manager,SkillSchema,`${SkillSelect} ORDER BY lower(name),id LIMIT 5001`);
    if(found.length>5000) throw new ConflictException('The skill catalogue exceeds the 5000-record local demo limit');
    return found;
  }

  async get(rawId:string):Promise<Skill> {
    const id=IdSchema.parse(rawId).toLowerCase();
    const [skill]=await readSkills(this.store.db.source.manager,[id]);
    if(!skill) throw new NotFoundException('Skill not found');
    return skill;
  }

  async save(id:string|null,input:unknown,actor:OperatorActor):Promise<Skill> {
    // Both authenticated Backoffice roles manage this catalogue and participant qualifications.
    const command=id?SkillUpdateInput.parse(input):SkillCreateInput.parse(input);
    const skillId=id?IdSchema.parse(id).toLowerCase():randomUUID();
    try {
      return await this.store.db.source.transaction(async(manager)=>{
        await manager.query('SELECT pg_advisory_xact_lock(7041001)');
        const previous=id?(await rows(manager,SkillSchema,`${SkillSelect} WHERE id=$1 FOR UPDATE`,[skillId]))[0]:undefined;
        if(id&&!previous) throw new NotFoundException('Skill not found');
        if(previous&&(!('version' in command)||command.version!==previous.version)) throw new ConflictException('Skill changed. Reload before editing.');
        if(previous && !command.enabled) await assertRouteSkillsRetained(manager,[skillId]);
        const version=previous?previous.version+1:1;
        const description=command.description===undefined?previous?.description??null:command.description?.trim()||null;
        if(previous) await manager.query('UPDATE skill SET version=$2,name=$3,description=$4,enabled=$5 WHERE id=$1',[skillId,version,command.name,description,command.enabled]);
        else await manager.query('INSERT INTO skill(id,version,name,description,enabled) VALUES($1,1,$2,$3,$4)',[skillId,command.name,description,command.enabled]);
        await this.store.audit(manager,actor,previous?'skill.updated':'skill.created',{id:skillId,version,enabled:command.enabled});
        return SkillSchema.parse({id:skillId,version,name:command.name,description,enabled:command.enabled});
      });
    }catch(error:unknown){
      const driver:unknown=error instanceof QueryFailedError?error.driverError:null;
      if(z.object({code:z.literal('23505'),constraint:z.literal('skill_name_unique')}).safeParse(driver).success) throw new ConflictException('A skill with this name already exists');
      throw error;
    }
  }

  async requiredSnapshots(manager:EntityManager,ids:string[]):Promise<SkillSnapshot[]> {
    const unique=[...new Set(ids.map((id)=>IdSchema.parse(id).toLowerCase()))];
    const records=await readSkills(manager,unique);
    const found=new Map(records.map((skill)=>[skill.id,skill]));
    return unique.map((id)=>{
      const skill=found.get(id);
      if(!skill) throw new ConflictException(`Required skill "${id}" is unavailable`);
      return {id:skill.id,name:skill.name};
    });
  }

  /** Every actual person must independently cover every saved requirement; no default-roster inference. */
  async qualify(manager:EntityManager,people:Participant[],requirements:SkillSnapshot[],crewName:string):Promise<PersonSnapshot[]> {
    const required=new Map(requirements.map((skill)=>[skill.id.toLowerCase(),skill]));
    const ids=[...new Set([...required.keys(),...people.flatMap((person)=>person.skillIds)])];
    const found=new Map((await readSkills(manager,ids)).map((skill)=>[skill.id,skill]));
    for(const [id,requiredSkill] of required) {
      if(!found.get(id)?.enabled) throw new ConflictException(`Crew "${crewName}" requires disabled or unavailable skill "${requiredSkill.name}"`);
    }
    return people.map((person)=>{
      const granted=new Set(person.skillIds.map((id)=>id.toLowerCase()));
      const missing=[...required].filter(([id])=>!granted.has(id)).map(([,skill])=>skill.name);
      if(missing.length) throw new ConflictException(`Participant "${person.name}" in crew "${crewName}" lacks required skills: ${missing.join(', ')}`);
      const skillsSnapshot=person.skillIds.flatMap((id)=>{
        const skill=found.get(id.toLowerCase());
        return skill?.enabled?[{id:skill.id,name:skill.name}]:[];
      });
      return {id:person.id,name:person.name,external:person.external,skillsSnapshot};
    });
  }
}
