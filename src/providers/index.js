// Provider registry. To add a site, implement the same shape as akwam.js
// ({ id, name, catalogs, getCatalog, getMeta, getStreams }) and list it here.
const akwam = require('./akwam');
// Top Cinema and Faselhd are host-based providers: their video hosts
// (vidtube/luluvdo/streamwish/...) Cloudflare-block datacenter IPs, and
// Faselhd's player additionally needs a headless browser to build its m3u8
// at all (see src/resolver.js). Both modules work fine with the browser
// disabled (getStreams just returns direct-only/empty results), but
// they're only *registered* below when ENABLE_BROWSER=1 — see why further
// down.
const topcinema = require('./topcinema');
const faselhd = require('./faselhd');
const egydead = require('./egydead');
// wecima.js exists but is intentionally NOT registered (operator preference).
// arabseed/cimaclub/shahid4u files also exist but stay disabled (site
// unreachable/Cloudflare-blocked from datacenter IPs).

// Registration is gated on ENABLE_BROWSER: the registry is shared by the
// Vercel deploy (api/index.js, browser disabled — stays clean Akwam-only) and
// the browser-enabled VM deploy (server.js). Only providers that actually
// resolve from the deploy IP are listed, so catalogs are never empty.
const HOST_BASED = process.env.ENABLE_BROWSER === '1' ? [topcinema, faselhd, egydead] : [];

const providers = [akwam, ...HOST_BASED];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

module.exports = { providers, byId };
