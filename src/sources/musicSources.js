import { resolveYtdlpEndpointStream } from './ytdlpSource.js';
import { resolvePipedStream } from './pipedSource.js';
import { saavnApi } from '../api/saavn.js';
import { pickBestTrackMatch } from '../../shared/trackMatch.js';

const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeVideoId(track) {
  const raw = track?.videoId || track?.id || '';
  return String(raw).replace(/^yt-/, '').trim();
}

function isPreviewLength(track, streamUrl = '') {
  const duration = Number(track?.duration || 0);
  if (duration > 0 && duration <= 35) return true;

  const url = String(streamUrl || '').toLowerCase();
  return url.includes('preview') || url.includes('sample') || url.includes('30sec');
}

async function resolveSaavnFallbackTrack(track) {
  if (!saavnApi) return null;

  const query = `${String(track?.title || '').trim()} ${String(track?.artist || '').trim()} ${String(track?.album || '').trim()}`.trim();
  if (!query) return null;

  const result = await saavnApi.searchSongsSafe(query, 12);
  if (!result?.data?.length) return null;

  const candidates = result.data
    .map((song) => saavnApi.formatTrack(song))
    .filter((song) => song?.streamUrl && Number(song?.duration || 0) > 35);

  const confident = pickBestTrackMatch(candidates, track, {
    getTitle: (item) => item?.title,
    getArtist: (item) => item?.artist,
  });

  return confident?.candidate || null;
}

export function createMusicSources({
  youtubeApi,
  jamendoApi,
  soundcloudApi,
  pipedResolver = resolvePipedStream,
  ytdlpResolver = resolveYtdlpEndpointStream,
  monochromeResolver,
}) {
  const streamCache = new Map();

  function getCachedStream(videoId) {
    const cached = streamCache.get(videoId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      streamCache.delete(videoId);
      return null;
    }
    return {
      streamUrl: cached.streamUrl,
      streamSource: cached.streamSource,
      verified: true,
      cacheState: 'memory',
    };
  }

  function setCachedStream(videoId, resolved) {
    if (!videoId || !resolved?.streamUrl) return;
    streamCache.set(videoId, {
      streamUrl: resolved.streamUrl,
      streamSource: resolved.streamSource || 'unknown',
      expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
    });

    if (streamCache.size > 400) {
      const oldestKey = streamCache.keys().next().value;
      if (oldestKey) streamCache.delete(oldestKey);
    }
  }

  async function resolveYoutubePrimary(videoId, track) {
    if (!monochromeResolver) return null;

    const monochromePromise = monochromeResolver(videoId, {
      title: track?.title,
      artist: track?.artist,
    });
    const timeoutMs = Math.max(900, Number(track?.monochromeTimeoutMs || 1400));
    const race = await Promise.race([
      monochromePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    const mustPreferSaavn =
      !race?.streamUrl ||
      isPreviewLength(track, race?.streamUrl) ||
      race?.resolutionMode === 'search-fallback';

    if (mustPreferSaavn) {
      const saavnResolved = await resolveSaavnFallbackTrack(track);
      if (saavnResolved?.streamUrl) {
        const nextResolved = {
          ...saavnResolved,
          streamSource: saavnResolved.streamSource || 'saavn',
        };
        setCachedStream(videoId, nextResolved);
        return nextResolved;
      }
    }

    if (race?.streamUrl && !isPreviewLength(track, race.streamUrl)) {
      const nextResolved = {
        ...race,
        streamSource: race.streamSource || 'monochrome',
      };
      setCachedStream(videoId, nextResolved);
      return nextResolved;
    }

    if (race?.streamUrl) {
      const nextResolved = {
        ...race,
        streamSource: race.streamSource || 'monochrome',
      };
      setCachedStream(videoId, nextResolved);
      return nextResolved;
    }

    return null;
  }

  async function resolveYoutubeFallback(videoId, track) {
    if (!pipedResolver) return null;

    const resolved = await pipedResolver(videoId, {
      title: track?.title,
      artist: track?.artist,
    });

    if (!resolved?.streamUrl) return null;

    const nextResolved = {
      ...resolved,
      streamSource: resolved.streamSource || 'piped',
    };
    setCachedStream(videoId, nextResolved);
    return nextResolved;
  }

  async function resolveYoutubeBackup(videoId, track) {
    if (!ytdlpResolver) return null;

    const resolved = await ytdlpResolver(videoId, {
      title: track?.title,
      artist: track?.artist,
    });

    if (!resolved?.streamUrl) return null;

    const nextResolved = {
      ...resolved,
      streamSource: resolved.streamSource || 'yt-dlp',
    };
    setCachedStream(videoId, nextResolved);
    return nextResolved;
  }

  const youtubeSource = {
    id: 'youtube',
    async search(query, limit = 20) {
      return youtubeApi.searchSongsSafe(query, limit);
    },
    async getStreamUrl(track) {
      const videoId = normalizeVideoId(track);
      if (!videoId) return null;

      const cached = getCachedStream(videoId);
      if (cached?.streamUrl) {
        return cached;
      }

      const resolvedPrimary = await resolveYoutubePrimary(videoId, track);
      if (resolvedPrimary?.streamUrl) {
        return resolvedPrimary;
      }

      const resolvedFallback = await resolveYoutubeFallback(videoId, track);
      if (resolvedFallback?.streamUrl) {
        return resolvedFallback;
      }

      const resolvedBackup = await resolveYoutubeBackup(videoId, track);
      if (resolvedBackup?.streamUrl) {
        return resolvedBackup;
      }

      return null;
    },
  };

  const monochromeSource = {
    id: 'monochrome',
    async search() {
      return { ok: true, data: [], error: null };
    },
    async getStreamUrl(track) {
      const videoId = normalizeVideoId(track);
      if (!videoId) return null;
      if (!monochromeResolver) return null;
      return monochromeResolver(videoId, {
        title: track?.title,
        artist: track?.artist,
      });
    },
  };

  const jamendoSource = {
    id: 'jamendo',
    async search(query, limit = 20) {
      if (!jamendoApi) return { ok: false, data: [], error: 'Jamendo is unavailable.' };
      return jamendoApi.searchSongsSafe(query, limit);
    },
    async getStreamUrl(track) {
      if (!jamendoApi) return null;

      const resolved = await jamendoApi.resolveStreamSafe({
        url: track?.streamUrl || track?.url,
        title: track?.title,
        artist: track?.artist,
        trackId: track?.originalId || normalizeVideoId(track),
      });

      if (!resolved.ok || !resolved.data?.streamUrl) return null;

      return {
        streamUrl: resolved.data.streamUrl,
        streamSource: resolved.data.streamSource || 'jamendo',
        verified: true,
      };
    },
  };

  const soundcloudSource = {
    id: 'soundcloud',
    async search(query, limit = 20) {
      if (!soundcloudApi) return { ok: false, data: [], error: 'SoundCloud is unavailable.' };
      return soundcloudApi.searchSongsSafe(query, limit);
    },
    async getStreamUrl(track) {
      if (!soundcloudApi) return null;

      const resolved = await soundcloudApi.resolveStreamSafe({
        trackId: track?.originalId || String(track?.id || '').replace(/^sc-/, ''),
        transcodings: Array.isArray(track?.transcodings) ? track.transcodings : [],
      });

      if (!resolved.ok || !resolved.data?.streamUrl) return null;

      return {
        streamUrl: resolved.data.streamUrl,
        streamSource: resolved.data.streamSource || 'soundcloud',
        verified: true,
      };
    },
  };

  return {
    youtube: youtubeSource,
    monochrome: monochromeSource,
    jamendo: jamendoSource,
    soundcloud: soundcloudSource,
  };
}
