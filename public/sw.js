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

/* Notifications (US-81, US-83, US-94). Le message arrive chiffré pour cet appareil seul ; il ne contient que ce qui s'affiche,
 * le lien de l'écran à ouvrir et le nombre de confirmations en attente pour le badge de l'icône (US-84).
 * Sur iPhone, toute notification reçue doit être affichée : le badge n'est donc mis à jour qu'à la réception d'un message ou à l'ouverture de l'application. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const work = [
    self.registration.showNotification(data.title || "MAAQ", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/192",
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/assistant" },
    }),
  ];
  if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    work.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(work));
});

/* Un appui ouvre l'écran concerné : l'application déjà ouverte est mise au premier plan, sinon elle est lancée. L'application se verrouille
 * d'elle-même si besoin, puis revient à cet écran (AF-3). */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/assistant";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : undefined));
      return self.clients.openWindow(url);
    }),
  );
});
