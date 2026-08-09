// Arab Seed provider — a port of the CloudStream `Arabseed.kt` scraper.
// Source site: https://asd.pics. Unlike topcinema.js/faselhd.js, Arabseed.kt
// never mentions an alternate/rotating entry domain anywhere in the source —
// just one hardcoded `mainUrl` — so MAIN_CANDIDATES has a single entry.
// resolveBase() still cycles it (and caches the post-redirect origin) for
// symmetry with the other host-based providers, so a second domain slots in
// later without touching call sites.
//
// IMPORTANT caveat: the Kotlin source routes every request through
// `safeGet`/`safePost`, which detect a Cloudflare interstitial (403/503/429,
// "checking your browser", "just a moment", cf-browser-verification) and
// hand off to a `CloudflareSolver` that drives a real Android WebView through
// the JS challenge. This addon has nothing equivalent: fetchDoc/fetchText are
// plain HTTP, and the headless-browser resolver (src/resolver.js) only
// sniffs media requests from a page load — it doesn't attempt to solve an
// interactive Cloudflare challenge either. If asd.pics is actively
// Cloudflare-gating requests from this host's IP, catalog/meta/streams can
// all legitimately come back empty even with ENABLE_BROWSER=1.
//
// Streams: loadLinks() walks watch-page -> csrf token -> per-quality AJAX
// server list -> per-server AJAX iframe lookup -> CloudStream's generic
// `loadExtractor()` dispatch. There's no CloudStream-equivalent extractor
// registry here, so this file ports two concrete strategies instead: (1) the
// generic `eval(function(p,a,c,k,e,d)` packed-script unpacker most CDN embeds
// use (copied from topcinema.js's extractPacked/unpackJs), and (2) the
// bespoke GameHubExtractor.kt logic for Arabseed's own "سيرفر عرب سيد" host
// (m.reviewrate.net), which is the only extractor the plugin registers by
// hand (registerExtractorAPI(GameHubExtractor())) — everything else in the
// Kotlin relies on CloudStream's built-in extractor library, which this repo
// doesn't have, so the packed-script unpacker is the closest generic
// fallback for those hosts.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');

const mainUrl = 'https://asd.pics';
const MAIN_CANDIDATES = ['https://asd.pics'];
const PER_PAGE = 30; // Arabseed.kt never states a page size; 30 mirrors akwam.js/faselhd.js's WP-ish default.
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8' };

// The public domain rotates in theory (see header comment); resolve it once
// and cache it, same pattern as topcinema.js/faselhd.js's resolveBase().
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  for (const cand of MAIN_CANDIDATES) {
    try {
      const { $, finalUrl } = await fetchDoc(cand + '/main0/', { headers: { ...baseHeaders, Referer: cand + '/' } });
      if ($('.movie__block').length) {
        cachedBase = new URL(finalUrl).origin;
        return cachedBase;
      }
    } catch {
      /* domain blocked/down (or Cloudflare-challenged) — try next */
    }
  }
  cachedBase = new URL(mainUrl).origin;
  return cachedBase;
}

const CATALOGS = [
  { type: 'movie', id: 'arabseed-movies', name: 'Arab Seed · أفلام', path: '/movies/', search: true },
  // Arabseed.kt's own `mainPageOf(...)` maps "المسلسلات" (series) to the
  // exact same `/main0/` URL as "الرئيسية" (home) — no dedicated
  // series-listing path exists anywhere in the Kotlin source (looks like a
  // stale/copy-pasted row upstream). Kept as-is rather than guessing an
  // unverified URL; expect this catalog to surface a mix of movies and
  // series like the homepage does.
  { type: 'series', id: 'arabseed-series', name: 'Arab Seed · مسلسلات', path: '/main0/', search: true },
];

// `.movie__block` is the card's own `<a>` tag in both the home-page grid
// (`div.movie__block`... actually an anchor, per Arabseed.kt's `it.attr("href")`
// on the selected element itself) and the search results
// (`ul.blocks__ul > li > a.movie__block`) — so one selector covers both.
function parseCards($, base) {
  const items = [];
  $('.movie__block').each((_, el) => {
    const href = absUrl($(el).attr('href'), base);
    if (!href) return;
    const title = ($(el).attr('title') || $(el).find('h3').first().text() || '').trim();
    if (!title) return;
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
      url = `${base}/find/?word=${encodeURIComponent(search.trim()).replace(/%20/g, '+')}`;
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

// Arabseed.kt stashes its CSRF token in an inline `<script>` as
// `'csrf__token': "..."` (single-quoted key, double-quoted value) — pull it
// out of every script tag's concatenated contents, same as `document.select
// ("script").html()` in Kotlin/Jsoup.
function extractCsrf($) {
  const scripts = $('script')
    .map((_, s) => $(s).html() || '')
    .get()
    .join('\n');
  const m = scripts.match(/'csrf__token':\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function getMeta({ url }) {
  try {
    const base = await resolveBase();
    const [pageUrl, hintPoster] = url.split('#');
    const { $, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    // load(): an episode page's breadcrumbs link back to the parent series
    // page via a `/selary/` href; season/episode breadcrumb entries are
    // excluded so the *series* page (not another episode) is picked.
    let seriesUrl = null;
    $(".bread__crumbs li a[href*='/selary/']").each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('%d8%a7%d9%84%d9%85%d9%88%d8%b3%d9%85-') && !href.includes('%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9-')) {
        seriesUrl = absUrl(href, finalUrl); // last match wins, matching Kotlin's `lastOrNull`
      }
    });
    if (!seriesUrl) {
      seriesUrl =
        absUrl(
          pageUrl.split('%d8%a7%d9%84%d9%85%d9%88%d8%b3%d9%85-')[0].split('%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9-')[0],
          finalUrl
        ) || pageUrl;
    }

    let seriesDoc = $;
    let seriesFinal = finalUrl;
    if (seriesUrl !== pageUrl && seriesUrl !== finalUrl) {
      try {
        const sd = await fetchDoc(seriesUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
        seriesDoc = sd.$;
        seriesFinal = sd.finalUrl;
      } catch {
        /* series page unreachable — fall back to the episode page's own data */
      }
    }

    const title =
      seriesDoc('h1.post__name').first().text().trim() || $('h1.post__name').first().text().trim() || 'Unknown';
    const posterImg = seriesDoc('.poster__single img, .single__cover > img:not(.rating__box img), .post__poster img').first();
    const poster = hintPoster || posterImg.attr('data-src')?.trim() || posterImg.attr('src')?.trim() || null;
    const plot = seriesDoc('.post__story > p').first().text().trim() || null;

    const episodes = [];
    const seasonElements = seriesDoc('div#seasons__list ul li');

    if (seasonElements.length > 0) {
      const csrfToken = extractCsrf(seriesDoc);
      if (csrfToken) {
        for (let i = 0; i < seasonElements.length; i++) {
          const el = seasonElements.eq(i);
          const seasonId = (el.attr('data-term') || '').trim();
          if (!seasonId) continue;
          const seasonNum = i + 1;
          const seasonEpisodes = [];
          let hasMore = true;
          let offset = 0;
          while (hasMore) {
            try {
              const r = await fetchText(`${base}/season__episodes/`, {
                method: 'POST',
                body: new URLSearchParams({ season_id: seasonId, offset: String(offset), csrf_token: csrfToken }).toString(),
                headers: {
                  ...baseHeaders,
                  Referer: seriesUrl,
                  'X-Requested-With': 'XMLHttpRequest',
                  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                  Accept: '*/*',
                },
              });
              const j = JSON.parse(r.text);
              if (!j || !j.html) {
                hasMore = false;
              } else {
                const ed = cheerio.load(j.html);
                const eps = ed('li a');
                if (eps.length === 0) {
                  hasMore = false;
                } else {
                  eps.each((_, a) => {
                    const epHref = absUrl(ed(a).attr('href'), seriesFinal);
                    if (!epHref) return;
                    const epTitle = ed(a).find('.epi__num').first().text().trim() || ed(a).text().trim();
                    const num = Number((epTitle.match(/\d+/) || [])[0]) || null;
                    seasonEpisodes.push({ url: epHref, name: epTitle, season: seasonNum, episode: num, poster });
                  });
                  offset += eps.length;
                  hasMore = j.hasmore === true;
                }
              }
            } catch {
              hasMore = false;
            }
          }
          episodes.push(...seasonEpisodes.reverse());
        }
      }
    } else {
      const seasonNumFromName =
        Number(($('.bread__crumbs li:contains(الموسم) span').first().text().match(/\d+/) || [])[0]) || 1;
      $('ul.episodes__list li a').each((_, a) => {
        const epHref = absUrl($(a).attr('href'), finalUrl);
        if (!epHref) return;
        const epTitle = $(a).find('.epi__num').first().text().trim() || $(a).text().trim();
        const num = Number((epTitle.match(/\d+/) || [])[0]) || null;
        episodes.push({ url: epHref, name: epTitle, season: seasonNumFromName, episode: num, poster });
      });
    }

    const isTvSeries = episodes.length > 0 || seriesUrl.includes('/selary/');
    if (!isTvSeries) {
      return { type: 'movie', name: title, poster, background: poster, description: plot };
    }

    // De-dupe by URL, matching Kotlin's `episodes.distinctBy { it.data }`.
    const seenEp = new Set();
    const deduped = episodes.filter((e) => {
      if (seenEp.has(e.url)) return false;
      seenEp.add(e.url);
      return true;
    });
    if (!deduped.length) {
      return { type: 'movie', name: title, poster, background: poster, description: plot };
    }
    return { type: 'series', name: title, poster, background: poster, description: plot, episodes: deduped };
  } catch {
    return { type: 'movie', name: 'Unknown', poster: null, background: null, description: null };
  }
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer) — copied
// verbatim from topcinema.js since most of Arabseed's CDN host embeds use
// the same packer to hide their `file:"..."` JWPlayer config.
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
    .map((fileUrl, i) => ({ url: fileUrl, quality: cleanLabel(labels[i]) }))
    .filter((f) => /\.(m3u8|mp4|m4v)(\?|$)/i.test(f.url) || /\/hls\d?\//i.test(f.url));
}

// Port of GameHubExtractor.kt — the only extractor Arabseed's plugin
// registers by hand (`registerExtractorAPI(GameHubExtractor())`), for its
// own "سيرفر عرب سيد" host. Without a CSRF token the page already embeds a
// direct file link; with one, it needs a second AJAX round-trip (post_id
// pulled from the `embed-<id>.html` URL shape) whose response carries either
// a nested iframe src (unpacked the same generic way) or a raw .m3u8.
const GAMEHUB_HOST = 'https://m.reviewrate.net';
async function extractGameHub(embedUrl, referer) {
  try {
    const cleanUrl = embedUrl.split('#quality=')[0];
    const r = await fetchText(cleanUrl, { headers: { ...baseHeaders, Referer: referer || GAMEHUB_HOST }, timeout: 12000 });
    const html = r.text;
    const csrfMatch = html.match(/['"]csrf_token['"]\s*:\s*['"]([^'"]+)['"]/);
    if (!csrfMatch) {
      return [...html.matchAll(/https?:\/\/[^\s"']+\.(?:m3u8|mp4|mkv)/g)].map((m) => ({
        url: m[0],
        quality: 'auto',
        referer: cleanUrl,
        host: 'reviewrate',
      }));
    }

    const objId = (cleanUrl.split('embed-')[1] || '').split('.html')[0];
    if (!objId) return [];

    const ar = await fetchText(`${GAMEHUB_HOST}/get__watch__server/`, {
      method: 'POST',
      body: new URLSearchParams({ post_id: objId, csrf_token: csrfMatch[1] }).toString(),
      headers: {
        ...baseHeaders,
        Referer: cleanUrl,
        Origin: GAMEHUB_HOST,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      timeout: 12000,
    });

    const results = [];
    for (const m of ar.text.matchAll(/src=["'](https?:\/\/[^"']+)["']/g)) {
      try {
        const nested = await fetchText(m[1], { headers: { ...baseHeaders, Referer: cleanUrl }, timeout: 12000 });
        const host = new URL(m[1]).hostname.replace(/^www\./, '').split('.')[0];
        results.push(...extractPacked(nested.text).map((f) => ({ url: f.url, quality: f.quality, referer: m[1], host })));
      } catch {
        /* nested embed unreachable / unsupported packed format */
      }
    }
    for (const m of ar.text.matchAll(/https?:\/\/[^\s"']+\.m3u8/g)) {
      results.push({ url: m[0], quality: 'auto', referer: cleanUrl, host: 'reviewrate' });
    }
    return results;
  } catch {
    return [];
  }
}

async function extractFromHost(embedUrl, referer) {
  try {
    const host = new URL(embedUrl).hostname.replace(/^www\./, '');
    if (host.includes('reviewrate')) return extractGameHub(embedUrl, referer);
    const r = await fetchText(embedUrl, { headers: { ...baseHeaders, Referer: referer }, timeout: 12000 });
    return extractPacked(r.text).map((f) => ({ url: f.url, quality: f.quality, referer: embedUrl, host: host.split('.')[0] }));
  } catch {
    return [];
  }
}

// A stream is only IP-bound if its own URL literally embeds an IPv4 host —
// unlike faselhd.js (which force-sets ipBound on every resolved stream),
// Arabseed's CDN embeds are normally hostname-based, so only flag the ones
// that actually resolved to a raw IP.
function isIpBound(streamUrl) {
  try {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(new URL(streamUrl).hostname);
  } catch {
    return false;
  }
}

// Run async `fn` over `items` with at most `limit` in flight — same helper
// as topcinema.js's mapPool (the browser fallback opens a real Chromium page
// per embed, so unbounded parallelism is unsafe).
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

async function resolveEmbed(embedUrl, referer, quality, streams, seen) {
  const results = await extractFromHost(embedUrl, referer);
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    streams.push({
      url: r.url,
      quality: r.quality || quality || 'auto',
      referer: r.referer || embedUrl,
      host: r.host,
      proxy: true,
      ipBound: isIpBound(r.url),
    });
  }

  if (results.length === 0 && ENABLE_BROWSER) {
    try {
      // Late-require: keeps Playwright out of any bundle where
      // ENABLE_BROWSER isn't set (see src/resolver.js's header comment).
      const { resolveStream } = require('../resolver');
      const resolved = await resolveStream(embedUrl, { referer });
      for (const r of resolved) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        streams.push({
          url: r.url,
          quality: r.quality || quality || 'auto',
          referer: r.referer || embedUrl,
          proxy: true,
          ipBound: isIpBound(r.url),
        });
      }
    } catch {
      /* browser resolver unavailable / failed for this embed */
    }
  }
}

// Port of loadLinks(): episode page -> watch page -> csrf token -> per-
// quality AJAX server list -> per-server AJAX iframe lookup -> extractor.
async function getStreams({ url }) {
  const streams = [];
  try {
    const base = await resolveBase();
    const pageUrl = url.split('#')[0];
    const { $: epDoc } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
    const watchUrl = absUrl(epDoc('a.btton.watch__btn').attr('href'), pageUrl);
    if (!watchUrl) return [];

    const { $: watchDoc } = await fetchDoc(watchUrl, { headers: { ...baseHeaders, Referer: pageUrl } });
    const csrfToken = extractCsrf(watchDoc);
    const postId = watchDoc('.servers__list li').first().attr('data-post');
    if (!csrfToken || !postId) return [];

    const qualities = watchDoc('.quality__swither ul.qualities__list li')
      .map((_, li) => watchDoc(li).attr('data-quality'))
      .get()
      .filter(Boolean);

    const seen = new Set();
    await mapPool(qualities, 2, async (quality) => {
      let serverIds = [];
      try {
        const r = await fetchText(`${base}/get__quality__servers/`, {
          method: 'POST',
          body: new URLSearchParams({ post_id: postId, quality, csrf_token: csrfToken }).toString(),
          headers: {
            ...baseHeaders,
            Referer: watchUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: '*/*',
          },
        });
        const j = JSON.parse(r.text);
        if (j && j.html) {
          const sd = cheerio.load(j.html);
          serverIds = sd('li')
            .map((_, li) => sd(li).attr('data-server'))
            .get()
            .filter(Boolean);
        }
      } catch {
        /* quality's server list unavailable */
      }

      await mapPool(serverIds, 3, async (serverId) => {
        try {
          const r = await fetchText(`${base}/get__watch__server/`, {
            method: 'POST',
            body: new URLSearchParams({ post_id: postId, quality, server: serverId, csrf_token: csrfToken }).toString(),
            headers: {
              ...baseHeaders,
              Referer: watchUrl,
              'X-Requested-With': 'XMLHttpRequest',
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Accept: '*/*',
            },
          });
          const j = JSON.parse(r.text);
          const embedUrl = j && j.server;
          if (!embedUrl) return;
          await resolveEmbed(embedUrl, watchUrl, quality, streams, seen);
        } catch {
          /* server unavailable */
        }
      });
    });
  } catch {
    /* whole flow failed — dead domain, Cloudflare block, or layout change */
  }
  return streams;
}

module.exports = { id: 'arabseed', name: 'Arab Seed', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
