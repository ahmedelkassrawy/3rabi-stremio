// Local / VM runner: `npm start` -> http://127.0.0.1:7000/manifest.json
//
// serveHTTP() from the SDK owns its own http.Server with no way to add
// extra routes, so we run our own server instead: it delegates addon
// requests to the SDK's router (with the same permissive CORS api/index.js
// adds for Vercel) and additionally serves /proxy (media/HLS proxy, see
// src/proxy.js) and /selftest (end-to-end resolver smoke check).
//
// This is also where browser-based resolution gets turned on: ENABLE_BROWSER
// must be '1' before src/addon.js is required, since providers late-require
// src/resolver.js (Playwright) only inside that gate.
if (!process.env.ENABLE_BROWSER) process.env.ENABLE_BROWSER = '1';

const http = require('http');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const { handleProxy } = require('./src/proxy');
const { selftest } = require('./src/selftest');
const { PUBLIC_URL } = require('./src/config');

// 7860 matches Hugging Face Docker Spaces' fixed public container port
// (the primary deploy target); override PORT for local runs / other hosts.
const port = Number(process.env.PORT) || 7860;
const router = getRouter(addonInterface);

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (path === '/proxy') {
    return handleProxy(req, res);
  }

  if (path === '/selftest') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return selftest()
      .then((result) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result, null, 2));
      })
      .catch((e) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }, null, 2));
      });
  }

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
});

server.listen(port, () => {
  console.log(`3rabi addon running: http://127.0.0.1:${port}/manifest.json`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`ENABLE_BROWSER: ${process.env.ENABLE_BROWSER}`);
});
