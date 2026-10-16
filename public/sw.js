// Minimal service worker so the controller can be installed as an app (and packaged as an APK).
const CACHE = 'tilt-rush-v1';
const SHELL = ['/play', '/controller.css', '/controller.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// Network first (the game needs a live connection anyway), cache as offline fallback for the app shell.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/socket.io')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
