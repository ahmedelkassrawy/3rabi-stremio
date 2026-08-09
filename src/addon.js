// Pure Stremio STREAM addon. No catalogs/meta of our own: the user browses
// via Stremio/Nuvio's built-in Cinemeta catalog, opens a title, and Stremio
// asks us for streams by IMDb id. We resolve that id back to a title via
// Cinemeta, fan the title out to every registered Arabic provider's search,
// fuzzy-match the best result per provider (src/match.js), and aggregate
// every stream we find, labeled by provider.
const { addonBuilder } = require('stremio-addon-sdk');
const { providers } = require('./providers');
const { getTitle } = require('./cinemeta');
const { bestMatch } = require('./match');
const { proxifyUrl, containsIPv4 } = require('./proxy');
const { PUBLIC_URL, DESKTOP_UA } = require('./config');

const pkg = require('../package.json');

const manifest = {
  id: 'community.re3arabi.stremio', // unchanged so installed clients update in place
  version: pkg.version,
  name: '3rabi عربي',
  description:
    'ستريمات عربية مجمعة من عدة مواقع (اكوام، توب سينما، فاصل الاعلانات، إيجي ديد) — ported from the 3rabi CloudStream extension.',
  logo: 'https://raw.githubusercontent.com/Abodabodd/re-3arabi/main/import/ic_launcher.png',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  // stremio-addon-linter requires `catalogs` to be an array even when empty
  // — this is a pure stream addon, so it stays empty (no catalog/meta
  // resources are declared or handled).
  catalogs: [],
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);

// Per-provider budget: one slow/hanging provider must never stall the whole
// aggregated response (each job is raced against this via withTimeout
// below). OVERALL_DEADLINE_MS is a second, coarser cap on the whole
// aggregate — see the comment on the handler's Promise.all race.
const PROVIDER_BUDGET_MS = 16000;
const OVERALL_DEADLINE_MS = 20000;

function qualityLabel(q) {
  if (!q || q === 'direct') return 'Direct';
  return /^\d+$/.test(q) ? `${q}p` : q;
}

// Maps a provider's raw stream objects into Stremio wire-format stream
// entries, applying the same direct-vs-proxy / ipBound / proxyHeaders logic
// that used to live inline in defineStreamHandler (see git history on
// addon.js pre-stream-addon-rework for the original single-provider version).
function toStremioStreams(provider, streams) {
  const out = [];
  for (const s of streams) {
    if (s.proxy) {
      // Host-based providers (Top Cinema, Faselhd) resolve streams that may
      // be Cloudflare-gated against datacenter IPs and/or (Faselhd)
      // literally IP-bound to whichever machine resolved them. Most of this
      // addon's *users* are on residential IPs though — only the server
      // that runs the resolver is on a datacenter/VM IP — so a stream that
      // isn't IP-bound should still be offered direct (host -> viewer's
      // device, zero server bandwidth) with a proxied fallback, and only
      // genuinely IP-bound streams (Faselhd) get proxy-only, since a direct
      // entry for those would just be broken on every device but the one
      // that resolved it.
      const label = s.host ? `${provider.name}\n${s.host}` : provider.name;
      const headers = {
        ...(s.referer ? { Referer: s.referer } : {}),
        ...(s.origin ? { Origin: s.origin } : {}),
        'User-Agent': DESKTOP_UA,
      };
      const boundToIp = s.ipBound || containsIPv4(s.url);

      if (!boundToIp) {
        out.push({
          url: s.url,
          name: label,
          description: `${qualityLabel(s.quality)} · direct`,
          behaviorHints: {
            notWebReady: s.url.startsWith('http:'),
            bingeGroup: `3rabi-${provider.id}`,
            proxyHeaders: { request: headers },
          },
        });
      }
      out.push({
        url: proxifyUrl(PUBLIC_URL, s.url, headers),
        name: label,
        description: `${qualityLabel(s.quality)} · proxy`,
        behaviorHints: { bingeGroup: `3rabi-${provider.id}` },
      });
      continue;
    }
    out.push({
      url: s.url,
      name: s.host ? `${provider.name}\n${s.host}` : provider.name,
      description: qualityLabel(s.quality),
      // http CDN links + direct file: use Stremio's native player, not the web one.
      behaviorHints: {
        notWebReady: s.url.startsWith('http:'),
        bingeGroup: `3rabi-${provider.id}`,
        ...(s.referer
          ? {
              proxyHeaders: {
                request: { Referer: s.referer, ...(s.origin ? { Origin: s.origin } : {}) },
              },
            }
          : {}),
      },
    });
  }
  return out;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// One provider's full search -> match -> streams pipeline, wrapped so any
// failure (network error, parse error, timeout) resolves to [] rather than
// rejecting — a single bad provider must never break the aggregate.
async function streamsFromProvider(provider, { type, imdbBase, name, year, season, episode }) {
  try {
    if (type === 'series') {
      const supportsSeries = provider.catalogs.some((c) => c.type === 'series');
      if (!supportsSeries) return [];

      const results = await provider.getCatalog({ search: name, type: 'series' });
      // Pass the Cinemeta year through here too: bestMatch's year guard only
      // *rejects* a candidate whose own detected year is >1 off (a
      // candidate with no detectable year just takes a small penalty), so
      // it's a free disambiguation signal against same-titled shows.
      const m = bestMatch(name, year, results, { kind: 'series' });
      if (!m) return [];

      const meta = await provider.getMeta({ url: m.url });
      const ep = meta?.episodes?.find((e) => Number(e.season) === season && Number(e.episode) === episode);
      if (!ep) return [];

      const streams = await provider.getStreams({ url: ep.url });
      return toStremioStreams(provider, streams);
    }

    // movie
    const results = await provider.getCatalog({ search: name, type: 'movie' });
    const m = bestMatch(name, year, results, { kind: 'movie' });
    if (!m) return [];

    const streams = await provider.getStreams({ url: m.url });
    return toStremioStreams(provider, streams);
  } catch (e) {
    console.error(`[stream ${imdbBase} @ ${provider.id}]`, e.message);
    return [];
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  // id is `tt#######` for movies, or `tt#######:S:E` for series episodes.
  const [imdbBase, seasonStr, episodeStr] = id.split(':');
  if (!/^tt\d+$/.test(imdbBase)) return { streams: [] };

  const season = seasonStr != null ? Number(seasonStr) : null;
  const episode = episodeStr != null ? Number(episodeStr) : null;
  if (type === 'series' && (!Number.isFinite(season) || !Number.isFinite(episode))) {
    return { streams: [] };
  }

  const title = await getTitle(type, imdbBase);
  if (!title) return { streams: [] };

  // Every job is individually capped at PROVIDER_BUDGET_MS (so one slow
  // provider can't stall the rest), and PROVIDER_BUDGET_MS < OVERALL_DEADLINE_MS
  // so Promise.all(jobs) below is always guaranteed to settle before the
  // overall deadline. The outer withTimeout is a second safety net in case
  // that invariant ever drifts (e.g. the per-provider budget is raised) —
  // it returns whatever aggregated so far rather than hanging the response.
  const jobs = providers.map((provider) =>
    withTimeout(
      streamsFromProvider(provider, { type, imdbBase, name: title.name, year: title.year, season, episode }),
      PROVIDER_BUDGET_MS,
      []
    )
  );

  const settled = (await withTimeout(Promise.all(jobs), OVERALL_DEADLINE_MS, null)) || jobs.map(() => []);

  const streams = settled.flat();
  return { streams };
});

module.exports = builder.getInterface();
// Exposed for test/addon.test.js: the direct-vs-proxy/ipBound mapping is the
// most playback- and security-sensitive piece of this file (it decides what
// headers/URLs a client is handed), so it gets its own network-free unit
// tests rather than only being exercised indirectly via the stream handler.
module.exports.toStremioStreams = toStremioStreams;
