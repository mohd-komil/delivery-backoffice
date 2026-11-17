'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest } from './api';

export const sourceHealthSchema = z.object({ status: z.literal('ok'), sourceKind: z.enum(['synthetic', 'odoo_readonly']) });
export type WorkspaceSource = 'loading' | 'unknown' | z.infer<typeof sourceHealthSchema>['sourceKind'];

export const workspaceSourceMessages = {
  loading: { workspace: 'localWorkspace', badge: 'checkingSource', description: 'checkingSource', login: 'checkingSource', imports: 'checkingSource' },
  unknown: { workspace: 'localWorkspace', badge: 'sourceUnknown', description: 'sourceUnknownHelp', login: 'sourceUnknownHelp', imports: 'sourceUnknownHelp' },
  synthetic: { workspace: 'demoWorkspace', badge: 'syntheticOnly', description: 'sourceTeaching', login: 'loginFoot', imports: 'importNotice' },
  odoo_readonly: { workspace: 'connectedWorkspace', badge: 'odooReadOnly', description: 'sourceOdooReadOnly', login: 'loginOdooReadOnly', imports: 'importOdooReadOnly' },
} as const;

export function useWorkspaceSource(enabled = true): WorkspaceSource {
  const [source, setSource] = useState<WorkspaceSource>('loading');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void apiRequest('/health', sourceHealthSchema, { signal: controller.signal }).then(
      ({ sourceKind }) => { if (!controller.signal.aborted) setSource(sourceKind); },
      () => { if (!controller.signal.aborted) setSource('unknown'); },
    );
    return () => controller.abort();
  }, [enabled]);
  return source;
}
