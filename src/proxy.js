// Media/HLS proxy. Host-based providers (Top Cinema, Faselhd) resolve
// streams that are IP-bound or Cloudflare-gated against the resolving IP —
// Faselhd's m3u8 literally embeds the resolver's IP in its path — so
// playback has to be fetched through *this* server rather than played
// directly by the Stremio client. addon.js rewrites such stream URLs to
// `${PUBLIC_URL}/proxy?url=...&h=...` via proxifyUrl(); handleProxy serves
// that route.
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const { DEFAULT_UA } = require('./fetcher');

// id.js doesn't export its base64url helpers, so this is a small local copy
// (same alphabet/behavior) rather than reaching into its internals.
function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Build a proxied URL that carries the target + the headers it needs
// (Referer/Origin/User-Agent) so handleProxy can replay them upstream.
function proxifyUrl(publicBase, targetUrl, headersObj = {}) {
  const u = b64urlEncode(targetUrl);
  const h = b64urlEncode(JSON.stringify(headersObj || {}));
  return `${publicBase.replace(/\/+$/, '')}/proxy?url=${u}&h=${h}`;
}

// ---- SSRF guards ----
// This proxy fetches whatever URL a resolved stream points at, on the
// server's own behalf — an open proxy like that must never be aimable at
// cloud metadata endpoints (169.254.169.254) or internal services, so every
// target (including each redirect hop) gets its *resolved IP* checked
// against private/loopback/link-local ranges before we fetch it.
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // malformed -> reject
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::1') return true; // loopback
  if (norm === '::') return true;
  if (norm.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // fc00::/7 unique local
  if (norm.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — check the embedded v4 address too.
    const v4 = norm.split(':').pop();
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a recognizable IP -> reject
}

// Resolve + validate one URL. Throws with a short reason on any block.
async function assertPublicTarget(urlObj) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${urlObj.protocol}`);
  }
  const hostname = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('blocked host: localhost/.local');
  }
  // A literal IP in the URL still needs the same range check (no DNS to do).
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error(`blocked private IP: ${hostname}`);
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  if (!records.length) throw new Error(`no DNS records for ${hostname}`);
  for (const rec of records) {
    if (isPrivateIP(rec.address)) throw new Error(`blocked private IP: ${hostname} -> ${rec.address}`);
  }
}

// fetch() with redirect:'manual', validating (DNS + IP range) every hop
// before following it — auto-follow would skip straight past our checks on
// the *final* fetch call, letting a malicious redirect chain slip through.
//
// Residual risk (accepted): this is a check-then-fetch (TOCTOU) — assertPublicTarget
// resolves DNS, then fetch() resolves again independently, so a hostile host with a
// very short TTL could DNS-rebind to a private IP between the two. Fully closing it
// needs pinning the validated IP into the fetch (custom lookup/agent). Given the
// threat model (an open media proxy whose targets are already attacker-controlled
// stream hosts, with no local secrets beyond what the range check blocks), we accept
// this rather than pin. Decimal/octal IP literals are NOT a bypass: net.isIP rejects
// them and dns.lookup normalizes them, so the range check still fires.
async function fetchPublicOnly(targetUrl, options, maxRedirects = 5) {
  let current = new URL(targetUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicTarget(current);
    const res = await fetch(current.toString(), { ...options, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
}

function isManifest(contentType, url) {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

// Tags whose URI="..." attribute needs proxying too — AES-128 keys, nested
// renditions, fMP4 init segments, and I-frame playlists all point at media
// the client will fetch directly, same as a bare segment/playlist line.
const URI_ATTR_RE = /URI="([^"]+)"/;

function proxifyUriAttr(line, manifestUrl, publicBase, headersObj) {
  const m = line.match(URI_ATTR_RE);
  if (!m) return line;
  let abs;
  try {
    abs = new URL(m[1], manifestUrl).toString();
  } catch {
    return line;
  }
  const proxied = proxifyUrl(publicBase, abs, headersObj);
  return line.slice(0, m.index) + `URI="${proxied}"` + line.slice(m.index + m[0].length);
}

// Rewrite every URI in an HLS manifest — bare segment/playlist lines AND the
// URI="..." attribute on #EXT-X-KEY / #EXT-X-MEDIA / #EXT-X-MAP /
// #EXT-X-I-FRAME-STREAM-INF — to point back through this proxy, carrying the
// same upstream headers. Every other `#EXT...` directive line (and anything
// without a URI to rewrite) is passed through verbatim.
function rewriteManifest(text, manifestUrl, publicBase, headersObj) {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-(KEY|MEDIA|MAP|I-FRAME-STREAM-INF|SESSION-KEY):/.test(trimmed)) {
          return proxifyUriAttr(line, manifestUrl, publicBase, headersObj);
        }
        return line;
      }
      let abs;
      try {
        abs = new URL(trimmed, manifestUrl).toString();
      } catch {
        return line;
      }
      return proxifyUrl(publicBase, abs, headersObj);
    })
    .join('\n');
}

async function handleProxy(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  let targetUrl;
  let headersObj = {};
  try {
    const parsed = new URL(req.url, 'http://internal');
    const rawUrl = parsed.searchParams.get('url');
    const rawH = parsed.searchParams.get('h');
    if (!rawUrl) {
      res.statusCode = 400;
      return res.end('missing url param');
    }
    targetUrl = b64urlDecode(rawUrl);
    if (rawH) {
      try {
        headersObj = JSON.parse(b64urlDecode(rawH)) || {};
      } catch {
        headersObj = {};
      }
    }
  } catch (e) {
    res.statusCode = 400;
    return res.end('bad proxy request: ' + e.message);
  }

  const publicBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  try {
    const upstreamHeaders = {
      'User-Agent': DEFAULT_UA,
      ...headersObj,
    };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    // SSRF-guarded fetch: validates DNS + IP range on the target and on every
    // redirect hop before following it (a plain redirect:'follow' would skip
    // our checks on the final address).
    const upstream = await fetchPublicOnly(targetUrl, { headers: upstreamHeaders });

    const contentType = upstream.headers.get('content-type') || '';

    if (upstream.status >= 400) {
      res.statusCode = upstream.status;
      const body = await upstream.text().catch(() => '');
      return res.end(body || `upstream ${upstream.status}`);
    }

    if (isManifest(contentType, upstream.url || targetUrl)) {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, upstream.url || targetUrl, publicBase, headersObj);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(rewritten);
    }

    res.statusCode = upstream.status;
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();

    // Pipe with backpressure (Readable.fromWeb honors the socket's drain),
    // so a slow client can't make us buffer a whole segment in memory.
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    return body.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.statusCode = 502;
    return res.end('proxy error: ' + e.message);
  }
}

// A stream is "IP-bound" when its URL embeds a literal IPv4 (Faselhd's m3u8
// bakes in the resolver's IP) — such a stream is only playable from the IP
// that produced it, so addon.js must offer it proxy-only, never direct. Uses
// real 0-255 octets so version-like tokens (app.v1.2.3.4) don't false-match.
function containsIPv4(url) {
  const octet = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
  return new RegExp(`\\b${octet}(\\.${octet}){3}\\b`).test(url);
}

module.exports = {
  handleProxy,
  proxifyUrl,
  rewriteManifest,
  containsIPv4,
  b64urlEncode,
  b64urlDecode,
};
