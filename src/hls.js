// Best-effort HLS "Auto" resolution labeling. Top Cinema and Egydead resolve
// HLS *master* playlists and tag them `quality: 'auto'` (the master itself
// lists every variant, so there's no single "the" resolution at resolve
// time) — a master playlist body has lines like:
//   #EXT-X-STREAM-INF:BANDWIDTH=...,RESOLUTION=1920x1080,...
//   https://.../1080p/index.m3u8
// This module reads that master (server-side, with the stream's own
// referer/origin — these CDN links are IP-bound and 403 without them) and
// relabels "auto" with the real max height, e.g. "1080", so addon.js's
// qualityLabel turns it into "1080p" instead of showing "Auto".
const { fetchText } = require('./fetcher');

// Pure parser: scan every RESOLUTION=WxH tag in a master playlist body and
// return the largest height found, or null if none exist (a media playlist,
// an error page, an empty body, etc.). No network, no state — testable
// offline unlike enrichHlsQuality below.
function parseMaxResolution(text) {
  if (!text) return null;
  let max = null;
  const re = /RESOLUTION=(\d+)x(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const h = Number(m[2]);
    if (Number.isFinite(h) && (max === null || h > max)) max = h;
  }
  return max;
}

// Run async `fn` over `items` with at most `limit` in flight — same bounded-
// concurrency pattern as topcinema.js/egydead.js's mapPool, copied locally
// so this module has no dependency on either provider.
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

// Single-stream enricher: the unit the batch version below is built from, and
// also called directly by providers that interleave enrichment into their
// resolve pool (kick this off the moment a stream is discovered rather than
// waiting for the whole provider race to finish — see topcinema.js/
// egydead.js). Self-filtering and fail-open, so it's always safe to call on
// every stream unconditionally: non-"auto"/non-.m3u8 streams are a no-op, and
// any fetch/parse failure just leaves "auto" in place. Mutates `stream` in
// place and returns nothing (mirrors enrichHlsQuality's per-item behavior).
async function enrichStreamQuality(stream, { timeout = 3000 } = {}) {
  if (!/^auto$/i.test(String(stream.quality || ''))) return;
  if (!/\.m3u8(\?|$)/i.test(String(stream.url || ''))) return;
  try {
    const headers = {
      ...(stream.referer ? { Referer: stream.referer } : {}),
      ...(stream.origin ? { Origin: stream.origin } : {}),
    };
    const { text } = await fetchText(stream.url, { headers, timeout });
    const h = parseMaxResolution(text);
    if (h) stream.quality = String(h);
  } catch {
    /* fetch/timeout/403 — leave "auto" as-is, fail open */
  }
}

// Best-effort, fail-open: mutate `streams` in place, replacing quality
// "auto"/"Auto" with the real max height wherever we can fetch and parse the
// master playlist in time. Must NEVER cost the caller streams — addon.js
// gives each provider a 16s hard budget and drops ALL of a provider's
// streams if it's blown, so the cap here is budget-aware rather than a fixed
// guess: when the caller passes its wall-clock `deadline` (how much of that
// 16s is actually left after search/match/resolve already ran), the cap is
// derived from that, shaved by SAFETY_MARGIN_MS so this always finishes
// (or is skipped outright) well before the provider budget fires — instead
// of stacking a fixed 3s on top of however much time is already gone and
// risking addon.js's withTimeout dropping the whole provider. Every failure
// (403, timeout, malformed body) just leaves the original "auto" label
// untouched. Back-compat: with no `deadline` (or no options at all), this
// behaves exactly as before — a flat 3000ms cap.
//
// NOTE: providers now prefer interleaving enrichStreamQuality directly into
// their resolve pool (started the moment each stream is discovered, so it
// overlaps the provider's own ~11s resolve race instead of running after
// it) — see topcinema.js/egydead.js. This batch version stays exported and
// unchanged for back-compat and its existing test coverage.
async function enrichHlsQuality(streams, { timeout = 3000, concurrency = 3, overallMs, deadline } = {}) {
  const targets = streams.filter(
    (s) => /^auto$/i.test(String(s.quality || '')) && /\.m3u8(\?|$)/i.test(String(s.url || ''))
  );

  const SAFETY_MARGIN_MS = 1500; // finish this long before the provider budget fires
  let budget = overallMs != null ? overallMs : 3000;
  if (deadline != null) budget = Math.min(budget, deadline - Date.now() - SAFETY_MARGIN_MS);
  budget = Math.max(0, budget);
  // Too little time left in the provider's budget — skip entirely and keep
  // "auto" rather than risk pushing the provider over its 16s cap.
  if (budget < 300 || !targets.length) return streams;
  const perFetch = Math.min(timeout, budget);

  const pool = mapPool(targets, concurrency, async (s) => {
    await enrichStreamQuality(s, { timeout: perFetch });
  });

  // Overall cap so a slow/hanging fetch can never blow the provider's own
  // latency budget: whichever finishes first wins, in-flight work is simply
  // abandoned (its results, if any land later, are harmless mutations).
  await Promise.race([pool, new Promise((resolve) => setTimeout(resolve, budget))]);

  return streams;
}

module.exports = { parseMaxResolution, enrichStreamQuality, enrichHlsQuality };
