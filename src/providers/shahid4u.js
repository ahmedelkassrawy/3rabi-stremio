// Shahid4u provider — a port of the CloudStream `Shahid4u.kt` scraper
// (com.shahid4u). Source site: mainUrl in the Kotlin is
// "https://shaahed4u.net/", but the Kotlin's own EarnVids extractor
// special-cases a Referer of "https://shhahid4u.cam" for one CDN
// (fdewsdc.sbs) — a strong hint the domain rotates between at least those
// two spellings, same as topcinema.js/faselhd.js's rotating entry domains.
//
// Catalog/meta are plain HTML scraping (Bootstrap-ish theme:
// `div.shows-container.row div[class*=col-]` cards). Streams: the
// /watch/ page embeds a `let servers = JSON.parse('[...]')` array of
// {name,url} host embeds. This is HOST-BASED: each server is resolved by
// (1) generic packed-script (`eval(function(p,a,c,k,e,d)`) unpacking, same
// approach as topcinema.js, (2) for servers named EarnVids/StreamHG, the
// Kotlin ships a bespoke `ExternalEarnVidsExtractor` that both regexes a
// bare .m3u8 out of the page and, failing that, unpacks a packer payload
// looking for a `var links = {...}` object with an `hls4`/`hls` key — ported
// here as `extractEarnVidsLink`, and (3) the headless-browser resolver as a
// last resort, gated on ENABLE_BROWSER exactly like topcinema.js/faselhd.js.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');

// Entry domains rotate/typo-vary (shaahed4u.net vs shhahid4u.cam in the
// Kotlin source); try the live one first and cache whichever actually
// returns cards, same pattern as topcinema.js's resolveBase().
const mainUrl = 'https://shaahed4u.net';
const MAIN_CANDIDATES = ['https://shaahed4u.net', 'https://shhahid4u.cam'];
const PER_PAGE = 24; // Kotlin's home categories `take(40)`; no explicit page size for category pagination — 24 is a guess.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8' };

// The public domain rotates; resolve it once from a redirect and cache it.
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  for (const cand of MAIN_CANDIDATES) {
    try {
      const { $, finalUrl } = await fetchDoc(cand + '/', { headers: { ...baseHeaders, Referer: cand + '/' } });
      if ($('.shows-container').length || $('.glide').length) {
        cachedBase = new URL(finalUrl).origin;
        return cachedBase;
      }
    } catch {
      /* domain blocked/down — try next */
    }
  }
  cachedBase = new URL(mainUrl).origin;
  return cachedBase;
}

// Kotlin's getMainPage lists 13 Arabic-slug categories (`category/افلام-اجنبي`
// etc). Mirroring all of them would bloat the manifest, so — like
// topcinema.js/faselhd.js — this keeps a representative movie+series pair
// per language family (foreign + Arabic) rather than the full Kotlin list.
const CATALOGS = [
  { type: 'movie', id: 'shahid4u-movies-foreign', name: 'Shahid4u · أفلام أجنبي', path: '/category/افلام-اجنبي', search: true },
  { type: 'movie', id: 'shahid4u-movies-arabic', name: 'Shahid4u · أفلام عربي', path: '/category/افلام-عربي' },
  { type: 'series', id: 'shahid4u-series-foreign', name: 'Shahid4u · مسلسلات أجنبي', path: '/category/مسلسلات-اجنبي', search: true },
  { type: 'series', id: 'shahid4u-series-arabic', name: 'Shahid4u · مسلسلات عربي', path: '/category/مسلسلات-عربي' },
];

// Port of Kotlin's parseCard(): title from `p.title`(+`p.description`), or a
// couple of fallbacks; poster from the link's inline `style="...url(...)"`
// (a CSS background-image) before falling back to `img[data-src|src]`.
function parseCards($, base) {
  const items = [];
  $('div.shows-container.row div[class*=col-]').each((_, el) => {
    const a = $(el).find('a.show.card, a.glide_post, a').first();
    const href = absUrl(a.attr('href'), base);
    if (!href) return;

    const mainTitle = $(el).find('p.title').first().text().trim();
    const description = $(el).find('p.description').first().text().trim();
    let title = mainTitle ? (description ? `${mainTitle} - ${description}` : mainTitle) : '';
    if (!title) {
      title = $(el).find('div.card-content').first().text().trim() || $(el).find('h3').first().text().trim();
    }
    if (!title) return;

    const style = a.attr('style') || '';
    const styleMatch = style.match(/url\(['"]?(.*?)['"]?\)/);
    let poster = styleMatch ? styleMatch[1] : null;
    if (!poster) {
      const img = $(el).find('img').first();
      poster = img.attr('data-src')?.trim() || img.attr('src')?.trim() || null;
    }
    poster = poster ? absUrl(poster, base) : null;

    items.push({ url: href, name: title, poster });
  });
  return items;
}

async function getCatalog({ path, search, skip = 0 }) {
  try {
    const base = await resolveBase();
    let url;
    if (search) {
      url = `${base}/search?s=${encodeURIComponent(search)}`;
    } else {
      const page = Math.floor(skip / PER_PAGE) + 1;
      url = page > 1 ? `${base}${path}?page=${page}` : `${base}${path}`;
    }
    const { $, finalUrl } = await fetchDoc(url, { headers: { ...baseHeaders, Referer: base + '/' } });
    return parseCards($, finalUrl);
  } catch {
    return [];
  }
}

async function getMeta({ url }) {
  try {
    const base = await resolveBase();
    const [pageUrl, hintPoster] = url.split('#');
    const { $, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    const title = $('span.title').first().text().trim() || 'Unknown';
    const poster =
      hintPoster ||
      $('div.poster-side img').attr('src')?.trim() ||
      $('meta[property="og:image"]').attr('content')?.trim() ||
      null;
    const plot = $('span.description').first().text().trim() || null;
    const genres = $('div.qualities span.q-tag a').map((_, a) => $(a).text().trim()).get().filter(Boolean);

    // Episode rows share one class (`a.epss`); season links are the subset
    // pointing at `/season/`, real episode rows are everything else inside
    // the same container — matches the Kotlin's `:not([href*='/season/'])`.
    const EP_CONTAINER = "div.w-100.bg-main.rounded.my-4 a.epss";
    const EP_SELECTOR = `${EP_CONTAINER}:not([href*='/season/'])`;

    function collectEpisodes($doc, seasonNum, docBase) {
      const eps = [];
      $doc(EP_SELECTOR).each((_, el) => {
        const epUrl = absUrl($doc(el).attr('href'), docBase);
        if (!epUrl) return;
        const epName = $doc(el).text().trim();
        if (!epName) return;
        const num = Number((epName.match(/\d+/) || [])[0]) || eps.length + 1;
        eps.push({ url: epUrl, name: epName, season: seasonNum, episode: num, poster });
      });
      return eps;
    }

    const episodes = [];
    const seasonLinks = $(`${EP_CONTAINER}[href*='/season/']`);
    if (seasonLinks.length > 0) {
      for (let i = 0; i < seasonLinks.length; i++) {
        const el = seasonLinks.eq(i);
        const seasonUrl = absUrl(el.attr('href'), finalUrl);
        const seasonNum = Number((el.text().match(/الموسم\s*(\d+)/) || [])[1]) || i + 1;
        if (!seasonUrl) continue;
        try {
          const sd = await fetchDoc(seasonUrl, { headers: { ...baseHeaders, Referer: pageUrl } });
          episodes.push(...collectEpisodes(sd.$, seasonNum, sd.finalUrl));
        } catch {
          /* skip season on failure */
        }
      }
    } else {
      episodes.push(...collectEpisodes($, 1, finalUrl));
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

    if (!episodes.length) {
      return { type: 'movie', name: title, poster, background: poster, description: plot, genres };
    }
    return { type: 'series', name: title, poster, background: poster, description: plot, genres, episodes };
  } catch {
    return { type: 'movie', name: 'Unknown', poster: null, background: null, description: null };
  }
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer) — copied from
// topcinema.js's unpacker, which handles the common `file:"..."`-shaped
// packed hosts (streamwish/vidtube/filelions/... clones).
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function intToBase(n, base) {
  if (n === 0) return '0';
  let s = '';
  while (n > 0) {
    s = B62[n % base] + s;
    n = Math.floor(n / base);
  }
  return s;
}
function unpackJs(p, a, c, k) {
  const map = {};
  for (let i = 0; i < c; i++) {
    const key = intToBase(i, a);
    if (k[i]) map[key] = k[i];
  }
  return p.replace(/[0-9A-Za-z]+/g, (m) => map[m] || m);
}

function extractPacked(html) {
  const m = html.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\((['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split/
  );
  if (!m) return [];
  const p = m[2].replace(/\\'/g, "'");
  const a = Math.min(Number(m[3]) || 62, 62);
  const c = Number(m[4]) || 0;
  const k = m[6].length ? m[6].split('|') : [];
  const unpacked = unpackJs(p, a <= 0 ? 62 : a, c <= 0 ? k.length : c, k);
  const files = [...unpacked.matchAll(/file\s*:\s*"(https?:\/\/[^"]+)"/g)].map((x) => x[1]);
  const labels = [...unpacked.matchAll(/label\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
  const cleanLabel = (l) => (l && /\d{3,4}p?|HD|SD|FHD|auto/i.test(l) ? l : 'Auto');
  return files
    .map((u, i) => ({ url: u, quality: cleanLabel(labels[i]) }))
    .filter((f) => /\.(m3u8|mp4|m4v)(\?|$)/i.test(f.url) || /\/hls\d?\//i.test(f.url));
}

// Port of Kotlin's `unpackPackerSimple`: unlike `unpackJs` above (which
// counts tokens 0..c-1 against a symtab indexed by base-`a` digits), this
// one walks every bare word token in the payload and substitutes it from
// `symtab[parseInt(tok, radix)]` directly — matching `ExternalEarnVidsExtractor`'s
// own logic exactly (it's a different, simpler packer variant than the
// generic file:/label: hosts above).
function unpackPackerSimple(js) {
  const m = js.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*['"]([\s\S]*?)['"]\s*,\s*(\d+)\s*,\s*\d+\s*,\s*['"]([\s\S]*?)['"]/
  );
  if (!m) return null;
  const payload = m[1];
  const radix = Number(m[2]) || 36;
  const symtab = m[3].split('|');
  return payload.replace(/\b[0-9A-Za-z]+\b/g, (tok) => {
    const idx = parseInt(tok, radix);
    return !Number.isNaN(idx) && idx >= 0 && idx < symtab.length ? symtab[idx] : tok;
  });
}

// Port of `ExternalEarnVidsExtractor.extract()`: first try a bare .m3u8 in
// the raw HTML, then unpack up to 4 packer layers looking for a
// `var links = {...}` object (single-quoted JSON) with an `hls4`/`hls` key.
function extractEarnVidsLink(html, pageUrl) {
  try {
    const direct = html.match(/https?:\/\/[^'"\s>]+?\.m3u8[^'"\s>]*/i);
    if (direct) {
      let link = direct[0].replace(/\\\//g, '/');
      if (link.startsWith('/')) link = absUrl(link, pageUrl);
      return link;
    }
  } catch {
    /* no bare m3u8 */
  }

  if (!html.includes('eval(function')) return null;

  let working = html;
  let unpacked = null;
  for (let i = 0; i < 4; i++) {
    unpacked = unpackPackerSimple(working);
    if (!unpacked) break;
    if (!unpacked.includes('eval(function')) {
      working = unpacked;
      break;
    }
    working = unpacked;
  }
  if (!unpacked) return null;

  const cleaned = unpacked.replace(/\\\//g, '/');
  const linksMatch = cleaned.match(/var\s+links\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!linksMatch) {
    const hlsInline = cleaned.match(/"hls4"\s*:\s*"([^"]+)"/) || cleaned.match(/"hls"\s*:\s*"([^"]+)"/);
    if (hlsInline) {
      let link = hlsInline[1].replace(/\\\//g, '/');
      if (link.startsWith('/')) link = absUrl(link, pageUrl);
      return link;
    }
    return null;
  }

  const jsonRaw = linksMatch[1].replace(/'/g, '"');
  let map = {};
  try {
    map = JSON.parse(jsonRaw);
  } catch {
    map = {};
    const pairRe = /"([^"]+)"\s*:\s*"([^"]+)"/g;
    let pm;
    while ((pm = pairRe.exec(jsonRaw))) map[pm[1]] = pm[2];
  }
  let link = map.hls4 || map.hls || '';
  if (!link) return null;
  link = link.replace(/\\\//g, '/');
  if (link.startsWith('/')) link = absUrl(link, pageUrl);
  return link;
}

// A stream is only forced proxy-only when its own URL literally contains an
// IPv4 host — matching faselhd.js's ipBound comment on why *that* provider
// forces it unconditionally instead: Shahid4u's servers aren't known to be
// universally IP-bound, so this only fires per-URL.
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

// Run async `fn` over `items` with at most `limit` in flight (same as
// topcinema.js's mapPool — the browser resolver opens a heavy Chromium page
// per embed).
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

async function getStreams({ url }) {
  try {
    const base = await resolveBase();
    const pageUrl = url.split('#')[0];
    // Kotlin: data.replace("/film/", "/watch/").replace("/episode/", "/watch/")
    const watchUrl = pageUrl.replace('/film/', '/watch/').replace('/episode/', '/watch/');

    const w = await fetchText(watchUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
    if (w.status >= 400) return [];

    // Find the inline `<script>` containing `let servers`, same as the
    // Kotlin's `document.select("script").find { it.data().contains("let servers") }`.
    const wd = cheerio.load(w.text);
    let serversScript = null;
    wd('script').each((_, el) => {
      const data = wd(el).html() || '';
      if (data.includes('let servers')) serversScript = data;
    });
    if (!serversScript) return [];

    const jsonMatch = serversScript.match(/JSON\.parse\(\s*'([\s\S]*?)'\s*\)/);
    if (!jsonMatch) return [];
    const jsonStringDecoded = jsonMatch[1].replace(/\\\//g, '/');

    let servers;
    try {
      servers = JSON.parse(jsonStringDecoded);
    } catch {
      return [];
    }
    if (!Array.isArray(servers)) return [];

    const streams = [];
    const seen = new Set();

    await mapPool(servers, 3, async (server) => {
      const serverUrl = server?.url;
      if (!serverUrl) return;
      let host;
      let origin;
      try {
        host = new URL(serverUrl).hostname.replace(/^www\./, '').split('.')[0];
        origin = new URL(serverUrl).origin;
      } catch {
        return;
      }

      let foundAny = false;

      // 1) Generic packed-script extraction (streamwish/vidtube-style hosts).
      let embedHtml = null;
      try {
        const r = await fetchText(serverUrl, { headers: { ...baseHeaders, Referer: watchUrl }, timeout: 12000 });
        embedHtml = r.text;
        for (const f of extractPacked(r.text)) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          foundAny = true;
          streams.push({
            url: f.url,
            quality: f.quality,
            referer: serverUrl,
            origin,
            host,
            proxy: true,
            ...(IPV4_RE.test(f.url) ? { ipBound: true } : {}),
          });
        }
      } catch {
        /* host unreachable / unsupported packed format */
      }

      // 2) EarnVids/StreamHG: bespoke extractor from ExternalEarnVidsExtractor.kt.
      if (!foundAny && /earnvids|streamhg/i.test(server?.name || '')) {
        try {
          // fdewsdc.sbs (one of EarnVids' CDN aliases) rejects the normal
          // Referer and needs this specific one — ported verbatim from the
          // Kotlin's `if (pageUrl.contains("fdewsdc.sbs", true))` check.
          const referer = serverUrl.includes('fdewsdc.sbs') ? 'https://shhahid4u.cam' : base;
          let html = embedHtml;
          if (referer !== watchUrl) {
            // Re-fetch with the EarnVids-specific Referer (the Kotlin extractor
            // always makes its own request rather than reusing loadExtractor's).
            const r2 = await fetchText(serverUrl, { headers: { ...baseHeaders, Referer: referer }, timeout: 12000 });
            html = r2.text;
          }
          const link = html ? extractEarnVidsLink(html, serverUrl) : null;
          if (link && !seen.has(link)) {
            seen.add(link);
            foundAny = true;
            streams.push({
              url: link,
              quality: 'auto',
              referer: base,
              host: `${host}-earnvids`,
              proxy: true,
              ...(IPV4_RE.test(link) ? { ipBound: true } : {}),
            });
          }
        } catch {
          /* EarnVids extractor failed for this embed */
        }
      }

      // 3) Headless-browser fallback (only ever pulled in when ENABLE_BROWSER=1).
      if (!foundAny && ENABLE_BROWSER) {
        try {
          // Late-require: keeps Playwright out of any bundle where
          // ENABLE_BROWSER isn't set (see src/resolver.js's header comment).
          const { resolveStream } = require('../resolver');
          const resolved = await resolveStream(serverUrl, { referer: watchUrl });
          for (const r of resolved) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            streams.push({
              url: r.url,
              quality: r.quality || 'auto',
              referer: serverUrl,
              host,
              proxy: true,
              ...(IPV4_RE.test(r.url) ? { ipBound: true } : {}),
            });
          }
        } catch {
          /* browser resolver unavailable / failed for this embed */
        }
      }
    });

    return streams;
  } catch {
    return [];
  }
}

module.exports = { id: 'shahid4u', name: 'Shahid4u', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
