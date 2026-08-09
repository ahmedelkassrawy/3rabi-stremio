// Fuzzy matching between a Cinemeta title (English, clean) and a provider's
// search-result title (Arabic-site-formatted, e.g. "فيلم Oppenheimer 2023
// مترجم اون لاين"). Pure and network-free so it's easy to unit test — see
// test/match.test.js.

// Decorator words the providers glue onto every listing title, stripped as
// EXACT whole tokens (never substrings — Arabic letters aren't in \w, so a
// regex \b boundary doesn't work here; see normalizeTitle below, which
// tokenizes on whitespace and compares tokens verbatim). This is what keeps
// a real word that merely *contains* a decorator's letters (e.g. a title
// word containing 'كامل' as a prefix) from getting chopped into a stray
// fragment.
const DECORATOR_WORDS = new Set([
  'مشاهدة', 'فيلم', 'مسلسل', 'انمي', 'أنمي', 'مترجم', 'مترجمة', 'مترجمه',
  'مدبلج', 'مدبلجة', 'مدبلجه', 'اونلاين', 'كامل', 'الحلقة', 'حلقة', 'الموسم',
  'برنامج', 'اون', 'نسخة', 'والاخيرة', 'الاخيرة',
]);

// Multi-word decorator phrases (space-separated in the source), stripped by
// matching a consecutive run of tokens rather than a single one.
const DECORATOR_PHRASES = [['اون', 'لاين']];

// Quality/release tags that show up appended to titles on some sites,
// stripped the same whole-token way.
const RELEASE_TAG_SET = new Set([
  '1080p', '720p', '480p', 'web-dl', 'webrip', 'hdts', 'hdcam',
  'bluray', 'brrip', 'x264', 'x265', 'hevc', 'hdtv', 'camrip', 'v2', 'v3',
]);

const EPISODE_HINT_RE = /(?:حلقة|الحلقة)|s\d{1,2}e\d{1,3}|الموسم/i;

// Arabic ordinal season words -> number. Providers title their per-season
// cards "<show> الموسم <ordinal>" (Akwam) or "… موسم <n>" (Faselhd), so a
// requested IMDb season can be located among candidates by parsing this.
// Compound ordinals ("الثاني عشر" = 12) MUST be tested before their simple
// prefix ("الثاني" = 2) or a 12th-season title would read as season 2 — the
// lookup below sorts keys longest-first to guarantee that.
const AR_SEASON_WORDS = {
  الاول: 1, الأول: 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5,
  السادس: 6, السابع: 7, الثامن: 8, التاسع: 9, العاشر: 10,
  'الحادي عشر': 11, 'الثاني عشر': 12, 'الثالث عشر': 13, 'الرابع عشر': 14,
  'الخامس عشر': 15, 'السادس عشر': 16, 'السابع عشر': 17, 'الثامن عشر': 18,
  'التاسع عشر': 19, العشرون: 20,
};
const AR_SEASON_ENTRIES = Object.entries(AR_SEASON_WORDS).sort((a, b) => b[0].length - a[0].length);

// Best-effort season number for a provider listing/title. Returns null when no
// season marker is present (a bare show title, or an "all seasons" hub) so the
// caller can treat "unknown" differently from a concrete mismatch.
function seasonFromTitle(name) {
  if (!name) return null;
  const lower = name.toLowerCase().replace(/[ً-ْ]/g, '');
  for (const [word, num] of AR_SEASON_ENTRIES) {
    if (lower.includes(word)) return num;
  }
  // Numeric forms: "موسم 3", "season 3", "s3".
  const m = lower.match(/(?:(?:الموسم|موسم)\s*|\b(?:season|s)\s*[-:]?\s*)(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

// Removes every consecutive run of tokens matching `phrase`, in place of a
// substring split (a raw string split would also nuke the phrase's letters
// out of an unrelated word that happens to contain them).
function stripPhrase(tokens, phrase) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (phrase.every((w, j) => tokens[i + j] === w)) {
      i += phrase.length - 1; // skip the whole matched run
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

function normalizeTitle(s) {
  if (!s) return '';
  let lower = s.toLowerCase().replace(/[ً-ْ]/g, ''); // strip Arabic diacritics (tashkeel)

  // Strip Arabic season/episode phrases as a unit: "الموسم <ordinal>" and
  // "الحلقة <number|word>" (and bare "حلقة <n>"). Provider series results are
  // per-season/per-episode cards ("House of the Dragon الموسم الثالث الحلقة 7"),
  // and leaving the ordinal/number tokens in would make the candidate title far
  // longer than the clean query and sink the length-ratio score below match —
  // so the base series title must collapse to exactly the query.
  lower = lower
    .replace(/الموسم\s+\S+/g, ' ')
    .replace(/الحلقة\s+\S+/g, ' ')
    .replace(/حلقة\s+\S+/g, ' ');

  let tokens = lower.split(/\s+/).filter(Boolean);
  for (const phrase of DECORATOR_PHRASES) tokens = stripPhrase(tokens, phrase);
  tokens = tokens.filter((t) => !DECORATOR_WORDS.has(t) && !RELEASE_TAG_SET.has(t));

  // Drop a leading/trailing standalone 4-digit year token (release-year
  // metadata) — kept only at the ends so a title that's genuinely built
  // around a number isn't eaten from the middle.
  if (tokens.length && /^(19|20)\d{2}$/.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length && /^(19|20)\d{2}$/.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);

  // Whatever's left may still carry punctuation (e.g. a trailing comma) —
  // drop it now, keeping latin + digits + arabic letters + spaces.
  const cleaned = tokens.join(' ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractYear(text) {
  if (!text) return null;
  const m = String(text).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function tokenize(normalized) {
  return normalized.split(' ').filter(Boolean);
}

// Jaccard similarity of token sets, boosted by TOKEN-based containment: every
// token of the shorter title appears as a whole token in the longer one
// (handles "oppenheimer" vs "oppenheimer 2023 imax cut" style provider
// titles where plain overlap alone would undersell it). A raw substring
// check here is a trap — "the office" is a literal substring of "the office
// ladies", a different show entirely — so containment is token-set-based,
// and both the plain score and the containment bonus are scaled down by how
// much of the longer title's token budget is *unaccounted for*, squared so
// a couple of stray extra tokens costs more than a linear scale-down would.
function titleScore(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = tokenize(na);
  const tokensB = tokenize(nb);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  const jaccard = union ? intersection / union : 0;

  // A lone short token ("it", "up") must not qualify for containment on its
  // own — almost anything "contains" a two-letter word — so it needs either
  // >=2 tokens or one long-enough (>=4 char) token.
  const shorterIsA = tokensA.length <= tokensB.length;
  const shorterTokens = shorterIsA ? tokensA : tokensB;
  const longerSet = shorterIsA ? setB : setA;
  const meaningfulShort = shorterTokens.length >= 2 || (shorterTokens.length === 1 && shorterTokens[0].length >= 4);
  const contained = meaningfulShort && shorterTokens.every((t) => longerSet.has(t));

  const lengthRatio = Math.min(tokensA.length, tokensB.length) / Math.max(tokensA.length, tokensB.length);
  const dampen = lengthRatio * lengthRatio;

  const base = jaccard * dampen;
  const boosted = contained ? (0.85 + 0.15 * jaccard) * dampen : 0;

  return Math.max(base, boosted);
}

function looksLikeEpisode(name) {
  return EPISODE_HINT_RE.test(name || '');
}

// Score a single candidate against the query, applying the year and
// movie-episode penalties. Returns a number (<= 0 means "no match at all").
function scoreCandidate(query, year, cand, kind) {
  if (!cand?.name) return 0;
  let score = titleScore(query, cand.name);
  if (score <= 0) return 0;

  const candYear = extractYear(cand.name);
  if (year != null) {
    if (candYear != null) {
      if (Math.abs(candYear - year) > 1) return 0; // year mismatch -> reject
    } else {
      score *= 0.9; // no year on the candidate -> slight penalty, not a reject
    }
  }

  if (kind === 'movie' && looksLikeEpisode(cand.name)) {
    score *= 0.5; // probably an episode card leaking into a movie search
  }
  return score;
}

// candidates: [{ url, name, ... }]. Returns every candidate scoring at/above
// the 0.6 threshold, best-first. Used by the series pipeline, where each
// search hit can be a *single season* of the show (Akwam lists
// "X الموسم الأول/الثاني/…" as separate cards) and the requested season may
// not be the top-scored one — the caller re-orders these by season.
function bestMatchesRanked(query, year, candidates, { kind } = {}) {
  return candidates
    .map((cand) => ({ cand, score: scoreCandidate(query, year, cand, kind) }))
    .filter((r) => r.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cand);
}

// Returns the single best candidate or null.
function bestMatch(query, year, candidates, opts = {}) {
  return bestMatchesRanked(query, year, candidates, opts)[0] || null;
}

module.exports = {
  normalizeTitle,
  titleScore,
  extractYear,
  seasonFromTitle,
  bestMatch,
  bestMatchesRanked,
};
