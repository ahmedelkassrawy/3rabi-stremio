// Shared runtime config. Kept tiny and dependency-free so it's safe to
// require from anywhere (including api/index.js on Vercel).
// Default port matches Hugging Face Docker Spaces' fixed public port (7860)
// — the primary deploy target — but PORT/PUBLIC_URL both stay overridable
// for local runs or any other Docker host.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${Number(process.env.PORT) || 7860}`).replace(
  /\/+$/,
  ''
);

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Browser-based resolution (Playwright/Chromium) is opt-in only. Vercel's
// serverless bundle must stay Chromium-free, so providers late-require
// './resolver' and only when this is exactly '1'.
const ENABLE_BROWSER = process.env.ENABLE_BROWSER === '1';

module.exports = { PUBLIC_URL, DESKTOP_UA, ENABLE_BROWSER };
