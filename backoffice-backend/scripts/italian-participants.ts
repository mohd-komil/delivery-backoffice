import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../src/config';
import { ParticipantSchema, UpdateParticipantInput, type Participant } from '../src/operations/contracts';
import { ItalianParticipantFixtureSchema, italianParticipantById, type ItalianParticipantFixture } from './italian-participant-data';

type ProfileUpdate=Omit<z.infer<typeof UpdateParticipantInput>,'password'>;
export type ItalianProfilePlan={update:ProfileUpdate|null;needsCredentials:boolean;credentialWarning:string|null};
function demoLabel(value:string|null):boolean {return value!==null&&/^DEMO(?:\s+Person\s+\d+|\s+Flex\s+Worker)?$/i.test(value.trim());}

export function planItalianProfile(input:Participant,fixtureInput:ItalianParticipantFixture):ItalianProfilePlan {
  const participant=ParticipantSchema.parse(input);
  const fixture=ItalianParticipantFixtureSchema.parse(fixtureInput);
  if(participant.id!==fixture.id) throw new Error('Italian fixture UUID does not match the participant');
  const demoPair=participant.firstName?.toUpperCase()==='DEMO'&&/^(?:Person\s+\d+|Flex\s+Worker)$/i.test(participant.lastName??'');
  const firstName=participant.firstName===null||demoLabel(participant.firstName)?fixture.firstName:participant.firstName;
  const lastName=participant.lastName===null||demoLabel(participant.lastName)||demoPair?fixture.lastName:participant.lastName;
  const preferredName=participant.preferredName===null||demoLabel(participant.preferredName)
    ?firstName===fixture.firstName&&lastName===fixture.lastName?fixture.preferredName:`${firstName} ${lastName}`:participant.preferredName;
  const needsCredentials=participant.login===null&&!participant.hasPassword;
  const credentialWarning=participant.login===null&&participant.hasPassword?'PASSWORD_WITHOUT_LOGIN_PRESERVED':null;
  const current:ProfileUpdate={version:participant.version,firstName:participant.firstName,lastName:participant.lastName,
    preferredName:participant.preferredName,phoneNumber:participant.phoneNumber,address:participant.address,
    login:participant.login,external:participant.external,enabled:participant.enabled};
  const update:ProfileUpdate={...current,firstName,lastName,preferredName,
    phoneNumber:participant.phoneNumber??fixture.phoneNumber,address:participant.address??fixture.address,
    login:needsCredentials?fixture.login:participant.login};
  return {update:JSON.stringify(current)===JSON.stringify(update)?null:UpdateParticipantInput.parse(update),needsCredentials,credentialWarning};
}

const Accounts=z.object({admin:z.object({email:z.string().email(),password:z.string().min(1).max(256)})});
const ManifestSchema=z.object({formatVersion:z.literal(1),accounts:z.array(z.object({
  id:z.string().uuid(),login:z.string().min(3).max(200),password:z.string().min(15).max(256),
}).strict()).max(5000)}).strict().refine((manifest)=>new Set(manifest.accounts.map((account)=>account.id)).size===manifest.accounts.length,'Duplicate account identity');
type Manifest=z.infer<typeof ManifestSchema>;
export type ItalianParticipantsOptions={baseUrl?:string;accountsPath?:string;manifestPath?:string;fetcher?:typeof fetch};
export type ItalianParticipantsSummary={updated:number;unchanged:number;unmapped:number;credentialWarnings:{id:string;code:string}[]};

async function localJson<T>(filename:string,schema:z.ZodType<T>):Promise<T> {
  const source=await readFile(filename,'utf8');
  let raw:unknown;
  try{raw=JSON.parse(source);}catch{throw new Error('A local demo JSON file is invalid; it was not overwritten');}
  const parsed=schema.safeParse(raw);
  if(!parsed.success) throw new Error('A local demo JSON file has an invalid format; it was not overwritten');
  return parsed.data;
}

export async function runItalianParticipants(options:ItalianParticipantsOptions={}):Promise<ItalianParticipantsSummary> {
  const base=new URL(options.baseUrl??'http://127.0.0.1:3001/api');
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.search||base.hash||base.pathname.replace(/\/$/,'')!=='/api') throw new Error('Italian demo population requires an explicit loopback HTTP API');
  const baseUrl=base.toString().replace(/\/$/,'');
  const accountsPath=options.accountsPath??'.local/demo-accounts.json';
  const manifestPath=path.resolve(options.manifestPath??'.local/participant-demo-accounts.json');
  const fetcher=options.fetcher??fetch;
  const origin=config().FRONTEND_ORIGIN;
  const summary:ItalianParticipantsSummary={updated:0,unchanged:0,unmapped:0,credentialWarnings:[]};
  let cookie:string|null=null;
  let primaryFailure=false;
  let ownsLock=false;
  const lockPath=manifestPath+'.lock';
  async function request<T>(route:string,schema:z.ZodType<T>,method='GET',body?:unknown):Promise<{data:T;response:Response}> {
    let response:Response;
    try{response=await fetcher(baseUrl+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
    catch{throw new Error('Demo HTTP response could not be verified. The partial run stopped; rerun to reconcile current profiles without rotating credentials.');}
    if(!response.ok) throw new Error(`Demo HTTP request failed (${response.status}). The run stopped; review current profiles before retrying.`);
    let raw:unknown;
    try{raw=await response.json();}catch{throw new Error('Demo API returned invalid JSON; the run stopped without assuming success.');}
    const parsed=schema.safeParse(raw);
    if(!parsed.success) throw new Error('Demo API returned an unexpected contract; the run stopped without assuming success.');
    return {data:parsed.data,response};
  }
  try{
    await mkdir(path.dirname(manifestPath),{recursive:true,mode:0o700});
    try{await writeFile(lockPath,String(process.pid),{flag:'wx',mode:0o600});ownsLock=true;}
    catch{throw new Error('A demo account manifest lock already exists or cannot be created. Review the local lock before retrying.');}
    let manifest:Manifest={formatVersion:1,accounts:[]};
    let manifestExists=false;
    try{manifest=await localJson(manifestPath,ManifestSchema);manifestExists=true;}
    catch(error:unknown){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT') throw error;}
    async function persistCredentials(id:string,login:string):Promise<string> {
      const existing=manifest.accounts.find((account)=>account.id===id);
      if(existing){if(existing.login!==login) throw new Error('Existing demo credential metadata differs from the fixture; review it without rotating the password');return existing.password;}
      const password=randomBytes(24).toString('base64url');
      const next:Manifest={formatVersion:1,accounts:[...manifest.accounts,{id,login,password}]};
      const serialized=JSON.stringify(next,null,2)+'\n';
      if(!manifestExists){await writeFile(manifestPath,serialized,{flag:'wx',mode:0o600});manifestExists=true;}
      else{
        const temporary=manifestPath+'.'+randomUUID()+'.pending';
        try{await writeFile(temporary,serialized,{flag:'wx',mode:0o600});await rename(temporary,manifestPath);}
        finally{try{await unlink(temporary);}catch(error:unknown){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT') throw error;}}
      }
      manifest=next;
      return password;
    }
    const accounts=await localJson(accountsPath,Accounts);
    const login=await request('/auth/login',z.object({id:z.string().uuid(),name:z.string(),role:z.literal('admin')}),'POST',accounts.admin);
    const candidate=login.response.headers.get('set-cookie')?.split(';')[0];
    if(!candidate||!/^backoffice_session=[0-9a-f]{64}$/.test(candidate)) throw new Error('Admin login did not return the expected local session');
    cookie=candidate;
    const participants=(await request('/participants',z.array(ParticipantSchema).max(5000))).data;
    for(const participant of participants){
      const fixture=italianParticipantById.get(participant.id);
      if(!fixture){summary.unmapped++;continue;}
      const plan=planItalianProfile(participant,fixture);
      if(plan.credentialWarning) summary.credentialWarnings.push({id:participant.id,code:plan.credentialWarning});
      if(!plan.update){summary.unchanged++;continue;}
      const password=plan.needsCredentials?await persistCredentials(participant.id,fixture.login):undefined;
      const body=password===undefined?plan.update:{...plan.update,password};
      const saved=(await request('/participants/'+participant.id,ParticipantSchema,'PATCH',body)).data;
      const savedFields=z.record(z.string(),z.unknown()).parse(saved);
      const {version,...expected}=plan.update;
      if(saved.id!==participant.id||saved.version!==version+1||Object.entries(expected).some(([key,value])=>savedFields[key]!==value)||plan.needsCredentials&&!saved.hasPassword) throw new Error('Participant write readback differs from the requested profile; the partial run stopped');
      summary.updated++;
    }
    return summary;
  }catch(error:unknown){primaryFailure=true;throw error;}
  finally{
    try{
      if(cookie) try{await request('/auth/logout',z.object({ok:z.literal(true)}),'POST',{});}
      catch{if(!primaryFailure) throw new Error('Profiles were reconciled but logout could not be verified; inspect the local admin session');}
    }finally{if(ownsLock) await unlink(lockPath);}
  }
}

if(require.main===module){
  if(process.argv.length>2) throw new Error('This opt-in command uses the fixed local API and accepts no CLI arguments');
  void runItalianParticipants().then((summary)=>{
    console.log(`Italian demo profiles: ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.unmapped} unmapped, ${summary.credentialWarnings.length} credential warnings.`);
    console.log('Generated credentials remain in .local/participant-demo-accounts.json. No crew/member/appointment/history updates or participant sign-in were created.');
  }).catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Italian demo population stopped');process.exitCode=1;});
}
