const { fetchDoc, fetchText } = require('../src/fetcher');

const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8' };

(async () => {
  const main = 'https://web8.topcinema.cam';
  console.log('== home ==');
  const home = await fetchText(main + '/', { headers: { ...H, Referer: main + '/' } });
  console.log('status', home.status, 'final', home.url, 'len', home.text.length,
    'challenge', /just a moment|cf_chl|Attention Required/i.test(home.text),
    'Small--Box', home.text.includes('Small--Box'));

  const { $ } = await fetchDoc(main + '/', { headers: { ...H, Referer: main + '/' } });
  const cards = $('.Posts--List .Small--Box a, .Slides--Main .Slides--Item a')
    .map((_, e) => ({ href: $(e).attr('href'), title: $(e).attr('title') }))
    .get()
    .filter((c) => c.href);
  console.log('cards:', cards.length, '| sample:', cards.slice(0, 3).map((c) => c.title));

  // pick a movie
  const movie = cards.find((c) => (c.title || '').includes('فيلم')) || cards[0];
  console.log('\n== movie ==', movie.title, movie.href);
  const md = await fetchDoc(movie.href, { headers: { ...H, Referer: main + '/' } });
  console.log('title:', md.$('h1.post-title').first().text().trim());
  console.log('isSeries(section.tabs):', md.$('section.tabs').length > 0);

  // watch page
  const watchUrl = movie.href.replace(/\/$/, '') + '/watch/';
  console.log('\n== watch ==', watchUrl);
  const w = await fetchText(watchUrl, { headers: { ...H, Referer: movie.href } });
  console.log('watch status', w.status, 'final', w.url, 'len', w.text.length);
  const wd = require('cheerio').load(w.text);
  const iframe = wd('.player--iframe iframe').attr('src');
  console.log('player iframe:', iframe);
  const servers = wd('.watch--servers--list li.server--item')
    .map((_, e) => ({ id: wd(e).attr('data-id'), i: wd(e).attr('data-server'), name: wd(e).text().trim() }))
    .get();
  console.log('servers:', servers.length, JSON.stringify(servers.slice(0, 8)));

  // resolve one server via AJAX
  const base = new URL(w.url).origin;
  if (servers[0]) {
    const ajax = base + '/wp-content/themes/movies2023/Ajaxat/Single/Server.php';
    const body = new URLSearchParams({ id: servers[0].id || '', i: servers[0].i || '' }).toString();
    const r = await fetchText(ajax, {
      method: 'POST',
      body,
      headers: { ...H, Referer: w.url, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*' },
    });
    const host = require('cheerio').load(r.text)('iframe').attr('src');
    console.log('server0 ajax -> iframe host:', host);
  }
})().catch((e) => console.log('ERR', e.cause?.message || e.message));
