import { access, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
try {
  await access(resolve(projectRoot, '.next/dev/lock'));
  throw new Error('Stop this project\'s next dev process before typecheck/build. Next 16 generates duplicate route globals when both dev and build type caches are included.');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const generatedDevTypes = resolve(projectRoot, '.next/dev/types');
if (!generatedDevTypes.startsWith(projectRoot + sep)) throw new Error('Generated cache path escaped project root');
// These are disposable framework outputs. Fresh route types are generated below;
// first-party files and compiler coverage remain unchanged.
await rm(generatedDevTypes, { recursive: true, force: true });

function run(relativeBin: string, args: string[]) {
  const result = spawnSync(process.execPath, [resolve(projectRoot, 'node_modules', relativeBin), ...args], { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes('--build')) run('next/dist/bin/next', ['build']);
else { run('next/dist/bin/next', ['typegen']); run('typescript/bin/tsc', ['--noEmit']); }
