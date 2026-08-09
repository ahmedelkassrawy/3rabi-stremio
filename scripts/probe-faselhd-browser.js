// Validate that a headless browser can resolve a Faselhd stream (obfuscated
// JS player -> sniff the .m3u8 the player requests). Proves the resolver technique.
const { chromium } = require('playwright');
const { fetchDoc } = require('../src/fetcher');

(async () => {
  const start = 'https://web31312x.faselhdx.bid';
  const { $, finalUrl } = await fetchDoc(start + '/main', { headers: { Referer: start } });
  const base = new URL(finalUrl).origin;
  const movie = [
    ...new Set($('a[href]').map((_, e) => $(e).attr('href')).get().filter((h) => /\/movies\//i.test(h))),
  ][0];
  console.log('movie:', movie);

  const md = await fetchDoc(movie, { headers: { Referer: base } });
  const html = md.$.html();
  const playerUrl = [...html.matchAll(/player_iframe\.location\.href\s*=\s*['"]([^'"]+)/g)].map((m) => m[1])[0];
  console.log('player iframe URL:', playerUrl ? playerUrl.slice(0, 80) + '...' : null);
  if (!playerUrl) return console.log('no player URL');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const found = new Set();
  const sniff = (u) => {
    if (u.includes('.m3u8')) found.add(u);
  };
  page.on('request', (r) => sniff(r.url()));
  page.on('response', (r) => sniff(r.url()));

  try {
    await page.goto(playerUrl, { referer: movie, waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give the obfuscated player time to build/fetch the HLS, and nudge play.
    for (let i = 0; i < 12 && found.size === 0; i++) {
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        try {
          document.querySelectorAll('video, .jw-icon-display, button, [onclick]').forEach((el) => {
            try { el.click(); } catch {}
          });
          if (window.jwplayer) { const p = window.jwplayer('player'); p && p.play && p.play(); }
        } catch {}
      }).catch(() => {});
    }
  } catch (e) {
    console.log('nav error:', e.message);
  }

  console.log('m3u8 sniffed:', [...found].slice(0, 3));
  await browser.close();
})().catch((e) => console.log('ERR', e.message));
