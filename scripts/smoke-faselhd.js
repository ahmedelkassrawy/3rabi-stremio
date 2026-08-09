// Run with ENABLE_BROWSER=1 on a residential host to exercise the headless
// resolver end-to-end (see src/resolver.js). Without ENABLE_BROWSER, streams
// will be 0 by design — catalog/meta should still work everywhere.
const fh = require('../src/providers/faselhd');

(async () => {
  console.log('== 1. Movies catalog ==');
  const movies = await fh.getCatalog({ path: '/movies', type: 'movie', skip: 0 });
  console.log(`  ${movies.length} items; first:`, movies[0]?.name);

  console.log('== 2. Movie meta + streams ==');
  const meta = await fh.getMeta({ url: movies[0].url });
  console.log(`  type=${meta.type} name=${meta.name}`);
  const streams = await fh.getStreams({ url: movies[0].url });
  console.log(`  ${streams.length} stream(s):`);
  streams.slice(0, 8).forEach((s) => console.log(`   [${s.host}] ${s.quality} ipBound=${!!s.ipBound} -> ${s.url.slice(0, 90)}`));

  console.log('== 3. Series catalog + meta ==');
  const series = await fh.getCatalog({ path: '/series', type: 'series', skip: 0 });
  console.log(`  ${series.length} items; first:`, series[0]?.name);
  const sMeta = await fh.getMeta({ url: series[0].url });
  console.log(`  type=${sMeta.type} episodes=${sMeta.episodes?.length || 0}`);
  if (sMeta.episodes?.length) {
    const ep = sMeta.episodes[0];
    console.log(`  ep: S${ep.season}E${ep.episode} ${ep.name}`);
    const epStreams = await fh.getStreams({ url: ep.url });
    console.log(`  ep streams: ${epStreams.length}`);
  }

  console.log('== 4. Search ==');
  const found = await fh.getCatalog({ path: '/movies', type: 'movie', search: 'batman' });
  console.log(`  search "batman" -> ${found.length} items; first:`, found[0]?.name);

  console.log('\nDONE');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
