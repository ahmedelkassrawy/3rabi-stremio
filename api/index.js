// Vercel serverless entry. Every request is rewritten here (see vercel.json)
// and dispatched through the addon SDK router. Stremio requires permissive
// CORS, which serveHTTP adds for us locally but we must set by hand here.
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../src/addon');

const router = getRouter(addonInterface);

const { fetchText } = require('../src/fetcher');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // Diagnostic route: what does the source site return to THIS host's IP?
  if (req.url && req.url.startsWith('/debug')) {
    try {
      const r = await fetchText('https://ak.sv/movies');
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          status: r.status,
          finalUrl: r.url,
          length: r.text.length,
          hasItems: r.text.includes('col-lg-auto'),
          challenge: /just a moment|cf-challenge|Attention Required|cf_chl/i.test(r.text),
          snippet: r.text.slice(0, 400),
        })
      );
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: e.message, cause: e.cause?.message }));
    }
  }
  router(req, res, () => {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'not found' }));
  });
};
