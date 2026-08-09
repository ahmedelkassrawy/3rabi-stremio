// Unit tests for the pure, network-free episode-number parsing
// (episodeNumberFrom). Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { episodeNumberFrom } = require('../src/providers/akwam');

test('episodeNumberFrom: the first number (right after "حلقة") wins, not a number embedded in the episode title', () => {
  // "2 Guns" here must NOT be picked over the leading "7".
  assert.equal(episodeNumberFrom('حلقة 7 : مسلسل Breaking Bad الموسم الاول  2 Guns'), 7);
});

test('episodeNumberFrom: a plain two-digit episode number', () => {
  assert.equal(episodeNumberFrom('حلقة 12 : X'), 12);
});

test('episodeNumberFrom: no number in the title returns null', () => {
  assert.equal(episodeNumberFrom('no number'), null);
});
