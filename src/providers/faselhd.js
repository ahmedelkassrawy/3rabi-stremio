// Faselhd provider — a port of the CloudStream `Faselhd.kt` scraper's
// catalog/meta scraping. Source site: https://web31312x.faselhdx.bid
// (rotates; redirects to the live domain — resolved+cached the same way
// topcinema.js resolves its base).
//
// Streams: the movie/episode page HTML embeds a `player_iframe.location.href
// = '...'` onclick handler pointing at a `video_player?player_token=...`
// URL. That page renders an obfuscated JS player that builds its HLS URL
// client-side (and Faselhd's m3u8 is IP-bound to whichever host resolves
// it — see src/resolver.js), so plain HTTP can't get the stream: only the
// headless-browser resolver can, and only when ENABLE_BROWSER=1. With the
// browser disabled this provider still returns catalog/meta correctly, just
// zero streams — matching the "direct-only" contract of every provider.
const { fetchDoc, absUrl } = require('../fetcher');
const { ENABLE_BROWSER } = require('../config');
const { seasonFromTitle } = require('../match');

const mainUrl = 'https://web31312x.faselhdx.bid';
const PER_PAGE = 30;
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9' };

// The public domain rotates; resolve it once from a redirect and cache it,
// same pattern as topcinema.js's resolveBase().
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  const { finalUrl } = await fetchDoc(mainUrl + '/main', { headers: { ...baseHeaders, Referer: mainUrl } });
  cachedBase = new URL(finalUrl).origin;
  return cachedBase;
}

const CATALOGS = [
  { type: 'movie', id: 'faselhd-movies', name: 'Faselhd · أفلام', path: '/movies', search: true },
  { type: 'series', id: 'faselhd-series', name: 'Faselhd · مسلسلات', path: '/series', search: true },
];

// A show's season hub can list many seasons; cap how many we open and how many
// at once so building meta for one series can't fan out unbounded fetches.
const MAX_SEASONS = 15;
const SEASON_FETCH_CONCURRENCY = 4;

// Run async `fn` over `items` with at most `limit` in flight.
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Cards render as .postDiv / .blockMovie / .Small--Box, all with the same
// inner shape: `a[href]` for the link, `.h1/.h4/.h5` for the title.
function parseCards($, base) {
  const items = [];
  $('.postDiv, .blockMovie, .Small--Box').each((_, el) => {
    const a = $(el).find('a').first();
    const href = absUrl(a.attr('href'), base);
    if (!href) return;
    const title = $(el).find('.h1, .h4, .h5').first().text().trim();
    if (!title) return;
    const img = $(el).find('img').first();
    const poster = img.attr('data-src')?.trim() || img.attr('src')?.trim() || null;
    items.push({ url: href, name: title, poster });
  });
  return items;
}

async function getCatalog({ path, search, skip = 0 }) {
  const base = await resolveBase();
  let url;
  if (search) {
    url = `${base}/?s=${encodeURIComponent(search)}`;
  } else {
    const page = Math.floor(skip / PER_PAGE) + 1;
    url = page > 1 ? `${base}${path}/page/${page}` : `${base}${path}`;
  }
  const { $, finalUrl } = await fetchDoc(url, { headers: { ...baseHeaders, Referer: base + '/' } });
  return parseCards($, finalUrl);
}

async function getMeta({ url }) {
  const base = await resolveBase();
  const [pageUrl, hintPoster] = url.split('#');
  const { $, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

  const title = $('.singleInfo .title.h1').first().contents().first().text().trim() || 'Unknown';
  const plot = $('.singleDesc p, .story p').first().text().trim() || null;
  const poster =
    hintPoster ||
    $('meta[itemprop=image]').attr('content')?.trim() ||
    $('.posterImg img.poster').attr('src')?.trim() ||
    null;

  // Parse one page's own episode list (`#epAll`), tagging every entry with the
  // supplied season number. `#epAll` lists episodes ascending, so reverse to
  // return them newest-first like the catalog does.
  function parseEpisodes($doc, seasonNum) {
    const eps = [];
    $doc('div#epAll a').each((_, a) => {
      const epUrl = absUrl($doc(a).attr('href'), finalUrl);
      if (!epUrl) return;
      const epTitle = $doc(a).text().trim();
      if (!epTitle || /باقي الحلقات|المزيد/.test(epTitle)) return;
      const num = Number((epTitle.match(/\d+/) || [])[0]) || eps.length + 1;
      eps.push({ url: epUrl, name: epTitle, season: seasonNum, episode: num, poster });
    });
    return eps.reverse();
  }

  // Faselhd season hubs render every season as a `.seasonDiv` whose onclick is
  // `window.location.href = '/?p=<postId>'` and whose label reads "… موسم N".
  // The page we loaded is the `.seasonDiv.active` one, so its episodes are
  // already in this doc's `#epAll` — reuse it and only fetch the *other*
  // seasons. Before this, every episode was mislabeled season 1 and only the
  // active season was ever reachable (HANDOFF issue #1). If a div isn't
  // correctly flagged active it just gets fetched via its own href (one
  // redundant request), so no episodes are lost.
  const seasonEls = $('.seasonDiv').toArray();
  const episodes = [];

  if (seasonEls.length) {
    const seasons = seasonEls
      .map((el, i) => {
        const $el = $(el);
        // Use the shared parser (src/match.js) instead of a digits-only regex
        // so ordinal-word labels ("الموسم الأول") are read correctly, same as
        // Akwam. The seasonDiv text also contains a view-count number (e.g.
        // "308٬277 موسم 1"), but seasonFromTitle only reads digits adjacent to
        // a season keyword, so it isn't fooled by the view count.
        const num = seasonFromTitle($el.text()) || i + 1;
        const href = ($el.attr('onclick') || '').match(/href\s*=\s*['"]([^'"]+)['"]/);
        return {
          num,
          href: href ? absUrl(href[1], finalUrl) : null,
          active: /\bactive\b/.test($el.attr('class') || ''),
        };
      })
      .slice(0, MAX_SEASONS);

    await mapPool(seasons, SEASON_FETCH_CONCURRENCY, async (s) => {
      if (s.active) {
        episodes.push(...parseEpisodes($, s.num));
        return;
      }
      if (!s.href) return;
      try {
        const sd = await fetchDoc(s.href, { headers: { ...baseHeaders, Referer: finalUrl } });
        episodes.push(...parseEpisodes(sd.$, s.num));
      } catch {
        /* skip a season that failed to load */
      }
    });
  } else {
    // No season hub (single-season show): treat the current list as season 1.
    episodes.push(...parseEpisodes($, 1));
  }

  if (!episodes.length) {
    return { type: 'movie', name: title, poster, background: poster, description: plot };
  }
  return { type: 'series', name: title, poster, background: poster, description: plot, episodes };
}

// Pull the `video_player?player_token=...` URL out of the page's
// `player_iframe.location.href = '...'` onclick handler.
function extractPlayerUrl(html, base) {
  const m = html.match(/player_iframe\.location\.href\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return null;
  return absUrl(m[1], base);
}

async function getStreams({ url }) {
  const pageUrl = url.split('#')[0];
  const base = await resolveBase();
  const { $, finalUrl } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
  const playerUrl = extractPlayerUrl($.html(), finalUrl);
  if (!playerUrl) return [];

  if (!ENABLE_BROWSER) {
    // Direct-only mode (Vercel / ENABLE_BROWSER unset): the player URL never
    // exposes a static m3u8, only the headless resolver can get it.
    return [];
  }

  // Late-require: keeps Playwright out of any bundle where ENABLE_BROWSER
  // isn't set (see src/resolver.js's header comment and src/config.js).
  const { resolveStream } = require('../resolver');
  const resolved = await resolveStream(playerUrl, { referer: pageUrl });
  return resolved.map((r) => ({
    url: r.url,
    quality: r.quality || 'auto',
    referer: r.referer || playerUrl,
    host: 'faselhd-player',
    proxy: true,
    // Faselhd's m3u8 always embeds the resolving host's IP, so it's never
    // playable by anyone else's device — force proxy-only regardless of
    // whether the IPv4 regex in addon.js happens to catch this particular URL.
    ipBound: true,
  }));
}

module.exports = { id: 'faselhd', name: 'Faselhd', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
