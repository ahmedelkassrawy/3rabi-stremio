// Builds the Stremio addon interface from the provider registry.
// Maps: getMainPage->catalog, load->meta, loadLinks->stream.
const { addonBuilder } = require('stremio-addon-sdk');
const { providers, byId } = require('./providers');
const { makeId, parseId } = require('./id');
const { proxifyUrl } = require('./proxy');
const { PUBLIC_URL, DESKTOP_UA } = require('./config');

const pkg = require('../package.json');

// Flatten every provider's catalogs into the manifest, tagging each catalog id
// with its provider so we can route requests back later: `<providerId>|<catId>`.
const manifestCatalogs = [];
for (const p of providers) {
  for (const c of p.catalogs) {
    manifestCatalogs.push({
      type: c.type,
      id: `${p.id}|${c.id}`,
      name: c.name,
      extra: [
        { name: 'skip', isRequired: false },
        ...(c.search ? [{ name: 'search', isRequired: false }] : []),
      ],
    });
  }
}

const manifest = {
  id: 'community.re3arabi.stremio',
  version: pkg.version,
  name: '3rabi عربي',
  description: 'مشاهدة الافلام والمسلسلات العربية — ported from the 3rabi CloudStream extension.',
  logo: 'https://raw.githubusercontent.com/Abodabodd/re-3arabi/main/import/ic_launcher.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['3rabi:'],
  catalogs: manifestCatalogs,
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);

// ---- catalog ----
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const [providerId, ...catRest] = id.split('|');
  const catId = catRest.join('|');
  const provider = byId[providerId];
  if (!provider) return { metas: [] };
  const cat = provider.catalogs.find((c) => c.id === catId);
  if (!cat) return { metas: [] };

  const skip = Number(extra?.skip) || 0;
  const search = extra?.search || null;

  try {
    const items = await provider.getCatalog({ path: cat.path, type: cat.type, search, skip });
    const metas = items.map((it) => ({
      id: makeId(provider.id, it.poster ? `${it.url}#${it.poster}` : it.url),
      type: cat.type,
      name: it.name,
      poster: it.poster || undefined,
      posterShape: 'poster',
    }));
    return { metas };
  } catch (e) {
    console.error(`[catalog ${id}]`, e.message);
    return { metas: [] };
  }
});

// ---- meta ----
builder.defineMetaHandler(async ({ type, id }) => {
  const parsed = parseId(id);
  if (!parsed) return { meta: null };
  const provider = byId[parsed.providerId];
  if (!provider) return { meta: null };

  try {
    const m = await provider.getMeta({ url: parsed.payload, type });
    const meta = {
      id,
      type: m.type,
      name: m.name,
      poster: m.poster || undefined,
      background: m.background || m.poster || undefined,
      description: m.description || undefined,
      genres: m.genres?.length ? m.genres : undefined,
      releaseInfo: m.year ? String(m.year) : undefined,
    };
    if (m.type === 'series' && m.episodes) {
      meta.videos = m.episodes.map((ep) => ({
        id: makeId(provider.id, ep.url),
        title: ep.name,
        season: ep.season,
        episode: ep.episode,
        thumbnail: ep.poster || undefined,
      }));
    }
    return { meta };
  } catch (e) {
    console.error(`[meta ${id}]`, e.message);
    return { meta: null };
  }
});

// ---- stream ----
builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseId(id);
  if (!parsed) return { streams: [] };
  const provider = byId[parsed.providerId];
  if (!provider) return { streams: [] };

  try {
    const streams = await provider.getStreams({ url: parsed.payload });
    const out = [];
    for (const s of streams) {
      if (s.proxy) {
        // Host-based providers (Top Cinema, Faselhd) resolve streams that
        // may be Cloudflare-gated against datacenter IPs and/or (Faselhd)
        // literally IP-bound to whichever machine resolved them. Most of
        // this addon's *users* are on residential IPs though — only the
        // server that runs the resolver is on a datacenter/VM IP — so a
        // stream that isn't IP-bound should still be offered direct
        // (host -> viewer's device, zero server bandwidth) with a proxied
        // fallback, and only genuinely IP-bound streams (Faselhd) get
        // proxy-only, since a direct entry for those would just be broken
        // on every device but the one that resolved it.
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
    return { streams: out };
  } catch (e) {
    console.error(`[stream ${id}]`, e.message);
    return { streams: [] };
  }
});

function qualityLabel(q) {
  if (!q || q === 'direct') return 'Direct';
  return /^\d+$/.test(q) ? `${q}p` : q;
}

// Faselhd's m3u8 (and occasionally other hosts) embeds a literal IPv4 in the
// URL and is only playable from the IP that resolved it — such a stream must
// never be offered "direct" to other viewers, only through this server's
// /proxy. Top Cinema's CDN links are normally hostname-based, not IP-bound.
function containsIPv4(url) {
  return /\b\d{1,3}(\.\d{1,3}){3}\b/.test(url);
}

module.exports = builder.getInterface();
