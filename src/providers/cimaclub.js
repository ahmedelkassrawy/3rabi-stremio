// CimaClub provider — a port of the CloudStream `CimaClubProvider.kt` scraper.
// Source site: https://ciimaclub.club (the Kotlin plugin hard-codes this as
// the only mainUrl; no rotating/backup domain shows up anywhere in the
// source, unlike topcinema/faselhd — MAIN_CANDIDATES below is a single entry
// today but kept as an array so a mirror can be appended later).
//
// Catalog/meta are plain HTML scraping. Streams: the /watch/ page renders a
// `ul#watch li[data-watch=...]` server list plus a `.ServersList.Download a`
// list, both of which the Kotlin hands to CloudStream's generic
// `loadExtractor()` (i.e. "whatever host this is, some registered extractor
// knows it"). We don't have that registry, so each entry is resolved the
// same way topcinema.js resolves its host embeds: try the generic
// `eval(function(p,a,c,k,e,d)` packed-script unpacker first (covers
// Vidtube/StreamWish/Filelions/Lulustream/Uqload-style hosts), and only if
// that yields nothing fall back to the headless-browser resolver.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');

const mainUrl = 'https://ciimaclub.club';
const MAIN_CANDIDATES = ['https://ciimaclub.club'];
const PER_PAGE = 30;
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8' };

// The public domain could rotate the same way topcinema's does even though
// the Kotlin only lists one; resolve+cache the same way so a future mirror
// only needs adding to MAIN_CANDIDATES.
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  for (const cand of MAIN_CANDIDATES) {
    try {
      const { $, finalUrl } = await fetchDoc(cand + '/', { headers: { ...baseHeaders, Referer: cand + '/' } });
      if ($('.BlocksHolder').length || $('.Small--Box').length) {
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

// mainPageOf() categories from the Kotlin plugin, split into movie/series
// catalogs by their أفلام (movies) / مسلسلات (series) path segment.
const CATALOGS = [
  { type: 'movie', id: 'cimaclub-foreign-movies', name: 'CimaClub · أفلام أجنبي', path: '/category/افلام-اجنبي/', search: true },
  { type: 'movie', id: 'cimaclub-arabic-movies', name: 'CimaClub · أفلام عربي', path: '/category/افلام-عربي/', search: false },
  { type: 'movie', id: 'cimaclub-indian-movies', name: 'CimaClub · أفلام هندي', path: '/category/افلام-هندي/', search: false },
  { type: 'movie', id: 'cimaclub-asian-movies', name: 'CimaClub · أفلام اسيوية', path: '/category/افلام-اسيوية/', search: false },
  { type: 'movie', id: 'cimaclub-anime-movies', name: 'CimaClub · أفلام انمي', path: '/category/افلام-انمي/', search: false },
  { type: 'series', id: 'cimaclub-foreign-series', name: 'CimaClub · مسلسلات أجنبي', path: '/category/مسلسلات-اجنبي/', search: true },
  { type: 'series', id: 'cimaclub-turkish-series', name: 'CimaClub · مسلسلات تركية', path: '/category/مسلسلات-تركية/', search: false },
  { type: 'series', id: 'cimaclub-arabic-series', name: 'CimaClub · مسلسلات عربي', path: '/category/مسلسلات-عربي/', search: false },
  { type: 'series', id: 'cimaclub-asian-series', name: 'CimaClub · مسلسلات اسيوية', path: '/category/مسلسلات-اسيوية/', search: false },
  { type: 'series', id: 'cimaclub-indian-series', name: 'CimaClub · مسلسلات هندية', path: '/category/مسلسلات-هندية/', search: false },
  { type: 'series', id: 'cimaclub-anime-series', name: 'CimaClub · مسلسلات انمي', path: '/category/مسلسلات-انمي/', search: false },
  { type: 'series', id: 'cimaclub-dubbed-series', name: 'CimaClub · مسلسلات مدبلجة', path: '/category/مسلسلات-مدبلجة/', search: false },
];

// The Kotlin's card selector is `div.BlocksHolder > div.Small--Box` with
// title from `element.selectFirst("inner--title > h2")`. That selector has
// no leading dot on "inner--title" (jsoup reads it as a *tag* name, not a
// class) — almost certainly a stale/broken selector in the source plugin, so
// it likely always falls through to jsoup's null-safe chain there. We widen
// it here (`.inner--title h2` with a plain `h2` fallback) so cards still
// parse if that markup is actually `<div class="inner--title"><h2>`.
function parseCards($, base) {
  const items = [];
  $('div.BlocksHolder > div.Small--Box').each((_, el) => {
    const title =
      $(el).find('.inner--title h2').first().text().trim() || $(el).find('h2').first().text().trim();
    if (!title) return;
    const href = absUrl($(el).find('a').first().attr('href'), base);
    if (!href) return;
    const img = $(el).find('img').first();
    const poster = img.attr('data-src')?.trim() || img.attr('src')?.trim() || null;
    items.push({ url: href, name: title, poster });
  });
  return items;
}

async function getCatalog({ path, search, skip = 0 }) {
  try {
    const base = await resolveBase();
    let url;
    if (search) {
      url = `${base}/?s=${encodeURIComponent(search).replace(/%20/g, '+')}`;
    } else {
      const page = Math.floor(skip / PER_PAGE) + 1;
      url = page > 1 ? `${base}${path}page/${page}/` : `${base}${path}`;
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
    const { $ } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    const title = $('h1.PostTitle').first().text().trim() || 'Unknown';
    const poster = hintPoster || $('.MainSingle .left .image img').attr('src')?.trim() || null;
    const plot = $('.StoryArea p').first().text().replace('قصة العرض', '').trim() || null;
    const genres = $(".TaxContent a[href*='/genre/']").map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const year = Number($(".TaxContent a[href*='/release-year/']").first().text().trim()) || null;

    const isSeries =
      /\/series\/|\/مسلسل-/.test(pageUrl) || $('section.allepcont .row a').length > 1;
    if (!isSeries) {
      return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
    }

    const episodes = [];
    const seasonLinks = $('section.allseasonss .Small--Box a');

    async function collectEpisodes($doc, seasonNum) {
      const eps = [];
      $doc('section.allepcont .row a').each((_, ep) => {
        const epUrl = absUrl($doc(ep).attr('href'), base);
        if (!epUrl) return;
        const epTitle = $doc(ep).find('.ep-info h2').first().text().trim();
        const num = Number(($doc(ep).find('.epnum').text().trim().match(/\d+/) || [])[0]) || eps.length + 1;
        eps.push({ url: epUrl, name: epTitle || `الحلقة ${num}`, season: seasonNum, episode: num, poster });
      });
      return eps;
    }

    if (seasonLinks.length > 0) {
      for (let i = 0; i < seasonLinks.length; i++) {
        const el = seasonLinks.eq(i);
        const seasonUrl = absUrl(el.attr('href'), base);
        if (!seasonUrl) continue;
        const seasonNumText = el.find('.epnum span').text().trim();
        const seasonNum = Number(seasonNumText) || i + 1;
        try {
          if (seasonUrl === pageUrl) {
            episodes.push(...(await collectEpisodes($, seasonNum)));
          } else {
            const sd = await fetchDoc(seasonUrl, { headers: { ...baseHeaders, Referer: pageUrl } });
            episodes.push(...(await collectEpisodes(sd.$, seasonNum)));
          }
        } catch {
          /* skip season on failure */
        }
      }
    } else {
      episodes.push(...(await collectEpisodes($, 1)));
    }

    // Some titles list the same episode href twice (e.g. season nav + list) —
    // de-dupe by URL the way the Kotlin's `distinctBy { it.data }` does.
    const uniq = [];
    const seenUrls = new Set();
    for (const ep of episodes) {
      if (seenUrls.has(ep.url)) continue;
      seenUrls.add(ep.url);
      uniq.push(ep);
    }
    uniq.sort((a, b) => a.season - b.season || a.episode - b.episode);

    if (uniq.length === 0) {
      return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
    }
    return { type: 'series', name: title, poster, background: poster, description: plot, year, genres, episodes: uniq };
  } catch {
    return { type: 'movie', name: 'Unknown', poster: null, description: null };
  }
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer) — copied from
// topcinema.js's unpacker since CimaClub's host embeds (reached generically
// via CloudStream's loadExtractor in the Kotlin) are the same family of
// Vidtube/StreamWish/Filelions/Lulustream/Uqload-style players.
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

// Pull direct file URLs out of any host embed that uses the eval packer.
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
  // Keep only real media; the packer also carries logos/thumbnails/subs.
  const cleanLabel = (l) => (l && /\d{3,4}p?|HD|SD|FHD|auto/i.test(l) ? l : 'Auto');
  return files
    .map((url, i) => ({ url, quality: cleanLabel(labels[i]) }))
    .filter((f) => /\.(m3u8|mp4|m4v)(\?|$)/i.test(f.url) || /\/hls\d?\//i.test(f.url));
}

// Run async `fn` over `items` with at most `limit` in flight — same pattern
// as topcinema.js's mapPool, needed because the browser resolver opens a
// heavy Chromium page per embed.
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
    const pageUrl = url.split('#')[0].replace(/\/$/, '');
    const watchUrl = pageUrl.endsWith('/watch') ? pageUrl + '/' : `${pageUrl}/watch/`;

    const streams = [];
    const seen = new Set();
    const embeds = new Map(); // embedUrl -> referer

    let w;
    try {
      w = await fetchText(watchUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
    } catch {
      return [];
    }
    const wd = cheerio.load(w.text);
    const wbase = new URL(w.url).origin;

    // `ul#watch li[data-watch]` — the primary server list (Kotlin passes each
    // straight to loadExtractor).
    wd('ul#watch li').each((_, li) => {
      const embed = wd(li).attr('data-watch');
      const abs = absUrl(embed, wbase);
      if (abs) embeds.set(abs, w.url);
    });

    // `.ServersList.Download a` — download-page links, also handed to
    // loadExtractor by the Kotlin rather than treated as direct files.
    wd('.ServersList.Download a').each((_, a) => {
      const href = wd(a).attr('href')?.trim();
      const abs = absUrl(href, wbase);
      if (abs) embeds.set(abs, w.url);
    });

    // Resolve each host embed: try the generic packed-script unpacker first,
    // and only fall back to the headless browser when that yields nothing
    // and ENABLE_BROWSER is on. Every stream here comes from an external
    // CDN, so it's marked `proxy: true` (addon.js decides direct-vs-proxied
    // per viewer, including its own IPv4 check on the resolved URL).
    await mapPool([...embeds.entries()], 3, async ([embed, referer]) => {
      const host = (() => {
        try {
          return new URL(embed).hostname.replace(/^www\./, '').split('.')[0];
        } catch {
          return 'cimaclub';
        }
      })();
      const origin = (() => {
        try {
          return new URL(embed).origin;
        } catch {
          return undefined;
        }
      })();

      let foundAny = false;
      try {
        const r = await fetchText(embed, { headers: { ...baseHeaders, Referer: referer }, timeout: 12000 });
        for (const f of extractPacked(r.text)) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          foundAny = true;
          streams.push({ url: f.url, quality: f.quality, referer: embed, origin, host, proxy: true });
        }
      } catch {
        /* host unreachable / unsupported packed format */
      }

      if (!foundAny && ENABLE_BROWSER) {
        try {
          // Late-require: keeps Playwright out of any bundle where
          // ENABLE_BROWSER isn't set (see src/resolver.js's header comment).
          const { resolveStream } = require('../resolver');
          const resolved = await resolveStream(embed, { referer });
          for (const r of resolved) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            streams.push({ url: r.url, quality: r.quality || 'auto', referer: embed, origin, host, proxy: true });
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

module.exports = { id: 'cimaclub', name: 'CimaClub', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
