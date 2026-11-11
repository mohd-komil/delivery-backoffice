import { mkdir, writeFile } from 'node:fs/promises';
import { apiDocument } from '../src/openapi';
async function main(){await mkdir('docs',{recursive:true});await writeFile('docs/openapi.json',JSON.stringify(apiDocument(),null,2));console.log('OpenAPI written to docs/openapi.json');}
void main();
