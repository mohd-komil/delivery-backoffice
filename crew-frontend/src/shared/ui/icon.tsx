import type { ReactNode } from 'react';

const shapes = {
  truck: <><path d="M1 4h14v13H1zM15 9h4l3 3v5h-7"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.9 7.3a7 7 0 0 1 11.5-1L20 12M4 12l2.6 5.7a7 7 0 0 0 11.5-1"/></>,
  pin: <><path d="M20 10c0 5-8 10-8 10s-8-5-8-10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  arrowRight: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  arrowLeft: <path d="M19 12H5m6 6-6-6 6-6"/>,
  external: <><path d="M13 5h6v6m0-6-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>,
  logout: <><path d="M10 17l5-5-5-5m5 5H3"/><path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="m3 3 18 18M10.7 10.7a2 2 0 0 0 2.6 2.6M7 7a15 15 0 0 0-5 5s3.5 6 10 6c1.5 0 3-.3 4.1-.9M11 6h1c6.5 0 10 6 10 6a13 13 0 0 1-2.3 2.7"/></>,
  alert: <><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></>,
  phone: <path d="M6.5 3h3l1.5 4-2.2 1.9a14 14 0 0 0 6.3 6.3L17 13l4 1.5v3a2 2 0 0 1-2 2C10.4 19.5 4.5 13.6 4.5 5a2 2 0 0 1 2-2Z"/>,
  mobile: <><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></>,
  chevron: <path d="m6 9 6 6 6-6"/>,
  users: <><path d="M3 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2m1-6a4 4 0 0 1 3 4v2"/><circle cx="10" cy="7" r="3"/><path d="M17 4a3 3 0 0 1 0 6"/></>,
  box: <><path d="m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M7.5 5l9 4"/></>,
  list: <><path d="M10 6h10m-10 6h10m-10 6h10M4 6h1m-1 6h1m-1 6h1"/></>,
  note: <><path d="M6 3h8l4 4v14H6zM14 3v5h4m-9 4h6m-6 4h6"/></>,
  camera: <><path d="M4 6h4l2-2h4l2 2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></>,
} satisfies Record<string, ReactNode>;

export function Icon({ name, size = 18 }: { name: keyof typeof shapes; size?: number }) {
  return <svg aria-hidden="true" className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}
