import axios from 'axios';
import { friendlyErrorMessage, logError } from '../utils/logger';

import { API_BASE } from './apiBase';

const SAAVN_API_BASE = `${API_BASE}/saavn`;
const HOME_FEED_QUERIES = [
  { title: 'Bollywood Heat', query: 'Bollywood hits 2025' },
  { title: 'Hindi Anthems', query: 'Hindi songs 2025' },
  { title: 'Pop Pulse', query: 'Pop hits 2025' },
  { title: 'Lo-Fi Drift', query: 'lofi chill beats' },
  { title: 'Indie Bloom', query: 'indie songs 2025' },
  { title: 'Romantic Wave', query: 'romantic songs hindi' },
  { title: 'Party Starter Pack', query: 'party songs 2025' },
  { title: 'Retro Rewind', query: '90s hits throwback' },
];

const decodeHtml = (value) =>
  String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

const pickBestImage = (images = []) => {
  const valid = (Array.isArray(images) ? images : []).filter((img) => img?.url);
  if (!valid.length) return '';

  const preferred =
    valid.find((img) => img.quality === '500x500') ||
    [...valid].sort((a, b) => {
      const score = (item) => {
        const match = String(item.quality || '').match(/(\d+)x(\d+)/);
        return match ? Number(match[1]) * Number(match[2]) : 0;
      };
      return score(b) - score(a);
    })[0];

  return preferred?.url || '';
};

const dedupeTracks = (tracks = []) => {
  const seen = new Set();
  const output = [];

  for (const track of tracks) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    output.push(track);
  }

  return output;
};

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

    return {
      id: saavnSong.id,
      title: decodeHtml(saavnSong.name) || 'Unknown Title',
      artist: decodeHtml(saavnSong.primaryArtists || saavnSong.singers) || 'Unknown Artist',
      album: decodeHtml(saavnSong.album?.name) || '',
      coverArt: pickBestImage(saavnSong.image || []),
      streamUrl: highestQuality,
      duration: parseInt(saavnSong.duration, 10) || 0,
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

  getSongSuggestionsSafe: async (songId) => {
    const result = await requestSaavn(
      'saavn.getSongSuggestions',
      `/songs/${songId}/suggestions`,
      { params: { limit: 15 }, timeout: 8000 },
      'Song suggestions are unavailable.'
    );

    if (!result.ok) {
      return { ok: false, data: [], error: result.error };
    }

    return {
      ok: true,
      data: (result.response?.data?.data || []).map(saavnApi.formatTrack),
      error: null,
    };
  },

  getHomeFeedSafe: async () => {
    const rows = await Promise.all(
      HOME_FEED_QUERIES.map(async ({ title, query }) => {
        const result = await saavnApi.searchSongsSafe(query, 12);
        const tracks = dedupeTracks((result.data || []).map(saavnApi.formatTrack).filter((track) => track?.streamUrl)).slice(0, 10);

        return {
          title,
          query,
          tracks,
        };
      })
    );

    const sections = rows.filter((row) => row.tracks.length > 0).map((row) => ({
      title: row.title,
      query: row.query,
      tracks: row.tracks,
      filterYoutubeOnly: false,
    }));

    const featured = dedupeTracks(sections.flatMap((section) => section.tracks)).slice(0, 18);

    return {
      ok: true,
      data: {
        featured,
        sections,
      },
      error: null,
    };
  },
};
