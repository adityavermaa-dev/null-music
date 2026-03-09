import axios from 'axios';
import { friendlyErrorMessage, logError } from '../utils/logger';

// Mobile app calls EC2 backend directly
const SAAVN_API_BASE = 'https://music.devsyncapp.in/api/saavn';

const requestSaavn = async (tag, path, config, fallbackMessage) => {
  try {
    const response = await axios.get(`${SAAVN_API_BASE}${path}`, config);
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

export const saavnApi = {
  searchSongsSafe: async (query, limit = 10) => {
    const result = await requestSaavn(
      'saavn.searchSongs',
      '/search/songs',
      { params: { query, limit }, timeout: 10000 },
      'Saavn search is unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data?.data?.results || [],
      error: null,
    };
  },

  searchSongs: async (query, limit = 10) => {
    const result = await saavnApi.searchSongsSafe(query, limit);
    return result.data;
  },

  getTrendingSafe: async () => {
    const result = await requestSaavn(
      'saavn.getTrending',
      '/search/songs',
      { params: { query: 'trending hits 2025', limit: 20 }, timeout: 10000 },
      'Trending songs are unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data?.data?.results || [],
      error: null,
    };
  },

  getTrending: async () => {
    const result = await saavnApi.getTrendingSafe();
    return result.data;
  },

  formatTrack: (saavnSong) => {
    const downloadUrls = saavnSong.downloadUrl || [];
    const highestQuality = downloadUrls.slice(-1)[0]?.url || '';

    const images = saavnSong.image || [];
    const bestImage = images.find((img) => img.quality === '500x500')?.url || images.slice(-1)[0]?.url || '';

    return {
      id: saavnSong.id,
      title: saavnSong.name,
      artist: saavnSong.primaryArtists || saavnSong.singers || 'Unknown',
      album: saavnSong.album?.name || 'Unknown Album',
      coverArt: bestImage,
      streamUrl: highestQuality,
      duration: parseInt(saavnSong.duration, 10),
      source: 'saavn',
      hasLyrics: saavnSong.hasLyrics === 'true' || saavnSong.hasLyrics === true,
    };
  },

  getSearchSuggestionsSafe: async (query) => {
    const result = await requestSaavn(
      'saavn.getSearchSuggestions',
      '/search',
      { params: { query }, timeout: 5000 },
      'Suggestions are unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    const data = result.response?.data?.data || {};
    const suggestions = [];

    const topResults = data.topQuery?.results || [];
    topResults.forEach((item) => {
      suggestions.push({
        id: item.id,
        title: item.title,
        type: item.type,
        description: item.description || '',
        image:
          item.image?.find((i) => i.quality === '150x150')?.url ||
          item.image?.slice(-1)[0]?.url ||
          '',
      });
    });

    const songs = data.songs?.results || [];
    songs.forEach((item) => {
      suggestions.push({
        id: item.id,
        title: item.title,
        type: 'song',
        description: item.description || item.primaryArtists || '',
        image:
          item.image?.find((i) => i.quality === '150x150')?.url ||
          item.image?.slice(-1)[0]?.url ||
          '',
      });
    });

    const albums = data.albums?.results || [];
    albums.slice(0, 2).forEach((item) => {
      suggestions.push({
        id: item.id,
        title: item.title,
        type: 'album',
        description: item.description || item.artist || '',
        image:
          item.image?.find((i) => i.quality === '150x150')?.url ||
          item.image?.slice(-1)[0]?.url ||
          '',
      });
    });

    return { ok: true, data: suggestions.slice(0, 8), error: null };
  },

  getSearchSuggestions: async (query) => {
    const result = await saavnApi.getSearchSuggestionsSafe(query);
    return result.data;
  },

  getLyricsSafe: async (trackId) => {
    const result = await requestSaavn(
      'saavn.getLyrics',
      `/songs/${trackId}/lyrics`,
      { timeout: 5000 },
      'Lyrics could not be loaded right now.'
    );

    if (!result.ok) {
      return { ok: false, data: null, error: result.error };
    }

    return {
      ok: true,
      data: result.response?.data?.data?.lyrics || null,
      error: null,
    };
  },

  getLyrics: async (trackId) => {
    const result = await saavnApi.getLyricsSafe(trackId);
    return result.data;
  },
};
