import { runRouteBrowserDemo } from './demo-route-publication';

void runRouteBrowserDemo('acceptance').catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Stage 10 isolated demo failed');
  process.exitCode = 1;
});
