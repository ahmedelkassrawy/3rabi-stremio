// Akwam provider — a port of the CloudStream `Akwam.kt` scraper.
// Source site: https://ak.sv  (currently 301-redirects to https://akwam.it).
//
// The provider is intentionally framework-agnostic: it returns plain objects
// (catalog items, meta, streams) and lets addon.js translate them into the
// Stremio wire format. Every "id" it deals in is a real site URL.
const { fetchDoc, absUrl } = require('../fetcher');
const { seasonFromTitle } = require('../match');

// Use the live domain directly. The old entry domain ak.sv 301-redirects here,
// but Cloudflare hard-challenges ak.sv from datacenter IPs (403 "Just a
// moment") while akwam.it serves 200 — so hitting akwam.it is what lets this
// run on serverless hosts like Vercel.
const mainUrl = 'https://akwam.it';
const PER_PAGE = 30; // Akwam lists ~30 cards per page; used to map Stremio `skip`.

const ITEM_SELECTOR = 'div.col-lg-auto.col-md-4.col-6';

function getPoster($, el) {
  const img = $(el).find('img').first();
  if (!img.length) return null;
  return img.attr('data-src')?.trim() || img.attr('src')?.trim() || null;
}

// Parse a listing/search page into catalog items.
function parseListing($, base) {
  const items = [];
  $(ITEM_SELECTOR).each((_, el) => {
    const a = $(el).find('h3.entry-title a').first();
    const title = a.text().trim();
    if (!title) return;
    const href = absUrl($(el).find('a').first().attr('href'), base);
    if (!href) return;
    items.push({ url: href, name: title, poster: getPoster($, el) });
  });
  return items;
}

const CATALOGS = [
  { type: 'movie', id: 'akwam-movies', name: 'Akwam · أفلام', path: '/movies', search: true },
  { type: 'series', id: 'akwam-series', name: 'Akwam · مسلسلات', path: '/series', search: true },
];

async function getCatalog({ path, search, skip = 0 }) {
  if (search) {
    const url = `${mainUrl}/search?q=${encodeURIComponent(search)}`;
    const { $, finalUrl } = await fetchDoc(url);
    return parseListing($, finalUrl);
  }
  const page = Math.floor(skip / PER_PAGE) + 1;
  const url = page > 1 ? `${mainUrl}${path}?page=${page}` : `${mainUrl}${path}`;
  const { $, finalUrl } = await fetchDoc(url);
  return parseListing($, finalUrl);
}

// Delegate to the shared parser (src/match.js) so Akwam and every other
// provider agree on how Arabic/numeric season markers are read. Unlike the
// old local numeric fallback — which grabbed the LAST number anywhere in the
// title and could misfire on things like "Yellowstone 1883" or a bare year —
// seasonFromTitle only reads digits adjacent to a season keyword. Preserve
// the 999 sentinel: callers here treat 999 as "couldn't tell, assume season 1".
function getSeasonNumber(name) {
  const s = seasonFromTitle(name);
  return s == null ? 999 : s;
}

// Akwam episode titles always LEAD with the episode number right after
// "حلقة" (e.g. "حلقة 7 : مسلسل Breaking Bad الموسم الاول  A No-Rough-Stuff-..."),
// so the first number in the string is the episode number. Using the last
// number (the old behavior) broke whenever the English episode title itself
// contained a number ("2 Guns", "Part 3") or a trailing year — it would
// return that instead of the real episode number.
function episodeNumberFrom(name) {
  const nums = name.match(/\d+/g);
  return nums ? Number(nums[0]) : null;
}

async function getMeta({ url }) {
  // The catalog stores "pageUrl#poster"; split it back apart.
  const [pageUrl, hintPoster] = url.split('#');
  const headers = { Referer: mainUrl };
  const { $, finalUrl } = await fetchDoc(pageUrl, { headers });
  const base = finalUrl;

  const title = $('h1.entry-title').first().text().trim() || 'Unknown';
  const plot =
    $('h2:contains(قصة المسلسل) + div > p').first().text().trim() ||
    $('meta[name=description]').attr('content')?.trim() ||
    null;
  const poster = hintPoster || $('meta[property="og:image"]').attr('content') || null;
  const year = Number(
    $("div.font-size-16.text-white a[href*='/year/']").first().text().trim()
  ) || null;
  const genres = $(
    "div.font-size-16.text-white a[href*='/genre/'], div.font-size-16.text-white a[href*='/category/']"
  )
    .map((_, a) => $(a).text().trim())
    .get()
    .filter(Boolean);

  // Collect seasons (the current page is always season 1), then episodes.
  const seasons = new Map(); // url -> name
  seasons.set(base, title);
  $("div.widget-body > a.btn[href*='/series/']").each((_, a) => {
    const href = absUrl($(a).attr('href'), base);
    if (href && !seasons.has(href)) seasons.set(href, $(a).text().trim());
  });

  const directEpisodes = $("div#series-episodes div[class*='col-']");
  const isSeries = seasons.size > 1 || directEpisodes.length > 0;

  if (!isSeries) {
    return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
  }

  const sorted = [...seasons.entries()].sort(
    (a, b) => getSeasonNumber(a[1]) - getSeasonNumber(b[1])
  );
  const episodes = [];
  for (const [seasonUrl, seasonName] of sorted) {
    const seasonNumber = getSeasonNumber(seasonName);
    let sdoc = $;
    if (seasonUrl !== base) {
      try {
        sdoc = (await fetchDoc(seasonUrl, { headers })).$;
      } catch {
        continue;
      }
    }
    sdoc('div#series-episodes div.col-lg-4, div#series-episodes div.col-md-6').each((_, c) => {
      const link = sdoc(c).find("a[href*='/episode/']").first();
      const epUrl = absUrl(link.attr('href'), base);
      const epName = link.find('h2').first().text().trim() || link.text().trim();
      if (!epUrl || !epName) return;
      episodes.push({
        url: epUrl,
        name: epName,
        season: seasonNumber === 999 ? 1 : seasonNumber,
        episode: episodeNumberFrom(epName) ?? episodes.length + 1,
        poster: getPoster(sdoc, c),
      });
    });
  }

  if (!episodes.length) {
    return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
  }
  return { type: 'series', name: title, poster, background: poster, description: plot, year, genres, episodes };
}

// Port of loadLinks(): page -> watch page -> <source> tags.
async function getStreams({ url }) {
  const pageUrl = url.split('#')[0];
  const { $, finalUrl } = await fetchDoc(pageUrl);
  const base = new URL(finalUrl).origin;

  // `a.link-show` now points straight at the complete watch URL for both movies
  // (/watch/<watchId>/<contentId>/<slug>) and episodes. Older Akwam builds
  // required reconstructing it from #page_id; kept as a fallback.
  const linkShow = $('a.link-show').first();
  const watchHref = (linkShow.attr('href') || '').trim();
  let watchUrl;
  if (watchHref.includes('/watch/')) {
    watchUrl = absUrl(watchHref, base);
  } else {
    const pageId = ($('input#page_id').attr('value') || $('input#page_id').attr('data-value') || '').trim();
    if (!watchHref || !pageId) return [];
    const idx = watchHref.indexOf('watch');
    const suffix = (idx >= 0 ? watchHref.slice(idx + 'watch'.length) : watchHref)
      .trim().replace(/^\/+/, '').replace(/\/+$/, '');
    watchUrl = new URL(`/watch/${suffix}/${pageId}`.replace(/\/{2,}/g, '/'), base).toString();
  }
  if (!watchUrl) return [];

  let sdoc;
  try {
    sdoc = (await fetchDoc(watchUrl)).$;
  } catch {
    sdoc = (await fetchDoc(watchUrl, { headers: { Referer: pageUrl } })).$;
  }

  const streams = [];
  const seen = new Set();
  sdoc('source[src]').each((_, s) => {
    // The downet.net CDN serves an incomplete TLS chain over https that many
    // players reject; the http endpoint streams fine (206 + range support), so
    // downgrade like the original CloudStream provider does.
    const raw = (sdoc(s).attr('src') || '').trim().replace(/ /g, '%20').replace(/^https:/, 'http:');
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    const quality = (sdoc(s).attr('size') || sdoc(s).attr('label') || 'direct').trim();
    streams.push({ url: raw, quality });
  });
  return streams;
}

module.exports = { id: 'akwam', name: 'Akwam', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
// Exposed for test/akwam.test.js: the first-number-wins episode parsing is
// easy to regress silently (e.g. reverting to "last number"), so it gets its
// own network-free unit tests, mirroring how addon.js exposes internals.
module.exports.episodeNumberFrom = episodeNumberFrom;
