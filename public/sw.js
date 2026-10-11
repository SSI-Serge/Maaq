/* MAAQ — service worker.
 * Aucune donnée personnelle n'est mise en cache (US-2 RT2) : seule la page « hors connexion »
 * est conservée, pour l'afficher si MAAQ est lancée sans réseau (US-2 RF8).
 * Les pages passent toujours par le réseau : une nouvelle version s'applique au lancement suivant (US-2 RF9).
 */
const CACHE = "maaq-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
