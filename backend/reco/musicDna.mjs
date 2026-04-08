import { query } from '../db/postgres.mjs';
import { logger } from '../lib/logger.mjs';

/**
 * Music DNA Profile Structure
 * Represents a user's unique musical identity based on their play history
 */

const CACHE_TTL_SECONDS = 86400; // 24 hours

// Default track features (fallback if not available)
const DEFAULT_TRACK_FEATURES = {
  energy: 0.5,
  valence: 0.5,
  acousticness: 0.3,
  danceability: 0.5,
  tempo: 120,
  genres: [],
  releaseYear: 2020,
  key: 'C',
  timeSignature: 4,
  artistArchetype: 'mainstream',
};

/**
 * Calculate user's music DNA from their play history
 */
export async function calculateUserDNA(userId) {
  try {
    // Get user's play history (completed/mostly-played tracks)
    const historyResult = await query(
      `SELECT track_id, title, artist, features, completion_ratio 
       FROM user_tracks 
       WHERE user_id = $1 
       AND completion_ratio > 0.3
       ORDER BY updated_at DESC 
       LIMIT 500`,
      [userId]
    );

    if (historyResult.rows.length === 0) {
      return createEmptyDNA();
    }

    const tracks = historyResult.rows;
    
    // Extract and aggregate features
    const dna = aggregateTrackFeatures(tracks);

    // Store DNA profile
    await storeDNAProfile(userId, dna);

    return dna;
  } catch (error) {
    logger.error(`Error calculating DNA for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Aggregate track features into user DNA profile
 */
function aggregateTrackFeatures(tracks) {
  const genreMap = {};
  let totalEnergy = 0;
  let totalValence = 0;
  let totalAcousticness = 0;
  let totalDanceability = 0;
  let totalTempo = 0;
  let yearCount = {};
  const keyMap = {};
  const timeSignatureMap = {};
  const archetypeMap = {};
  const artists = {};

  let validTrackCount = 0;

  for (const track of tracks) {
    const features = track.features || DEFAULT_TRACK_FEATURES;
    const weight = Math.min(1, track.completion_ratio || 0.5);

    // Energy
    totalEnergy += (features.energy || 0.5) * weight;

    // Valence (mood)
    totalValence += (features.valence || 0.5) * weight;

    // Acousticness
    totalAcousticness += (features.acousticness || 0.3) * weight;

    // Danceability
    totalDanceability += (features.danceability || 0.5) * weight;

    // Tempo
    totalTempo += (features.tempo || 120) * weight;

    // Genres
    if (Array.isArray(features.genres)) {
      for (const genre of features.genres) {
        genreMap[genre] = (genreMap[genre] || 0) + weight;
      }
    }

    // Release year
    const year = features.releaseYear || 2020;
    yearCount[year] = (yearCount[year] || 0) + weight;

    // Key
    const key = features.key || 'C';
    keyMap[key] = (keyMap[key] || 0) + weight;

    // Time signature
    const ts = features.timeSignature || 4;
    timeSignatureMap[ts] = (timeSignatureMap[ts] || 0) + weight;

    // Artist archetype
    const archetype = features.artistArchetype || 'mainstream';
    archetypeMap[archetype] = (archetypeMap[archetype] || 0) + weight;

    // Track artist
    if (track.artist) {
      artists[track.artist] = (artists[track.artist] || 0) + weight;
    }

    validTrackCount += weight;
  }

  const avgCount = Math.max(1, validTrackCount);

  // Compute percentages and ranges
  const genresArray = Object.entries(genreMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([genre, count]) => ({
      genre,
      percentage: Math.round((count / avgCount) * 100),
    }));

  const topYears = Object.entries(yearCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([year, count]) => ({
      year: parseInt(year),
      percentage: Math.round((count / avgCount) * 100),
    }));

  const topArtists = Object.entries(artists)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([artist]) => artist);

  const topKeys = Object.entries(keyMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key]) => key);

  const topArchetypes = Object.entries(archetypeMap)
    .sort((a, b) => b[1] - a[1])
    .map(([archetype, count]) => ({
      archetype,
      percentage: Math.round((count / avgCount) * 100),
    }));

  // Calculate energy/valence ranges
  const energyMin = 0.2;
  const energyMax = 0.9;
  const valenceMin = 0.2;
  const valenceMax = 0.9;

  const avgEnergy = totalEnergy / avgCount;
  const avgValence = totalValence / avgCount;

  return {
    userId: null, // Set by caller
    dnaId: generateDNAId(),
    genres: genresArray,
    energyAverage: Math.round(avgEnergy * 100) / 100,
    energyRange: [energyMin, energyMax],
    valenceAverage: Math.round(avgValence * 100) / 100,
    valenceRange: [valenceMin, valenceMax],
    acousticnessAverage: Math.round((totalAcousticness / avgCount) * 100) / 100,
    danceabilityAverage: Math.round((totalDanceability / avgCount) * 100) / 100,
    tempoAverage: Math.round(totalTempo / avgCount),
    favoriteKeys: topKeys,
    decadePreferences: topYears,
    archetypes: topArchetypes,
    topArtists: topArtists,
    trackCount: tracks.length,
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Store DNA profile in database
 */
async function storeDNAProfile(userId, dna) {
  try {
    await query(
      `INSERT INTO user_dna_profiles (user_id, dna_id, profile_data, calculated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
       profile_data = $3,
       calculated_at = $4`,
      [userId, dna.dnaId, JSON.stringify(dna), new Date().toISOString()]
    );
  } catch (error) {
    logger.error(`Error storing DNA profile for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Get user's DNA profile (cached)
 */
export async function getUserDNA(userId) {
  try {
    const result = await query(
      `SELECT profile_data, calculated_at FROM user_dna_profiles WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Calculate and return DNA if not cached
      return calculateUserDNA(userId);
    }

    const cached = result.rows[0];
    const profile = JSON.parse(cached.profile_data);
    profile.userId = userId;
    return profile;
  } catch (error) {
    logger.error(`Error fetching DNA for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Find sonic twins - similar artists based on DNA match
 */
export async function findSonicTwins(userId, limit = 10) {
  try {
    const userDNA = await getUserDNA(userId);
    
    // Get user's artists to exclude
    const historyResult = await query(
      `SELECT DISTINCT artist FROM user_tracks 
       WHERE user_id = $1 AND completion_ratio > 0.2
       LIMIT 20`,
      [userId]
    );

    const userArtists = new Set(
      historyResult.rows.map(r => normalizeArtistName(r.artist))
    );

    // In a real implementation, this would query a music database or Spotify API
    // For now, we'll do a similarity search on cached track features
    const allTracksResult = await query(
      `SELECT DISTINCT artist, features FROM tracks 
       WHERE features IS NOT NULL 
       LIMIT 1000`
    );

    const artistScores = calculateArtistSimilarity(userDNA, allTracksResult.rows, userArtists);
    
    const twins = Object.entries(artistScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([artist, score]) => ({
        artist,
        matchPercentage: Math.round(score * 100),
        reason: generateMatchReason(userDNA),
      }));

    return twins;
  } catch (error) {
    logger.error(`Error finding sonic twins for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Calculate similarity between user DNA and other artists
 */
function calculateArtistSimilarity(userDNA, allTracks, excludeArtists) {
  const artistScores = {};

  for (const track of allTracks) {
    const artist = normalizeArtistName(track.artist);
    
    if (excludeArtists.has(artist)) continue;

    if (!artistScores[artist]) {
      artistScores[artist] = [];
    }

    const features = track.features || DEFAULT_TRACK_FEATURES;
    
    // Calculate individual feature similarity
    const energySim = 1 - Math.abs((features.energy || 0.5) - userDNA.energyAverage) / 1;
    const valenceSim = 1 - Math.abs((features.valence || 0.5) - userDNA.valenceAverage) / 1;
    const danceabilitySim = 1 - Math.abs((features.danceability || 0.5) - userDNA.danceabilityAverage) / 1;
    
    // Weight combination
    const similarity = (energySim * 0.4 + valenceSim * 0.4 + danceabilitySim * 0.2);
    
    artistScores[artist].push(similarity);
  }

  // Average scores per artist
  const averaged = {};
  for (const [artist, scores] of Object.entries(artistScores)) {
    averaged[artist] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  return averaged;
}

/**
 * Generate match reason for sonic twin
 */
function generateMatchReason(userDNA) {
  const reasons = [];
  
  const topGenre = userDNA.genres[0]?.genre || 'genre';
  reasons.push(`Matches your ${topGenre} taste`);

  if (userDNA.energyAverage > 0.7) {
    reasons.push('Similar high-energy vibe');
  } else if (userDNA.energyAverage < 0.4) {
    reasons.push('Shares your calm aesthetic');
  }

  return reasons[0];
}

/**
 * Create empty DNA profile for new users
 */
function createEmptyDNA() {
  return {
    genres: [],
    energyAverage: 0.5,
    energyRange: [0.2, 0.9],
    valenceAverage: 0.5,
    valenceRange: [0.2, 0.9],
    acousticnessAverage: 0.3,
    danceabilityAverage: 0.5,
    tempoAverage: 120,
    favoriteKeys: [],
    decadePreferences: [],
    archetypes: [],
    topArtists: [],
    trackCount: 0,
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Generate unique DNA ID
 */
function generateDNAId() {
  return `dna-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Normalize artist name for comparison
 */
function normalizeArtistName(artist) {
  return String(artist || '')
    .toLowerCase()
    .trim()
    .split(/,|&|x|feat/i)[0]
    .trim();
}

/**
 * Schedule DNA recalculation for a user (e.g., when library changes)
 */
export async function invalidateUserDNA(userId) {
  try {
    await query(
      `DELETE FROM user_dna_profiles WHERE user_id = $1`,
      [userId]
    );
  } catch (error) {
    logger.error(`Error invalidating DNA for user ${userId}:`, error);
  }
}
