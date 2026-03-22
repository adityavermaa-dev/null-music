/* eslint-disable react-refresh/only-export-components */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef
} from "react";

import { registerPlugin } from "@capacitor/core";
import { Capacitor } from '@capacitor/core';

import { youtubeApi } from "../api/youtube";
import { saavnApi } from "../api/saavn";
import { recommendationsApi } from "../api/recommendations";
import { getOrCreateUserId } from "../utils/userId";

import {
  buildPlaybackSession,
  cycleSleepTimerValue,
  getPreviousQueueIndex,
  parseStoredSession,
  serializeSession
} from "../utils/playerState";

const MusicPlayer = registerPlugin("MusicPlayer");

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

  const [autoRadioEnabled, setAutoRadioEnabled] = useState(true);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState(null);
  const [volume, setVolumeState] = useState(0.8);

  const sleepTimerRef = useRef(null);
  const skipNextRef = useRef(null);
  const skipPrevRef = useRef(null);
  const playTrackRef = useRef(null);
  const queueModeRef = useRef(queueMode);
  const autoRadioEnabledRef = useRef(autoRadioEnabled);
  const isLoadingRef = useRef(isLoading);

  const playedIdsRef = useRef(new Set());
  const isFetchingRecsRef = useRef(false);
  const pendingRecsRef = useRef([]);
  const currentTrackRef = useRef(null);
  const repeatModeRef = useRef(repeatMode);
  const loadAndPlayRef = useRef(null);
  const queueRef = useRef(queue);
  const queueIndexRef = useRef(queueIndex);
  const playSeqRef = useRef(0);

  /* -------------------------- PLAY TRACK -------------------------- */

  const trySaavnFallback = useCallback(async (track) => {
    if (!track?.title) return null;
    const q = `${track.title} ${track.artist || ''}`.trim();
    if (!q) return null;

    const result = await saavnApi.searchSongsSafe(q, 5);
    if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;

    // Pick the first match. Keep existing track metadata to avoid queue/index churn.
    const saavnTrack = saavnApi.formatTrack(result.data[0]);
    return saavnTrack?.streamUrl || null;
  }, []);

  const loadAndPlay = useCallback(async (track) => {

    if (!track) return;

    const seq = ++playSeqRef.current;

    setIsLoading(true);
    setPlaybackError(null);

    try {
      // Stop current playback to avoid UI/audio desync while loading a new track.
      await MusicPlayer.pause();
    } catch {
      // ignore (web/no plugin)
    }

    if (seq !== playSeqRef.current) return;

    setIsPlaying(false);
    setProgress(0);
    setDuration(0);

    try {

      let streamUrl = track.streamUrl;

      if (track.source === "youtube") {
        const videoId = track.videoId || track.id.replace(/^yt-/, "");

        const details = await youtubeApi.getStreamDetails(videoId, {
          preferDirect: Capacitor.isNativePlatform(),
        });

        if (seq !== playSeqRef.current) return;

        if (!details?.streamUrl) {
          throw new Error("Stream fetch failed");
        }

        streamUrl = details.streamUrl;
      }

      if (seq !== playSeqRef.current) return;

      if (!streamUrl) {
        // Try Saavn fallback for YouTube tracks
        if (track.source === 'youtube') {
          const saavnUrl = await trySaavnFallback(track);
          if (seq !== playSeqRef.current) return;
          if (saavnUrl) {
            streamUrl = saavnUrl;
          }
        }

        if (!streamUrl) throw new Error('Stream unavailable');
      }

      await MusicPlayer.play({
        url: streamUrl,
        title: track.title,
        artist: track.artist,
        artwork: track.coverArt || FALLBACK_COVER
      });

      if (seq !== playSeqRef.current) return;

      setCurrentTrack(track);
      setIsPlaying(true);

      // Track behavior (fire-and-forget)
      try {
        const userId = getOrCreateUserId();
        await recommendationsApi.trackSafe({ userId, song: { ...track, streamUrl } , action: 'play' });
      } catch {
        // ignore
      }

    } catch (error) {

      console.error("Playback error", error);
      if (seq !== playSeqRef.current) return;

      // Retry with Saavn once if YouTube playback failed.
      if (track?.source === 'youtube') {
        try {
          const saavnUrl = await trySaavnFallback(track);
          if (seq !== playSeqRef.current) return;
          if (saavnUrl) {
            await MusicPlayer.play({
              url: saavnUrl,
              title: track.title,
              artist: track.artist,
              artwork: track.coverArt || FALLBACK_COVER
            });
            if (seq !== playSeqRef.current) return;
            setCurrentTrack({ ...track, streamUrl: saavnUrl });
            setIsPlaying(true);
            setPlaybackError(null);
            return;
          }
        } catch {
          // ignore
        }
      }

      setIsPlaying(false);
      setPlaybackError("Song not available");

    } finally {

      if (seq === playSeqRef.current) {
        setIsLoading(false);
      }

    }

  }, [trySaavnFallback]);

  /* -------------------------- PLAY SESSION -------------------------- */

  const playTrack = useCallback((track, trackList, options = {}) => {

    if (!track) return;

    const session = buildPlaybackSession({
      track,
      trackList,
      mode: options.mode
    });

    setQueueMode(session.queueMode);
    setQueue(session.queue);
    setQueueIndex(session.queueIndex);

    pendingRecsRef.current = [];

    loadAndPlay(track);

  }, [loadAndPlay]);

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

      // Strategy 1: YouTube Music "Up Next" (best quality recs)
      const videoId = seedTrack.videoId || (seedTrack.source === 'youtube' ? seedTrack.id.replace(/^yt-/, '') : null);
      if (videoId) {
        try {
          const upNext = await youtubeApi.getUpNextSafe(videoId);
          if (upNext.ok) results.push(...upNext.data);
        } catch {
          // ignore
        }
      }

      // Strategy 2: Saavn suggestions (if Saavn track)
      if (seedTrack.source === 'saavn' && results.length < 5) {
        try {
          const suggestions = await saavnApi.getSongSuggestionsSafe(seedTrack.id);
          if (suggestions.ok) results.push(...suggestions.data);
        } catch {
          // ignore
        }
      }

      // Strategy 3: Search by artist name
      if (results.length < 8 && seedTrack.artist) {
        try {
          const artistRes = await youtubeApi.searchSongsSafe(seedTrack.artist, 10);
          if (artistRes.ok) results.push(...artistRes.data);
        } catch {
          // ignore
        }
      }

      // Strategy 4: Search by title + artist keywords
      if (results.length < 10) {
        try {
          const q = `${seedTrack.title} ${seedTrack.artist}`.trim();
          const similarRes = await youtubeApi.searchSongsSafe(q, 8);
          if (similarRes.ok) results.push(...similarRes.data);
        } catch {
          // ignore
        }
      }

      // Deduplicate and filter out already played/queued tracks
      const seen = new Set();
      const currentQueue = queueRef.current;
      const queueIds = new Set(currentQueue.map(t => t.id));

      return results.filter(track => {
        if (!track?.id) return false;
        if (seen.has(track.id)) return false;
        if (queueIds.has(track.id)) return false;
        if (playedIdsRef.current.has(track.id)) return false;
        seen.add(track.id);
        return true;
      }).slice(0, 20);
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
      setQueueIndex(nextIndex);
      loadAndPlay(queue[nextIndex]);
      return;
    }

    nextIndex = queueIndex + 1;

    if (nextIndex < queue.length) {
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

      if (seedTrack.source === 'saavn') {
        try {
          const suggestions = await saavnApi.getSongSuggestionsSafe(seedTrack.id);
          if (suggestions.ok) results.push(...suggestions.data);
        } catch {
          // ignore
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
  }, []);

  /* -------------------------- AUTO RADIO TOGGLE -------------------------- */

  const toggleAutoRadio = useCallback(() => {

    setAutoRadioEnabled(v => !v);

  }, []);

  /* ----------- KEEP REFS IN SYNC FOR NATIVE LISTENERS ----------- */

  useEffect(() => { skipNextRef.current = skipNext; }, [skipNext]);
  useEffect(() => { skipPrevRef.current = skipPrev; }, [skipPrev]);
  useEffect(() => { playTrackRef.current = playTrack; }, [playTrack]);
  useEffect(() => { queueModeRef.current = queueMode; }, [queueMode]);
  useEffect(() => { autoRadioEnabledRef.current = autoRadioEnabled; }, [autoRadioEnabled]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { repeatModeRef.current = repeatMode; }, [repeatMode]);
  useEffect(() => { loadAndPlayRef.current = loadAndPlay; }, [loadAndPlay]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { queueIndexRef.current = queueIndex; }, [queueIndex]);

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
        "aura-player-session",
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
      localStorage.getItem("aura-player-session")
    );

    if (!saved) return;

    setQueue(saved.queue);
    setQueueIndex(saved.queueIndex);
    setCurrentTrack(saved.currentTrack);

  }, []);

  /* -------------------------- LOCK SCREEN CONTROLS & AUTOPLAY -------------------------- */

  useEffect(() => {
    let nextListener, prevListener, statusListener, errorListener;

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
    };
  }, []);

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
    sleepTimerMinutes,

    playTrack,
    togglePlay,
    skipNext,
    skipPrev,
    seekTo,
    setVolume,

    toggleShuffle,
    cycleRepeat,
    toggleAutoRadio,
    getRecommendationsFor,

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