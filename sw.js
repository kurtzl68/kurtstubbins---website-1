/* Offline support for FutureLog and BoxScout. Plain ASCII on purpose.
 * - App pages and sync.js: network first, cached copy when offline.
 * - Google Fonts: cache first.
 * - /api/ and everything else: not touched.
 */
var CACHE = 'apps-v1';
var PAGES = ['/futurelog', '/boxscout', '/sync.js'];

function norm(u) {
  var x = new URL(u);
  return x.origin + x.pathname.replace(/\.html$/, '');
}
function isApp(u) {
  var x = new URL(u);
  if (x.origin !== self.location.origin) return false;
  var p = x.pathname.replace(/\.html$/, '');
  return PAGES.indexOf(p) >= 0;
}

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (isApp(req.url)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(norm(req.url), copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(norm(req.url)).then(function (hit) {
          return hit || new Response('Offline and not yet cached. Open this page once while online.', { status: 503, headers: { 'content-type': 'text/plain' } });
        });
      })
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
  }
});
