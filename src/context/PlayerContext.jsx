/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { getColor } from 'colorthief';
import { youtubeApi } from '../api/youtube';
import { saavnApi } from '../api/saavn';
import {
  buildPlaybackSession,
  cycleSleepTimerValue,
  getNextListIndex,
  getPreviousQueueIndex,
  parseStoredSession,
  serializeSession,
} from '../utils/playerState';

const PlayerContext = createContext();
const FALLBACK_COVER = 'https://placehold.co/500x500/27272a/71717a?text=%E2%99%AA';

const normalizeText = (value = '') => value
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const getPrimaryArtist = (artist = '') => artist.split(',')[0]?.trim() || artist.trim();

export const usePlayer = () => useContext(PlayerContext);

export const PlayerProvider = ({ children }) => {
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.8);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMode, setQueueMode] = useState('list');
  const [isLoading, setIsLoading] = useState(false);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off');
  const [autoRadioEnabled, setAutoRadioEnabled] = useState(true);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState(null);
  const [dominantColor, setDominantColor] = useState('rgba(15, 15, 19, 1)');

  const audioRef = useRef(new Audio());
  const fadeTimerRef = useRef(null);
  const sleepTimerTimeoutRef = useRef(null);
  const nextTrackCache = useRef(null);
  const radioHistoryRef = useRef(new Set());
  const radioFetchInFlightRef = useRef(false);

  // Initialize Audio settings for mobile background support
  useEffect(() => {
    const audio = audioRef.current;
    audio.preload = "auto";
    audio.playsInline = true;
  }, []);

  const prefetchNextTrack = useCallback(async (track) => {
    if (!track || track.source !== 'youtube') return;

    try {
      const videoId = track.videoId || track.id.replace(/^yt-/, '');
      const details = await youtubeApi.getStreamDetails(videoId);
      if (details?.streamUrl) {
        nextTrackCache.current = {
          id: track.id,
          streamUrl: details.streamUrl,
        };
      }
    } catch (error) {
      console.warn('Prefetch failed:', error);
    }
  }, []);

  const fetchSimilarTracks = useCallback(async (seedTrack) => {
    if (!seedTrack) return [];

    const seedArtist = getPrimaryArtist(seedTrack.artist || '');
    const seedTitle = seedTrack.title || '';
    const queryBase = [seedArtist, seedTitle].filter(Boolean).join(' ').trim();
    const queryArtistOnly = seedArtist ? `${seedArtist} songs` : '';

    const [ytBase, ytArtist, saavnBase, saavnArtist] = await Promise.all([
      queryBase ? youtubeApi.searchSongs(queryBase, 12).catch(() => []) : Promise.resolve([]),
      queryArtistOnly ? youtubeApi.searchSongs(queryArtistOnly, 8).catch(() => []) : Promise.resolve([]),
      queryBase ? saavnApi.searchSongs(queryBase, 12).catch(() => []) : Promise.resolve([]),
      queryArtistOnly ? saavnApi.searchSongs(queryArtistOnly, 8).catch(() => []) : Promise.resolve([]),
    ]);

    const saavnTracks = [...saavnBase, ...saavnArtist].map(saavnApi.formatTrack);
    const ytTracks = [...ytBase, ...ytArtist];
    const mixedTracks = seedTrack.source === 'youtube'
      ? [...ytTracks, ...saavnTracks]
      : [...saavnTracks, ...ytTracks];

    const seen = new Set();
    const titleTokens = normalizeText(seedTitle).split(' ').filter((word) => word.length > 2);
    const normalizedArtist = normalizeText(seedArtist);

    return mixedTracks
      .filter((track) => {
        if (!track?.id || seen.has(track.id)) return false;
        seen.add(track.id);
        if (track.id === seedTrack.id) return false;
        if (radioHistoryRef.current.has(track.id)) return false;
        return true;
      })
      .map((track) => {
        const candidateTitle = normalizeText(track.title || '');
        const candidateArtist = normalizeText(getPrimaryArtist(track.artist || ''));

        let score = 0;
        if (normalizedArtist && candidateArtist.includes(normalizedArtist)) score += 4;
        if (track.source === seedTrack.source) score += 2;
        if (seedTrack.album && track.album && normalizeText(track.album).includes(normalizeText(seedTrack.album))) score += 1;
        if (Math.abs((track.duration || 0) - (seedTrack.duration || 0)) <= 25) score += 1;

        for (const token of titleTokens) {
          if (candidateTitle.includes(token)) score += 1;
        }

        return { track, score };
      })
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : Math.random() - 0.5))
      .map((item) => item.track)
      .slice(0, 8);
  }, []);

  const loadAndPlay = useCallback(async (track) => {
    if (!track) return;

    setIsLoading(true);
    setCurrentTrack(track);
    setIsPlaying(false);

    const audio = audioRef.current;
    if (fadeTimerRef.current) {
      clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    audio.pause();

    try {
      let streamUrl = track.streamUrl;

      if (nextTrackCache.current && nextTrackCache.current.id === track.id) {
        streamUrl = nextTrackCache.current.streamUrl;
        nextTrackCache.current = null;
      }

      if (track.source === 'youtube' && !streamUrl) {
        const videoId = track.videoId || track.id.replace(/^yt-/, '');
        const details = await youtubeApi.getStreamDetails(videoId);
        if (!details?.streamUrl) {
          throw new Error('Could not fetch YouTube audio stream');
        }
        streamUrl = details.streamUrl;
      }

      if (streamUrl) {
        audio.src = streamUrl;
        audio.volume = 0;
        audio.currentTime = 0;
        await audio.play();
        setIsPlaying(true);

        const targetVolume = volume;
        const steps = 15;
        const fadeDurationMs = 1200;
        let currentStep = 0;
        fadeTimerRef.current = setInterval(() => {
          currentStep += 1;
          audio.volume = Math.min(targetVolume, (targetVolume * currentStep) / steps);
          if (currentStep >= steps) {
            clearInterval(fadeTimerRef.current);
            fadeTimerRef.current = null;
          }
        }, fadeDurationMs / steps);
      }
    } catch (error) {
      console.error('Error playing track:', error);
    } finally {
      setIsLoading(false);
    }
  }, [volume]);

  const queueRadioTrack = useCallback(async (seedTrack) => {
    if (!seedTrack || radioFetchInFlightRef.current) return;

    radioFetchInFlightRef.current = true;
    try {
      const candidates = await fetchSimilarTracks(seedTrack);
      if (!candidates.length) return;

      const nextTrack = candidates[0];
      radioHistoryRef.current.add(nextTrack.id);

      let nextIndex = -1;
      setQueue((previousQueue) => {
        nextIndex = previousQueue.length;
        return [...previousQueue, nextTrack];
      });

      if (nextIndex >= 0) {
        setQueueIndex(nextIndex);
      }

      await loadAndPlay(nextTrack);

      if (candidates[1]) {
        prefetchNextTrack(candidates[1]);
      }
    } catch (error) {
      console.error('Radio fetch error:', error);
    } finally {
      radioFetchInFlightRef.current = false;
    }
  }, [fetchSimilarTracks, loadAndPlay, prefetchNextTrack]);

  const playTrack = useCallback((track, trackList, options = {}) => {
    if (!track) return;

    const playbackSession = buildPlaybackSession({
      track,
      trackList,
      mode: options.mode,
    });

    setQueueMode(playbackSession.queueMode);
    setQueue(playbackSession.queue);
    setQueueIndex(playbackSession.queueIndex);
    radioFetchInFlightRef.current = false;

    if (playbackSession.queueMode === 'radio') {
      radioHistoryRef.current = new Set([track.id]);
    }

    loadAndPlay(track);
  }, [loadAndPlay]);

  const togglePlay = useCallback(() => {
    if (!currentTrack) return;

    const audio = audioRef.current;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    if (!audio.src) {
      loadAndPlay(currentTrack);
      return;
    }

    audio.play().then(() => setIsPlaying(true)).catch((error) => console.error('Playback failed', error));
  }, [currentTrack, isPlaying, loadAndPlay]);

  const getShuffledIndex = useCallback((currentIndex, length) => {
    if (length <= 1) return 0;

    let nextIndex;
    do {
      nextIndex = Math.floor(Math.random() * length);
    } while (nextIndex === currentIndex);

    return nextIndex;
  }, []);

  const crossfadeToTrack = useCallback(async (nextTrack) => {
    if (!nextTrack) return;

    const audio = audioRef.current;
    if (!audio.paused && Number.isFinite(audio.duration) && audio.duration - audio.currentTime > 1) {
      const originalVolume = audio.volume;
      const steps = 8;
      const fadeDurationMs = 350;
      let step = 0;

      await new Promise((resolve) => {
        const intervalId = setInterval(() => {
          step += 1;
          audio.volume = originalVolume * Math.max(0, 1 - step / steps);
          if (step >= steps) {
            clearInterval(intervalId);
            audio.pause();
            audio.volume = originalVolume;
            resolve();
          }
        }, fadeDurationMs / steps);
      });
    } else {
      audio.pause();
    }

    await loadAndPlay(nextTrack);
  }, [loadAndPlay]);

  const skipNext = useCallback(async () => {
    if (queueMode === 'radio') {
      const nextIndex = queueIndex + 1;
      if (nextIndex >= 0 && nextIndex < queue.length) {
        setQueueIndex(nextIndex);
        await crossfadeToTrack(queue[nextIndex]);
        return;
      }

      await queueRadioTrack(currentTrack || queue[queueIndex]);
      return;
    }

    if (!queue.length) {
      if (autoRadioEnabled && currentTrack) {
        setQueueMode('radio');
        await queueRadioTrack(currentTrack);
      }
      return;
    }

    let nextIndex = null;
    if (shuffleMode) {
      nextIndex = getShuffledIndex(queueIndex, queue.length);
    } else {
      nextIndex = getNextListIndex({
        queueIndex,
        queueLength: queue.length,
        repeatMode,
      });
    }

    if (nextIndex == null) {
      if (autoRadioEnabled) {
        const seedTrack = currentTrack || queue[queueIndex];
        if (seedTrack) {
          setQueueMode('radio');
          await queueRadioTrack(seedTrack);
        }
      }
      return;
    }

    setQueueIndex(nextIndex);
    await crossfadeToTrack(queue[nextIndex]);
  }, [autoRadioEnabled, crossfadeToTrack, currentTrack, getShuffledIndex, queue, queueIndex, queueMode, queueRadioTrack, repeatMode, shuffleMode]);

  useEffect(() => {
    if (!queue.length) return;
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) {
      prefetchNextTrack(queue[nextIndex]);
    }
  }, [prefetchNextTrack, queue, queueIndex]);

  // Fallback timer to ensure next track starts if 'ended' event fails in background
  useEffect(() => {
    const audio = audioRef.current;
    const interval = setInterval(() => {
      if (!audio || !audio.duration || isNaN(audio.duration)) return;

      const remaining = audio.duration - audio.currentTime;
      // If less than 1 second remaining and playing, trigger skipNext
      if (remaining < 1 && isPlaying && !audio.paused) {
        skipNext();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isPlaying, skipNext]);

  const skipPrev = useCallback(() => {
    if (audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      setProgress(0);
      return;
    }

    if (!queue.length) return;

    const previousIndex = getPreviousQueueIndex({
      queueIndex,
      queueLength: queue.length,
      queueMode,
      repeatMode,
    });

    if (previousIndex == null) {
      audioRef.current.currentTime = 0;
      setProgress(0);
      return;
    }

    setQueueIndex(previousIndex);
    crossfadeToTrack(queue[previousIndex]);
  }, [crossfadeToTrack, queue, queueIndex, queueMode, repeatMode]);

  const seekTo = useCallback((time) => {
    audioRef.current.currentTime = time;
    setProgress(time);
  }, []);

  const setVolume = useCallback((nextVolume) => {
    setVolumeState(nextVolume);
    if (fadeTimerRef.current) {
      clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    audioRef.current.volume = nextVolume;
  }, []);

  const cycleSleepTimer = useCallback(() => {
    setSleepTimerMinutes((previousValue) => {
      const nextValue = cycleSleepTimerValue(previousValue);

      if (sleepTimerTimeoutRef.current) {
        clearTimeout(sleepTimerTimeoutRef.current);
        sleepTimerTimeoutRef.current = null;
      }

      if (nextValue != null) {
        sleepTimerTimeoutRef.current = setTimeout(() => {
          audioRef.current.pause();
          setIsPlaying(false);
          setSleepTimerMinutes(null);
          sleepTimerTimeoutRef.current = null;
        }, nextValue * 60 * 1000);
      }

      return nextValue;
    });
  }, []);

  const toggleShuffle = useCallback(() => setShuffleMode((value) => !value), []);
  const cycleRepeat = useCallback(() => {
    setRepeatMode((value) => (value === 'off' ? 'all' : value === 'all' ? 'one' : 'off'));
  }, []);
  const toggleAutoRadio = useCallback(() => {
    setAutoRadioEnabled((value) => !value);
  }, []);

  useEffect(() => () => {
    if (sleepTimerTimeoutRef.current) {
      clearTimeout(sleepTimerTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    const onTimeUpdate = () => setProgress(audio.currentTime);
    const onLoadedMeta = () => setDuration(audio.duration);
    const onEnded = () => {
      if (repeatMode === 'one') {
        audio.currentTime = 0;
        audio.play();
        return;
      }

      setIsPlaying(false);
      skipNext();
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMeta);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMeta);
      audio.removeEventListener('ended', onEnded);
    };
  }, [repeatMode, skipNext]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', skipPrev);
    navigator.mediaSession.setActionHandler('nexttrack', skipNext);
    navigator.mediaSession.setActionHandler('stop', () => {
      audioRef.current.pause();
      setIsPlaying(false);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.fastSeek && 'fastSeek' in audioRef.current) {
        audioRef.current.fastSeek(details.seekTime);
        setProgress(details.seekTime);
      } else {
        seekTo(details.seekTime);
      }
    });
  }, [seekTo, skipNext, skipPrev, togglePlay]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!currentTrack || typeof MediaMetadata === 'undefined') {
      navigator.mediaSession.metadata = null;
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album || 'Aura Player',
      artwork: currentTrack.coverArt
        ? [
            { src: currentTrack.coverArt, sizes: '500x500', type: 'image/jpeg' },
            { src: currentTrack.coverArt, sizes: '512x512', type: 'image/png' },
          ]
        : [{ src: FALLBACK_COVER, sizes: '500x500', type: 'image/png' }],
    });
  }, [currentTrack]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(progress, duration)),
        playbackRate: audioRef.current.playbackRate || 1,
      });
    } catch {
      // Some Android WebViews throw when metadata is incomplete.
    }
  }, [duration, progress]);

  useEffect(() => {
    if (!currentTrack?.coverArt) {
      setDominantColor('rgba(15, 15, 19, 1)');
      return;
    }

    const image = new Image();
    image.crossOrigin = 'Anonymous';
    image.onload = async () => {
      try {
        const color = await getColor(image);
        if (typeof color?.css === 'function') {
          setDominantColor(color.css('rgb'));
        } else if (Array.isArray(color) && color.length >= 3) {
          setDominantColor(`rgb(${color[0]}, ${color[1]}, ${color[2]})`);
        } else {
          setDominantColor('rgba(15, 15, 19, 1)');
        }
      } catch (error) {
        console.warn('ColorThief failed:', error);
        setDominantColor('rgba(15, 15, 19, 1)');
      }
    };
    image.onerror = () => {
      setDominantColor('rgba(15, 15, 19, 1)');
    };
    image.src = currentTrack.coverArt;
  }, [currentTrack]);

  const getRecommendationsFor = useCallback(async (seedTrack) => fetchSimilarTracks(seedTrack), [fetchSimilarTracks]);

  useEffect(() => {
    try {
      window.localStorage.setItem('aura-player-session', serializeSession({
        queue,
        queueIndex,
        currentTrack,
      }));
    } catch {
      // ignore
    }
  }, [currentTrack, queue, queueIndex]);

  useEffect(() => {
    const restoredSession = parseStoredSession(window.localStorage.getItem('aura-player-session'));
    if (!restoredSession) return;

    setQueue(restoredSession.queue);
    setQueueIndex(restoredSession.queueIndex);
    setCurrentTrack(restoredSession.currentTrack);
  }, []);

  const value = {
    currentTrack,
    isPlaying,
    progress,
    duration,
    volume,
    queue,
    queueIndex,
    queueMode,
    isLoading,
    shuffleMode,
    repeatMode,
    dominantColor,
    autoRadioEnabled,
    sleepTimerMinutes,
    togglePlay,
    playTrack,
    setVolume,
    seekTo,
    skipNext,
    skipPrev,
    toggleShuffle,
    cycleRepeat,
    toggleAutoRadio,
    cycleSleepTimer,
    setQueue,
    getRecommendationsFor,
  };

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
};
