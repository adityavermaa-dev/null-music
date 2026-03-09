import axios from 'axios';
import { friendlyErrorMessage, logError } from '../utils/logger';

const YT_API_BASE = 'https://music.devsyncapp.in/api/yt';

const requestYoutube = async (tag, path, config, fallbackMessage) => {
  try {
    const response = await axios.get(`${YT_API_BASE}${path}`, config);
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

  getStreamDetails: async (videoId) => ({
    videoId,
    streamUrl: `${YT_API_BASE}/pipe/${videoId}`,
  }),

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

  formatTrack: (ytSong) => ({
    id: `yt-${ytSong.id}`,
    videoId: ytSong.id,
    title: ytSong.title || 'Unknown',
    artist: ytSong.artist || ytSong.artists?.map((a) => a.name).join(', ') || 'YouTube Artist',
    album: ytSong.album || 'YouTube Music',
    coverArt: ytSong.thumbnail || ytSong.thumbnails?.[0]?.url || '',
    streamUrl: `${YT_API_BASE}/pipe/${ytSong.id}`,
    duration: ytSong.duration || 0,
    source: 'youtube',
  }),
};
