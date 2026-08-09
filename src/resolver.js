// Headless-browser stream resolver. Only ever require()'d when
// ENABLE_BROWSER=1 (see src/config.js) — providers late-require this module
// so Vercel's Chromium-free serverless bundle never pulls Playwright in.
//
// Some host-based embeds (Faselhd's obfuscated player, in particular) build
// their .m3u8 URL client-side via JS instead of exposing it in the HTML, and
// Cloudflare hard-blocks plain HTTP fetches from datacenter IPs anyway. A
// real browser navigation sidesteps both problems: we open the embed/player
// URL in headless Chromium and sniff the network requests it makes for the
// media URL, the same technique scripts/probe-faselhd-browser.js validated.
const { chromium } = require('playwright');
const { DESKTOP_UA } = require('./config');

let browserPromise = null;

// Lazily launch one shared Chromium instance and reuse it across resolves —
// launching a fresh browser per request is far too slow for a stream lookup.
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

// URLs that show up in media-looking requests but are never the stream
// itself — ad/analytics/captcha noise the sniffer should ignore.
const IGNORE_RE = /(google|recaptcha|analytics|doubleclick|googlesyndication|googletagmanager|\.gif(\?|$)|pixel|ping)/i;

function isMediaUrl(u) {
  if (!u || !/\.(m3u8|mp4)(\?|$)/i.test(u)) return false;
  return !IGNORE_RE.test(u);
}

// Prefer a "master"/"playlist"/"index" .m3u8 (the manifest) over segment/
// variant URLs when several media URLs got sniffed.
function pickBest(urls) {
  const list = [...urls];
  const manifest = list.find((u) => {
    const clean = u.split('?')[0];
    return clean.endsWith('.m3u8') && /(master|playlist|index)/i.test(clean);
  });
  if (manifest) return manifest;
  const anyM3u8 = list.find((u) => u.split('?')[0].endsWith('.m3u8'));
  return anyM3u8 || list[0];
}

// Resolve a page/embed URL to a playable media URL by watching what the page
// requests. Never throws — callers treat "no streams" as a normal outcome.
async function resolveStream(pageUrl, { referer } = {}) {
  let context;
  let page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ userAgent: DESKTOP_UA, ignoreHTTPSErrors: true });
    page = await context.newPage();

    const found = new Set();
    const sniff = (url) => {
      if (isMediaUrl(url)) found.add(url);
    };
    page.on('request', (r) => sniff(r.url()));
    page.on('response', (r) => sniff(r.url()));

    try {
      await page.goto(pageUrl, { referer, waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      // Navigation errors (timeouts, aborted loads) still leave a chance the
      // sniffer caught something before failing — keep going.
    }

    // Poll for ~15s, nudging play controls each second until a media URL
    // shows up (the player often waits for a genuine click/gesture).
    for (let i = 0; i < 15 && found.size === 0; i++) {
      await page.waitForTimeout(1000);
      await page
        .evaluate(() => {
          try {
            document.querySelectorAll('video, .jw-icon-display, button, [onclick]').forEach((el) => {
              try {
                el.click();
              } catch {
                /* ignore unclickable element */
              }
            });
            if (window.jwplayer) {
              const p = window.jwplayer('player');
              if (p && p.play) p.play();
            }
          } catch {
            /* page has no jwplayer / DOM not ready yet */
          }
        })
        .catch(() => {});
    }

    if (!found.size) return [];
    const best = pickBest(found);
    return [{ url: best, quality: 'auto', referer: pageUrl, headers: { Referer: pageUrl, 'User-Agent': DESKTOP_UA } }];
  } catch {
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

module.exports = { resolveStream, closeBrowser };
