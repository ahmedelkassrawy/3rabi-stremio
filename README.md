# 3rabi عربي — Stremio addon

A Stremio addon port of the [**3rabi عربي**](https://github.com/Abodabodd/re-3arabi) CloudStream
extension — browse and stream Arabic movies & series inside Stremio.

This is a **catalog addon**: the source sites have no IMDB IDs, so you browse each
site's own catalog inside Stremio (custom `3rabi:` IDs), open a title, and play the
scraped stream — exactly like CloudStream, just in Stremio.

## Providers

| Provider | Site | Status |
|----------|------|--------|
| Akwam | ak.sv → akwam.it | ✅ Movies, series, episodes, search, direct streams |

More providers (Faselhd, Arabseed, anime) can be added — see [Adding a provider](#adding-a-provider).

## Run locally

```bash
npm install
npm start
```

Then in Stremio: **Addons → paste** `http://127.0.0.1:7000/manifest.json` → **Install**.

Verify the scrapers against the live site any time:

```bash
npm run smoke
```

## Deploy (free, always-on) — Vercel

The addon is serverless-ready (`api/index.js` + `vercel.json`). Client devices stream
video **directly from the source CDN**, so the host only does light HTML scraping.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/git/external?repository-url=https://github.com/ahmedelkassrawy/3rabi-stremio)

1. This repo is already on GitHub: `ahmedelkassrawy/3rabi-stremio`.
2. Go to <https://vercel.com/new>, sign in with GitHub, **Import** this repo
   (or click the button above).
3. Framework preset: **Other**. Leave build/output empty. Click **Deploy**.
4. Your manifest URL is `https://<your-project>.vercel.app/manifest.json`.
5. Install that URL in Stremio (Addons → paste → Install).

> Note: source sites sit behind Cloudflare. It currently serves normally to
> datacenter IPs, but if a provider starts returning Cloudflare challenge pages
> from Vercel, that provider's scraping will fail there (playback is unaffected —
> it goes client→CDN). Akwam works today.

## Adding a provider

Implement the same shape as [`src/providers/akwam.js`](src/providers/akwam.js):

```js
module.exports = {
  id: 'faselhd',
  name: 'FaselHD',
  catalogs: [{ type: 'movie', id: 'faselhd-movies', name: '…', path: '/movies', search: true }],
  async getCatalog({ path, type, search, skip }) { /* -> [{ url, name, poster }] */ },
  async getMeta({ url, type }) { /* -> { type, name, poster, description, year, genres, episodes? } */ },
  async getStreams({ url }) { /* -> [{ url, quality, referer? }] */ },
};
```

Then register it in [`src/providers/index.js`](src/providers/index.js). Its catalogs
appear automatically in the manifest, and IDs are namespaced by provider id.

## How it maps to CloudStream

| CloudStream (`MainAPI`) | This addon |
|-------------------------|------------|
| `getMainPage()` | `getCatalog()` → `/catalog` |
| `search()` | `getCatalog({ search })` |
| `load()` | `getMeta()` → `/meta` |
| `loadLinks()` | `getStreams()` → `/stream` |

## Legal

For personal use. You are responsible for complying with the laws in your
jurisdiction and the terms of the source sites. This project only re-implements
publicly available scraping logic; it hosts no content.
