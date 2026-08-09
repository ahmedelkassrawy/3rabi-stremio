// /selftest — runs Top Cinema and Faselhd end-to-end (catalog -> getStreams)
// against their first movie, so the operator can check from the DEPLOY IP
// whether host resolution actually works there. Never throws; every
// per-provider failure is captured as a string in the result instead.
const { ENABLE_BROWSER } = require('./config');

async function runProvider(provider) {
  const result = { provider: provider.id, browserUsed: ENABLE_BROWSER, streams: 0, error: null };
  try {
    const movieCat = provider.catalogs.find((c) => c.type === 'movie') || provider.catalogs[0];
    const items = await provider.getCatalog({ path: movieCat.path, type: movieCat.type, skip: 0 });
    if (!items.length) {
      result.error = 'catalog returned 0 items';
      return result;
    }
    const first = items[0];
    result.title = first.name;
    const streams = await provider.getStreams({ url: first.url });
    result.streams = streams.length;
    result.direct = streams.filter((s) => !s.proxy).length;
    result.hostBased = streams.filter((s) => s.proxy).length;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

async function selftest() {
  const { byId } = require('./providers');
  const targets = ['topcinema', 'faselhd'].filter((id) => byId[id]);
  const results = {};
  for (const id of targets) {
    results[id] = await runProvider(byId[id]);
  }
  return { enableBrowser: ENABLE_BROWSER, results };
}

module.exports = { selftest };
