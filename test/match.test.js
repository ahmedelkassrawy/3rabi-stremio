// Unit tests for the pure, network-free title-matching logic. Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitle, titleScore, extractYear, bestMatch } = require('../src/match');

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
