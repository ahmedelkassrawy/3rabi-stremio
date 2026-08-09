// Vercel serverless entry. Every request is rewritten here (see vercel.json)
// and dispatched through the addon SDK router. Stremio requires permissive
// CORS, which serveHTTP adds for us locally but we must set by hand here.
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../src/addon');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  router(req, res, () => {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'not found' }));
  });
};
