// Media/HLS proxy. Host-based providers (Top Cinema, Faselhd) resolve
// streams that are IP-bound or Cloudflare-gated against the resolving IP —
// Faselhd's m3u8 literally embeds the resolver's IP in its path — so
// playback has to be fetched through *this* server rather than played
// directly by the Stremio client. addon.js rewrites such stream URLs to
// `${PUBLIC_URL}/proxy?url=...&h=...` via proxifyUrl(); handleProxy serves
// that route.
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

// Rewrite every URI line of an HLS manifest (segments, nested playlists, keys
// via #EXT-X-KEY are left alone — only bare URI lines need proxying) to point
// back through this proxy, carrying the same upstream headers. `#EXT...`
// directive lines are passed through untouched.
function rewriteManifest(text, manifestUrl, publicBase, headersObj) {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
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

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
    });

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

    // Stream the body through without buffering the whole thing in memory.
    const reader = upstream.body.getReader();
    res.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (e) {
    res.statusCode = 502;
    return res.end('proxy error: ' + e.message);
  }
}

module.exports = { handleProxy, proxifyUrl, b64urlEncode, b64urlDecode };
