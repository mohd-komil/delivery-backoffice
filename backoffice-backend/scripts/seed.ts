import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { makeDataSource, rows } from '../src/database/database';
import { hashPassword } from '../src/identity/identity';
import { TaskTemplateSchema } from '../src/domain/model';

const AccountsSchema=z.object({admin:z.object({email:z.string().email(),password:z.string().min(16)}),operator:z.object({email:z.string().email(),password:z.string().min(16)})});
const accountPath='.local/demo-accounts.json';
export async function seed(test=false) {
  await mkdir('.local',{recursive:true});
  let raw:unknown;
  try{raw=JSON.parse(await readFile(accountPath,'utf8'));}catch(error:unknown){
    if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT') throw error;
    raw={admin:{email:'admin@example.test',password:randomBytes(24).toString('base64url')},operator:{email:'francesca@example.test',password:randomBytes(24).toString('base64url')}};
    await writeFile(accountPath,JSON.stringify(raw,null,2),{flag:'wx'});
  }
  const accounts=AccountsSchema.parse(raw);
  const db=makeDataSource(test);await db.initialize();
  try{
    for(const role of ['admin','operator'] as const){
      const account=accounts[role];
      const existing=await rows(db.manager,z.object({id:z.string()}),'SELECT id FROM app_user WHERE email=$1',[account.email]);
      if(!existing.length) await db.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',[role==='admin'?'00000000-0000-4000-8000-000000000001':'00000000-0000-4000-8000-000000000002',account.email,role==='admin'?'Demo Administrator':'Francesca Demo',role,await hashPassword(account.password)]);
    }
    const names=['Messina Uno','Messina Due','Catania Uno','Catania Due','Assembly Studio','External Specialists'];
    for(let index=1;index<=6;index++){
      const id='10000000-0000-4000-8000-'+String(index).padStart(12,'0');
      const participantIds:string[]=[];
      for(let offset=0;offset<3;offset++){
        const number=(index-1)*3+offset+1;
        const personId='20000000-0000-4000-8000-'+String(number).padStart(12,'0');
        participantIds.push(personId);
        // Add missing synthetic identities only; never fill unknown fields or overwrite migrated/user-edited profiles.
        await db.query('INSERT INTO person(id,first_name,last_name,external,enabled) VALUES($1,$2,$3,$4,true) ON CONFLICT(id) DO NOTHING',
          [personId,'DEMO','Person '+String(number),index===6]);
      }
      const created=await rows(db.manager,z.object({id:z.string().uuid()}),
        'INSERT INTO crew(id,version,name,classification,area,enabled) VALUES($1,1,$2,$3,$4,true) ON CONFLICT(id) DO NOTHING RETURNING id',
        [id,names[index-1],index%2?'indoor':'outdoor',index<=2?'Messina':'Catania']);
      // A pre-existing crew owns its roster, including an intentionally empty roster.
      if(created.length) for(const [position,personId] of participantIds.entries()) await db.query(
        'INSERT INTO crew_member(crew_id,person_id,position) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,personId,position]);
    }
    const titles=['Check products','Check quantity','Check integrity','Assemble','Clean work area','Remove packaging'];
    for(let index=1;index<=6;index++){
      const id='30000000-0000-4000-8000-'+String(index).padStart(12,'0');
      const template=TaskTemplateSchema.parse({id,version:1,title:titles[index-1],severity:index===3?'high':'medium',order:index,checklist:[titles[index-1]??'Check task'],enabled:true});
      await db.query('INSERT INTO task_template(id,version,data) VALUES($1,1,$2::jsonb) ON CONFLICT DO NOTHING',[id,JSON.stringify(template)]);
    }
    const marker=await rows(db.manager,z.object({id:z.string()}),"SELECT id FROM audit WHERE action='demo.seeded' LIMIT 1");
    if(!marker.length) await db.query('INSERT INTO audit(id,actor_id,actor_name,action,details) VALUES($1,$2,$3,$4,$5::jsonb)',[randomUUID(),'00000000-0000-4000-8000-000000000001','Demo Administrator','demo.seeded',JSON.stringify({synthetic:true})]);
    console.log('Default synthetic users/crews/participants/templates are ready; existing profiles and rosters were preserved. Credentials: .local/demo-accounts.json (not committed).');
  }finally{await db.destroy();}
}
if(require.main===module) void seed(process.argv.includes('--test')).catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Seed failed');process.exitCode=1;});
