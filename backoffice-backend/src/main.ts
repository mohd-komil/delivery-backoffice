import { createApp } from './app';
import { config } from './config';
async function main() {
  const environment=config();
  const app=await createApp();
  await app.listen(environment.PORT,environment.HOST);
  console.log('Backoffice API listening on http://'+environment.HOST+':'+String(environment.PORT)+'/api');
}
void main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
