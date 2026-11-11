'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from './client';

export type ResourceState<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T; checkedAt: string; refreshError: number | null }
  | { state: 'error'; status: number };

function isTransient(status: number) {
  return status === 0 || status === 429 || status >= 500;
}

export function useCrewResource<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, revision?: (data: T) => number) {
  const [resource, setResource] = useState<ResourceState<T>>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const active = useRef<AbortController | null>(null);

  const loadData = useCallback(() => {
    if (active.current) return Promise.resolve();

    const controller = new AbortController();
    active.current = controller;
    return load(controller.signal).then((result) => {
      if (active.current !== controller) return;

      active.current = null;
      if (result.ok) {
        const checkedAt = new Date().toISOString();
        setResource((previous) => ({
          state: 'ready',
          data: previous.state === 'ready' && revision && revision(previous.data) > revision(result.data) ? previous.data : result.data,
          checkedAt,
          refreshError: null,
        }));
        return;
      }

      const status = result.status;
      setResource((previous) => previous.state === 'ready' && isTransient(status)
        ? { ...previous, refreshError: status }
        : { state: 'error', status });

      if (status === 401) window.location.replace('/login');
    });
  }, [load, revision]);

  useEffect(() => {
    void loadData();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadData();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void loadData();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      active.current?.abort();
      active.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [loadData]);

  function refresh() {
    if (active.current) return;
    setRefreshing(true);
    void loadData().finally(() => setRefreshing(false));
  }

  function revalidate() {
    active.current?.abort();
    active.current = null;
    return loadData();
  }

  function publish(data: T) {
    const checkedAt = new Date().toISOString();
    setResource((previous) => previous.state === 'ready' && (!revision || revision(data) >= revision(previous.data))
      ? { state: 'ready', data, checkedAt, refreshError: null }
      : previous);
  }

  return { resource, refreshing, refresh, revalidate, publish };
}
