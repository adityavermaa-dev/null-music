/**
 * User Track Activity Tracking Middleware
 * Records play events and features for Music DNA calculation
 */

import { pool } from '../db/postgres.mjs';
import { logger } from '../lib/logger.mjs';

/**
 * Record track play completion
 * Call this when a track finishes playing (>80% completion)
 */
export async function recordTrackPlay(userId, track, completionRatio = 1.0, features = null) {
  if (!userId || !track?.id) {
    logger.warn('Invalid track play record attempt', { userId, track });
    return false;
  }

  try {
    const query = `
      INSERT INTO user_tracks (user_id, track_id, title, artist, features, completion_ratio, play_count)
      VALUES ($1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT (user_id, track_id) DO UPDATE SET
        completion_ratio = GREATEST(user_tracks.completion_ratio, $6),
        play_count = user_tracks.play_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `;

    await pool.query(query, [
      userId,
      track.id,
      track.title || 'Unknown',
      track.artist || 'Unknown',
      features ? JSON.stringify(features) : null,
      Math.max(0, Math.min(1, completionRatio)),
    ]);

    logger.debug('Track play recorded', { userId, trackId: track.id, completionRatio });
    return true;
  } catch (error) {
    logger.error('Error recording track play:', error);
    throw error;
  }
}

/**
 * Batch record multiple track plays
 */
export async function recordTrackPlayBatch(userId, tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return;
  }

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const track of tracks) {
        await recordTrackPlay(userId, track, track.completionRatio || 1.0, track.features);
      }

      await client.query('COMMIT');
      logger.debug('Batch track plays recorded', { userId, count: tracks.length });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error in batch track recording:', error);
    throw error;
  }
}

/**
 * Get user's recent plays for DNA calculation
 */
export async function getUserRecentPlays(userId, limit = 500) {
  try {
    const result = await pool.query(
      `SELECT track_id, title, artist, features, completion_ratio 
       FROM user_tracks 
       WHERE user_id = $1 
       AND completion_ratio > 0.3
       ORDER BY updated_at DESC 
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  } catch (error) {
    logger.error('Error fetching user recent plays:', error);
    throw error;
  }
}

/**
 * Get track play statistics for a user
 */
export async function getUserPlayStats(userId) {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_tracks,
        SUM(play_count) as total_plays,
        COUNT(CASE WHEN completion_ratio >= 0.8 THEN 1 END) as fully_played_tracks,
        AVG(completion_ratio) as avg_completion,
        MAX(updated_at) as last_played,
        MIN(updated_at) as first_played
       FROM user_tracks 
       WHERE user_id = $1`,
      [userId]
    );

    const stats = result.rows[0] || {};
    return {
      totalTracks: parseInt(stats.total_tracks) || 0,
      totalPlays: parseInt(stats.total_plays) || 0,
      fullyPlayedTracks: parseInt(stats.fully_played_tracks) || 0,
      avgCompletion: parseFloat(stats.avg_completion) || 0,
      lastPlayed: stats.last_played ? new Date(stats.last_played) : null,
      firstPlayed: stats.first_played ? new Date(stats.first_played) : null,
    };
  } catch (error) {
    logger.error('Error fetching play stats:', error);
    throw error;
  }
}

/**
 * Delete track from user's history
 * Useful if user wants to remove a track from DNA calculation
 */
export async function removeTrackFromHistory(userId, trackId) {
  try {
    await pool.query(
      `DELETE FROM user_tracks WHERE user_id = $1 AND track_id = $2`,
      [userId, trackId]
    );

    // Invalidate DNA cache
    await pool.query(
      `DELETE FROM user_dna_profiles WHERE user_id = $1`,
      [userId]
    );

    logger.debug('Track removed from history', { userId, trackId });
  } catch (error) {
    logger.error('Error removing track from history:', error);
    throw error;
  }
}

/**
 * Clear all play history for a user
 */
export async function clearUserHistory(userId) {
  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(`DELETE FROM user_tracks WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM user_dna_profiles WHERE user_id = $1`, [userId]);

      await client.query('COMMIT');
      logger.debug('User history cleared', { userId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error clearing user history:', error);
    throw error;
  }
}

/**
 * Enrich track with Spotify audio features
 * Optional: integrate with Spotify API
 */
export async function enrichTrackWithFeatures(track, spotifyAccessToken = null) {
  // If track already has features, return as-is
  if (track.features) {
    return track;
  }

  // If Spotify token available, fetch from Spotify API
  if (spotifyAccessToken && track.spotifyId) {
    try {
      const response = await fetch(`https://api.spotify.com/v1/audio-features/${track.spotifyId}`, {
        headers: {
          'Authorization': `Bearer ${spotifyAccessToken}`,
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const features = await response.json();
        track.features = {
          energy: features.energy || 0.5,
          valence: features.valence || 0.5,
          acousticness: features.acousticness || 0.3,
          danceability: features.danceability || 0.5,
          tempo: features.tempo || 120,
          key: features.key ? getKeyName(features.key) : 'C',
          timeSignature: features.time_signature || 4,
        };
      }
    } catch (error) {
      logger.warn('Error enriching track with Spotify features:', error);
    }
  }

  return track;
}

/**
 * Convert Spotify key number to note name
 */
function getKeyName(keyNum) {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return notes[keyNum % 12] || 'C';
}

/**
 * Middleware for Express to track track plays
 * Usage: app.post('/api/track/play', trackPlayMiddleware, handler);
 */
export function trackPlayMiddleware(req, res, next) {
  const originalJson = res.json;

  res.json = function(data) {
    // Intercept track play events and record them
    if (data?.track && req.user?.id) {
      recordTrackPlay(
        req.user.id,
        data.track,
        data.completionRatio || 1.0,
        data.track.features
      ).catch(error => logger.error('Failed to record track play in middleware:', error));
    }

    return originalJson.call(this, data);
  };

  next();
}
