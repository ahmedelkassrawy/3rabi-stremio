const { fetchDoc, fetchText } = require('../src/fetcher');

(async () => {
  const base = 'https://web8818x.faselhdx.life';
  const { $ } = await fetchDoc(base + '/main', { headers: { Referer: base } });
  const links = [
    ...new Set(
      $('a[href]')
        .map((_, e) => $(e).attr('href'))
        .get()
        .filter((h) => h && /\/(movies|film)\//i.test(h))
    ),
  ];
  console.log('sample movie links:', links.slice(0, 4));
  const first = links[0];
  if (!first) return console.log('no movie link found');

  const movieUrl = first.startsWith('http') ? first : base + first;
  const mp = await fetchDoc(movieUrl, { headers: { Referer: base } });
  console.log('movie:', movieUrl);
  console.log('title:', mp.$('.singleInfo .title.h1').first().text().trim());

  const html = mp.$.html();
  const iframes = mp.$('iframe[src]').map((_, e) => mp.$(e).attr('src')).get();
  const onclick = [...html.matchAll(/player_iframe\.location\.href\s*=\s*['"]([^'"]+)/g)].map((m) => m[1]);
  console.log('iframes:', iframes.slice(0, 4));
  console.log('onclick players:', onclick.slice(0, 4));

  const iframe =
    iframes.find((u) => !/recaptcha|googlesyndication|googletag/.test(u)) || onclick[0];
  if (!iframe) return console.log('NO PLAYER IFRAME');

  const ifu = iframe.startsWith('http') ? iframe : base + iframe;
  console.log('\nplayer iframe:', ifu);
  const r = await fetchText(ifu, { headers: { Referer: movieUrl } });
  console.log('status:', r.status, 'len:', r.text.length);
  console.log('  has enc: ', r.text.includes('enc:'));
  console.log('  has jwplayer:', r.text.includes('jwplayer'));
  console.log('  has .m3u8:', r.text.includes('.m3u8'));
  console.log('  has "sources":', r.text.includes('sources'));

  const files = [...r.text.matchAll(/["']?file["']?\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  console.log('  file: entries:', files.slice(0, 6));
  const m3u8s = [...r.text.matchAll(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g)].map((m) => m[0]);
  console.log('  raw m3u8 urls:', m3u8s.slice(0, 4));
  const encs = [...r.text.matchAll(/enc:[A-Za-z0-9+/=_-]+/g)].map((m) => m[0]);
  console.log('  enc: tokens:', encs.slice(0, 3).map((s) => s.slice(0, 50)));
})().catch((e) => console.log('ERR', e.cause?.message || e.message));
