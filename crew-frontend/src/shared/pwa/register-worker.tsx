'use client';

import { useEffect } from 'react';

export function RegisterWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Installation support is optional; the online application remains usable.
    });
  }, []);

  return null;
}
