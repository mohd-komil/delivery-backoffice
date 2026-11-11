import type { ReactNode } from 'react';
import { CrewWorkspace } from './crew-workspace';

export default function CrewLayout({ children }: { children: ReactNode }) {
  return <CrewWorkspace>{children}</CrewWorkspace>;
}
