/* Raffle Platform service worker (hand-written, no build step).
 *
 * - Precaches the offline fallback page and app shell assets (Req 21.1).
 * - Raffle pages: stale-while-revalidate with a 7-day expiry (Req 21.2, 21.3).
 * - Offline and no usable cached copy: serve the offline notice, never a broken page (Req 21.3).
 * - A new worker waits until the user confirms the update prompt (Req 21.9, 21.10).
 * - Web push display for non-mandatory notifications (Req 21.6, 21.7).
 */
/* global self, caches, fetch, Response, Headers, URL, Notification */
const VERSION = "v1";
const SHELL_CACHE = "raffle-shell-" + VERSION;
const PAGES_CACHE = "raffle-pages-" + VERSION;
const ASSETS_CACHE = "raffle-assets-" + VERSION;
const KNOWN_CACHES = [SHELL_CACHE, PAGES_CACHE, ASSETS_CACHE];

const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [OFFLINE_URL, "/icon.svg", "/manifest.webmanifest"];
const RAFFLE_PAGE_PATTERN = /^\/(raffles?|r)(\/|$)/;
const PAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-sw-cached-at";

function isRafflePage(url) {
  return RAFFLE_PAGE_PATTERN.test(url.pathname);
}

function isFresh(response, now) {
  const at = Number(response.headers.get(CACHED_AT_HEADER));
  return Number.isFinite(at) && at > 0 && now - at <= PAGE_MAX_AGE_MS;
}

async function stamp(response, now) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(now));
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function offlineResponse() {
  const cached = await caches.match(OFFLINE_URL);
  return (
    cached || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
  );
}

async function revalidateRafflePage(request) {
  const response = await fetch(request);
  if (response && response.status === 200 && response.type === "basic") {
    const cache = await caches.open(PAGES_CACHE);
    await cache.put(request.url, await stamp(response.clone(), Date.now()));
  }
  return response;
}

async function handleRafflePage(event) {
  const request = event.request;
  const cache = await caches.open(PAGES_CACHE);
  const cached = await cache.match(request.url);
  if (cached && isFresh(cached, Date.now())) {
    // Stale-while-revalidate: answer from cache, refresh in the background.
    event.waitUntil(revalidateRafflePage(request).catch(() => undefined));
    return cached;
  }
  if (cached) await cache.delete(request.url); // expired (older than 7 days)
  try {
    return await revalidateRafflePage(request);
  } catch {
    return offlineResponse();
  }
}

async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  // No skipWaiting here: the update prompt asks the user first (Req 21.9).
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !KNOWN_CACHES.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache API traffic

  if (request.mode === "navigate") {
    event.respondWith(isRafflePage(url) ? handleRafflePage(event) : handleNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(handleStaticAsset(request));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // Web push is an extra channel for non-mandatory notifications only.
  if (data.mandatory === true) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  event.waitUntil(
    self.registration.showNotification(data.title || "Raffle Platform", {
      body: data.body || "",
      icon: "/icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(self.clients.openWindow(target));
});
