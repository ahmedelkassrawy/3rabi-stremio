// Provider registry. To add a site, implement the same shape as akwam.js
// ({ id, name, catalogs, getCatalog, getMeta, getStreams }) and list it here.
const akwam = require('./akwam');

const providers = [akwam];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

module.exports = { providers, byId };
