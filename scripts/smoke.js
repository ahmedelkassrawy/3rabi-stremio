// End-to-end provider smoke test against the live site.
// Run: npm run smoke
const akwam = require('../src/providers/akwam');

(async () => {
  console.log('== 1. Movies catalog ==');
  const movies = await akwam.getCatalog({ path: '/movies', type: 'movie', skip: 0 });
  console.log(`  ${movies.length} items; first:`, movies[0]?.name, '|', movies[0]?.url);

  console.log('== 2. Movie meta + stream ==');
  const movieMeta = await akwam.getMeta({ url: movies[0].url });
  console.log(`  type=${movieMeta.type} name=${movieMeta.name} year=${movieMeta.year}`);
  const movieStreams = await akwam.getStreams({ url: movies[0].url });
  console.log(`  ${movieStreams.length} stream(s):`, movieStreams.map((s) => s.quality).join(', '));
  if (movieStreams[0]) console.log('  first url:', movieStreams[0].url.slice(0, 90));

  console.log('== 3. Series catalog + meta ==');
  const series = await akwam.getCatalog({ path: '/series', type: 'series', skip: 0 });
  console.log(`  ${series.length} items; first:`, series[0]?.name);
  const seriesMeta = await akwam.getMeta({ url: series[0].url });
  console.log(`  type=${seriesMeta.type} episodes=${seriesMeta.episodes?.length || 0}`);
  if (seriesMeta.episodes?.length) {
    const ep = seriesMeta.episodes[0];
    console.log(`  ep1: S${ep.season}E${ep.episode} ${ep.name}`);
    const epStreams = await akwam.getStreams({ url: ep.url });
    console.log(`  ep1 streams: ${epStreams.length}`, epStreams.map((s) => s.quality).join(', '));
  }

  console.log('== 4. Search ==');
  const found = await akwam.getCatalog({ path: '/movies', type: 'movie', search: 'the' });
  console.log(`  search "the" -> ${found.length} items`);

  console.log('\nDONE');
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
