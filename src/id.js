// Stremio content IDs must survive being a single URL path segment. The
// underlying provider "IDs" are full site URLs (plus an optional poster), so we
// base64url-encode them behind a `3rabi:<provider>:` prefix.
//
//   makeId('akwam', 'https://akwam.it/movie/123#poster') ->
//     '3rabi:akwam:aHR0cHM6...'
const PREFIX = '3rabi';

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function makeId(providerId, payload) {
  return `${PREFIX}:${providerId}:${b64urlEncode(payload)}`;
}

// Returns { providerId, payload } or null if it's not one of ours.
function parseId(id) {
  if (!id || !id.startsWith(`${PREFIX}:`)) return null;
  const rest = id.slice(PREFIX.length + 1);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  const providerId = rest.slice(0, sep);
  const encoded = rest.slice(sep + 1);
  try {
    return { providerId, payload: b64urlDecode(encoded) };
  } catch {
    return null;
  }
}

module.exports = { makeId, parseId, PREFIX };
