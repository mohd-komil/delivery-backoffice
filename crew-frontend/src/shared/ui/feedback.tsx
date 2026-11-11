import type { ReactNode } from 'react';
import { Icon } from './icon';

export function Notice({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`notice notice-${tone}`}><Icon name="alert" /> <div>{children}</div></div>;
}

export function Loading({ children }: { children: ReactNode }) {
  return <div className="panel loading-panel" role="status"><span className="spinner" aria-hidden="true" />{children}</div>;
}
