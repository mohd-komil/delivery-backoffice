import { makeDataSource } from '../src/database/database';
const source = makeDataSource(process.argv.includes('--test'));
async function main() {
  await source.initialize();
  try { const applied = await source.runMigrations({transaction:'all'}); console.log('Applied migrations:', applied.map((migration) => migration.name)); }
  finally { await source.destroy(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
