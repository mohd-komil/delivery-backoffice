import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createApp } from '../src/app';
import { Identity } from '../src/identity/identity';
import { Importer } from '../src/integration/importer';
const Accounts=z.object({operator:z.object({email:z.string().email(),password:z.string()})});
async function main() {
  if(process.env['NODE_ENV']==='production') throw new Error('This local importer runner is for the synthetic demo only');
  const app=await createApp(true);await app.init();
  try{
    const raw:unknown=JSON.parse(await readFile('.local/demo-accounts.json','utf8'));
    const account=Accounts.parse(raw).operator;
    const identity=app.get(Identity);
    const loggedIn=await identity.login(account);
    const request={headers:{cookie:'backoffice_session='+loggedIn.token}};
    const operator=await identity.authenticate(request);
    const importer=app.get(Importer);
    const run=async()=>{const result=await importer.run(operator);console.log(JSON.stringify({id:result.id,status:result.status,processed:result.processed,error:result.error}));};
    await run();
    if(process.argv.includes('--watch')){
      console.log('Local repeat scan every 60 seconds. Ctrl+C to stop.');
      const interval=setInterval(()=>{void run().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Import failed');});},60000);
      await new Promise<void>((resolve)=>{
        const stop=()=>{clearInterval(interval);resolve();};
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });
    }
    await identity.logout(request);
  }finally{await app.close();}
}
void main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Import runner failed');process.exitCode=1;});
