// Egydead provider — a port of the CloudStream `egydeadProvider.kt` scraper.
// Source site: https://egydead.beer (the Kotlin source hardcodes this single
// domain with no rotation list — unlike topcinema/faselhd there's no evidence
// in the source of alternate mirrors, so MAIN_CANDIDATES only has the one
// live domain today; resolveBase() still cycles the array the same way so a
// mirror can be appended later without touching the rest of the file).
//
// Catalog/meta are plain HTML scraping of a WordPress "MoviesVod"-style theme
// (li.movieItem cards, meta[property=og:*] on detail pages). The Kotlin
// source never scrapes dedicated /movies or /series browse pages — only the
// homepage sections (div.pin-posts-list / section.main-section) and search
// (/?s=) — so getCatalog mirrors that: it fetches the homepage and filters
// cards by URL shape (/film/ = movie, /season//serie/ = series) rather than
// hitting an unverified browse path.
//
// Streams: loadLinks() POSTs `View=1` to `<url>?view=watch`, then scrapes a
// long list of possible server containers (`ul.donwload-servers-list`,
// `ul.serversList`, any `[data-link]`, or bare `<a>` tags whose href looks
// like a player/embed/download link). Two extraction strategies per
// candidate, mirroring the Kotlin: (1) the generic `eval(function(p,a,c,k,e,
// d)` packed-script unpacker (same approach as topcinema.js's extractPacked/
// unpackJs) for hosts that ship a JW Player packed payload, and (2) a port of
// `ExternalEarnVidsExtractor.kt` (EarnVids/StreamHG servers): look for a
// literal .m3u8 URL in the raw HTML first, else unpack up to 4 nested
// `eval(function` layers and pull `hls4`/`hls` out of a `var links = {...}`
// object.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');

const mainUrl = 'https://egydead.beer';
const MAIN_CANDIDATES = ['https://egydead.beer'];
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar,en-US;q=0.9' };

// The public domain could rotate like topcinema/faselhd's; resolve it once
// from a redirect and cache it, same pattern as those providers.
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  for (const cand of MAIN_CANDIDATES) {
    try {
      const { $, finalUrl } = await fetchDoc(cand + '/', { headers: { ...baseHeaders, Referer: cand + '/' } });
      if ($('li.movieItem').length) {
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

const CATALOGS = [
  { type: 'movie', id: 'egydead-movies', name: 'Egydead · أفلام', path: '/movies', search: true },
  { type: 'series', id: 'egydead-series', name: 'Egydead · مسلسلات', path: '/series', search: true },
];

function isSeriesHref(href) {
  return /\/(season|serie|series|show|assembly)\//.test(href);
}
function isMovieHref(href) {
  return /\/film\//.test(href);
}

// Cards are `li.movieItem` everywhere: home sections, search results, season
// listings, and movie-collection pages — same shape each time (an `<a>` for
// the link, `h1.BottomTitle` for the title, first `<img>` for the poster).
function parseCards($, base) {
  const items = [];
  $('li.movieItem').each((_, el) => {
    const a = $(el).find('a').first();
    const href = absUrl(a.attr('href'), base);
    if (!href) return;
    const title = $(el).find('h1.BottomTitle').first().text().trim();
    if (!title) return;
    const poster = $(el).find('img').first().attr('src')?.trim() || null;
    items.push({ url: href, name: title, poster });
  });
  return items;
}

async function getCatalog({ type, search, skip = 0 }) {
  try {
    const base = await resolveBase();
    if (search) {
      const url = `${base}/?s=${encodeURIComponent(search)}`;
      const { $, finalUrl } = await fetchDoc(url, { headers: { ...baseHeaders, Referer: base + '/' } });
      return parseCards($, finalUrl).filter((c) => (type === 'movie' ? isMovieHref(c.url) : isSeriesHref(c.url)));
    }
    // No dedicated paginated browse-by-type page is scraped in the Kotlin
    // source (getMainPage only reads homepage sections) — so pagination past
    // the homepage isn't supported; skip > 0 returns nothing rather than
    // guessing at an unverified URL shape.
    if (skip > 0) return [];
    const { $, finalUrl } = await fetchDoc(base + '/', { headers: { ...baseHeaders, Referer: base + '/' } });
    return parseCards($, finalUrl).filter((c) => (type === 'movie' ? isMovieHref(c.url) : isSeriesHref(c.url)));
  } catch {
    return [];
  }
}

function parseEpisodeNum(title) {
  const m = title.match(/(?:حلقة|Episode|EP)\D*(\d+)/i) || title.match(/\d+[xX](\d+)/) || title.match(/(\d+)/);
  return m ? Number(m[1] ?? m[0]) : null;
}
function parseSeasonNum(title) {
  const m = title.match(/(?:الموسم|Season|S)\D*(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Port of `extractEpisodesFromSeasonDoc`: pull episode links out of a season
// (or series/episode-list) page, skipping season/movie links that leak into
// the same container.
function extractEpisodes($doc, seasonUrl, seasonNum, seasonPoster, fallbackPoster) {
  const eps = [];
  let container = $doc('div.EpsList');
  if (!container.length) container = $doc('div.episodes-list');
  if (!container.length) container = $doc('ul');
  if (!container.length) return eps;

  container.find('li, a').each((_, el) => {
    const elm = $doc(el);
    const a = elm.is('a') ? elm : elm.find('a').first();
    if (!a || !a.length) return;
    const href = absUrl(a.attr('href'), seasonUrl);
    if (!href || href.includes('/season/') || href.includes('/film/')) return;
    const rawTitle = (a.attr('title') || a.text() || '').trim();
    const num = parseEpisodeNum(rawTitle) || eps.length + 1;
    eps.push({
      url: href,
      name: rawTitle || `الحلقة ${num}`,
      season: seasonNum,
      episode: num,
      poster: seasonPoster || fallbackPoster,
    });
  });
  return eps;
}

async function getMeta({ url }) {
  try {
    const base = await resolveBase();
    const [pageUrl, hintPoster] = url.split('#');
    const { $, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

    const title = $('meta[property="og:title"]').attr('content')?.trim() || 'Unknown';
    const poster = hintPoster || $('meta[property="og:image"]').attr('content')?.trim() || null;
    const plot = $('div.singleStory').first().text().trim() || null;

    // Movie-collection page (e.g. a franchise grouping several standalone
    // films) — the Kotlin exposes each film as a fake "episode" of a fake
    // series so CloudStream can list them; do the same here.
    const collection = $('div.salery-list ul');
    if (collection.length) {
      const episodes = [];
      collection.find('li.movieItem').each((i, el) => {
        const a = $(el).find('a').first();
        const href = absUrl(a.attr('href'), finalUrl);
        if (!href || !isMovieHref(href)) return;
        const name = $(el).find('h1.BottomTitle').first().text().trim() || `Movie ${i + 1}`;
        const epPoster = $(el).find('img').first().attr('src')?.trim() || null;
        episodes.push({ url: href, name, season: 1, episode: episodes.length + 1, poster: epPoster });
      });
      if (episodes.length) {
        return { type: 'series', name: title, poster, background: poster, description: plot, episodes };
      }
    }

    if (isMovieHref(pageUrl)) {
      const year = Number($('div.LeftBox li:contains(السنه) a').first().text().trim()) || null;
      const genres = $('div.LeftBox li:contains(النوع) a').map((_, a) => $(a).text().trim()).get();
      return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
    }

    // Series/season/episode page: prefer a season-links list (walked like
    // `discoverSeasonsPreserveOrder`, simplified to one level since the
    // Kotlin's own recursive walk only ever finds one extra level in
    // practice); fall back to episodes embedded directly on this page.
    let seasonLinks = $('div.seasons-list li.movieItem a, div.seasons-list a')
      .map((_, a) => absUrl($(a).attr('href'), finalUrl))
      .get()
      .filter(Boolean);
    seasonLinks = [...new Set(seasonLinks)].reverse(); // oldest season first, like the Kotlin's `.reverse()`

    let episodes = [];
    if (seasonLinks.length) {
      for (let i = 0; i < seasonLinks.length; i++) {
        try {
          const sUrl = seasonLinks[i];
          const sd = await fetchDoc(sUrl, { headers: { ...baseHeaders, Referer: finalUrl } });
          const sPoster = sd.$('meta[property="og:image"]').attr('content')?.trim() || null;
          const sTitle = sd.$('meta[property="og:title"]').attr('content')?.trim() || '';
          const seasonNum = parseSeasonNum(sTitle) || i + 1;
          episodes.push(...extractEpisodes(sd.$, sd.finalUrl, seasonNum, sPoster, poster));
        } catch {
          /* skip season on failure */
        }
      }
    }
    if (!episodes.length) {
      episodes = extractEpisodes($, finalUrl, 1, poster, poster);
    }

    if (!episodes.length) {
      // Nothing episode-shaped found — treat as a movie fallback rather than
      // returning an empty series.
      return { type: 'movie', name: title, poster, background: poster, description: plot };
    }
    return { type: 'series', name: title, poster, background: poster, description: plot, episodes };
  } catch {
    return { type: 'movie', name: 'Unknown', poster: null, description: null };
  }
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer) — identical to
// topcinema.js's unpacker, used for generic host embeds.
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

// Simpler token-substitution unpacker used by `ExternalEarnVidsExtractor.kt`
// (`unpackPackerSimple`): instead of `unpackJs`'s explicit key->word map, it
// replaces every base-`radix` alnum token in the payload with `symtab[value]`
// whenever the token parses cleanly as a number in that radix. Good enough to
// surface the plain-JS `var links = {...}` object EarnVids/StreamHG ship;
// it isn't a full packer implementation (no eval), just string substitution.
function unpackPackerSimple(js) {
  const m = js.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*\d+\s*,\s*(['"])([\s\S]*?)\4/
  );
  if (!m) return null;
  const payload = m[2];
  const radix = Number(m[3]) || 36;
  const symtab = m[5].split('|');
  const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
  return payload.replace(/\b[0-9a-zA-Z]+\b/g, (tok) => {
    if (![...tok.toLowerCase()].every((ch) => validChars.includes(ch))) return tok;
    const idx = parseInt(tok, radix);
    if (Number.isNaN(idx) || idx < 0 || idx >= symtab.length || !symtab[idx]) return tok;
    return symtab[idx];
  });
}

// Port of `ExternalEarnVidsExtractor.extract`: try a literal .m3u8 in the raw
// HTML first, else unpack up to 4 nested packed layers and pull `hls4`/`hls`
// out of a `var links = {...}` object (JSON.parse first, regex-pair fallback
// like the Kotlin's manual pairRegex path for malformed JSON).
function extractEarnVidsLink(html, pageUrl) {
  const direct = html.match(/https?:\/\/[^'"\s>]+?\.m3u8[^'"\s>]*/i);
  if (direct) {
    const link = direct[0].replace(/\\\//g, '/');
    return link.startsWith('/') ? absUrl(link, pageUrl) : link;
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
      const link = hlsInline[1].replace(/\\\//g, '/');
      return link.startsWith('/') ? absUrl(link, pageUrl) : link;
    }
    return null;
  }

  let map = {};
  try {
    map = JSON.parse(linksMatch[1].replace(/'/g, '"'));
  } catch {
    map = {};
    const pairRe = /"([^"]+)"\s*:\s*"([^"]+)"/g;
    let mm;
    while ((mm = pairRe.exec(linksMatch[1]))) map[mm[1]] = mm[2];
  }
  let link = map.hls4 || map.hls || '';
  if (!link) return null;
  link = link.replace(/\\\//g, '/');
  return link.startsWith('/') ? absUrl(link, pageUrl) : link;
}

// Run async `fn` over `items` with at most `limit` in flight — same pattern
// as topcinema.js's mapPool (the browser resolver opens a heavy Chromium
// page per embed, so an unbounded Promise.all could spawn many at once).
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

// A literal IPv4 address in the resolved URL means the link is bound to
// whichever host resolved it and won't play for other viewers — same
// reasoning as faselhd.js's `ipBound` comment.
function isIpBound(u) {
  return /https?:\/\/\d{1,3}(\.\d{1,3}){3}(:|\/)/.test(u);
}

async function getStreams({ url }) {
  try {
    const originalUrl = url.split('#')[0];
    const watchPageUrl = originalUrl.includes('?view=watch')
      ? originalUrl
      : `${originalUrl}${originalUrl.includes('?') ? '&' : '?'}view=watch`;

    // Priming GET (mirrors the Kotlin's unconditional `httpGet(originalUrl)`
    // before the POST — some of these WP themes gate the watch POST on a
    // cookie/session set by the plain page load).
    try {
      await fetchDoc(originalUrl, { headers: { ...baseHeaders, Referer: originalUrl } });
    } catch {
      /* priming GET failing isn't fatal — still try the POST */
    }

    let doc;
    let finalUrl = watchPageUrl;
    try {
      const body = new URLSearchParams({ View: '1' }).toString();
      const r = await fetchText(watchPageUrl, {
        method: 'POST',
        body,
        headers: {
          ...baseHeaders,
          Referer: originalUrl,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
      });
      doc = cheerio.load(r.text);
      finalUrl = r.url;
    } catch {
      try {
        const d = await fetchDoc(watchPageUrl, { headers: { ...baseHeaders, Referer: originalUrl } });
        doc = d.$;
        finalUrl = d.finalUrl;
      } catch {
        return [];
      }
    }

    // Collect every server candidate the Kotlin's loadLinks looks at: the
    // download-servers list, the watch-servers list, any bare `[data-link]`
    // element, and finally any `<a>` whose href looks like a player/embed
    // link — all merged into one deduped map (url -> server name, used to
    // decide which extractor to try).
    const candidates = new Map();
    const addCandidate = (raw, name) => {
      const href = absUrl(raw, finalUrl);
      if (href && !candidates.has(href)) candidates.set(href, name || null);
    };

    doc('ul.donwload-servers-list li, ul.download-servers-list li, div.donwload-servers-list li').each((_, li) => {
      const $li = doc(li);
      const name = $li.find('span.ser-name').text().trim() || $li.find('p').text().trim() || null;
      const href = $li.find('a.ser-link').attr('href') || $li.find('a').attr('href') || $li.attr('data-link');
      if (href) addCandidate(href, name);
    });
    doc('ul.serversList li, ul.servers-list li, div.serversList li, div.servers-list li').each((_, li) => {
      const $li = doc(li);
      const name =
        $li.find('p').text().trim() || $li.find('.ser-name').text().trim() || $li.find('span.ser-name').text().trim() || null;
      const cand =
        $li.attr('data-link') ||
        $li.find('[data-link]').attr('data-link') ||
        $li.find('button[data-link]').attr('data-link') ||
        $li.find('a').attr('href');
      if (cand) addCandidate(cand, name);
    });
    doc('[data-link]').each((_, el) => {
      const $el = doc(el);
      const name = $el.attr('data-name') || $el.attr('data-provider') || null;
      const dl = $el.attr('data-link');
      if (dl) addCandidate(dl, name);
    });
    doc('a').each((_, a) => {
      const href = doc(a).attr('href') || '';
      if (/player|embed|download|drive|mp4/i.test(href)) {
        const name = doc(a).attr('title')?.trim() || doc(a).text().trim() || null;
        addCandidate(href, name);
      }
    });

    const streams = [];
    const seen = new Set();

    await mapPool([...candidates.entries()], 4, async ([embed, name]) => {
      let foundAny = false;
      let host;
      let origin;
      try {
        host = new URL(embed).hostname.replace(/^www\./, '').split('.')[0];
        origin = new URL(embed).origin;
      } catch {
        return; // malformed candidate URL
      }

      try {
        // EarnVids mirrors one specific bad host (fdewsdc.sbs) that only
        // serves with a hardcoded foreign Referer — port that quirk as-is.
        const referer = /fdewsdc\.sbs/i.test(embed) ? 'https://shhahid4u.cam' : originalUrl;
        const r = await fetchText(embed, { headers: { ...baseHeaders, Referer: referer }, timeout: 12000 });

        // 1) EarnVids/StreamHG servers: custom extractor.
        if (name && /earnvids|streamhg/i.test(name)) {
          const link = extractEarnVidsLink(r.text, embed);
          if (link && !seen.has(link)) {
            seen.add(link);
            foundAny = true;
            const stream = { url: link, quality: 'auto', referer: embed, origin, host, proxy: true };
            if (isIpBound(link)) stream.ipBound = true;
            streams.push(stream);
          }
        }

        // 2) Generic packed-script hosts (Vidtube/StreamWish/Filelions/...).
        for (const f of extractPacked(r.text)) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          foundAny = true;
          const stream = { url: f.url, quality: f.quality, referer: embed, origin, host, proxy: true };
          if (isIpBound(f.url)) stream.ipBound = true;
          streams.push(stream);
        }
      } catch {
        /* host unreachable / unsupported format */
      }

      if (!foundAny && ENABLE_BROWSER) {
        try {
          // Late-require: keeps Playwright out of any bundle where
          // ENABLE_BROWSER isn't set (see src/resolver.js's header comment).
          const { resolveStream } = require('../resolver');
          const resolved = await resolveStream(embed, { referer: originalUrl });
          for (const r of resolved) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            const stream = {
              url: r.url,
              quality: r.quality || 'auto',
              referer: r.referer || embed,
              host,
              proxy: true,
            };
            if (isIpBound(r.url)) stream.ipBound = true;
            streams.push(stream);
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

module.exports = { id: 'egydead', name: 'Egydead', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
