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
const arabseed = require('./arabseed');
const wecima = require('./wecima');
const cimaclub = require('./cimaclub');
const egydead = require('./egydead');
const shahid4u = require('./shahid4u');

// Registration itself is gated on ENABLE_BROWSER, not just stream
// resolution: this registry is shared by both deploys — Vercel
// (api/index.js, browser disabled) and the Hugging Face Space / any VM
// (server.js, ENABLE_BROWSER=1). Registering host-based providers
// unconditionally would show their catalogs on Vercel with zero working
// streams (bad UX). So Vercel stays a clean Akwam-only deploy, and the
// browser-enabled deploy is the all-in-one with all three providers.
const HOST_BASED =
  process.env.ENABLE_BROWSER === '1' ? [topcinema, faselhd, arabseed, wecima, cimaclub, egydead, shahid4u] : [];

const providers = [akwam, ...HOST_BASED];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

module.exports = { providers, byId };
