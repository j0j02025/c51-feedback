"use strict";

const scope = new URL(self.registration.scope);
const lessonRoot = new URL("lessons/", scope).pathname;
const thumbRoot = new URL("thumbs/", scope).pathname;
const cachePrefix = "c51-lessons:" + scope.pathname + ":";
const cacheName = cachePrefix + "v1";
const shaParam = "c51-sha";
const minimumFree = 2 * 1024 ** 3;
const background = new Map();
const foreground = new Map();
const thumbCache = new Map();
const thumbWrites = new Map();
// Chrome drops cache.put calls that overlap. Every write waits for the one before it.
let cacheWrite = Promise.resolve();
function writeCache(action) {
  const result = cacheWrite.then(action, action);
  cacheWrite = result.then(() => {}, () => {});
  return result;
}
let versions;
let manifestRequest;
let cacheChanges = Promise.resolve();

// t3180: one background transfer at a time. The page cancels it when a lesson
// the reviewer opened needs the bandwidth (J 261123: clicked lesson jumps the queue).
let activeDownload = null;

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

function thumbURL(file) {
  if (typeof file !== "string") return null;
  try {
    const url = new URL(file, scope);
    const name = url.pathname.slice(thumbRoot.length);
    return url.origin === scope.origin && url.pathname.startsWith(thumbRoot) &&
      /^[^/]+\.(?:jpg|jpeg|png|webp)$/.test(name) && !/%(?:2f|5c)/i.test(name) ? url : null;
  } catch {
    return null;
  }
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
    const url = new URL("manifest.json", scope);
    // The review proxy keys its edge cache by c51-sha even for the manifest.
    if (url.hostname === "review.ooii.top") {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      url.searchParams.set(shaParam, hex(nonce));
    }
    const aborter = new AbortController();
    const timeout = setTimeout(() => aborter.abort(), 8000);
    let manifest;
    try {
      const response = await fetch(url, {
        cache: "no-store", mode: "same-origin", redirect: "error", signal: aborter.signal
      });
      if (!response.ok) throw new Error("Manifest unavailable");
      manifest = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    if (!Array.isArray(manifest.items)) throw new Error("Invalid manifest");
    const current = new Set();
    for (const item of manifest.items) {
      const url = lessonURL(item?.file);
      if (url && /^[a-f0-9]{64}$/.test(item.sha)) current.add(cacheKey(url, item.sha));
    }
    versions = current;
    const keys = await mutateCache(async cache => {
      const keys = await cache.keys();
      await Promise.all(keys.filter(key => !current.has(key.url)).map(key => cache.delete(key)));
      return keys.filter(key => current.has(key.url)).map(key => key.url);
    }).catch(() => null);
    return { manifest, keys: keys || [], offlineSupported: keys !== null };
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

// The clicked lesson needs the wire. Abort whatever background transfer holds it.
function yieldBandwidth() {
  activeDownload?.abort();
}

function coverCacheName(url, sha) {
  return "c51-thumb:" + sha + ":" + url.pathname.split("/").pop();
}

async function readCover(url, sha) {
  const own = coverCacheName(url, sha);
  await thumbWrites.get(own);
  return (await caches.open(own)).match("cover");
}

async function saveCover(url, sha, response) {
  if (!response.ok || response.redirected) return;
  const blob = await response.blob();
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  if (hex(new Uint8Array(digest)) !== sha) return;
  const own = coverCacheName(url, sha);
  const writing = writeCache(async () => {
    const store = await caches.open(own);
    await store.put("cover", new Response(blob));
  });
  thumbWrites.set(own, writing);
  try { await writing; }
  finally { if (thumbWrites.get(own) === writing) thumbWrites.delete(own); }
  return blob;
}

async function fetchThumb(file, sha) {
  const url = thumbURL(file);
  if (!url || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Unknown thumbnail");
  const key = cacheKey(url, sha);
  const hit = await readCover(url, sha);
  if (hit) return { cached: true, blob: await hit.blob() };
  const response = await fetch(key, {
    cache: "force-cache", mode: "same-origin", redirect: "error"
  });
  const blob = await saveCover(url, sha, response);
  return { cached: Boolean(blob), blob };
}

// Media referenced by a stub or a lesson, stored under its own fingerprint so an
// unchanged asset is never fetched twice. One at a time; abort yields the wire.
async function fetchAsset(url, sha, { signal, progress } = {}) {
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.origin !== scope.origin || !/^[a-f0-9]{64}$/.test(sha)) return false;
  const key = cacheKey(target, sha);
  const cache = await caches.open(cacheName);
  if (await cache.match(key)) return true;
  if (await lowStorage()) return false;
  const aborter = new AbortController();
  const stop = () => aborter.abort();
  signal?.addEventListener("abort", stop, { once: true });
  activeDownload = aborter;
  try {
    const response = await fetch(key, {
      cache: "no-store", mode: "same-origin", redirect: "error", signal: aborter.signal
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const encoding = response.headers.get("Content-Encoding");
    const total = !encoding || encoding === "identity"
      ? Number(response.headers.get("Content-Length")) : 0;
    let received = 0, last = -1;
    const stream = response.body?.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        const percent = total > 0 ? Math.min(99, Math.floor(received * 100 / total)) : null;
        if (percent !== last && progress) progress(last = percent);
        controller.enqueue(chunk);
      }
    }), { signal: aborter.signal });
    const bytes = await new Response(stream).arrayBuffer();
    if (aborter.signal.aborted) return false;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (hex(new Uint8Array(digest)) !== sha) return false;
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.set("Content-Length", String(bytes.byteLength));
    await mutateCache(async store => { await store.put(key, new Response(bytes, { headers })); });
    return true;
  } finally {
    if (activeDownload === aborter) activeDownload = null;
    signal?.removeEventListener("abort", stop);
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

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyLesson(key, response, { signal, progress } = {}) {
  if (!response.ok || response.status !== 200 || response.redirected ||
      !/^text\/html(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) {
    await response.body?.cancel().catch(() => {});
    return false;
  }

  // Hash the decoded bytes before either caching or displaying the lesson.
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
  if (hex(new Uint8Array(digest)) !== new URL(key).searchParams.get(shaParam)) return false;
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { headers });
}

// Foreground retries retain only the decoded bytes for the current iframe request.
const lessonIdleMs = 25000;
const lessonReconnectMs = 120000;

function waitToRetry(delay, signal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

async function downloadOpenedLesson(request, key, progress) {
  const signal = request.signal;
  let chunks = [], received = 0, total = 0, attempts = 0, outage = 0;
  let lastReport = 0, lastActivity = Date.now(), fresh = false;
  // Chromium requests identity for a byte range on GitHub Pages. A full GET can be gzip.
  let initialRange = scope.hostname.endsWith(".github.io");

  function report(state, force = false) {
    const now = Date.now();
    if (force || now - lastReport >= 150) {
      lastReport = now;
      progress?.({ received, total, state, percent: total ? Math.floor(received * 100 / total) : null });
    }
  }

  function reset() {
    chunks = [];
    received = total = 0;
  }

  while (!signal.aborted) {
    const url = new URL(key);
    if (fresh) url.searchParams.set("c51-reload", url.searchParams.get(shaParam));
    const headers = new Headers();
    if (received || initialRange) headers.set("Range", "bytes=" + received + "-");
    const aborter = new AbortController();
    const stop = () => aborter.abort();
    signal.addEventListener("abort", stop, { once: true });
    let timer;
    const restartIdleTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, lessonIdleMs);
    };
    try {
      restartIdleTimer();
      const response = await fetch(url, {
        headers, cache: "no-store", mode: "same-origin", redirect: "manual", signal: aborter.signal
      });
      if (response.type === "opaqueredirect") return response;
      const encoding = response.headers.get("Content-Encoding");
      const identity = !encoding || encoding === "identity";
      const part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
      let end = 0;
      if (response.status === 206 && identity && part && Number(part[1]) === received &&
          Number(part[2]) >= received && Number(part[2]) < Number(part[3]) &&
          Number.isSafeInteger(Number(part[3])) && (!total || total === Number(part[3]))) {
        total = Number(part[3]);
        end = Number(part[2]) + 1;
      } else if (response.status === 200) {
        reset(); // The origin ignored Range or this is a fresh download.
        const size = Number(response.headers.get("X-C51-Lesson-Length") ||
          (identity ? response.headers.get("Content-Length") : 0));
        if (Number.isSafeInteger(size) && size > 0) total = end = size;
      } else {
        if (response.status === 206 || response.status === 416) {
          initialRange = false;
          reset();
        }
        throw new Error("Lesson response unavailable");
      }

      const contentType = response.headers.get("Content-Type") || "";
      if (!/^text\/html(?:\s*;|$)/i.test(contentType) || !response.body) {
        throw new Error("Invalid lesson response");
      }
      report(outage && Date.now() - outage >= lessonReconnectMs ? "reconnecting" : "downloading", true);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          restartIdleTimer();
          if (!value.byteLength) continue;
          if (end && received + value.byteLength > end) {
            reset();
            throw new Error("Lesson response exceeds its byte range");
          }
          received += value.byteLength;
          chunks.push(value);
          // A trickle of bytes can take more than two minutes and still be healthy.
          attempts = outage = 0;
          lastActivity = Date.now();
          report("downloading");
        }
      } finally {
        reader.releaseLock();
      }

      if (end && received !== end) throw new Error("Lesson response ended early");
      if (total && received < total) continue;
      clearTimeout(timer);
      total = received;
      report("verifying", true);
      const blob = new Blob(chunks);
      chunks = [];
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      if (signal.aborted) break;
      if (hex(new Uint8Array(digest)) === new URL(key).searchParams.get(shaParam)) {
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete("Content-Encoding");
        responseHeaders.delete("Content-Range");
        responseHeaders.set("Content-Length", String(received));
        return new Response(blob, { headers: responseHeaders });
      }
      reset();
      if (!fresh) {
        fresh = true;
        continue;
      }
      // A second mismatch requires a fresh manifest before another attempt.
      return unavailableLesson();
    } catch {
      if (signal.aborted) break;
    } finally {
      clearTimeout(timer);
      aborter.abort();
      signal.removeEventListener("abort", stop);
    }

    if (total && received === total) reset();
    outage ||= lastActivity;
    const elapsed = Date.now() - outage;
    const prolonged = elapsed >= lessonReconnectMs;
    report(prolonged ? "reconnecting" : "interrupted", true);
    const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
    const delay = prolonged ? backoff : Math.min(backoff, lessonReconnectMs - elapsed);
    await waitToRetry(delay, signal);
    if (!signal.aborted && Date.now() - outage >= lessonReconnectMs) report("reconnecting", true);
  }

  return unavailableLesson();
}

async function storeLesson(key, response, { signal, manual } = {}) {
  if (!versions) await refreshManifest();
  const trim = manual && await lowStorage();
  return mutateCache(async cache => {
    if (signal?.aborted || !versions?.has(key)) return false;
    if (trim) await trimToLesson(cache, key);
    await cache.put(key, response);
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
        port.postMessage(await refreshManifest());
        return;
      }
      // t3180: covers are cached by fingerprint too, so a reload costs 0 requests.
      if (type === "thumb") {
        const key = file + "?" + sha;
        const existing = thumbCache.get(key);
        if (existing) { port.postMessage(await existing); return; }
        const download = fetchThumb(file, sha).catch(() => ({ cached: false }));
        thumbCache.set(key, download);
        try { port.postMessage(await download); }
        finally { if (thumbCache.get(key) === download) thumbCache.delete(key); }
        return;
      }
      // The reviewer opened a lesson: drop the background transfer immediately.
      if (type === "yield") { yieldBandwidth(); port.postMessage({ yielded: true }); return; }
      if (type === "asset") {
        const aborter = new AbortController();
        port.onmessage = () => aborter.abort();
        const ok = await fetchAsset(event.data?.url, sha, {
          signal: aborter.signal, progress: percent => port.postMessage({ percent })
        }).catch(() => false);
        port.postMessage({ cached: ok });
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
          activeDownload = aborter;
          const response = await fetch(key, {
            cache: "no-store", mode: "same-origin", redirect: "error", signal: aborter.signal
          });
          const verified = await verifyLesson(key, response, {
            signal: aborter.signal, progress: percent => port.postMessage({ percent })
          });
          return verified && storeLesson(key, verified, { signal: aborter.signal });
        })().catch(() => false);
        background.set(key, download);
        try {
          port.postMessage({ cached: await download });
        } finally {
          if (background.get(key) === download) background.delete(key);
          if (activeDownload === aborter) activeDownload = null;
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

function unavailableLesson() {
  return new Response('<!doctype html><html data-c51-unavailable><meta charset="utf-8"></html>', {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Read the saved cover when possible. Send the original request to the
  // network on a miss or storage failure and save the response separately.
  const cover = thumbURL(request.url);
  if (cover) {
    const sha = cover.searchParams.get(shaParam);
    if (!/^[a-f0-9]{64}$/.test(sha) || !isReviewPage(request.referrer)) return;
    const cached = readCover(cover, sha).catch(() => undefined);
    const fresh = cached.then(hit => hit ? undefined : fetch(request, { cache: "force-cache" }));
    event.respondWith(cached.then(hit => hit || fresh));
    event.waitUntil(fresh.then(response => {
      if (response?.ok && !response.redirected) return saveCover(cover, sha, response.clone());
    }).catch(() => {}));
    return;
  }

  if (new URL(request.url).pathname.endsWith("/sw-probe")) {
    const served = (async () => {
      const cache = await caches.open(cacheName);
      const sample = (await cache.keys()).find(k => k.url.includes("ru-lang-65-c.jpg"));
      const hit = sample && await cache.match(sample);
      return hit ? hit.clone() : new Response("nohit", { headers: { "Content-Type": "text/plain" } });
    })();
    event.respondWith(served);
    return;
  }

  // Fingerprinted media referenced by a lesson, same rule as the covers.
  const assetSha = new URL(request.url).searchParams.get(shaParam);
  if (request.destination !== "iframe" && /^[a-f0-9]{64}$/.test(assetSha) &&
      new URL(request.url).origin === scope.origin && isReviewPage(request.referrer)) {
    const key = cacheKey(new URL(request.url), assetSha);
    const cached = (async () => (await caches.open(cacheName)).match(key))().catch(() => undefined);
    event.respondWith(cached.then(hit => hit || fetch(request)));
    return;
  }

  if (request.destination !== "iframe" ||
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

    if (versions && !versions.has(key)) return { response: unavailableLesson() };
    // An iframe navigation may omit the initiating client ID.
    const client = event.clientId && await self.clients.get(event.clientId).catch(() => null);
    const reviewers = client?.url === request.referrer ? [client] :
      (await self.clients.matchAll({ type: "window" }).catch(() => []))
        .filter(candidate => candidate.url === request.referrer);
    const progress = reviewers.length === 1
      ? update => reviewers[0].postMessage({ type: "lesson-progress", key, ...update })
      : undefined;
    const verified = await downloadOpenedLesson(request, key, progress);
    // Preserve the login redirect so an expired session can be renewed.
    if (verified.type === "opaqueredirect") return { response: verified };
    if (!verified.ok || (versions && !versions.has(key))) return { response: unavailableLesson() };
    const stored = storeLesson(key, verified.clone(), { manual: true }).catch(() => false);
    trackForeground(key, stored);
    return { response: verified, stored };
  })().catch(() => ({ response: unavailableLesson() }));

  event.respondWith(result.then(value => value.response));
  event.waitUntil(result.then(value => value.stored).catch(() => {}));
});
