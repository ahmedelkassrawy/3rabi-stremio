// Provider registry. To add a site, implement the same shape as akwam.js
// ({ id, name, catalogs, getCatalog, getMeta, getStreams }) and list it here.
const akwam = require('./akwam');
// Top Cinema and Egydead are host-based providers: their video hosts
// (vidtube/luluvdo/streamwish/...) Cloudflare-block datacenter IPs. Both
// modules work fine with the browser disabled (getStreams just returns
// direct-only/empty results), but they're only *registered* below when
// ENABLE_BROWSER=1 — see why further down.
const topcinema = require('./topcinema');
const egydead = require('./egydead');
// wecima.js exists but is intentionally NOT registered (operator preference).
// faselhd/arabseed/cimaclub/shahid4u files also exist but stay disabled: their
// search endpoints Cloudflare-403 every request from the datacenter deploy IP
// (verified on faselhdx.life, fasel-hd.cam, faselhd.center — `/?s=` -> 403),
// so they never contribute a result and just burn a provider slot + CPU.
// Faselhd would work again if the registry below is changed to include it
// from a residential IP.

// Registration is gated on ENABLE_BROWSER: the registry is shared by the
// Vercel deploy (api/index.js, browser disabled — stays clean Akwam-only) and
// the browser-enabled VM deploy (server.js). Only providers that actually
// resolve from the deploy IP are listed, so catalogs are never empty.
const HOST_BASED = process.env.ENABLE_BROWSER === '1' ? [topcinema, egydead] : [];

const providers = [akwam, ...HOST_BASED];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

module.exports = { providers, byId };
