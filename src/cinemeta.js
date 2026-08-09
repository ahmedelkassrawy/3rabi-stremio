// Resolves an IMDb id to a plain { name, year } via Stremio's own Cinemeta
// addon. This is how a pure stream addon bridges "the user opened tt1234567
// in the Cinemeta catalog" back to a human title it can hand to each
// Arabic provider's search box (see src/match.js for the fuzzy match back
// to a provider's result).
const { fetchText } = require('./fetcher');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

// imdbId -> { name, year } | null. Titles never change, so a plain Map with
// no TTL/eviction is fine for a long-running process.
const cache = new Map();

function extractYear(m) {
  if (m.year) {
    const n = Number(String(m.year).slice(0, 4));
    if (Number.isFinite(n)) return n;
  }
  if (m.releaseInfo) {
    const match = String(m.releaseInfo).match(/\d{4}/);
    if (match) return Number(match[0]);
  }
  return null;
}

// Never throws — callers treat a null return as "skip Cinemeta lookup, no
// streams for this id" rather than letting one bad id crash the request.
async function getTitle(type, imdbId) {
  const key = `${type}:${imdbId}`;
  if (cache.has(key)) return cache.get(key);

  let result = null;
  try {
    const { status, text } = await fetchText(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    if (status < 400) {
      const data = JSON.parse(text);
      const m = data?.meta;
      if (m?.name) {
        result = { name: m.name, year: extractYear(m) };
      }
    }
  } catch {
    result = null;
  }

  cache.set(key, result);
  return result;
}

module.exports = { getTitle };
