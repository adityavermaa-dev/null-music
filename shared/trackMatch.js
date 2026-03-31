const TITLE_NOISE_WORDS = new Set([
  'official',
  'video',
  'audio',
  'lyric',
  'lyrics',
  'visualizer',
  'version',
  'song',
  'music',
  'full',
  'hd',
  'hq',
  'bass',
  'boosted',
  'slowed',
  'reverb',
  'edit',
]);

const ARTIST_NOISE_WORDS = new Set([
  'official',
  'topic',
  'music',
  'records',
  'recordings',
  'vevo',
  'channel',
]);

function stripBracketedText(value) {
  return String(value || '')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*}/g, ' ');
}

function normalizeTrackText(value) {
  return stripBracketedText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(feat|ft|featuring)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value, noiseWords = TITLE_NOISE_WORDS) {
  return normalizeTrackText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !noiseWords.has(token));
}

function overlapScore(expectedTokens, candidateTokens) {
  if (!expectedTokens.length) return 1;
  const candidateSet = new Set(candidateTokens);
  let hits = 0;
  for (const token of expectedTokens) {
    if (candidateSet.has(token)) hits += 1;
  }
  return hits / expectedTokens.length;
}

function containsNormalized(expected, candidate) {
  if (!expected || !candidate) return false;
  return candidate.includes(expected) || expected.includes(candidate);
}

export function scoreTrackCandidate(expectedTrack, candidate, options = {}) {
  const getTitle = options.getTitle || ((item) => item?.title || item?.name || '');
  const getArtist = options.getArtist || ((item) => item?.artist || item?.author || '');

  const expectedTitle = normalizeTrackText(expectedTrack?.title || '');
  const candidateTitle = normalizeTrackText(getTitle(candidate));
  const expectedArtistTokens = tokenize(expectedTrack?.artist || '', ARTIST_NOISE_WORDS);
  const candidateArtistTokens = tokenize(getArtist(candidate), ARTIST_NOISE_WORDS);

  const titleTokens = tokenize(expectedTrack?.title || '');
  const candidateTitleTokens = tokenize(getTitle(candidate));

  const titleScore = containsNormalized(expectedTitle, candidateTitle)
    ? 1
    : overlapScore(titleTokens, candidateTitleTokens);
  const artistScore = overlapScore(expectedArtistTokens, candidateArtistTokens);
  const combinedScore = (titleScore * 0.78) + (artistScore * 0.22);
  const isConfident =
    titleScore >= 0.72 &&
    (
      expectedArtistTokens.length === 0 ||
      artistScore >= 0.34 ||
      combinedScore >= 0.86
    );

  return {
    titleScore,
    artistScore,
    combinedScore,
    isConfident,
  };
}

export function pickBestTrackMatch(candidates, expectedTrack, options = {}) {
  if (!Array.isArray(candidates) || !expectedTrack) return null;

  let bestCandidate = null;
  let bestScore = null;

  for (const candidate of candidates) {
    const score = scoreTrackCandidate(expectedTrack, candidate, options);
    if (!bestScore || score.combinedScore > bestScore.combinedScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  if (!bestCandidate || !bestScore?.isConfident) {
    return null;
  }

  return {
    candidate: bestCandidate,
    score: bestScore,
  };
}
