import { runRouteBrowserDemo } from './demo-route-publication';

void runRouteBrowserDemo('lifecycle').catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Route lifecycle browser-demo failed');
  process.exitCode = 1;
});
