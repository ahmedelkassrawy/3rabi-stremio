// Thin HTTP + HTML-parse layer shared by every provider.
// Node 24 ships a global `fetch` (undici) that follows redirects by default,
// which matters here: ak.sv 301-redirects to the live akwam.it domain.
const cheerio = require('cheerio');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchText(url, { headers = {}, timeout = 15000, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, url: res.url, text };
  } finally {
    clearTimeout(t);
  }
}

// Returns a cheerio document. `finalUrl` is the post-redirect URL, used to
// resolve relative hrefs (the CloudStream `abs:href` equivalent).
async function fetchDoc(url, opts = {}) {
  const { status, url: finalUrl, text } = await fetchText(url, opts);
  if (status >= 400) throw new Error(`HTTP ${status} for ${url}`);
  const $ = cheerio.load(text);
  return { $, finalUrl, status };
}

// Resolve a possibly-relative href against a base, like Jsoup's abs:href.
function absUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

module.exports = { fetchText, fetchDoc, absUrl, DEFAULT_UA };
