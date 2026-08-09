# Deploying the browser resolver (Top Cinema + Faselhd)

The base Vercel deploy (see the main README) is **Akwam-only** and stays that
way on purpose — Akwam serves static links from an open CDN that datacenter
IPs can reach fine. Top Cinema and Faselhd resolve streams through external
video hosts (vidtube, luluvdo, streamwish, …) that Cloudflare-block or cloak
datacenter IPs, and Faselhd's player additionally builds its m3u8 with
obfuscated client-side JS with no static URL at all — a headless browser
(Playwright/Chromium) is required to resolve it, and Faselhd's resulting
m3u8 is **IP-bound**: only playable from the IP that resolved it. So this
deploy needs (a) somewhere to run a real Chromium and (b) proxy playback for
IP-bound streams.

`src/providers/index.js` registers Top Cinema and Faselhd **only** when
`ENABLE_BROWSER=1` — so this is the single **all-in-one** deployment: Akwam +
Top Cinema + Faselhd, all with working streams. Install its manifest URL
instead of the Vercel one if you want all three providers; the Vercel URL
remains available as a lightweight Akwam-only option, and both share the
same manifest id/name so Stremio treats them as the same addon if you ever
switch URLs.

## Multi-user bandwidth model

This addon is meant to be shared (e.g. with friends), whose Stremio clients
run on **residential** IPs — the Cloudflare block only affects the *server*
resolving the stream, not most viewers' own devices. So playback is **not**
blanket-proxied:

- **Faselhd** streams are always IP-bound to the resolving host → proxy-only.
  Every Faselhd view uses this server's bandwidth (see `src/proxy.js`).
- **Top Cinema** links are normally plain hostnames (no embedded IP) → each
  stream is offered **direct** (host → viewer's device, zero server
  bandwidth) first, with a **proxied fallback** listed after it for anyone
  whose own network still can't reach that host.
- **Akwam** is untouched — always direct, as before.

Net effect: this server's bandwidth scales with **concurrent Faselhd
viewers only** (plus the occasional Top Cinema viewer who needed the
fallback), not with total traffic across every provider.

## Primary target: Hugging Face Docker Spaces

Free, no credit card, 2 vCPU / 16GB RAM, built-in HTTPS URL — a good fit for
a low-traffic personal/friends addon.

1. Create a Space at <https://huggingface.co/new-space>, SDK = **Docker**,
   visibility your choice.
2. Push this repo's contents to the Space's git remote (Spaces are just git
   repos). At the **root of the Space repo**, add a `README.md` with the
   YAML frontmatter in [`docs/hf-space-README.md`](hf-space-README.md) —
   copy that file's content in (this app's own `README.md` stays as-is;
   Spaces read config only from the repo-root README).
3. In the Space's **Settings → Variables and secrets**, add:
   - `PUBLIC_URL` = `https://<user>-<space>.hf.space` (your Space's public
     URL — used to build `/proxy` links; get the exact value from the
     Space's "Embed this Space" panel once it's live)
   - `ENABLE_BROWSER` = `1`
4. HF routes public traffic to the container's **port 7860** — this repo's
   `Dockerfile`/`server.js` already default to that port, so no extra config
   is needed there.
5. Build logs appear on the Space page; once it's live, your manifest URL is
   `https://<user>-<space>.hf.space/manifest.json`. Install that in Stremio.
6. Hit `https://<user>-<space>.hf.space/selftest` to confirm Top Cinema and
   Faselhd are actually resolving streams **from HF's own IP** — HF's
   container IP is still a datacenter IP, so some hosts may still challenge
   it even with a real browser (see the caveat below).

### Keeping it awake

Free HF Spaces **sleep after ~48h idle**. Set up a free external uptime
pinger (e.g. <https://cron-job.org>, or UptimeRobot) hitting
`PUBLIC_URL/manifest.json` every ~10 minutes to keep the container warm.

## Any other Docker host works too

The `Dockerfile` is plain Docker — GCP e2-micro (free tier, needs a card),
a home server, a spare Linux box, etc. all work the same way: build the
image, run it with `PUBLIC_URL` and `ENABLE_BROWSER=1` set, and open
whatever port you choose:

```bash
docker build -t 3rabi-resolver .
docker run -e PUBLIC_URL=https://your-domain-or-tunnel \
           -e ENABLE_BROWSER=1 \
           -e PORT=7860 \
           -p 7860:7860 3rabi-resolver
```

A free **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:7860`)
gives any of these an https `PUBLIC_URL` without opening firewall ports.

## Residential fallback

`/selftest` reports whether Top Cinema/Faselhd actually resolved streams
from wherever this is deployed. **Honest caveat:** every option above still
runs on a datacenter/VM IP; if `/selftest` shows resolution failing there
(a host started hard-challenging even real-browser traffic), the only fix is
a genuinely residential IP. The lightest way to get one for free is an old
Android phone running **Termux** (`pkg install nodejs`, `npm install`, then
`ENABLE_BROWSER=1 node server.js` — note Termux's Node is a different
Playwright/Chromium story; test `npm run smoke` equivalents there first) kept
plugged in on home Wi-Fi. It's the same technique this project's own local
dev machine already validated (residential IP → all providers resolve).
