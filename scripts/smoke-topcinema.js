const tc = require('../src/providers/topcinema');

(async () => {
  console.log('== 1. Movies catalog ==');
  const movies = await tc.getCatalog({ path: '/movies/', type: 'movie', skip: 0 });
  console.log(`  ${movies.length} items; first:`, movies[0]?.name);

  console.log('== 2. Movie meta + streams ==');
  const meta = await tc.getMeta({ url: movies[0].url });
  console.log(`  type=${meta.type} name=${meta.name} year=${meta.year}`);
  const streams = await tc.getStreams({ url: movies[0].url });
  console.log(`  ${streams.length} stream(s):`);
  streams.slice(0, 8).forEach((s) => console.log(`   [${s.host}] ${s.quality} -> ${s.url.slice(0, 75)}`));

  console.log('== 3. Series catalog + meta ==');
  const series = await tc.getCatalog({ path: '/series/', type: 'series', skip: 0 });
  console.log(`  ${series.length} items; first:`, series[0]?.name);
  const sMeta = await tc.getMeta({ url: series[0].url });
  console.log(`  type=${sMeta.type} episodes=${sMeta.episodes?.length || 0}`);
  if (sMeta.episodes?.length) {
    const ep = sMeta.episodes[0];
    console.log(`  ep: S${ep.season}E${ep.episode} ${ep.name}`);
    const epStreams = await tc.getStreams({ url: ep.url });
    console.log(`  ep streams: ${epStreams.length}`, epStreams.slice(0, 4).map((s) => `${s.host}:${s.quality}`).join(', '));
  }

  console.log('== 4. Search ==');
  const found = await tc.getCatalog({ path: '/movies/', type: 'movie', search: 'batman' });
  console.log(`  search "batman" -> ${found.length} items; first:`, found[0]?.name);

  console.log('\nDONE');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
