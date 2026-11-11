const offlinePage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Delivery Crew · Offline</title>
<style>body{font:1rem system-ui,sans-serif;background:#f7f8f6;color:#152019;margin:0;padding:2rem;}
main{max-width:27rem;margin:12vh auto;}h1{font-size:1.65rem}a{color:#166534}</style></head>
<body><main><p>DELIVERY CREW</p><h1>You're offline</h1>
<p>Reconnect to view your current assignments.</p><p><a href="/">Try again</a></p></main></body></html>`;

self.addEventListener('fetch', (event) => {
  if (!(event instanceof FetchEvent)) return;
  const request = event.request;
  const path = new URL(request.url).pathname;
  if (request.mode !== 'navigate' || request.method !== 'GET' || path.startsWith('/api/')) return;

  // Never store authenticated pages, API responses, or customer data on the device.
  event.respondWith(fetch(request).catch(() => new Response(offlinePage, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  })));
});
