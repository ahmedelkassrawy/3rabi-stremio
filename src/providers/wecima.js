// Wecima provider — a port of the CloudStream `WecimaProvider.kt` scraper.
// Source site: https://wecima.ac (Cloudflare-fronted; the Kotlin keeps a
// `cf_clearance` cookie and a CloudflareKiller interceptor fallback — we skip
// the cookie dance and just follow whatever origin the site redirects a
// plain GET to, same as topcinema.js's resolveBase()).
//
// Catalog/meta are plain HTML scraping (WordPress-ish "Grid--WecimaPosts"
// cards). Search is a POST to /search returning JSON. Streams: the
// watch/movie page lists `<btn data-url="...">` server entries and
// `.openLinkDown[data-href]` download entries whose URLs are base64-encoded
// (with a `https`-prefix hack — see decodeWecimaUrl). The Kotlin just hands
// the decoded URL to CloudStream's generic `loadExtractor`, i.e. these are
// arbitrary host embeds — so we try the same packed-script unpacker
// topcinema.js uses, then fall back to the headless browser resolver.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');

// Only one known live domain in the Kotlin source (no alternate/rotating
// mirrors listed like topcinema's). Kept as a one-element candidate list so
// resolveBase() still follows the same shape as the other host-based
// providers, and a second mirror can be added later without touching callers.
const mainUrl = 'https://wecima.ac';
const MAIN_CANDIDATES = ['https://wecima.ac'];
const PER_PAGE = 30;
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7' };

// The live origin is resolved from a redirect and cached, same pattern as
// topcinema.js's resolveBase() (the Kotlin does this per-request via
// getFreshDomainAndCookies(); caching once per process is enough here).
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  for (const cand of MAIN_CANDIDATES) {
    try {
      const { $, finalUrl } = await fetchDoc(cand + '/', { headers: { ...baseHeaders, Referer: cand + '/' } });
      if ($('.Grid--WecimaPosts').length || $('.GridItem').length) {
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

// The Kotlin's mainPageOf() lists these six sections (no distinct anime
// section — supportedTypes is only Movie/TvSeries). Search is wired only on
// the two primary entries, same convention as topcinema.js/akwam.js.
const CATALOGS = [
  { type: 'movie', id: 'wecima-movies', name: 'Wecima · أفلام', path: '/movies', search: true },
  { type: 'series', id: 'wecima-series', name: 'Wecima · مسلسلات', path: '/seriestv', search: true },
  { type: 'movie', id: 'wecima-movies-ar', name: 'Wecima · أفلام عربية', path: '/category/arabic-movies', search: false },
  { type: 'movie', id: 'wecima-movies-foreign', name: 'Wecima · أفلام أجنبية', path: '/category/foreign-movies', search: false },
  { type: 'series', id: 'wecima-series-ar', name: 'Wecima · مسلسلات عربية', path: '/category/arabic-series', search: false },
  { type: 'series', id: 'wecima-series-foreign', name: 'Wecima · مسلسلات أجنبية', path: '/category/foreign-series', search: false },
];

// Cards: div.Grid--WecimaPosts div.GridItem, title in h2/strong, poster is a
// background-image on span.BG--GridItem (data-src, or a `style="...url(...)"`
// fallback — same shape the Kotlin's toSearchResult() unwraps).
function parseCards($, base) {
  const items = [];
  $('div.Grid--WecimaPosts div.GridItem').each((_, el) => {
    const titleEl = $(el).find('h2, strong').first();
    const title = titleEl.text().trim();
    if (!title) return;
    const a = $(el).find('a').first();
    const href = absUrl(a.attr('href'), base);
    if (!href) return;
    const posterSpan = $(el).find('span.BG--GridItem').first();
    let poster = posterSpan.attr('data-src')?.trim() || null;
    if (!poster) {
      const style = posterSpan.attr('style') || '';
      const m = style.match(/url\((.*?)\)/);
      poster = m ? m[1].replace(/^['"]|['"]$/g, '').trim() : null;
    }
    items.push({ url: href, name: title, poster: poster || null });
  });
  return items;
}

async function getCatalog({ path, search, skip = 0 }) {
  const base = await resolveBase();
  if (search) {
    // POST /search returns JSON: { status, results: [{title, slug, image,
    // year, istv}] }. istv: 0 = movie, 1 = series. The Kotlin also skips
    // istv === 2 with no comment on what that third bucket is — kept as the
    // same unexplained skip here rather than guessing.
    try {
      const r = await fetchText(`${base}/search`, {
        method: 'POST',
        body: new URLSearchParams({ q: search }).toString(),
        headers: {
          ...baseHeaders,
          Referer: base + '/',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
      });
      const data = JSON.parse(r.text);
      const results = Array.isArray(data?.results) ? data.results : [];
      return results
        .filter((it) => it && it.istv !== 2 && it.title && it.slug)
        .map((it) => {
          const isSeries = it.istv === 1;
          const prefix = isSeries ? '/series/' : '/watch/';
          const href = String(it.slug).startsWith('http')
            ? it.slug
            : `${base}${prefix}${encodeURIComponent(it.slug)}`;
          return { url: href, name: it.title, poster: it.image || null };
        });
    } catch {
      return [];
    }
  }
  try {
    const page = Math.floor(skip / PER_PAGE) + 1;
    // No confirmed pagination URL in the Kotlin (getMainPage() never pages);
    // guessing the common `/page/N/` scheme the other WordPress-style sites
    // in this repo use (topcinema.js). Unverified — revisit if page 2+ 404s.
    const url = page > 1 ? `${base}${path}/page/${page}/` : `${base}${path}`;
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
    const { $: doc, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    const isTvSeriesPage = pageUrl.includes('/series/') || doc('.List--Seasons--Episodes').length > 0;
    const isEpisodePage =
      pageUrl.includes('/watch/') && doc(".Breadcrumb--UX a[href*='/series/']").length > 0;

    if (isTvSeriesPage || isEpisodePage) {
      let seriesUrl = finalUrl;
      let $s = doc;
      if (isEpisodePage) {
        const href = doc(".Breadcrumb--UX a[href*='/series/']").first().attr('href');
        seriesUrl = absUrl(href, finalUrl) || finalUrl;
        try {
          const sd = await fetchDoc(seriesUrl, { headers: { ...baseHeaders, Referer: pageUrl } });
          $s = sd.$;
          seriesUrl = sd.finalUrl;
        } catch {
          /* fall back to the episode page's own document */
        }
      }

      const title = $s('div.Title--Content--Single-begin h1').first().text().trim() || 'Unknown';
      const poster = hintPoster || extractSeparatedTopImage($s, 'wecima.separated--top', '--img:url\\((.*?)\\)');
      const plot = $s('div.StoryMovieContent').first().text().trim() || null;
      const year = findYear($s);

      const episodes = [];
      const seasonEls = $s('div.List--Seasons--Episodes a.SeasonsEpisodes');
      if (seasonEls.length > 0) {
        for (let i = 0; i < seasonEls.length; i++) {
          const el = seasonEls.eq(i);
          const seasonText = el.text().trim();
          const seasonNum = Number((seasonText.match(/الموسم\s*(\d+)/) || [])[1]) || i + 1;
          const dataId = el.attr('data-id');
          const dataSeason = el.attr('data-season');
          if (!dataId || !dataSeason) continue;
          try {
            const r = await fetchText(`${base}/ajax/Episode`, {
              method: 'POST',
              body: new URLSearchParams({ post_id: dataId, season: dataSeason }).toString(),
              headers: {
                ...baseHeaders,
                Referer: seriesUrl,
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              },
            });
            const $ep = cheerio.load(r.text);
            $ep('a.hoverable.activable').each((_, a) => {
              const epUrl = absUrl($ep(a).attr('href'), seriesUrl);
              if (!epUrl) return;
              const epName = $ep(a).find('episodetitle').first().text().trim();
              const num = Number((epName.match(/الحلقة\s*(\d+)/) || [])[1]) || episodes.length + 1;
              episodes.push({ url: epUrl, name: epName || `الحلقة ${num}`, season: seasonNum, episode: num, poster });
            });
          } catch {
            /* skip season on ajax failure */
          }
        }
      } else {
        $s('.EpisodesList.Full--Width a').each((_, a) => {
          const epUrl = absUrl($s(a).attr('href'), seriesUrl);
          if (!epUrl) return;
          const epName = $s(a).find('episodetitle').first().text().trim();
          const num = Number((epName.match(/الحلقة\s*(\d+)/) || [])[1]) || episodes.length + 1;
          episodes.push({ url: epUrl, name: epName || `الحلقة ${num}`, season: 1, episode: num, poster });
        });
      }

      if (!episodes.length) {
        return { type: 'movie', name: title, poster, background: poster, description: plot, year };
      }
      return { type: 'series', name: title, poster, background: poster, description: plot, year, episodes };
    }

    const title = doc('div.Title--Content--Single-begin h1').first().text().trim() || 'Unknown';
    const poster =
      hintPoster ||
      doc('meta[property="og:image"]').attr('content')?.trim() ||
      extractSeparatedTopImage(doc, 'wecima.separated--top', 'url\\((.*?)\\)') ||
      null;
    const plot = doc('div.StoryMovieContent').first().text().trim() || null;
    const year = findYear(doc);
    return { type: 'movie', name: title, poster, background: poster, description: plot, year };
  } catch {
    return { type: 'movie', name: 'Unknown' };
  }
}

// The Kotlin reads a custom `<wecima class="separated--top">` element's
// inline (or lazy) style/data attribute for a `--img:url(...)` or
// `url(...)` background. Ported literally — cheerio treats `wecima` as a
// normal (if unusual) tag selector.
function extractSeparatedTopImage($doc, selector, pattern) {
  const el = $doc(selector).first();
  if (!el.length) return null;
  const style = el.attr('data-lazy-style') || el.attr('style') || '';
  const m = style.match(new RegExp(pattern));
  return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : null;
}

function findYear($doc) {
  let year = null;
  $doc('ul.Terms--Content--Single-begin li').each((_, li) => {
    if (year) return;
    const label = $doc(li).find('span').first().text();
    if (label.includes('السنة')) {
      const n = Number($doc(li).find('p').first().text().trim());
      if (n) year = n;
    }
  });
  return year;
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer) — copied from
// topcinema.js since several of Wecima's `loadExtractor` hosts (Vidtube-
// style CDNs) use the same packer.
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

// Wecima's server/download buttons carry the target URL as a base64 blob
// that has the leading "https"-prefix bytes stripped (`aHR0c` is
// base64("http")'s first 5 chars) — the site's own JS re-prepends it before
// decoding, so we do the same hacky concatenation the Kotlin does.
function decodeWecimaUrl(encoded) {
  if (!encoded) return null;
  try {
    let cleaned = String(encoded).replace(/\+/g, '').trim();
    if (!cleaned) return null;
    if (!cleaned.startsWith('aHR0c')) cleaned = 'aHR0c' + cleaned;
    const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
    return decoded.startsWith('http') ? decoded : null;
  } catch {
    return null;
  }
}

// Streams whose resolved URL embeds a literal IPv4 host are only reachable
// from whichever network resolved them (see faselhd.js's ipBound comment) —
// flag those instead of blanket-forcing proxy-only like faselhd does, since
// Wecima's hosts are normally hostname-based CDNs.
const IPV4_RE = /:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[:/]/;

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
  const streams = [];
  try {
    const base = await resolveBase();
    const pageUrl = url.split('#')[0];
    const { $: doc } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    // Both the server list and the download list decode to arbitrary host
    // embed URLs in the Kotlin (both go through `loadExtractor`); collect
    // them into one list, keeping the download entries' quality hint.
    const candidates = [];
    doc('ul.WatchServersList li btn[data-url]').each((_, el) => {
      const decoded = decodeWecimaUrl(doc(el).attr('data-url'));
      if (decoded) candidates.push({ embed: decoded, quality: null });
    });
    doc('.openLinkDown[data-href]').each((_, el) => {
      const decoded = decodeWecimaUrl(doc(el).attr('data-href'));
      if (!decoded) return;
      const resolution = doc(el).find('resolution').first().text().trim();
      const quality = doc(el).find('quality').first().text().trim();
      const label = [resolution, quality].filter(Boolean).join(' ').trim() || null;
      candidates.push({ embed: decoded, quality: label });
    });

    const seen = new Set();
    await mapPool(candidates, 3, async ({ embed, quality }) => {
      if (seen.has(embed)) return;
      let host;
      let origin;
      try {
        host = new URL(embed).hostname.replace(/^www\./, '').split('.')[0];
        origin = new URL(embed).origin;
      } catch {
        return;
      }
      let foundAny = false;
      try {
        const r = await fetchText(embed, { headers: { ...baseHeaders, Referer: base + '/' }, timeout: 12000 });
        for (const f of extractPacked(r.text)) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          foundAny = true;
          streams.push({
            url: f.url,
            quality: quality || f.quality,
            referer: embed,
            origin,
            host,
            proxy: true,
            ipBound: IPV4_RE.test(f.url),
          });
        }
      } catch {
        /* host unreachable / not a packed embed */
      }

      if (!foundAny && ENABLE_BROWSER) {
        try {
          // Late-require: keeps Playwright out of any bundle where
          // ENABLE_BROWSER isn't set (see src/resolver.js's header comment).
          const { resolveStream } = require('../resolver');
          const resolved = await resolveStream(embed, { referer: base });
          for (const r of resolved) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            streams.push({
              url: r.url,
              quality: quality || r.quality || 'auto',
              referer: r.referer || embed,
              origin,
              host,
              proxy: true,
              ipBound: IPV4_RE.test(r.url),
            });
          }
        } catch {
          /* browser resolver unavailable / failed for this embed */
        }
      }
    });
  } catch {
    /* whole page fetch failed — no streams */
  }
  return streams;
}

module.exports = { id: 'wecima', name: 'Wecima', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
