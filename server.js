// Local runner: `npm start` -> http://127.0.0.1:7000/manifest.json
const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');

const port = Number(process.env.PORT) || 7000;
serveHTTP(addonInterface, { port });
console.log(`3rabi addon running: http://127.0.0.1:${port}/manifest.json`);
