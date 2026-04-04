/* eslint-disable react-refresh/only-export-components */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef
} from "react";

import { Capacitor } from '@capacitor/core';

import { nativeMediaApi } from "../api/nativeMedia";
import { youtubeApi } from "../api/youtube";
import { jamendoApi } from "../api/jamendo";
import { recommendationsApi } from "../api/recommendations";
import { getOrCreateUserId } from "../utils/userId";
import { createMusicSources } from "../sources/musicSources";

import {
  buildPlaybackSession,
  cycleSleepTimerValue,
  getPreviousQueueIndex,
  parseStoredSession,
  serializeSession
} from "../utils/playerState";
import { MusicPlayer } from "../native/musicPlayer";
const PlayerContext = createContext();

/** Extract dominant color from an Image element using Canvas. */
function getColor(img) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const w = Math.min(img.naturalWidth || img.width, 50);
  const h = Math.min(img.naturalHeight || img.height, 50);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] < 128) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return [0, 0, 0];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

const FALLBACK_COVER =
  "https://placehold.co/500x500/27272a/71717a?text=%E2%99%AA";
const YOUTUBE_CACHE_PATH = "/api/yt/cache/";
const CACHE_PROMOTION_RECHECK_MS = 12_000;
const STREAM_URL_REUSE_MS = 30 * 60 * 1000;
const MAX_RELIABILITY_EVENTS = 18;
const PLAYBACK_ERROR_RECOVERY_DELAY_MS = 350;
const PLAYER_SESSION_STORAGE_KEY = "aura-player-session";
const AUTO_RADIO_STORAGE_KEY = "aura-auto-radio";
const PLAYBACK_PROFILE_STORAGE_KEY = "aura-playback-profile";
const OFFLINE_ONLY_STORAGE_KEY = "aura-offline-only";
const RESUME_STORAGE_KEY = "aura-resume-state";
const RECO_NOISE_TOKENS = new Set([
  'song',
  'songs',
  'music',
  'official',
  'video',
  'lyric',
  'lyrics',
  'audio',
  'full',
  'hd',
  'hq',
  'feat',
  'ft',
  'remix',
  'version',
  'new',
]);

function normalizePlaybackProfile(value) {
  return value === "data-saver" || value === "instant" ? value : "balanced";
}

function readStoredJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeResumeState(value) {
  if (!value || typeof value !== "object") return null;
  const track = value.track && typeof value.track === "object" ? value.track : null;
  const queue = Array.isArray(value.queue) ? value.queue.filter(Boolean) : [];
  const queueIndex = Number.isInteger(value.queueIndex) ? value.queueIndex : -1;
  const position = Number(value.position || 0);
  if (!track?.id) return null;
  return {
    track,
    queue,
    queueIndex,
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    capturedAt: Number(value.capturedAt || Date.now()),
  };
}

function isYoutubeCacheUrl(url = "") {
  return typeof url === "string" && url.includes(YOUTUBE_CACHE_PATH);
}

function isYoutubeTrack(track) {
  if (!track) return false;
  if (track.source === 'youtube') return true;
  if (typeof track.videoId === 'string' && track.videoId.trim()) return true;
  if (typeof track.id === 'string' && /^yt-/.test(track.id)) return true;
  return false;
}

function normalizeRecoText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeRecoText(value) {
  return normalizeRecoText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !RECO_NOISE_TOKENS.has(token));
}

function detectScriptBucket(value) {
  const text = String(value || '');
  if (/[\u0900-\u097F]/.test(text)) return 'devanagari';
  if (/[A-Za-z]/.test(text)) return 'latin';
  return 'other';
}

function hasWordOverlap(seedText, candidateText) {
  const seedTokens = tokenizeRecoText(seedText);
  if (!seedTokens.length) return false;
  const candidateTokenSet = new Set(tokenizeRecoText(candidateText));
  return seedTokens.some((token) => candidateTokenSet.has(token));
}

function shouldRejectCandidate(seedTrack, candidate) {
  const candidateArtist = String(candidate?.artist || '').trim().toLowerCase();
  if (!candidateArtist || candidateArtist === 'unknown artist') return true;

  const seedComposite = `${seedTrack?.title || ''} ${seedTrack?.artist || ''}`;
  const candidateComposite = `${candidate?.title || ''} ${candidate?.artist || ''}`;

  const seedScript = detectScriptBucket(seedComposite);
  const candidateScript = detectScriptBucket(candidateComposite);
  if (seedScript !== 'other' && candidateScript !== 'other' && seedScript !== candidateScript) {
    return true;
  }

  const seedHasDjContext = /\b(remix|dj|mashup|non stop)\b/i.test(seedComposite);
  const candidateHasDjContext = /\b(remix|dj|mashup|non stop)\b/i.test(candidateComposite);
  if (candidateHasDjContext && !seedHasDjContext) return true;

  return false;
}

function scoreRecommendation(seedTrack, candidate) {
  const seedTitleTokens = tokenizeRecoText(seedTrack?.title || '');
  const seedArtistTokens = tokenizeRecoText(seedTrack?.artist || '');
  const seedAlbumTokens = tokenizeRecoText(seedTrack?.album || '');
  const seedTokens = new Set([...seedTitleTokens, ...seedArtistTokens, ...seedAlbumTokens]);

  const titleTokens = tokenizeRecoText(candidate?.title || '');
  const artistTokens = tokenizeRecoText(candidate?.artist || '');
  const albumTokens = tokenizeRecoText(candidate?.album || '');
  const candidateTokens = [...titleTokens, ...artistTokens, ...albumTokens];

  let overlap = 0;
  for (const token of candidateTokens) {
    if (seedTokens.has(token)) overlap += 1;
  }

  const overlapScore = seedTokens.size ? overlap / seedTokens.size : 0;
  const artistOverlap = seedArtistTokens.length
    ? seedArtistTokens.filter((token) => artistTokens.includes(token)).length / seedArtistTokens.length
    : 0;

  const seedScript = detectScriptBucket(`${seedTrack?.title || ''} ${seedTrack?.artist || ''}`);
  const candidateScript = detectScriptBucket(`${candidate?.title || ''} ${candidate?.artist || ''}`);
  const scriptBonus = seedScript !== 'other' && seedScript === candidateScript ? 0.18 : 0;
  const scriptPenalty = seedScript !== 'other' && candidateScript !== 'other' && seedScript !== candidateScript
    ? -0.2
    : 0;

  return (overlapScore * 0.72) + (artistOverlap * 0.28) + scriptBonus + scriptPenalty;
}

function rankRecommendationCandidates(seedTrack, candidates, options = {}) {
  const { minScore = 0.3, minimumCount = 5, maxCount = 20 } = options;
  const youtubeOnly = (Array.isArray(candidates) ? candidates : [])
    .filter(isYoutubeTrack)
    .filter((track) => !shouldRejectCandidate(seedTrack, track));
  const ranked = youtubeOnly
    .map((track) => ({ track, score: scoreRecommendation(seedTrack, track) }))
    .sort((a, b) => b.score - a.score);

  const relevant = ranked.filter((item) => {
    if (item.score < minScore) return false;
    const titleOverlap = hasWordOverlap(seedTrack?.title || '', item.track?.title || '');
    const artistOverlap = hasWordOverlap(seedTrack?.artist || '', item.track?.artist || '');
    return titleOverlap || artistOverlap;
  });

  const picked = (relevant.length > 0 ? relevant : ranked.slice(0, minimumCount)).slice(0, maxCount);
  return picked.map((item) => item.track);
}

function buildSimilarityQueries(seedTrack) {
  const title = String(seedTrack?.title || '').trim();
  const artist = String(seedTrack?.artist || '').trim();
  const album = String(seedTrack?.album || '').trim();
  const queries = new Set();

  if (title && artist) queries.add(`${title} ${artist}`.trim());
  if (title && album) queries.add(`${title} ${album}`.trim());
  if (title) queries.add(`${title} soundtrack`);
  if (title) queries.add(`${title} hindi`);

  return [...queries].filter(Boolean);
}

export const usePlayer = () => useContext(PlayerContext);

export const PlayerProvider = ({ children }) => {

  const musicSources = useRef(createMusicSources({ youtubeApi, jamendoApi })).current;

  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMode, setQueueMode] = useState("list");

  const [shuffleMode, setShuffleMode] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off");

  const [isLoading, setIsLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState(null);
  const [dominantColor, setDominantColor] = useState("rgba(15,15,19,1)");

  const [autoRadioEnabled, setAutoRadioEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem(AUTO_RADIO_STORAGE_KEY);
      return stored == null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const [playbackProfile, setPlaybackProfileState] = useState(() => {
    try {
      return normalizePlaybackProfile(localStorage.getItem(PLAYBACK_PROFILE_STORAGE_KEY));
    } catch {
      return "balanced";
    }
  });
  const [offlineOnlyMode, setOfflineOnlyModeState] = useState(() => {
    try {
      return localStorage.getItem(OFFLINE_ONLY_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState(null);
  const [volume, setVolumeState] = useState(0.8);
  const [resumeState, setResumeState] = useState(() => normalizeResumeState(readStoredJson(RESUME_STORAGE_KEY, null)));
  const [equalizerState, setEqualizerState] = useState({
    available: false,
    enabled: false,
    currentPreset: 0,
    presets: [],
    message: "Equalizer is available in the Android app."
  });
  const [reliabilityDebug, setReliabilityDebug] = useState({
    lastResolved: null,
    lastPlayback: null,
    lastFallback: null,
    events: [],
  });

  const sleepTimerRef = useRef(null);
  const skipNextRef = useRef(null);
  const skipPrevRef = useRef(null);
  const playTrackRef = useRef(null);
  const queueModeRef = useRef(queueMode);
  const autoRadioEnabledRef = useRef(autoRadioEnabled);
  const isLoadingRef = useRef(isLoading);
  const isPlayingRef = useRef(isPlaying);

  const playedIdsRef = useRef(new Set());
  const isFetchingRecsRef = useRef(false);
  const pendingRecsRef = useRef([]);
  const currentTrackRef = useRef(null);
  const repeatModeRef = useRef(repeatMode);
  const loadAndPlayRef = useRef(null);
  const queueRef = useRef(queue);
  const queueIndexRef = useRef(queueIndex);
  const playSeqRef = useRef(0);
  const nativeQueueSyncSeqRef = useRef(0);
  const resolvedTrackMapRef = useRef(new Map());
  const resumeSeekRef = useRef(null);

  /* ── Gapless playback: pre-resolve next track URL ── */
  const preResolvedRef = useRef({ trackId: null, resolvedTrack: null, resolving: false });
  const preloadAudioRef = useRef(null);

  const recordReliabilityEvent = useCallback((kind, payload = {}) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      at: Date.now(),
      ...payload,
    };

    setReliabilityDebug((prev) => ({
      lastResolved: kind === 'resolved' ? entry : prev.lastResolved,
      lastPlayback: kind === 'playing' || kind === 'error' ? entry : prev.lastPlayback,
      lastFallback: kind === 'fallback' ? entry : prev.lastFallback,
      events: [entry, ...(prev.events || [])].slice(0, MAX_RELIABILITY_EVENTS),
    }));
  }, []);

  const clearReliabilityEvents = useCallback(() => {
    setReliabilityDebug((prev) => ({
      ...prev,
      events: [],
    }));
  }, []);

  const clearPlaybackRecovery = useCallback(() => {}, []);

  const mergeResolvedTrack = useCallback((baseTrack, patch = {}) => ({
    ...baseTrack,
    ...patch,
    title: patch.title || baseTrack?.title || "Unknown",
    artist: patch.artist || baseTrack?.artist || "Unknown",
    coverArt: patch.coverArt || baseTrack?.coverArt || FALLBACK_COVER,
    streamUrl: patch.streamUrl || baseTrack?.streamUrl || null,
    streamSource: patch.streamSource || baseTrack?.streamSource || null,
    cacheState: patch.cacheState || baseTrack?.cacheState || null,
    cacheCheckedAt: patch.cacheCheckedAt || baseTrack?.cacheCheckedAt || 0,
    streamResolvedAt: patch.streamResolvedAt || baseTrack?.streamResolvedAt || 0,
  }), []);

  const getResolvedTrackFromCache = useCallback((track) => {
    if (!track?.id) return track;
    const cachedTrack = resolvedTrackMapRef.current.get(track.id);
    return cachedTrack ? mergeResolvedTrack(track, cachedTrack) : track;
  }, [mergeResolvedTrack]);

  const persistResolvedTrack = useCallback((resolvedTrack) => {
    if (!resolvedTrack?.id) return;

    const mergedResolved = mergeResolvedTrack(resolvedTrack, resolvedTrack);
    resolvedTrackMapRef.current.set(resolvedTrack.id, mergedResolved);
    if (resolvedTrackMapRef.current.size > 250) {
      const oldestKey = resolvedTrackMapRef.current.keys().next().value;
      if (oldestKey) {
        resolvedTrackMapRef.current.delete(oldestKey);
      }
    }

    setQueue((prev) => {
      let changed = false;

      const next = prev.map((item) => {
        if (item.id !== resolvedTrack.id) return item;

        const merged = mergeResolvedTrack(item, resolvedTrack);
        if (
          item.streamUrl === merged.streamUrl &&
          item.title === merged.title &&
          item.artist === merged.artist &&
          item.coverArt === merged.coverArt
        ) {
          return item;
        }

        changed = true;
        return merged;
      });

      return changed ? next : prev;
    });

    setCurrentTrack((prev) => {
      if (!prev || prev.id !== resolvedTrack.id) return prev;

      const merged = mergeResolvedTrack(prev, resolvedTrack);
      if (
        prev.streamUrl === merged.streamUrl &&
        prev.title === merged.title &&
        prev.artist === merged.artist &&
        prev.coverArt === merged.coverArt
      ) {
        return prev;
      }

      currentTrackRef.current = merged;
      return merged;
    });
  }, [mergeResolvedTrack]);

  /* -------------------------- PLAY TRACK -------------------------- */

  const resolvePlayableTrack = useCallback(async (track, options = {}) => {
    const { forceRefresh = false, record = true, reason = 'playback' } = options;
    if (!track) throw new Error("Track is required");

    track = getResolvedTrackFromCache(track);
    const currentUrl = typeof track.streamUrl === "string" ? track.streamUrl.trim() : "";
    const isLocalFile = currentUrl.startsWith("file:");

    if (offlineOnlyMode && track.source !== "downloaded" && !isLocalFile) {
      throw new Error("Offline-only mode is enabled.");
    }

    const isNative = Capacitor.isNativePlatform();
    const existingUrl = currentUrl;
    const isPipeUrl = existingUrl.includes("/api/yt/pipe/");
    const isCacheUrl = isYoutubeCacheUrl(existingUrl);
    const lastCacheCheck = Number(track.cacheCheckedAt || 0);
    const lastResolvedAt = Number(track.streamResolvedAt || track.cacheCheckedAt || 0);
    const recentlyResolved = Date.now() - lastResolvedAt < STREAM_URL_REUSE_MS;

    if (!forceRefresh && existingUrl) {
      const shouldReuseExisting =
        track.source !== "youtube" ||
        !isNative ||
        isCacheUrl ||
        (!isPipeUrl && recentlyResolved);

      if (shouldReuseExisting) {
        return mergeResolvedTrack(track, {
          streamUrl: existingUrl,
          streamResolvedAt: lastResolvedAt || Date.now(),
        });
      }
    }

    if (!forceRefresh && preResolvedRef.current.trackId === track.id && preResolvedRef.current.resolvedTrack) {
      return mergeResolvedTrack(track, preResolvedRef.current.resolvedTrack);
    }

    if (track.source !== "youtube") {
      if (track.source === 'jamendo') {
        const resolvedJamendo = await musicSources.jamendo.getStreamUrl(track);
        const streamUrl = resolvedJamendo?.streamUrl || existingUrl;
        if (!streamUrl) throw new Error('Jamendo stream unavailable');

        const resolved = mergeResolvedTrack(track, {
          streamUrl,
          streamSource: resolvedJamendo?.streamSource || track.streamSource || 'jamendo',
          streamResolvedAt: Date.now(),
        });
        if (record) {
          recordReliabilityEvent('resolved', {
            trackId: track.id,
            title: track.title,
            streamSource: resolved.streamSource || 'jamendo',
            cacheState: null,
            reason,
            refreshed: forceRefresh,
            urlKind: 'remote',
          });
        }
        return resolved;
      }

      if (!existingUrl) throw new Error("Stream unavailable");
      const resolved = mergeResolvedTrack(track, {
        streamUrl: existingUrl,
        streamSource: track.streamSource || track.source || 'direct',
        streamResolvedAt: Date.now(),
      });
      if (record) {
        recordReliabilityEvent('resolved', {
          trackId: track.id,
          title: track.title,
          streamSource: resolved.streamSource || 'direct',
          cacheState: resolved.cacheState || (track.source === 'downloaded' ? 'offline' : null),
          reason,
          refreshed: forceRefresh,
          urlKind: resolved.streamUrl?.startsWith('file:') ? 'local-file' : 'direct',
        });
      }
      return resolved;
    }

    const details = await musicSources.youtube.getStreamUrl(track, {
      preferDirect: isNative,
    });

    const streamUrl = details?.streamUrl || existingUrl || null;
    if (!streamUrl) throw new Error("Stream unavailable");
    const resolved = mergeResolvedTrack(track, {
      streamUrl,
      streamSource: details?.streamSource || (isYoutubeCacheUrl(streamUrl) ? "disk-cache" : "unknown"),
      cacheState: details?.cacheState || (isYoutubeCacheUrl(streamUrl) ? "disk" : null),
      cacheCheckedAt: isNative ? Date.now() : lastCacheCheck,
      streamResolvedAt: Date.now(),
    });
    if (record) {
      const fallbackSources = new Set(['piped', 'ytdl-core', 'jamendo', 'yt-dlp', 'monochrome']);
      recordReliabilityEvent('resolved', {
        trackId: track.id,
        title: track.title,
        streamSource: resolved.streamSource || 'unknown',
        cacheState: resolved.cacheState || null,
        reason,
        refreshed: forceRefresh,
        urlKind: isYoutubeCacheUrl(streamUrl) ? 'disk-cache' : 'remote',
      });
      if (fallbackSources.has(resolved.streamSource)) {
        recordReliabilityEvent('fallback', {
          trackId: track.id,
          title: track.title,
          streamSource: resolved.streamSource,
          message: `Resolved via ${resolved.streamSource} fallback.`,
        });
      }
    }
    return resolved;
  }, [getResolvedTrackFromCache, mergeResolvedTrack, musicSources.jamendo, musicSources.youtube, offlineOnlyMode, recordReliabilityEvent]);

  /** Pre-resolve stream URL for a track (used for gapless preloading). */
  const preResolveStream = useCallback(async (track) => {
    if (!track) return;
    const trackId = track.id;
    if (preResolvedRef.current.trackId === trackId) return; // already resolved/resolving
    preResolvedRef.current = { trackId, resolvedTrack: null, resolving: true };

    try {
      const resolvedTrack = await resolvePlayableTrack(track, { reason: 'preload' });
      if (resolvedTrack?.streamUrl) {
        persistResolvedTrack(resolvedTrack);
        preResolvedRef.current = { trackId, resolvedTrack, resolving: false };
        // Preload audio on web for instant start
        if (!Capacitor.isNativePlatform() && playbackProfile !== "data-saver") {
          try {
            if (preloadAudioRef.current) { preloadAudioRef.current.src = ''; }
            const audio = new Audio();
            audio.preload = 'auto';
            audio.src = resolvedTrack.streamUrl;
            preloadAudioRef.current = audio;
          } catch { /* ignore */ }
        }
      } else {
        preResolvedRef.current = { trackId: null, resolvedTrack: null, resolving: false };
      }
    } catch {
      preResolvedRef.current = { trackId: null, resolvedTrack: null, resolving: false };
    }
  }, [persistResolvedTrack, playbackProfile, resolvePlayableTrack]);

  const loadAndPlay = useCallback(async (track) => {

    if (!track) return;

    const seq = ++playSeqRef.current;

    setIsLoading(true);
    setPlaybackError(null);

    try {
      await MusicPlayer.pause();
    } catch {
      // ignore (web/no plugin)
    }

    if (seq !== playSeqRef.current) return;

    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    recordReliabilityEvent('attempt', {
      trackId: track.id,
      title: track.title,
      message: 'Starting playback attempt.',
    });

    let resolvedTrack = track;

    try {
      if (preResolvedRef.current.trackId === track.id && preResolvedRef.current.resolvedTrack) {
        resolvedTrack = mergeResolvedTrack(track, preResolvedRef.current.resolvedTrack);
        preResolvedRef.current = { trackId: null, resolvedTrack: null, resolving: false };
      } else {
        resolvedTrack = await resolvePlayableTrack(track, { reason: 'playback' });
      }

      if (seq !== playSeqRef.current) return;

      await MusicPlayer.play({
        url: resolvedTrack.streamUrl,
        title: resolvedTrack.title,
        artist: resolvedTrack.artist,
        artwork: resolvedTrack.coverArt || FALLBACK_COVER
      });

      if (seq !== playSeqRef.current) return;

      const pendingResumeSeek = resumeSeekRef.current;
      if (pendingResumeSeek?.trackId === resolvedTrack.id && pendingResumeSeek.position > 0) {
        try {
          await MusicPlayer.seek({ position: pendingResumeSeek.position });
          setProgress(pendingResumeSeek.position);
        } catch {
          // ignore resume seek failures
        } finally {
          resumeSeekRef.current = null;
        }
      }

      persistResolvedTrack(resolvedTrack);
      setCurrentTrack(resolvedTrack);
      currentTrackRef.current = resolvedTrack;
      setIsPlaying(true);
      clearPlaybackRecovery();
      recordReliabilityEvent('playing', {
        trackId: resolvedTrack.id,
        title: resolvedTrack.title,
        streamSource: resolvedTrack.streamSource || resolvedTrack.source || 'unknown',
        cacheState: resolvedTrack.cacheState || null,
        message: 'Playback started successfully.',
      });

      // Track behavior (fire-and-forget)
      try {
        const userId = getOrCreateUserId();
        await recommendationsApi.trackSafe({ userId, song: resolvedTrack, action: 'play' });
      } catch {
        // ignore
      }

    } catch (error) {

      console.error("Playback error", error);
      if (seq !== playSeqRef.current) return;

      // Retry with Saavn once if YouTube playback failed.
      if (track?.source === 'youtube') {
        try {
          const refreshedTrack = await resolvePlayableTrack(track, { forceRefresh: true, reason: 'retry' });
          if (seq !== playSeqRef.current) return;
          if (refreshedTrack?.streamUrl && refreshedTrack.streamUrl !== resolvedTrack?.streamUrl) {
            await MusicPlayer.play({
              url: refreshedTrack.streamUrl,
              title: refreshedTrack.title,
              artist: refreshedTrack.artist,
              artwork: refreshedTrack.coverArt || FALLBACK_COVER
            });
            if (seq !== playSeqRef.current) return;
            persistResolvedTrack(refreshedTrack);
            setCurrentTrack(refreshedTrack);
            currentTrackRef.current = refreshedTrack;
            setIsPlaying(true);
            setPlaybackError(null);
            clearPlaybackRecovery();
            recordReliabilityEvent('fallback', {
              trackId: refreshedTrack.id,
              title: refreshedTrack.title,
              streamSource: refreshedTrack.streamSource || 'unknown',
              message: 'Recovered playback with a refreshed stream URL.',
            });
            recordReliabilityEvent('playing', {
              trackId: refreshedTrack.id,
              title: refreshedTrack.title,
              streamSource: refreshedTrack.streamSource || 'unknown',
              cacheState: refreshedTrack.cacheState || null,
              message: 'Playback recovered after refresh.',
            });
            return;
          }
        } catch {
          // ignore and continue to fallback
        }

      }

      setIsPlaying(false);
      setPlaybackError("Song not available");
      recordReliabilityEvent('error', {
        trackId: track.id,
        title: track.title,
        message: error?.message || 'Song not available',
      });

    } finally {

      if (seq === playSeqRef.current) {
        setIsLoading(false);
      }

    }

  }, [
    clearPlaybackRecovery,
    mergeResolvedTrack,
    persistResolvedTrack,
    recordReliabilityEvent,
    resolvePlayableTrack
  ]);

  /* -------------------------- PLAY SESSION -------------------------- */

  const playTrack = useCallback((track, trackList, options = {}) => {

    if (!track) return;

    clearPlaybackRecovery();
    const hydratedTrack = getResolvedTrackFromCache(track);
    const hydratedTrackList = Array.isArray(trackList)
      ? trackList.map((item) => getResolvedTrackFromCache(item))
      : trackList;

    const session = buildPlaybackSession({
      track: hydratedTrack,
      trackList: hydratedTrackList,
      mode: options.mode
    });

    queueModeRef.current = session.queueMode;
    queueRef.current = session.queue;
    queueIndexRef.current = session.queueIndex;
    currentTrackRef.current = hydratedTrack;
    setQueueMode(session.queueMode);
    setQueue(session.queue);
    setQueueIndex(session.queueIndex);

    pendingRecsRef.current = [];

    loadAndPlay(hydratedTrack);

  }, [clearPlaybackRecovery, getResolvedTrackFromCache, loadAndPlay]);

  /* -------------------------- TOGGLE PLAY -------------------------- */

  const togglePlay = useCallback(async () => {

    if (!currentTrack) return;
    if (isLoading) return;

    if (isPlaying) {

      await MusicPlayer.pause();
      setIsPlaying(false);

    } else {

      await MusicPlayer.resume();
      setIsPlaying(true);

    }

  }, [isPlaying, currentTrack, isLoading]);

  /* -------------------------- FETCH RECOMMENDATIONS (INFINITE AUTOPLAY) -------------------------- */

  const fetchRecommendations = useCallback(async (seedTrack) => {
    if (!seedTrack || isFetchingRecsRef.current) return [];
    isFetchingRecsRef.current = true;

    try {
      const results = [];
      const currentQueue = queueRef.current;
      const queueIds = new Set(currentQueue.map((track) => track.id));

      // Strategy 1: YouTube Music "Up Next" (highest-quality autoplay)
      const videoId = seedTrack.videoId || (seedTrack.source === 'youtube' ? seedTrack.id.replace(/^yt-/, '') : null);
      if (videoId) {
        try {
          const upNext = await youtubeApi.getUpNextSafe(videoId);
          if (upNext.ok) results.push(...upNext.data);
        } catch {
          // ignore
        }
      }

      // Strategy 2: YouTube expansion by track metadata (closer to "similar songs").
      if (results.length < 16) {
        try {
          const queries = buildSimilarityQueries(seedTrack);
          for (const q of queries) {
            const similarRes = await youtubeApi.searchSongsSafe(q, 8);
            if (similarRes.ok) results.push(...similarRes.data);
            if (results.length >= 24) break;
          }
        } catch {
          // ignore
        }
      }

      // Deduplicate and filter out already played/queued tracks
      const seen = new Set();

      const filtered = results.filter(track => {
        if (!track?.id) return false;
        if (seen.has(track.id)) return false;
        if (queueIds.has(track.id)) return false;
        if (playedIdsRef.current.has(track.id)) return false;
        if (seedTrack?.id && track.id === seedTrack.id) return false;
        seen.add(track.id);
        return true;
      });

      return rankRecommendationCandidates(seedTrack, filtered, {
        minScore: 0.3,
        minimumCount: 6,
        maxCount: 20,
      });
    } catch (error) {
      console.error('Recommendation fetch failed:', error);
      return [];
    } finally {
      isFetchingRecsRef.current = false;
    }
  }, []);

  /* -------------------------- NEXT TRACK -------------------------- */

  const skipNext = useCallback(async () => {

    if (!queue.length) return;

    let nextIndex;

    if (shuffleMode) {
      if (queue.length <= 1) {
        nextIndex = 0;
      } else {
        do {
          nextIndex = Math.floor(Math.random() * queue.length);
        } while (nextIndex === queueIndex && queue.length > 1);
      }
      queueIndexRef.current = nextIndex;
      setQueueIndex(nextIndex);
      loadAndPlay(queue[nextIndex]);
      return;
    }

    nextIndex = queueIndex + 1;

    if (nextIndex < queue.length) {
      queueIndexRef.current = nextIndex;
      setQueueIndex(nextIndex);
      loadAndPlay(queue[nextIndex]);
      return;
    }

    // End of queue — autoplay with recommendations
    if (autoRadioEnabledRef.current) {
      try {
        const recs = pendingRecsRef.current.length > 0
          ? pendingRecsRef.current.splice(0)
          : await fetchRecommendations(currentTrack);

        if (recs.length > 0) {
          const newQueue = [...queue, ...recs];
          queueRef.current = newQueue;
          queueIndexRef.current = queue.length;
          setQueue(newQueue);
          setQueueIndex(queue.length);
          loadAndPlay(recs[0]);
          return;
        }
      } catch {
        // ignore
      }
    }

    // Repeat all wraps around
    if (repeatMode === 'all' && queue.length > 0) {
      queueIndexRef.current = 0;
      setQueueIndex(0);
      loadAndPlay(queue[0]);
      return;
    }

  }, [queue, queueIndex, shuffleMode, repeatMode, loadAndPlay, currentTrack, fetchRecommendations]);

  /* -------------------------- PREVIOUS -------------------------- */

  const skipPrev = useCallback(async () => {

    if (!queue.length) return;

    const prevIndex = getPreviousQueueIndex({
      queueIndex,
      queueLength: queue.length,
      queueMode,
      repeatMode
    });

    if (prevIndex == null) return;

    queueIndexRef.current = prevIndex;
    setQueueIndex(prevIndex);
    loadAndPlay(queue[prevIndex]);

  }, [queue, queueIndex, queueMode, repeatMode, loadAndPlay]);

  /* -------------------------- SEEK -------------------------- */

  const seekTo = useCallback(async (time) => {

    await MusicPlayer.seek({ position: time });
    setProgress(time);

  }, []);

  /* -------------------------- SHUFFLE -------------------------- */

  const toggleShuffle = useCallback(() => {

    setShuffleMode(v => !v);

  }, []);

  /* -------------------------- REPEAT -------------------------- */

  const cycleRepeat = useCallback(() => {

    setRepeatMode(v =>
      v === "off" ? "all" : v === "all" ? "one" : "off"
    );

  }, []);

  /* -------------------------- VOLUME CONTROL -------------------------- */

  const setVolume = useCallback(async (vol) => {
    const normalizedVol = Math.max(0, Math.min(1, vol));
    setVolumeState(normalizedVol);
    // Future: add native volume control when available
  }, []);

  const refreshEqualizerState = useCallback(async () => {
    try {
      const next = await nativeMediaApi.getEqualizerState();
      setEqualizerState({
        available: Boolean(next?.available),
        enabled: Boolean(next?.enabled),
        currentPreset: Number(next?.currentPreset || 0),
        presets: Array.isArray(next?.presets) ? next.presets : [],
        message: next?.message || "Start playback on Android to use the equalizer.",
      });
    } catch {
      setEqualizerState((prev) => ({
        ...prev,
        available: false,
        message: "Equalizer is currently unavailable.",
      }));
    }
  }, []);

  const setEqualizerEnabled = useCallback(async (enabled) => {
    const next = await nativeMediaApi.setEqualizerEnabled(Boolean(enabled));
    setEqualizerState({
      available: Boolean(next?.available),
      enabled: Boolean(next?.enabled),
      currentPreset: Number(next?.currentPreset || 0),
      presets: Array.isArray(next?.presets) ? next.presets : [],
      message: next?.message || "Start playback on Android to use the equalizer.",
    });
  }, []);

  const setEqualizerPreset = useCallback(async (preset) => {
    const next = await nativeMediaApi.setEqualizerPreset(Number(preset));
    setEqualizerState({
      available: Boolean(next?.available),
      enabled: Boolean(next?.enabled),
      currentPreset: Number(next?.currentPreset || 0),
      presets: Array.isArray(next?.presets) ? next.presets : [],
      message: next?.message || "Start playback on Android to use the equalizer.",
    });
  }, []);

  /* -------------------------- RECOMMENDATIONS FOR DISCOVER -------------------------- */

  const getRecommendationsFor = useCallback(async (seedTrack) => {
    if (!seedTrack) return [];

    try {
      const results = [];

      const videoId = seedTrack.videoId || (seedTrack.source === 'youtube' ? seedTrack.id.replace(/^yt-/, '') : null);
      if (videoId) {
        try {
          const upNext = await youtubeApi.getUpNextSafe(videoId);
          if (upNext.ok) results.push(...upNext.data);
        } catch {
          // ignore
        }
      }

      // Expand around seed metadata via YouTube search before global blends.
      if (results.length < 10) {
        try {
          const queries = buildSimilarityQueries(seedTrack);
          for (const query of queries) {
            const similarRes = await youtubeApi.searchSongsSafe(query, 8);
            if (similarRes.ok) results.push(...similarRes.data);
            if (results.length >= 24) break;
          }
        } catch {
          // ignore
        }
      }

      // Deduplicate
      const seen = new Set();
      const filtered = results.filter(track => {
        if (!track?.id || seen.has(track.id) || track.id === seedTrack.id) return false;
        seen.add(track.id);
        return true;
      });

      return rankRecommendationCandidates(seedTrack, filtered, {
        minScore: 0.3,
        minimumCount: 5,
        maxCount: 15,
      });
    } catch {
      return [];
    }
  }, []);

  /* -------------------------- AUTO RADIO TOGGLE -------------------------- */

  const toggleAutoRadio = useCallback(() => {

    setAutoRadioEnabled(v => !v);

  }, []);

  const setPlaybackProfile = useCallback((profile) => {
    setPlaybackProfileState(normalizePlaybackProfile(profile));
  }, []);

  const cyclePlaybackProfile = useCallback(() => {
    setPlaybackProfileState((previous) => (
      previous === "data-saver"
        ? "balanced"
        : previous === "balanced"
          ? "instant"
          : "data-saver"
    ));
  }, []);

  const toggleOfflineOnlyMode = useCallback(() => {
    setOfflineOnlyModeState((previous) => !previous);
  }, []);

  const clearResumeState = useCallback(() => {
    setResumeState(null);
    resumeSeekRef.current = null;
    try {
      localStorage.removeItem(RESUME_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const resumePlayback = useCallback((snapshot = resumeState) => {
    const normalized = normalizeResumeState(snapshot);
    if (!normalized?.track) return;

    const nextQueue = normalized.queue?.length > 0 ? normalized.queue : [normalized.track];
    const boundedIndex = normalized.queueIndex >= 0 && normalized.queueIndex < nextQueue.length
      ? normalized.queueIndex
      : Math.max(0, nextQueue.findIndex((item) => item?.id === normalized.track.id));

    queueModeRef.current = "list";
    queueRef.current = nextQueue;
    queueIndexRef.current = boundedIndex;
    setQueueMode("list");
    setQueue(nextQueue);
    setQueueIndex(boundedIndex);
    resumeSeekRef.current = {
      trackId: normalized.track.id,
      position: normalized.position || 0,
    };
    loadAndPlay(normalized.track);
  }, [loadAndPlay, resumeState]);

  /* ----------- KEEP REFS IN SYNC FOR NATIVE LISTENERS ----------- */

  useEffect(() => { skipNextRef.current = skipNext; }, [skipNext]);
  useEffect(() => { skipPrevRef.current = skipPrev; }, [skipPrev]);
  useEffect(() => { playTrackRef.current = playTrack; }, [playTrack]);
  useEffect(() => { queueModeRef.current = queueMode; }, [queueMode]);
  useEffect(() => { autoRadioEnabledRef.current = autoRadioEnabled; }, [autoRadioEnabled]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { repeatModeRef.current = repeatMode; }, [repeatMode]);
  useEffect(() => { loadAndPlayRef.current = loadAndPlay; }, [loadAndPlay]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { queueIndexRef.current = queueIndex; }, [queueIndex]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_RADIO_STORAGE_KEY, String(autoRadioEnabled));
    } catch {
      // ignore storage failures
    }
  }, [autoRadioEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(PLAYBACK_PROFILE_STORAGE_KEY, playbackProfile);
    } catch {
      // ignore storage failures
    }
  }, [playbackProfile]);

  useEffect(() => {
    try {
      localStorage.setItem(OFFLINE_ONLY_STORAGE_KEY, String(offlineOnlyMode));
    } catch {
      // ignore storage failures
    }
  }, [offlineOnlyMode]);

  useEffect(() => () => {
    clearPlaybackRecovery();
  }, [clearPlaybackRecovery]);

  /* Track played IDs to avoid recommending already-heard songs */
  useEffect(() => {
    if (currentTrack?.id) {
      playedIdsRef.current.add(currentTrack.id);
      if (playedIdsRef.current.size > 200) {
        const arr = [...playedIdsRef.current];
        playedIdsRef.current = new Set(arr.slice(-100));
      }
    }
  }, [currentTrack]);

  /* -------------------------- QUEUE MANAGEMENT -------------------------- */

  const removeFromQueue = useCallback((index) => {
    if (index < 0 || index >= queue.length) return;
    const newQueue = queue.filter((_, i) => i !== index);
    let newIndex = queueIndex;
    if (index < queueIndex) {
      newIndex = queueIndex - 1;
    } else if (index === queueIndex) {
      // Removing current track — play next or stop
      if (newQueue.length === 0) {
        setQueue([]);
        setQueueIndex(-1);
        return;
      }
      newIndex = Math.min(queueIndex, newQueue.length - 1);
      setQueue(newQueue);
      setQueueIndex(newIndex);
      loadAndPlay(newQueue[newIndex]);
      return;
    }
    setQueue(newQueue);
    setQueueIndex(newIndex);
  }, [queue, queueIndex, loadAndPlay]);

  const clearQueue = useCallback(() => {
    const current = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;
    if (current) {
      setQueue([current]);
      setQueueIndex(0);
    } else {
      setQueue([]);
      setQueueIndex(-1);
    }
  }, [queue, queueIndex]);

  const moveQueueItem = useCallback((index, direction) => {
    if (!Number.isInteger(index)) return;
    if (index < 0 || index >= queue.length) return;

    const targetIndex = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
    if (targetIndex < 0 || targetIndex >= queue.length) return;

    const nextQueue = [...queue];
    const [moved] = nextQueue.splice(index, 1);
    nextQueue.splice(targetIndex, 0, moved);

    let nextQueueIndex = queueIndex;
    if (queueIndex === index) {
      nextQueueIndex = targetIndex;
    } else if (index < queueIndex && targetIndex >= queueIndex) {
      nextQueueIndex = queueIndex - 1;
    } else if (index > queueIndex && targetIndex <= queueIndex) {
      nextQueueIndex = queueIndex + 1;
    }

    setQueue(nextQueue);
    setQueueIndex(nextQueueIndex);
  }, [queue, queueIndex]);

  const dedupeQueue = useCallback(() => {
    if (!queue.length) return;

    const seen = new Set();
    const nextQueue = [];
    let nextIndex = queueIndex;

    queue.forEach((track, index) => {
      const key = String(track?.id || track?.videoId || `${track?.title || 'track'}-${track?.artist || 'artist'}`);
      if (seen.has(key)) {
        if (index < queueIndex) nextIndex -= 1;
        return;
      }
      seen.add(key);
      nextQueue.push(track);
    });

    if (!nextQueue.length) {
      setQueue([]);
      setQueueIndex(-1);
      return;
    }

    const boundedIndex = Math.max(0, Math.min(nextIndex, nextQueue.length - 1));
    setQueue(nextQueue);
    setQueueIndex(boundedIndex);
  }, [queue, queueIndex]);

  /* -------------------------- SLEEP TIMER WITH FADE -------------------------- */

  const fadeIntervalRef = useRef(null);

  const cycleSleepTimer = useCallback(() => {

    setSleepTimerMinutes(prev => {

      const next = cycleSleepTimerValue(prev);

      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);

      if (next != null) {
        const fadeStart = Math.max(0, next * 60 * 1000 - 30000);

        sleepTimerRef.current = setTimeout(() => {
          // Start 30s volume fade-out
          let fadeVol = 0.8;
          fadeIntervalRef.current = setInterval(async () => {
            fadeVol -= 0.04;
            if (fadeVol <= 0) {
              clearInterval(fadeIntervalRef.current);
              await MusicPlayer.pause();
              setIsPlaying(false);
              setSleepTimerMinutes(null);
            }
          }, 1500);
        }, fadeStart);
      }

      return next;

    });

  }, []);

  /* -------------------------- DOMINANT COLOR -------------------------- */

  useEffect(() => {

    if (!currentTrack?.coverArt) {
      setDominantColor("rgba(15,15,19,1)");
      return;
    }

    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = () => {

      try {

        const color = getColor(img);

        if (Array.isArray(color)) {
          setDominantColor(`rgb(${color[0]},${color[1]},${color[2]})`);
        }

      } catch {
        setDominantColor("rgba(15,15,19,1)");
      }

    };

    img.src = currentTrack.coverArt;

  }, [currentTrack]);

  /* -------------------------- SESSION STORAGE -------------------------- */

  useEffect(() => {

    try {

      localStorage.setItem(
        PLAYER_SESSION_STORAGE_KEY,
        serializeSession({
          queue,
          queueIndex,
          currentTrack
        })
      );

    } catch {
      // ignore
    }

  }, [queue, queueIndex, currentTrack]);

  useEffect(() => {

    const saved = parseStoredSession(
      localStorage.getItem(PLAYER_SESSION_STORAGE_KEY)
    );

    if (!saved) return;

    setQueue(saved.queue);
    setQueueIndex(saved.queueIndex);
    setCurrentTrack(saved.currentTrack);

  }, []);

  useEffect(() => {
    if (!currentTrack?.id || !Number.isFinite(progress) || progress <= 8) return;

    const nearEnd = duration > 0 && progress >= Math.max(duration - 8, duration * 0.96);
    if (nearEnd) {
      clearResumeState();
      return;
    }

    const snapshot = {
      track: currentTrack,
      queue,
      queueIndex,
      position: progress,
      capturedAt: Date.now(),
    };

    setResumeState(snapshot);
    try {
      localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // ignore storage failures
    }
  }, [clearResumeState, currentTrack, duration, progress, queue, queueIndex]);

  /* -------------------------- LOCK SCREEN CONTROLS & AUTOPLAY -------------------------- */

  useEffect(() => {
    let nextListener, prevListener, statusListener, errorListener, queueIndexListener;

    (async () => {
      try {
        nextListener = await MusicPlayer.addListener('nextTrack', () => {
          const repeat = repeatModeRef.current;

          // Natural track end with repeat-one: replay
          if (repeat === 'one') {
            const track = currentTrackRef.current;
            if (track) loadAndPlayRef.current?.(track);
            return;
          }

          // All other cases: skipNext handles autoplay, shuffle, repeat-all
          skipNextRef.current?.();
        });

        prevListener = await MusicPlayer.addListener('prevTrack', () => {
          skipPrevRef.current?.();
        });

        statusListener = await MusicPlayer.addListener('statusUpdate', (data) => {
          if (data.position != null) setProgress(data.position);
          if (data.duration != null) setDuration(data.duration);
        });

        errorListener = await MusicPlayer.addListener('playbackError', (data) => {
          const msg = data?.message ? String(data.message) : 'Song not available';
          setIsPlaying(false);
          setIsLoading(false);
          setPlaybackError(msg || 'Song not available');
          const activeTrack = currentTrackRef.current;
          recordReliabilityEvent('error', {
            trackId: activeTrack?.id || null,
            title: activeTrack?.title || 'Unknown',
            message: msg || 'Song not available',
          });
        });

        // Sync state when native background player auto-plays next track
        queueIndexListener = await MusicPlayer.addListener('queueIndexChanged', (data) => {
          const newIdx = data.index;
          if (newIdx >= 0 && newIdx < queueRef.current.length) {
            clearPlaybackRecovery();
            queueIndexRef.current = newIdx;
            setQueueIndex(newIdx);
            const track = getResolvedTrackFromCache(queueRef.current[newIdx]);
            setCurrentTrack(track);
            currentTrackRef.current = track;
            setIsPlaying(true);
            setProgress(0);
          }
        });
      } catch {
        // MusicPlayer plugin not available on web — ignore
      }
    })();

    return () => {
      nextListener?.remove?.();
      prevListener?.remove?.();
      statusListener?.remove?.();
      errorListener?.remove?.();
      queueIndexListener?.remove?.();
    };
  }, [clearPlaybackRecovery, getResolvedTrackFromCache, recordReliabilityEvent]);

  /* -------------------------- PRE-FETCH RECOMMENDATIONS -------------------------- */

  useEffect(() => {
    if (!autoRadioEnabled || queue.length === 0) return;

    const remaining = queue.length - 1 - queueIndex;

    if (remaining <= 2 && !isFetchingRecsRef.current && pendingRecsRef.current.length === 0) {
      const seed = queue[queue.length - 1] || currentTrack;
      if (seed) {
        fetchRecommendations(seed).then(recs => {
          if (recs.length > 0) pendingRecsRef.current = recs;
        }).catch(() => {});
      }
    }
  }, [queueIndex, queue, autoRadioEnabled, currentTrack, fetchRecommendations]);

  useEffect(() => {
    if (playbackProfile !== "instant") return;
    if (isLoading) return;
    if (!queue.length || queueIndex < 0) return;
    const nextTrack = queue[queueIndex + 1];
    if (nextTrack) {
      preResolveStream(nextTrack);
    }
  }, [isLoading, playbackProfile, queue, queueIndex, preResolveStream]);

  /* ----------- GAPLESS: Pre-resolve next track URL at 75% progress ----------- */

  useEffect(() => {
    if (!duration || duration <= 0 || !isPlaying) return;
    const lowerThreshold = playbackProfile === "instant" ? 0.55 : playbackProfile === "data-saver" ? 0.9 : 0.75;
    const pct = progress / duration;
    if (pct < lowerThreshold || pct > 0.98) return;

    const nextIdx = queueIndexRef.current + 1;
    const q = queueRef.current;
    if (nextIdx >= q.length) return; // no next track

    const nextTrack = q[nextIdx];
    if (!nextTrack || preResolvedRef.current.trackId === nextTrack.id) return;

    preResolveStream(nextTrack);
  }, [playbackProfile, progress, duration, isPlaying, preResolveStream]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (!isPlaying || currentTrack?.source !== 'youtube') return;

    const currentUrl = typeof currentTrack?.streamUrl === 'string' ? currentTrack.streamUrl : '';
    if (!currentUrl || isYoutubeCacheUrl(currentUrl)) return;

    const timer = setTimeout(() => {
      resolvePlayableTrack(currentTrack, { forceRefresh: true, reason: 'cache-promotion' })
        .then((refreshedTrack) => {
          if (!refreshedTrack?.streamUrl) return;
          persistResolvedTrack(refreshedTrack);
        })
        .catch(() => {});
    }, CACHE_PROMOTION_RECHECK_MS);

    return () => clearTimeout(timer);
  }, [currentTrack, isPlaying, persistResolvedTrack, resolvePlayableTrack]);

  /* ----------- NATIVE: Sync queue to native for background autoplay ----------- */

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const syncSeq = ++nativeQueueSyncSeqRef.current;

    const syncNativeQueue = async () => {
      if (!queue.length || queueIndex < 0 || queueIndex >= queue.length) {
        try {
          await MusicPlayer.setQueue({ tracks: [], currentIndex: -1, offset: 0 });
        } catch {
          // ignore
        }
        return;
      }

      const windowStart = Math.max(queueIndex - 1, 0);
      const windowEnd = Math.min(queue.length, queueIndex + 4);
      const queueWindow = queue.slice(windowStart, windowEnd);
      const currentIndex = queueIndex - windowStart;
      const preparedTracks = await Promise.all(queueWindow.map(async (item, index) => {
        const absoluteIndex = windowStart + index;
        const cachedItem = absoluteIndex === queueIndex && currentTrackRef.current?.id === item.id
          ? getResolvedTrackFromCache(currentTrackRef.current)
          : getResolvedTrackFromCache(item);

        if (cachedItem?.streamUrl) {
          return cachedItem;
        }

        if (cachedItem?.source === 'youtube') {
          const details = await musicSources.youtube.getStreamUrl(cachedItem, {
            preferDirect: true,
          });
          if (details?.streamUrl) {
            return mergeResolvedTrack(cachedItem, {
              streamUrl: details.streamUrl,
              streamSource: details.streamSource || 'youtube-direct',
              cacheState: details.cacheState || null,
              streamResolvedAt: Date.now(),
            });
          }
        }

        return cachedItem;
      }));

      if (cancelled || syncSeq !== nativeQueueSyncSeqRef.current) return;

      preparedTracks.forEach((item) => {
        if (item?.streamUrl) persistResolvedTrack(item);
      });

      const nativeQueue = preparedTracks.map((item, index) => ({
        id: item.id || '',
        index: windowStart + index,
        url: item.streamUrl || '',
        title: item.title || 'Unknown',
        artist: item.artist || 'Unknown',
        artwork: item.coverArt || '',
      }));

      try {
        await MusicPlayer.setQueue({ tracks: nativeQueue, currentIndex, offset: windowStart });
      } catch {
        // ignore
      }
    };

    syncNativeQueue();

    return () => {
      cancelled = true;
    };
  }, [getResolvedTrackFromCache, mergeResolvedTrack, musicSources.youtube, queue, queueIndex, persistResolvedTrack]);

  /* -------------------------- CONTEXT VALUE -------------------------- */

  const value = {

    currentTrack,
    isPlaying,
    progress,
    duration,
    volume,

    queue,
    queueIndex,
    queueMode,

    shuffleMode,
    repeatMode,

    dominantColor,
    isLoading,
    playbackError,

    autoRadioEnabled,
    playbackProfile,
    offlineOnlyMode,
    sleepTimerMinutes,
    resumeState,
    equalizerState,
    reliabilityDebug,

    playTrack,
    togglePlay,
    skipNext,
    skipPrev,
    seekTo,
    setVolume,

    toggleShuffle,
    cycleRepeat,
    toggleAutoRadio,
    setPlaybackProfile,
    cyclePlaybackProfile,
    toggleOfflineOnlyMode,
    getRecommendationsFor,
    refreshEqualizerState,
    setEqualizerEnabled,
    setEqualizerPreset,
    clearReliabilityEvents,
    resumePlayback,
    clearResumeState,

    cycleSleepTimer,
    setQueue,
    removeFromQueue,
    clearQueue,
    moveQueueItem,
    dedupeQueue

  };

  return (
    <PlayerContext.Provider value={value}>
      {children}
    </PlayerContext.Provider>
  );

};
