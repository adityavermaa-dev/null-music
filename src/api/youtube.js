import axios from 'axios';
import { friendlyErrorMessage, logError } from '../utils/logger';

import { buildApiUrl } from './apiBase';

const requestYoutube = async (tag, path, config, fallbackMessage) => {
  try {
    const response = await axios.get(buildApiUrl(`/yt${path}`), config);
    return { ok: true, response, error: null };
  } catch (error) {
    logError(tag, error, { path, params: config?.params });
    return {
      ok: false,
      response: null,
      error: friendlyErrorMessage(error, fallbackMessage),
    };
  }
};

export const youtubeApi = {
  searchSongsSafe: async (query, limit = 10) => {
    const result = await requestYoutube(
      'youtube.searchSongs',
      '/search',
      { params: { query, limit }, timeout: 15000 },
      'YouTube search is unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    const results = result.response?.data?.results || [];
    return {
      ok: true,
      data: results.map(youtubeApi.formatTrack),
      error: null,
    };
  },

  searchSongs: async (query, limit = 10) => {
    const result = await youtubeApi.searchSongsSafe(query, limit);
    return result.data;
  },

  getStreamDetailsSafe: async (videoId) => {
    const result = await requestYoutube(
      'youtube.getStreamDetails',
      `/stream/${videoId}`,
      { timeout: 15000 },
      'Stream is unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: null, error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data || null,
      error: null,
    };
  },

  // preferDirect=true is best for native (ExoPlayer) because it avoids proxy/streaming edge-cases.
  // Do NOT fall back to /pipe on native; if /stream fails, the caller should use Saavn fallback or show error.
  getStreamDetails: async (videoId, { preferDirect = false } = {}) => {
    const pipeUrl = buildApiUrl(`/yt/pipe/${videoId}`);

    if (!preferDirect) {
      return { videoId, streamUrl: pipeUrl, pipeUrl, directUrl: null, cacheState: 'pipe', cached: false, streamSource: 'pipe-proxy' };
    }

    const result = await youtubeApi.getStreamDetailsSafe(videoId);
    const directUrl = result.ok ? result.data?.streamUrl : null;
    return {
      videoId,
      streamUrl: directUrl || null,
      pipeUrl,
      directUrl: directUrl || null,
      cacheState: result.ok ? result.data?.cacheState || 'warming' : 'warming',
      cached: Boolean(result.ok ? result.data?.cached : false),
      cacheSizeBytes: Number(result.ok ? result.data?.cacheSizeBytes || 0 : 0),
      streamSource: result.ok ? result.data?.streamSource || null : null,
    };
  },

  getCacheStatusSafe: async (videoId) => {
    const result = await requestYoutube(
      'youtube.getCacheStatus',
      `/cache-status/${videoId}`,
      { timeout: 8000 },
      'Cache status is unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: null, error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data || null,
      error: null,
    };
  },

  getSearchSuggestionsSafe: async (query) => {
    const result = await requestYoutube(
      'youtube.getSearchSuggestions',
      '/suggestions',
      { params: { query }, timeout: 5000 },
      'YouTube suggestions are unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data?.suggestions || [],
      error: null,
    };
  },

  getSearchSuggestions: async (query) => {
    const result = await youtubeApi.getSearchSuggestionsSafe(query);
    return result.data;
  },

  getUpNextSafe: async (videoId) => {
    const result = await requestYoutube(
      'youtube.getUpNext',
      `/up-next/${videoId}`,
      { timeout: 10000 },
      'Up next is unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    const results = result.response?.data?.results || [];
    return {
      ok: true,
      data: results.map(youtubeApi.formatTrack),
      error: null,
    };
  },

  formatTrack: (ytSong) => ({
    id: `yt-${ytSong.id}`,
    videoId: ytSong.id,
    title: ytSong.title || 'Unknown',
    artist: ytSong.artist || ytSong.artists?.map((a) => a.name).join(', ') || 'YouTube Artist',
    album: ytSong.album || 'YouTube Music',
    coverArt: ytSong.thumbnail || ytSong.thumbnails?.[0]?.url || '',
    // Do not assume pipe works for native playback; PlayerContext resolves the best URL at play-time.
    streamUrl: null,
    duration: ytSong.duration || 0,
    source: 'youtube',
  }),
};
