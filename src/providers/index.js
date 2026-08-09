// Provider registry. To add a site, implement the same shape as akwam.js
// ({ id, name, catalogs, getCatalog, getMeta, getStreams }) and list it here.
const akwam = require('./akwam');
// NOTE: topcinema.js is a complete, working provider (catalog/meta/streams) but
// its video hosts (vidtube/luluvdo/updown/...) Cloudflare-block datacenter IPs,
// so its streams only resolve from a residential host — not from Vercel. It is
// intentionally left UNREGISTERED here. To use it, run this addon on a
// residential/home machine and add `require('./topcinema')` to the array below.

const providers = [akwam];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

module.exports = { providers, byId };
