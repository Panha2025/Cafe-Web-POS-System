import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/api/'),
  new NetworkOnly(),
);
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/uploads/'),
  async ({ request }) => {
    const cache = await caches.open('pos-catalog-assets-v1');
    return (await cache.match(request)) || fetch(request);
  },
);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/uploads\//],
  }),
);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_APPROVED_UPDATE') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
