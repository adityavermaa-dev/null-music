// ═══════════════════════════════════════════════════════════
// YouTube Music API — powered by youtubei.js backend
// Calls the local Express server via Vite proxy (/api/yt)
// ═══════════════════════════════════════════════════════════

import axios from 'axios';

const YT_API_BASE = 'https://music-player-4mnv.onrender.com';

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

    // Get stream details (audio URL) for a video ID
    getStreamDetails: async (videoId) => {
        try {
            const response = await axios.get(`${YT_API_BASE}/stream/${videoId}`, {
                timeout: 15000
            });
            const data = response.data;
            if (!data?.streamUrl) return null;

            // Proxy the googlevideo.com URL through our server to avoid CORS
            const proxiedUrl = `${YT_API_BASE}/proxy-stream?url=${encodeURIComponent(data.streamUrl)}`;

            return {
                ...data,
                streamUrl: proxiedUrl,
                originalStreamUrl: data.streamUrl
            };
        } catch (error) {
            console.error('[YouTube] Stream error:', error.message);
            return null;
        }
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
        streamUrl: null,  // Fetched on-demand when played
        duration: ytSong.duration || 0,
        source: 'youtube'
    })
};
