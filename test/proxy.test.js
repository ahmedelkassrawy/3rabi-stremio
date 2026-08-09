// Unit tests for the pure, network-free proxy logic. Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');

// rewriteManifest isn't exported (keeps proxy.js's surface small), so we test
// it through a tiny reflection: re-require the module and reach the function
// via its behavior on handleProxy is impractical, so we require the internals
// by loading the file and grabbing the functions we need. To keep this simple
// and honest, proxy.js exports the helpers it can; here we test the exported
// proxifyUrl + a locally-mirrored expectation of manifest rewriting by calling
// the real rewrite through a small exported hook.
const proxy = require('../src/proxy');

const BASE = 'https://pub.example';
const MANIFEST_URL = 'https://cdn.host/path/master.m3u8?token=abc';
const HEADERS = { Referer: 'https://host/e/x', 'User-Agent': 'UA' };

// A representative multi-variant, encrypted, fMP4 manifest.
const MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://cdn.host/keys/session.bin"',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.host/keys/key.bin",IV=0x1',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/eng.m3u8"',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000',
  'https://cdn.host/path/720/index.m3u8?token=abc',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000',
  '480/index.m3u8',
  '#EXTINF:6.0,',
  'seg-0001.ts?token=abc',
  '',
].join('\n');

// proxy.js exports rewriteManifest for testing (added alongside handleProxy).
test('rewriteManifest proxies every URI, preserves #EXT directives', () => {
  assert.ok(typeof proxy.rewriteManifest === 'function', 'rewriteManifest must be exported');
  const out = proxy.rewriteManifest(MANIFEST, MANIFEST_URL, BASE, HEADERS);
  const lines = out.split('\n');

  // #EXT-X-KEY URI rewritten (the blocker: AES key must go through the proxy
  // or IP-bound playback breaks and leaks the host).
  const keyLine = lines.find((l) => l.startsWith('#EXT-X-KEY'));
  assert.match(keyLine, /URI="https:\/\/pub\.example\/proxy\?url=/);
  assert.doesNotMatch(keyLine, /cdn\.host\/keys\/key\.bin"/); // original host not exposed
  assert.match(keyLine, /METHOD=AES-128/); // rest of the tag intact
  assert.match(keyLine, /IV=0x1/);

  // #EXT-X-MEDIA and #EXT-X-MAP URIs (relative) rewritten + absolutized.
  const mediaLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA'));
  assert.match(mediaLine, /URI="https:\/\/pub\.example\/proxy\?url=/);
  const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP'));
  assert.match(mapLine, /URI="https:\/\/pub\.example\/proxy\?url=/);
  const sessionKeyLine = lines.find((l) => l.startsWith('#EXT-X-SESSION-KEY'));
  assert.match(sessionKeyLine, /URI="https:\/\/pub\.example\/proxy\?url=/);
  assert.doesNotMatch(sessionKeyLine, /cdn\.host\/keys\/session\.bin"/);

  // Bare playlist/segment lines (absolute w/ query, and relative) rewritten.
  const bare = lines.filter((l) => l.startsWith('https://pub.example/proxy?url='));
  assert.ok(bare.length >= 3, 'absolute variant, relative variant, and segment all proxied');

  // Plain #EXT directives without a URI stay verbatim.
  assert.ok(lines.includes('#EXTM3U'));
  assert.ok(lines.includes('#EXT-X-VERSION:6'));
  assert.ok(lines.some((l) => l === '#EXT-X-STREAM-INF:BANDWIDTH=800000'));
  assert.ok(lines.some((l) => l.startsWith('#EXTINF:6.0')));
});

test('rewriteManifest resolves relative URIs against the manifest URL', () => {
  const out = proxy.rewriteManifest('480/index.m3u8\n', MANIFEST_URL, BASE, HEADERS);
  // decode the proxied target and confirm it absolutized against the manifest path
  const m = out.match(/url=([A-Za-z0-9\-_]+)/);
  assert.ok(m, 'a proxied url param is present');
  const decoded = proxy.b64urlDecode(m[1]);
  assert.equal(decoded, 'https://cdn.host/path/480/index.m3u8');
});

test('proxifyUrl round-trips target + headers', () => {
  const u = proxy.proxifyUrl(BASE, 'https://x.y/z.ts?a=1', HEADERS);
  assert.ok(u.startsWith('https://pub.example/proxy?url='));
  const url = new URL(u);
  assert.equal(proxy.b64urlDecode(url.searchParams.get('url')), 'https://x.y/z.ts?a=1');
  assert.deepEqual(JSON.parse(proxy.b64urlDecode(url.searchParams.get('h'))), HEADERS);
});
