import play from 'play-dl';
import { logger } from '../lib/logger.mjs';
import { pickBestTrackMatch, scoreTrackCandidate } from '../../shared/trackMatch.js';

/**
 * Validates a SoundCloud URL and ensures it's playable.
 * Used internally by the provider.
 */
async function getSoundcloudStreamUrl(scUrl) {
    try {
        const streamInfo = await play.stream(scUrl);
        if (streamInfo && streamInfo.url) {
            return streamInfo.url;
        }
    } catch (err) {
        logger.debug('soundcloud', `Failed to extract stream from ${scUrl}`, { error: err.message });
    }
    return null;
}

/**
 * Tries to fetch an audio stream URL from SoundCloud by searching for the track.
 * Used as a highly reliable fallback when YouTube/Piped fails.
 * @param {string} videoId For logging
 * @param {string} title Song title
 * @param {string} artist Artist name
 * @returns {Promise<string|null>} Stream URL or null
 */
export async function soundcloudGetAudioUrl(videoId, title, artist) {
    if (!title) return null;

    const query = `${artist ? artist + ' ' : ''}${title}`.trim();
    if (!query) return null;

    try {
        // Fix for play-dl not automatically initializing the SoundCloud client_id
        const clientId = await play.getFreeClientID();
        if (clientId) await play.setToken({ soundcloud: { client_id: clientId } });

        // Search SoundCloud for top 5 tracks
        const results = await play.search(query, {
            source: { soundcloud: 'tracks' },
            limit: 5
        });

        if (!Array.isArray(results) || results.length === 0) {
            logger.debug('soundcloud', `No search results for query: ${query}`);
            return null;
        }

        const match = pickBestTrackMatch(results, { title, artist }, {
            getTitle: (track) => track?.name || track?.title || '',
            getArtist: (track) =>
                track?.user?.name ||
                track?.user?.username ||
                track?.channel?.name ||
                track?.publisher?.name ||
                '',
        });

        if (!match) {
            logger.info('soundcloud', 'Rejected low-confidence SoundCloud fallback', { videoId, query });
            return null;
        }

        // Try the best semantic match first, then fall through to the rest of the
        // already-matching candidates in case the first stream is unavailable.
        const rankedResults = [
            match.candidate,
            ...results.filter((track) => (
                track !== match.candidate &&
                scoreTrackCandidate({ title, artist }, track, {
                    getTitle: (candidate) => candidate?.name || candidate?.title || '',
                    getArtist: (candidate) =>
                        candidate?.user?.name ||
                        candidate?.user?.username ||
                        candidate?.channel?.name ||
                        candidate?.publisher?.name ||
                        '',
                }).isConfident
            )),
        ];

        for (const track of rankedResults) {
            if (!track.url) continue;

            const streamUrl = await getSoundcloudStreamUrl(track.url);
            if (streamUrl) {
                logger.info('soundcloud', `Resolved stream via SoundCloud for: ${query}`, { videoId });
                return streamUrl;
            }
        }

        logger.debug('soundcloud', `Failed to extract a playable stream for query: ${query}`);
    } catch (err) {
        logger.warn('soundcloud', 'SoundCloud search failed', { query, error: err.message });
    }

    return null;
}
