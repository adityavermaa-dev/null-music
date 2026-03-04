// ═══════════════════════════════════════════════════════════
// YouTube Music API — powered by youtubei.js backend
// Calls the local Express server via Vite proxy (/api/yt)
// ═══════════════════════════════════════════════════════════

import axios from 'axios';

// In dev, Vite proxies /api/yt → localhost:3001
// In production, Nginx routes /music/api/yt → server.mjs
const YT_API_BASE = '/api/yt';

export const youtubeApi = {

    searchSongs: async (query, limit = 10) => {
        try {
            const response = await axios.get(`${YT_API_BASE}/search`, {
                params: { query, limit },
                timeout: 15000
            });
            const results = response.data?.results || [];
            return results.map(youtubeApi.formatTrack);
        } catch (error) {
            console.error('[YouTube] Search error:', error.message);
            return [];
        }
    },

    // Get stream URL — uses the server-side pipe endpoint
    getStreamDetails: async (videoId) => {
        // The server pipes audio directly, so we just return the URL
        return {
            videoId,
            streamUrl: `${YT_API_BASE}/pipe/${videoId}`,
        };
    },

    // Search suggestions
    getSearchSuggestions: async (query) => {
        try {
            const response = await axios.get(`${YT_API_BASE}/suggestions`, {
                params: { query },
                timeout: 5000
            });
            return response.data?.suggestions || [];
        } catch (error) {
            console.error('[YouTube] Suggestions error:', error.message);
            return [];
        }
    },

    // Format a YouTube Music result to our app's standard track object
    formatTrack: (ytSong) => ({
        id: `yt-${ytSong.id}`,
        videoId: ytSong.id,
        title: ytSong.title || 'Unknown',
        artist: ytSong.artist || ytSong.artists?.map(a => a.name).join(', ') || 'YouTube Artist',
        album: ytSong.album || 'YouTube Music',
        coverArt: ytSong.thumbnail || ytSong.thumbnails?.[0]?.url || '',
        streamUrl: `${YT_API_BASE}/pipe/${ytSong.id}`,
        duration: ytSong.duration || 0,
        source: 'youtube'
    })
};
