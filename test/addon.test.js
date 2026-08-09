// Unit tests for the pure, network-free direct-vs-proxy/ipBound stream
// mapping (toStremioStreams). Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toStremioStreams, orderCandidatesBySeason } = require('../src/addon');

const provider = { id: 'akwam', name: 'Akwam' };

test('toStremioStreams: a non-proxy stream maps to a single entry with quality label + notWebReady for http', () => {
  const streams = [{ url: 'http://cdn.example/movie.mp4', quality: '1080' }];
  const out = toStremioStreams(provider, streams);

  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'http://cdn.example/movie.mp4');
  assert.equal(out[0].name, provider.name);
  assert.equal(out[0].description, '1080p');
  assert.equal(out[0].behaviorHints.notWebReady, true); // http:// -> native player, not the web one
  assert.equal(out[0].behaviorHints.bingeGroup, `3rabi-${provider.id}`);
  assert.equal(out[0].behaviorHints.proxyHeaders, undefined); // no referer -> no proxyHeaders
});

test('toStremioStreams: a non-proxy https stream is not marked notWebReady', () => {
  const streams = [{ url: 'https://cdn.example/movie.mp4', quality: 'direct' }];
  const out = toStremioStreams(provider, streams);

  assert.equal(out.length, 1);
  assert.equal(out[0].behaviorHints.notWebReady, false);
  assert.equal(out[0].description, 'Direct');
});

test('toStremioStreams: a proxy stream that is NOT ip-bound produces direct + proxy entries', () => {
  const streams = [
    { url: 'https://host.example/hls/master.m3u8', quality: '720', proxy: true, host: 'luluvdo', referer: 'https://embed.example/e/1' },
  ];
  const out = toStremioStreams(provider, streams);

  assert.equal(out.length, 2);

  const [direct, proxied] = out;
  assert.equal(direct.url, 'https://host.example/hls/master.m3u8');
  assert.equal(direct.name, `${provider.name}\nluluvdo`);
  assert.match(direct.description, /· direct$/);
  assert.deepEqual(direct.behaviorHints.proxyHeaders.request.Referer, 'https://embed.example/e/1');
  assert.equal(direct.behaviorHints.bingeGroup, `3rabi-${provider.id}`);

  assert.notEqual(proxied.url, streams[0].url); // rewritten through /proxy
  assert.match(proxied.url, /\/proxy\?url=/);
  assert.match(proxied.description, /· proxy$/);
  assert.equal(proxied.behaviorHints.proxyHeaders, undefined); // proxy entry carries no client-side headers
});

test('toStremioStreams: a proxy stream that IS ip-bound (explicit flag) produces a proxy-only entry', () => {
  const streams = [{ url: 'https://host.example/hls/master.m3u8', quality: 'auto', proxy: true, ipBound: true }];
  const out = toStremioStreams(provider, streams);

  assert.equal(out.length, 1);
  assert.match(out[0].url, /\/proxy\?url=/);
  assert.match(out[0].description, /· proxy$/);
});

test('toStremioStreams: a proxy stream that IS ip-bound (detected via literal IPv4 in the url) produces a proxy-only entry', () => {
  const streams = [{ url: 'https://203.0.113.5/hls/master.m3u8', quality: 'auto', proxy: true }];
  const out = toStremioStreams(provider, streams);

  assert.equal(out.length, 1);
  assert.match(out[0].url, /\/proxy\?url=/);
});

test('toStremioStreams: multiple streams from one provider all get that provider\'s bingeGroup', () => {
  const streams = [
    { url: 'http://a.example/1.mp4', quality: '1080' },
    { url: 'http://a.example/2.mp4', quality: '720' },
  ];
  const out = toStremioStreams(provider, streams);
  assert.equal(out.length, 2);
  for (const s of out) assert.equal(s.behaviorHints.bingeGroup, `3rabi-${provider.id}`);
});

test('orderCandidatesBySeason: the exact-season card (tier 0) sorts first regardless of incoming order', () => {
  const cands = [
    { name: 'X الموسم الثالث', url: 's3' },
    { name: 'X الموسم الاول', url: 's1' },
    { name: 'X الموسم الثاني', url: 's2' },
  ];
  const out = orderCandidatesBySeason(cands, 1);
  assert.equal(out[0].url, 's1');
});

test('orderCandidatesBySeason: an unknown-season card (tier 1) sorts ahead of a concretely-different-season card (tier 2)', () => {
  const cands = [
    { name: 'X الموسم الثاني', url: 's2' }, // tier 2: concretely season 2, not what we want
    { name: 'X', url: 'hub' }, // tier 1: no season marker, unknown
  ];
  const out = orderCandidatesBySeason(cands, 1); // requested season 1 isn't present in either
  assert.equal(out[0].url, 'hub');
});
