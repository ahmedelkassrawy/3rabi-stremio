// Unit tests for the HLS master-playlist parser and the enrichHlsQuality
// best-effort labeler. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseMaxResolution, enrichStreamQuality, enrichHlsQuality } = require('../src/hls');

test('parseMaxResolution returns the highest RESOLUTION height across variants', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    'v720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
    'v1080.m3u8',
  ].join('\n');
  assert.equal(parseMaxResolution(master), 1080);
});

test('parseMaxResolution finds the max regardless of tag order (not just the first)', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
    'v1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v360.m3u8',
  ].join('\n');
  assert.equal(parseMaxResolution(master), 1080);
});

test('parseMaxResolution returns null for a media playlist with no RESOLUTION tags', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000,',
    'segment0.ts',
    '#EXTINF:6.000,',
    'segment1.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  assert.equal(parseMaxResolution(media), null);
});

test('parseMaxResolution returns null for an empty string', () => {
  assert.equal(parseMaxResolution(''), null);
});

test('parseMaxResolution returns null for a 403 HTML error page', () => {
  const errorPage = '<html><head><title>403 Forbidden</title></head><body>Forbidden</body></html>';
  assert.equal(parseMaxResolution(errorPage), null);
});

test('parseMaxResolution handles a 4K entry', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160',
    'v2160.m3u8',
  ].join('\n');
  assert.equal(parseMaxResolution(master), 2160);
});

// enrichHlsQuality needs a real fetch target (it's the network-touching half
// of this module), so these spin up a local HTTP server rather than hitting
// the network or mocking fetchText — a real 127.0.0.1 socket exercises the
// actual fetch/timeout/Promise.race path enrichHlsQuality depends on.
let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/master.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
          'v720.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
          'v1080.m3u8',
        ].join('\n')
      );
      return;
    }
    if (req.url.startsWith('/movie.mp4')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end('not-a-playlist');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('enrichHlsQuality relabels "auto" with the real max resolution on a fetchable master playlist', async () => {
  const streams = [{ url: `http://127.0.0.1:${port}/master.m3u8`, quality: 'auto' }];
  await enrichHlsQuality(streams);
  assert.equal(streams[0].quality, '1080');
  assert.equal(typeof streams[0].quality, 'string');
});

test('enrichHlsQuality leaves a non-"auto" quality untouched (filter only touches /^auto$/i)', async () => {
  const streams = [{ url: `http://127.0.0.1:${port}/master.m3u8`, quality: '720' }];
  await enrichHlsQuality(streams);
  assert.equal(streams[0].quality, '720');
});

test('enrichHlsQuality leaves a non-.m3u8 URL untouched (filter excludes it, no fetch attempted)', async () => {
  const streams = [{ url: `http://127.0.0.1:${port}/movie.mp4`, quality: 'auto' }];
  await enrichHlsQuality(streams);
  assert.equal(streams[0].quality, 'auto');
});

test('enrichHlsQuality fails open on a fetch error and never throws', async () => {
  // Port 1 has nothing listening — connection refused immediately, no
  // dedicated server needed for this case.
  const streams = [{ url: 'http://127.0.0.1:1/master.m3u8', quality: 'auto' }];
  await assert.doesNotReject(enrichHlsQuality(streams));
  assert.equal(streams[0].quality, 'auto');
});

// enrichStreamQuality is the single-stream unit providers now call directly,
// interleaved into their resolve pool (see topcinema.js/egydead.js) rather
// than after the fact — same server/self-filtering/fail-open behavior as
// enrichHlsQuality above, just one stream at a time and no return value.
test('enrichStreamQuality relabels "auto" with the real max resolution (string) on a fetchable master playlist', async () => {
  const stream = { url: `http://127.0.0.1:${port}/master.m3u8`, quality: 'auto' };
  await enrichStreamQuality(stream);
  assert.equal(stream.quality, '1080');
  assert.equal(typeof stream.quality, 'string');
});

test('enrichStreamQuality leaves a non-"auto" quality untouched', async () => {
  const stream = { url: `http://127.0.0.1:${port}/master.m3u8`, quality: '720' };
  await enrichStreamQuality(stream);
  assert.equal(stream.quality, '720');
});

test('enrichStreamQuality leaves a non-.m3u8 URL untouched (no fetch attempted)', async () => {
  const stream = { url: `http://127.0.0.1:${port}/movie.mp4`, quality: 'auto' };
  await enrichStreamQuality(stream);
  assert.equal(stream.quality, 'auto');
});

test('enrichStreamQuality fails open on a connection-refused url and never throws', async () => {
  const stream = { url: 'http://127.0.0.1:1/master.m3u8', quality: 'auto' };
  await assert.doesNotReject(enrichStreamQuality(stream));
  assert.equal(stream.quality, 'auto');
});

test('enrichHlsQuality skips entirely when too little time remains before the caller deadline', async () => {
  const streams = [{ url: `http://127.0.0.1:${port}/master.m3u8`, quality: 'auto' }];
  const start = Date.now();
  // deadline is only 100ms out — less than SAFETY_MARGIN_MS (1500ms), so the
  // computed budget goes negative/clamped and enrichment must be skipped
  // rather than racing a fetch it can't safely finish.
  await enrichHlsQuality(streams, { deadline: Date.now() + 100 });
  const elapsed = Date.now() - start;
  assert.equal(streams[0].quality, 'auto');
  assert.ok(elapsed < 300, `expected a fast skip, took ${elapsed}ms`);
});
