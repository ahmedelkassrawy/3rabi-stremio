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

  // v1: only the current page's own episode list (`#epAll`), treated as
  // season 1. Faselhd's cross-season navigation is via `.seasonDiv` onclick
  // (`window.location.href = '...'`) to a *different page* per season — left
  // as a follow-up rather than v1 scope.
  const episodes = [];
  $('div#epAll a').each((_, a) => {
    const epUrl = absUrl($(a).attr('href'), finalUrl);
    if (!epUrl) return;
    const epTitle = $(a).text().trim();
    if (!epTitle || /باقي الحلقات|المزيد/.test(epTitle)) return;
    const num = Number((epTitle.match(/\d+/) || [])[0]) || episodes.length + 1;
    episodes.push({ url: epUrl, name: epTitle, season: 1, episode: num, poster });
  });

  if (!episodes.length) {
    return { type: 'movie', name: title, poster, background: poster, description: plot };
  }
  return { type: 'series', name: title, poster, background: poster, description: plot, episodes: episodes.reverse() };
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
