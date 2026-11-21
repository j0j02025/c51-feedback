"use strict";

const scope = new URL(self.registration.scope);
const lessonRoot = new URL("lessons/", scope).pathname;
const cachePrefix = "c51-lessons:" + scope.pathname + ":";
const cacheName = cachePrefix + "v1";
const shaParam = "c51-sha";
const minimumFree = 2 * 1024 ** 3;
const background = new Map();
const foreground = new Map();
let versions;
let manifestRequest;
let cacheChanges = Promise.resolve();

function lessonURL(file) {
  if (typeof file !== "string") return null;
  try {
    const url = new URL(file, scope);
    const name = url.pathname.slice(lessonRoot.length);
    return url.origin === scope.origin && url.pathname.startsWith(lessonRoot) &&
      /^[^/]+\.html$/.test(name) && !/%(?:2f|5c)/i.test(name) ? url : null;
  } catch {
    return null;
  }
}

function cacheKey(url, sha) {
  const key = new URL(url.pathname, scope);
  key.searchParams.set(shaParam, sha);
  return key.href;
}

function isReviewPage(value) {
  try {
    const url = new URL(value);
    return url.origin === scope.origin &&
      (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
  } catch {
    return false;
  }
}

function mutateCache(action) {
  const result = cacheChanges.then(async () => action(await caches.open(cacheName)));
  cacheChanges = result.catch(() => {});
  return result;
}

function refreshManifest() {
  if (manifestRequest) return manifestRequest;
  manifestRequest = (async () => {
    const response = await fetch(new URL("manifest.json", scope), {
      cache: "no-store", mode: "same-origin", redirect: "error"
    });
    if (!response.ok) throw new Error("Manifest unavailable");
    const manifest = await response.json();
    if (!Array.isArray(manifest.items)) throw new Error("Invalid manifest");
    const current = new Set();
    for (const item of manifest.items) {
      const url = lessonURL(item?.file);
      if (url && /^[a-f0-9]{64}$/.test(item.sha)) current.add(cacheKey(url, item.sha));
    }
    return mutateCache(async cache => {
      versions = current;
      const keys = await cache.keys();
      await Promise.all(keys.filter(key => !current.has(key.url)).map(key => cache.delete(key)));
      return keys.filter(key => current.has(key.url)).map(key => key.url);
    });
  })().finally(() => { manifestRequest = null; });
  return manifestRequest;
}

async function cachedLesson(key) {
  if (versions && !versions.has(key)) return undefined;
  try {
    return await (await caches.open(cacheName)).match(key);
  } catch {
    return undefined;
  }
}

async function lowStorage() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return Number.isFinite(quota) && Number.isFinite(usage) && quota - usage < minimumFree;
  } catch {
    return false;
  }
}

function trimToLesson(cache, key) {
  return cache.keys().then(keys =>
    Promise.all(keys.filter(item => item.url !== key).map(item => cache.delete(item)))
  );
}

function trackForeground(key, stored) {
  foreground.set(key, stored);
  stored.finally(() => {
    if (foreground.get(key) === stored) foreground.delete(key);
  });
}

async function storeLesson(key, response, { signal, progress, manual } = {}) {
  if (!response.ok || response.status !== 200 || response.redirected ||
      !/^text\/html(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) {
    await response.body?.cancel().catch(() => {});
    return false;
  }

  // Read once, verify the actual bytes, then write the complete version atomically.
  // The proxy's edge cache can briefly serve an older body for the same filename.
  let body = response.body;
  if (progress && body) {
    const encoding = response.headers.get("Content-Encoding");
    const total = !encoding || encoding === "identity"
      ? Number(response.headers.get("Content-Length")) : 0;
    let received = 0;
    let last = -1;
    body = body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        const percent = total > 0 ? Math.min(99, Math.floor(received * 100 / total)) : null;
        if (percent !== last) progress(last = percent);
        controller.enqueue(chunk);
      }
    }), { signal });
  }
  const bytes = await new Response(body).arrayBuffer();
  if (signal?.aborted) return false;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha !== new URL(key).searchParams.get(shaParam)) return false;

  if (!versions) await refreshManifest();
  const trim = manual && await lowStorage();
  return mutateCache(async cache => {
    if (signal?.aborted || !versions?.has(key)) return false;
    if (trim) await trimToLesson(cache, key);
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.set("Content-Length", String(bytes.byteLength));
    await cache.put(key, new Response(bytes, { headers }));
    return true;
  });
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
        .map(name => caches.delete(name)));
    } catch {
      // A storage failure must never prevent the worker from serving network lessons.
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  const port = event.ports[0];
  if (!port || !isReviewPage(event.source?.url)) return;
  event.waitUntil((async () => {
    const { type, file, sha } = event.data || {};
    try {
      if (type === "sync") {
        port.postMessage({ keys: await refreshManifest() });
        return;
      }
      const url = lessonURL(file);
      if (!url || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Unknown lesson");
      const key = cacheKey(url, sha);
      if (type === "status") {
        await foreground.get(key);
        port.postMessage({ cached: Boolean(await cachedLesson(key)), lowStorage: await lowStorage() });
        return;
      }
      if (type !== "preload") return;

      const aborter = new AbortController();
      port.onmessage = () => aborter.abort();
      const timeout = setTimeout(() => aborter.abort(), 90000);
      try {
        if (await lowStorage()) {
          port.postMessage({ lowStorage: true });
          return;
        }
        if (!versions) await refreshManifest();
        if (!versions.has(key) || aborter.signal.aborted) throw new Error("Inactive lesson version");

        // Reuse an existing transfer if another tab or the iframe has this version in flight.
        const cached = await cachedLesson(key);
        const existing = background.get(key) || foreground.get(key);
        if (cached || (existing && await existing && await cachedLesson(key))) {
          port.postMessage({ cached: true });
          return;
        }
        if (aborter.signal.aborted) throw new Error("Preload cancelled");

        const download = (async () => {
          const response = await fetch(key, {
            cache: "reload", mode: "same-origin", redirect: "error", signal: aborter.signal
          });
          return storeLesson(key, response, {
            signal: aborter.signal, progress: percent => port.postMessage({ percent })
          });
        })().catch(() => false);
        background.set(key, download);
        try {
          port.postMessage({ cached: await download });
        } finally {
          if (background.get(key) === download) background.delete(key);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      port.postMessage({ error: true });
    } finally {
      port.close();
    }
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.destination !== "iframe" ||
      request.headers.has("Range") || !isReviewPage(request.referrer)) return;
  const url = lessonURL(request.url);
  const sha = url?.searchParams.get(shaParam);
  if (!/^[a-f0-9]{64}$/.test(sha)) return;
  const key = cacheKey(url, sha);

  const result = (async () => {
    let cached = await cachedLesson(key);
    if (!cached && background.has(key)) {
      await background.get(key);
      cached = await cachedLesson(key);
    }
    if (cached) {
      const stored = lowStorage().then(low => low && mutateCache(cache => trimToLesson(cache, key)))
        .catch(() => {});
      trackForeground(key, stored);
      return { response: cached, stored };
    }

    const response = await fetch(request, { cache: "reload" });
    const stored = storeLesson(key, response.clone(), { manual: true }).catch(() => false);
    trackForeground(key, stored);
    return { response, stored };
  })().catch(async () => ({ response: await fetch(request) }));

  event.respondWith(result.then(value => value.response));
  event.waitUntil(result.then(value => value.stored).catch(() => {}));
});
