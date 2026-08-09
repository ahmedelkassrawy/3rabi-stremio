// Unit tests for the pure, network-free title-matching logic. Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitle, titleScore, extractYear, bestMatch, seasonFromTitle, bestMatchesRanked } = require('../src/match');

test('normalizeTitle strips decorators, year, and release tags', () => {
  assert.equal(normalizeTitle('فيلم Oppenheimer 2023 مترجم اون لاين'), 'oppenheimer');
  assert.equal(normalizeTitle('مشاهدة فيلم Oppenheimer 2023 مترجم'), 'oppenheimer');
  assert.equal(normalizeTitle('Oppenheimer 1080p BluRay x264'), 'oppenheimer');
  // 'الموسم <ordinal>' is stripped as a whole season phrase, so the base
  // series title is what remains.
  assert.equal(normalizeTitle('مسلسل Breaking Bad الموسم الاول كامل'), 'breaking bad');
});

test('extractYear finds a 19xx/20xx year or returns null', () => {
  assert.equal(extractYear('فيلم Oppenheimer 2023 مترجم'), 2023);
  assert.equal(extractYear('no year here'), null);
});

test('titleScore rates identical normalized titles as a perfect match', () => {
  assert.equal(titleScore('Oppenheimer', 'فيلم Oppenheimer 2023 مترجم اون لاين'), 1);
});

test('bestMatch picks the correct candidate by title+year and rejects unrelated ones', () => {
  const candidates = [
    { url: 'https://site/1', name: 'The Batman 2022 مترجم' },
    { url: 'https://site/2', name: 'فيلم Oppenheimer 2023 مترجم اون لاين' },
    { url: 'https://site/3', name: 'Barbie 2023 مترجم' },
  ];
  const m = bestMatch('Oppenheimer', 2023, candidates, { kind: 'movie' });
  assert.equal(m?.url, 'https://site/2');
});

test('bestMatch returns null when nothing scores high enough', () => {
  const candidates = [{ url: 'https://site/1', name: 'Completely Unrelated Show' }];
  const m = bestMatch('Oppenheimer', 2023, candidates, { kind: 'movie' });
  assert.equal(m, null);
});

test('bestMatch rejects year mismatches beyond +/-1', () => {
  const candidates = [{ url: 'https://site/1', name: 'فيلم Oppenheimer 2019 مترجم' }];
  const m = bestMatch('Oppenheimer', 2023, candidates, { kind: 'movie' });
  assert.equal(m, null);
});

test('bestMatch (movie kind) penalizes an obvious episode title enough to reject it', () => {
  const candidates = [
    { url: 'https://site/1', name: 'مسلسل Oppenheimer الحلقة 5' },
    { url: 'https://site/2', name: 'Something Else Entirely' },
  ];
  const m = bestMatch('Oppenheimer', null, candidates, { kind: 'movie' });
  assert.equal(m, null);
});

test('bestMatch (series kind) still accepts an episode-shaped title', () => {
  // No trailing episode number here on purpose: 'الحلقة' is a decorator that
  // strips away cleanly, leaving an exact normalized match ('oppenheimer')
  // — isolating the kind:'series' vs kind:'movie' penalty as the only
  // variable, rather than mixing it with the token-containment scoring.
  const candidates = [{ url: 'https://site/1', name: 'مسلسل Oppenheimer الحلقة' }];
  const m = bestMatch('Oppenheimer', null, candidates, { kind: 'series' });
  assert.equal(m?.url, 'https://site/1');
});

test('normalizeTitle preserves a real word that merely contains a decorator as a substring', () => {
  // 'كاملون' is not itself the decorator 'كامل' (only a whole-token exact
  // match is stripped) — it must survive intact rather than get chopped
  // into a stray fragment by a substring-based strip.
  assert.equal(normalizeTitle('فيلم كاملون رائع'), 'كاملون رائع');
});

test('titleScore rejects a single-token containment false positive ("It" vs "Spirited Away")', () => {
  const score = titleScore('It', 'Spirited Away 2001');
  assert.ok(score < 0.6, `expected score < 0.6, got ${score}`);
});

test('titleScore rejects a single-token containment false positive ("Up" vs "Knocked Up")', () => {
  const score = titleScore('Up', 'Knocked Up 2007');
  assert.ok(score < 0.6, `expected score < 0.6, got ${score}`);
});

test('titleScore rejects a subset-title false positive ("The Office" vs "The Office Ladies")', () => {
  const score = titleScore('The Office', 'The Office Ladies 2021');
  assert.ok(score < 0.6, `expected score < 0.6, got ${score}`);
});

test('bestMatch rejects the three verified containment false positives, still matches Oppenheimer', () => {
  assert.equal(bestMatch('It', null, [{ url: 'x', name: 'Spirited Away 2001' }], { kind: 'movie' }), null);
  assert.equal(bestMatch('Up', null, [{ url: 'x', name: 'Knocked Up 2007' }], { kind: 'movie' }), null);
  assert.equal(
    bestMatch('The Office', null, [{ url: 'x', name: 'The Office Ladies 2021' }], { kind: 'series' }),
    null
  );
  const m = bestMatch(
    'Oppenheimer',
    2023,
    [{ url: 'https://site/2', name: 'فيلم Oppenheimer 2023 مترجم اون لاين' }],
    { kind: 'movie' }
  );
  assert.equal(m?.url, 'https://site/2');
});

test('seasonFromTitle reads Arabic ordinal and numeric season markers', () => {
  assert.equal(seasonFromTitle('مسلسل Breaking Bad الموسم الاول'), 1);
  assert.equal(seasonFromTitle('House of the Dragon الموسم الثالث'), 3);
  // Compound-before-simple trap: "الثاني عشر" (12) must not be read as its
  // simple prefix "الثاني" (2).
  assert.equal(seasonFromTitle('X الموسم الثاني عشر'), 12);
  assert.equal(seasonFromTitle('Show موسم 4'), 4);
  assert.equal(seasonFromTitle('The Last of Us'), null);
  // A stray number that isn't adjacent to a season keyword must be ignored,
  // not misread as a season.
  assert.equal(seasonFromTitle('Yellowstone 1883'), null);
});

test('bestMatchesRanked returns same-show season cards best-first, excludes unrelated titles', () => {
  const candidates = [
    { url: 'https://site/1', name: 'Breaking Bad الموسم الاول' },
    { url: 'https://site/2', name: 'Breaking Bad الموسم الخامس' },
    { url: 'https://site/3', name: 'Some Other Show 2020' },
  ];
  const ranked = bestMatchesRanked('Breaking Bad', null, candidates, { kind: 'series' });
  assert.ok(ranked.length >= 2);
  assert.ok(ranked.every((cand) => cand.name.includes('Breaking Bad')));
  assert.ok(!ranked.some((cand) => cand.name.includes('Some Other Show')));
  for (const cand of ranked) {
    assert.ok(scoreOf(cand, candidates) >= 0.6);
  }
  // Regression guard: bestMatch must still be "ranked[0]" after the refactor
  // that introduced bestMatchesRanked as the shared implementation.
  const single = bestMatch('Breaking Bad', null, candidates, { kind: 'series' });
  assert.equal(single, ranked[0]);
});

// Helper for the ranked test above — recomputes titleScore the same way
// scoreCandidate would, just to assert the >= 0.6 threshold held for every
// item bestMatchesRanked returned (titleScore is exported; scoreCandidate,
// which also folds in the year/episode penalties, is not).
function scoreOf(cand) {
  return titleScore('Breaking Bad', cand.name);
}
