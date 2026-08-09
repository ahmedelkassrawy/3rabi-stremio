// Top Cinema provider — a port of the CloudStream `topcinemaProvider.kt`.
// Source site: https://web8.topcinema.cam (rotating; redirects to the live
// domain, currently topcinemaa.co).
//
// Catalog/meta are plain HTML scraping. Streams: the /watch/ page exposes a
// player iframe plus an AJAX server list; each server resolves to an external
// host embed. Most hosts (Vidtube, StreamWish, Filelions, Lulustream, Uqload)
// ship a `eval(function(p,a,c,k,e,d)...)` packed script whose unpacked body
// contains `file:"..."` — one generic unpacker handles them all. The /download/
// page also yields direct file links.
const cheerio = require('cheerio');
const { fetchDoc, fetchText, absUrl } = require('../fetcher');

const mainUrl = 'https://web8.topcinema.cam';
const PER_PAGE = 60;
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const baseHeaders = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8' };

// The public domain rotates; resolve it once from a redirect and cache it.
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;
  const { finalUrl } = await fetchDoc(mainUrl + '/', { headers: { ...baseHeaders, Referer: mainUrl + '/' } });
  cachedBase = new URL(finalUrl).origin;
  return cachedBase;
}

const CATALOGS = [
  { type: 'movie', id: 'topcinema-movies', name: 'Top Cinema · أفلام', path: '/movies/', search: true },
  { type: 'series', id: 'topcinema-series', name: 'Top Cinema · مسلسلات', path: '/series/', search: true },
];

function parseCards($, base) {
  const items = [];
  $('.Posts--List .Small--Box, .Slides--Main .Slides--Item').each((_, el) => {
    const a = $(el).find('a').first();
    const href = absUrl(a.attr('href'), base);
    if (!href) return;
    const title = (a.attr('title') || a.text() || '').trim();
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
    url = `${base}/search/?query=${encodeURIComponent(search)}&type=all`;
  } else {
    const page = Math.floor(skip / PER_PAGE) + 1;
    url = page > 1 ? `${base}${path}page/${page}/` : `${base}${path}`;
  }
  const { $, finalUrl } = await fetchDoc(url, { headers: { ...baseHeaders, Referer: base + '/' } });
  return parseCards($, finalUrl);
}

async function getMeta({ url }) {
  const base = await resolveBase();
  const [pageUrl, hintPoster] = url.split('#');
  const { $ } = await fetchDoc(pageUrl, { headers: { ...baseHeaders, Referer: base + '/' } });

  const title =
    $('h1.post-title a').first().text().trim() || $('h1.post-title').first().text().trim() || 'Unknown';
  const poster = hintPoster || $('.MainSingle .left .image img').attr('src') || null;
  const plot = $('.story p').first().text().trim() || null;
  const genres = $('.RightTaxContent li:contains(نوع) a').map((_, a) => $(a).text().trim()).get();
  const year = Number($('.RightTaxContent li:contains(الصدور) a').first().text().trim()) || null;

  const isSeries = $('section.tabs').length > 0;
  if (!isSeries) {
    return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
  }

  const episodes = [];
  const seasonLinks = $('section.allseasonss .Small--Box.Season a');
  const seasonNumFromTitle = Number((title.match(/الموسم\s+(\d+)/) || [])[1]) || 1;

  async function collectEpisodes($doc, seasonNum, seasonPoster) {
    const eps = [];
    $doc('.allepcont .row > a').each((_, ep) => {
      const epUrl = absUrl($doc(ep).attr('href'), base);
      if (!epUrl) return;
      const epTitle = $doc(ep).find('h2').first().text().trim() || $doc(ep).text().trim();
      const num = Number(($doc(ep).find('.epnum').text().replace('الحلقة', '').trim().match(/\d+/) || [])[0]);
      eps.push({
        url: epUrl,
        name: epTitle || `الحلقة ${num || eps.length + 1}`,
        season: seasonNum,
        episode: num || eps.length + 1,
        poster: seasonPoster || poster,
      });
    });
    return eps.reverse();
  }

  if (seasonLinks.length > 0) {
    for (let i = 0; i < seasonLinks.length; i++) {
      const el = seasonLinks.eq(i);
      const seasonUrl = absUrl(el.attr('href'), base);
      const seasonPoster = el.find('img').attr('src') || null;
      const seasonNum = Number((el.find('.epnum').text().replace('الموسم', '').trim().match(/\d+/) || [])[0]) || i + 1;
      try {
        const sd = await fetchDoc(seasonUrl, { headers: { ...baseHeaders, Referer: pageUrl } });
        episodes.push(...(await collectEpisodes(sd.$, seasonNum, seasonPoster)));
      } catch {
        /* skip season on failure */
      }
    }
  }
  if (episodes.length === 0) {
    episodes.push(...(await collectEpisodes($, seasonNumFromTitle, poster)));
  }

  if (episodes.length === 0) {
    return { type: 'movie', name: title, poster, background: poster, description: plot, year, genres };
  }
  return { type: 'series', name: title, poster, background: poster, description: plot, year, genres, episodes };
}

// ---- stream extraction ----

// Decode a p,a,c,k,e,d packed payload (Dean Edwards packer), matching unpackJs.
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

function unwrapPlayUrl(url) {
  if (url.includes('play.php?to=')) {
    try {
      const decoded = decodeURIComponent(url.split('play.php?to=')[1]).trim();
      return decoded.startsWith('http') ? decoded : `https:${decoded.replace(/^:/, '')}`;
    } catch {
      return url;
    }
  }
  return url;
}

async function getStreams({ url }) {
  const base = await resolveBase();
  const pageUrl = url.split('#')[0].replace(/\/$/, '');
  const watchUrl = `${pageUrl}/watch/`;
  const downloadUrl = `${pageUrl}/download/`;

  const embeds = new Map(); // embedUrl -> referer
  const streams = [];
  const seen = new Set();

  // 1) /watch/ page: player iframe + AJAX server list.
  try {
    const w = await fetchText(watchUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
    const wd = cheerio.load(w.text);
    const wbase = new URL(w.url).origin;
    const iframe = wd('.player--iframe iframe').attr('src');
    if (iframe) embeds.set(absUrl(iframe, wbase), w.url);

    const servers = wd('.watch--servers--list li.server--item')
      .map((_, e) => ({ id: wd(e).attr('data-id'), i: wd(e).attr('data-server') }))
      .get()
      .filter((s) => s.id != null && s.i != null);

    await Promise.all(
      servers.map(async (s) => {
        try {
          const ajax = `${wbase}/wp-content/themes/movies2023/Ajaxat/Single/Server.php`;
          const body = new URLSearchParams({ id: s.id, i: s.i }).toString();
          const r = await fetchText(ajax, {
            method: 'POST',
            body,
            headers: { ...baseHeaders, Referer: w.url, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*' },
          });
          const src = cheerio.load(r.text)('iframe').attr('src');
          if (src) embeds.set(absUrl(src, wbase), w.url);
        } catch {
          /* skip server */
        }
      })
    );
  } catch {
    /* watch page failed */
  }

  // 2) Resolve each host embed via the generic packed-script unpacker.
  await Promise.all(
    [...embeds.entries()].map(async ([embed, referer]) => {
      const finalLink = unwrapPlayUrl(embed);
      try {
        const r = await fetchText(finalLink, { headers: { ...baseHeaders, Referer: referer }, timeout: 12000 });
        const host = new URL(finalLink).hostname.replace(/^www\./, '').split('.')[0];
        const origin = new URL(finalLink).origin;
        for (const f of extractPacked(r.text)) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          // These CDNs 403 without the embed page as Referer AND its Origin.
          streams.push({ url: f.url, quality: f.quality, referer: finalLink, origin, host });
        }
      } catch {
        /* host unreachable / unsupported */
      }
    })
  );

  // 3) /download/ page: only keep links that are direct media files (most are
  // host landing pages, which aren't playable, so filter to real files).
  try {
    const d = await fetchDoc(downloadUrl, { headers: { ...baseHeaders, Referer: base + '/' } });
    d.$('a.downloadsLink').each((_, a) => {
      const href = d.$(a).attr('href');
      if (href && !seen.has(href) && /\.(mp4|mkv|m3u8)(\?|$)/i.test(href)) {
        seen.add(href);
        const q = d.$(a).find('.quality, .resolution').text().trim() || 'Download';
        streams.push({ url: href, quality: q, host: 'download' });
      }
    });
  } catch {
    /* no download page */
  }

  return streams;
}

module.exports = { id: 'topcinema', name: 'Top Cinema', catalogs: CATALOGS, getCatalog, getMeta, getStreams };
