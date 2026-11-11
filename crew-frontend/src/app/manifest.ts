import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Delivery Crew',
    short_name: 'Crew',
    description: 'Your assigned delivery visits and customer confirmation status.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#152019',
    background_color: '#f7f8f6',
    icons: [
      { src: '/icons/crew-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/crew-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/crew-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
