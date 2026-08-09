// Fuzzy matching between a Cinemeta title (English, clean) and a provider's
// search-result title (Arabic-site-formatted, e.g. "فيلم Oppenheimer 2023
// مترجم اون لاين"). Pure and network-free so it's easy to unit test — see
// test/match.test.js.

// Arabic decorator words the providers glue onto every listing title. Each
// is stripped as a *whole word* (not a substring) so it never eats into a
// real title that happens to contain the same letters.
// Longer/more-specific variants must come before shorter substrings they
// contain (e.g. 'الحلقة' before 'حلقة', 'اون لاين' before 'اون') so the
// split-based strip below doesn't leave a stray fragment (bare 'ال') behind.
const DECORATORS = [
  'مشاهدة', 'فيلم', 'مسلسل', 'انمي', 'أنمي', 'مترجم', 'مدبلج',
  'اون لاين', 'اونلاين', 'كامل', 'الحلقة', 'حلقة', 'الموسم', 'برنامج',
  'اون', 'نسخة',
];

// Quality/release tags that show up appended to titles on some sites.
const RELEASE_TAGS = [
  '1080p', '720p', '480p', 'web-dl', 'webrip', 'hdts', 'hdcam',
  'bluray', 'brrip', 'x264', 'x265', 'hevc', 'hdtv', 'camrip', 'v2', 'v3',
];

const EPISODE_HINT_RE = /(?:حلقة|الحلقة)|s\d{1,2}e\d{1,3}|الموسم/i;

function normalizeTitle(s) {
  if (!s) return '';
  let out = ` ${s.toLowerCase()} `;

  // Strip decorator words as whole words (surrounded by non-word boundaries
  // — Arabic letters aren't in \w, so match against whitespace instead).
  for (const word of DECORATORS) {
    out = out.split(word.toLowerCase()).join(' ');
  }
  for (const tag of RELEASE_TAGS) {
    out = out.split(tag).join(' ');
  }

  // Strip a leading/trailing 4-digit year (a *standalone* one — kept as a
  // token so a title like "2001 a space odyssey" doesn't lose "2001" from
  // the middle, only from the ends).
  out = out.trim().replace(/^(19|20)\d{2}\b/, ' ').replace(/\b(19|20)\d{2}$/, ' ');

  // Drop punctuation/diacritics, keep latin + digits + arabic letters + spaces.
  out = out.replace(/[ً-ْ]/g, ''); // Arabic diacritics (tashkeel)
  out = out.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

function extractYear(text) {
  if (!text) return null;
  const m = String(text).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function tokenSet(normalized) {
  return new Set(normalized.split(' ').filter(Boolean));
}

// Jaccard similarity of token sets, boosted when one normalized string fully
// contains the other (handles "oppenheimer" vs "oppenheimer 2023 imax cut"
// style provider titles where token-set overlap alone would undersell it).
function titleScore(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const setA = tokenSet(na);
  const setB = tokenSet(nb);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  const jaccard = union ? intersection / union : 0;

  const containment = na.includes(nb) || nb.includes(na) ? 1 : 0;

  // Weighted blend: containment is a strong signal (near-guaranteed match)
  // but shouldn't fully override a token-level mismatch on short strings.
  return Math.max(jaccard, containment ? 0.85 + 0.15 * jaccard : jaccard);
}

function looksLikeEpisode(name) {
  return EPISODE_HINT_RE.test(name || '');
}

// candidates: [{ url, name, ... }]. Returns the best candidate or null.
function bestMatch(query, year, candidates, { kind } = {}) {
  let best = null;
  let bestScore = 0;

  for (const cand of candidates) {
    if (!cand?.name) continue;
    let score = titleScore(query, cand.name);
    if (score <= 0) continue;

    const candYear = extractYear(cand.name);
    if (year != null) {
      if (candYear != null) {
        if (Math.abs(candYear - year) > 1) continue; // year mismatch -> reject
      } else {
        score *= 0.9; // no year on the candidate -> slight penalty, not a reject
      }
    }

    if (kind === 'movie' && looksLikeEpisode(cand.name)) {
      score *= 0.5; // probably an episode card leaking into a movie search
    }

    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  return bestScore >= 0.6 ? best : null;
}

module.exports = { normalizeTitle, titleScore, extractYear, bestMatch };
