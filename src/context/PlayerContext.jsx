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
import { buildApiUrl } from "../api/apiBase";
import { youtubeApi } from "../api/youtube";
import { recommendationsApi } from "../api/recommendations";
import { getOrCreateUserId } from "../utils/userId";

import {
  buildPlaybackSession,
  cycleSleepTimerValue,
  getPreviousQueueIndex,
  parseStoredSession,
  serializeSession
} from "../utils/playerState";
import {
  buildLocalRecommendations,
  loadStoredTrackCollections
} from "../utils/recommendationFallback";
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

export const usePlayer = () => useContext(PlayerContext);

export const PlayerProvider = ({ children }) => {

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
  const recoSnapshotRef = useRef({ ts: 0, userId: null, data: null });
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

  const getRecommendationSnapshot = useCallback(async () => {
    const userId = getOrCreateUserId();
    const now = Date.now();

    // Cache to avoid spamming the backend during autoplay and prefetch.
    if (
      recoSnapshotRef.current.data &&
      recoSnapshotRef.current.userId === userId &&
      now - recoSnapshotRef.current.ts < 2 * 60 * 1000
    ) {
      return recoSnapshotRef.current.data;
    }

    try {
      const res = await recommendationsApi.getRecommendationsSafe(userId);
      if (!res.ok || !res.data) return null;
      recoSnapshotRef.current = { ts: now, userId, data: res.data };
      return res.data;
    } catch {
      return null;
    }
  }, []);

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

    const videoId = track.videoId || track.id.replace(/^yt-/, "");
    const details = await youtubeApi.getStreamDetails(videoId, {
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
      const fallbackSources = new Set(['piped', 'ytdl-core', 'soundcloud', 'yt-dlp']);
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
  }, [getResolvedTrackFromCache, mergeResolvedTrack, offlineOnlyMode, recordReliabilityEvent]);

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

      // Strategy 2: Your backend recommendations (made-for-you / based-on-recent / trending)
      // These tend to be more stable than generic search fallbacks.
      if (results.length < 12) {
        const snapshot = await getRecommendationSnapshot();
        if (snapshot) {
          results.push(
            ...(snapshot.basedOnRecent || []),
            ...(snapshot.madeForYou || []),
            ...(snapshot.trending || [])
          );
        }
      }

      // Strategy 3: Saavn suggestions (if Saavn track)
      // Strategy 3: Targeted YouTube search by title (+ artist) as a last resort
      // Avoid artist-only search; it produces a lot of low-signal results.
      if (results.length < 16) {
        try {
          const q = `${seedTrack.title || ''} ${seedTrack.artist || ''}`.trim();
          if (q) {
            const similarRes = await youtubeApi.searchSongsSafe(q, 8);
            if (similarRes.ok) results.push(...similarRes.data);
          }
        } catch {
          // ignore
        }
      }

      if (results.length < 16) {
        const { history, favorites } = loadStoredTrackCollections();
        results.push(
          ...buildLocalRecommendations({
            seedTrack,
            history,
            favorites,
            limit: 12,
            excludeIds: [...queueIds, ...playedIdsRef.current],
          })
        );
      }

      // Deduplicate and filter out already played/queued tracks
      const seen = new Set();

      return results.filter(track => {
        if (!track?.id) return false;
        if (seen.has(track.id)) return false;
        if (queueIds.has(track.id)) return false;
        if (playedIdsRef.current.has(track.id)) return false;
        if (seedTrack?.id && track.id === seedTrack.id) return false;
        seen.add(track.id);
        return true;
      }).slice(0, 20);
    } catch (error) {
      console.error('Recommendation fetch failed:', error);
      return [];
    } finally {
      isFetchingRecsRef.current = false;
    }
  }, [getRecommendationSnapshot]);

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

      // Fill from backend recommendations to keep Discover mixes higher-quality.
      if (results.length < 10) {
        const snapshot = await getRecommendationSnapshot();
        if (snapshot) {
          results.push(
            ...(snapshot.basedOnRecent || []),
            ...(snapshot.madeForYou || [])
          );
        }
      }

      if (results.length < 5 && seedTrack.artist) {
        try {
          const artistRes = await youtubeApi.searchSongsSafe(seedTrack.artist, 8);
          if (artistRes.ok) results.push(...artistRes.data);
        } catch {
          // ignore
        }
      }

      // Deduplicate
      const seen = new Set();
      return results.filter(track => {
        if (!track?.id || seen.has(track.id) || track.id === seedTrack.id) return false;
        seen.add(track.id);
        return true;
      }).slice(0, 15);
    } catch {
      return [];
    }
  }, [getRecommendationSnapshot]);

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
          const videoId = cachedItem.videoId || String(cachedItem.id || '').replace(/^yt-/, '');
          if (videoId) {
            return mergeResolvedTrack(cachedItem, {
              streamUrl: buildApiUrl(`/yt/pipe/${videoId}`),
              streamSource: 'pipe-proxy',
              cacheState: 'pipe',
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
  }, [getResolvedTrackFromCache, mergeResolvedTrack, queue, queueIndex, persistResolvedTrack]);

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
    clearQueue

  };

  return (
    <PlayerContext.Provider value={value}>
      {children}
    </PlayerContext.Provider>
  );

};
