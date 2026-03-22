import React, { useState, useEffect, useRef } from 'react';
import { usePlayer } from '../context/PlayerContext';
import {
  ChevronDown, Play, Pause, SkipBack, SkipForward,
  Repeat, Repeat1, Shuffle, ListMusic, FileText, Heart,
  Infinity as InfinityIcon, Share2
} from 'lucide-react';

const FALLBACK_COVER = 'https://placehold.co/500x500/27272a/71717a?text=%E2%99%AA';

export default function MobilePlayer({ onOpenLyrics, onOpenQueue }) {
  const {
    currentTrack,
    isPlaying,
    progress,
    duration,
    isLoading,
    playbackError,
    togglePlay,
    skipNext,
    skipPrev,
    seekTo,
    shuffleMode,
    repeatMode,
    toggleShuffle,
    cycleRepeat,
    dominantColor,
    autoRadioEnabled,
    toggleAutoRadio,
  } = usePlayer();

  const [isExpanded, setIsExpanded] = useState(false);
  const artRef = useRef(null);
  const touchRef = useRef({ startX: 0, startY: 0 });

  const handleTouchStart = (e) => {
    const touch = e.touches[0];
    touchRef.current = { startX: touch.clientX, startY: touch.clientY };
  };

  const handleTouchEnd = (e) => {
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchRef.current.startX;
    const dy = touch.clientY - touchRef.current.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx < 50 && absDy < 50) return;

    if (absDy > absDx && dy > 80) {
      setIsExpanded(false);
    } else if (absDx > absDy) {
      if (dx < -50) skipNext();
      else if (dx > 50) skipPrev();
    }
  };

  const handleShare = async () => {
    const shareData = {
      title: currentTrack.title,
      text: `${currentTrack.title} by ${currentTrack.artist}`,
    };

    if (currentTrack.source === "youtube") {
      const videoId = currentTrack.videoId || currentTrack.id?.replace(/^yt-/, "");
      if (videoId) shareData.url = `https://music.youtube.com/watch?v=${videoId}`;
    } else if (currentTrack.source === "saavn" && currentTrack.permaUrl) {
      shareData.url = currentTrack.permaUrl;
    }

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      }
    } catch {
      // User cancelled or share failed — no action needed
    }
  };

  useEffect(() => {
    let wakeLock = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && isExpanded) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Wake Lock error:', err.message);
      }
    };

    requestWakeLock();

    const handleVisibilityChange = () => {
      if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLock !== null) {
        wakeLock.release().then(() => {
          wakeLock = null;
        });
      }
    };
  }, [isExpanded]);

  if (!currentTrack) return null;

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progressPercent = safeDuration > 0 ? Math.max(0, Math.min(100, (progress / safeDuration) * 100)) : 0;

  const coverArt = currentTrack.coverArt || FALLBACK_COVER;

  const formatTime = (time) => {
    if (!time && time !== 0) return '0:00';
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleProgressScrub = (e) => {
    const val = parseFloat(e.target.value);
    seekTo(val);
  };

  const handleImageError = (event) => {
    event.currentTarget.src = FALLBACK_COVER;
  };

  const glowColorStrong = dominantColor.replace('rgb', 'rgba').replace(')', ', 0.55)');
  const RepeatIcon = repeatMode === 'one' ? Repeat1 : Repeat;

  return (
    <div className="mobile-player-wrapper" aria-live="polite">
      {/* ─── Mini Player ────────────────────────── */}
      <div
        className={`mobile-mini-player ${isExpanded ? 'hidden' : ''}`}
        onClick={() => setIsExpanded(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(true);
          }
        }}
        aria-label="Open player"
      >
        <div className="mini-progress-track">
          <div className="mini-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="mini-content">
          <img src={coverArt} alt="" className="mini-cover" onError={handleImageError} />
          <div className="mini-info">
            <div className="mini-title">{currentTrack.title}</div>
            <div className="mini-artist">{currentTrack.artist}</div>
            {playbackError ? (
              <div className="mini-error error-text" role="status" aria-live="polite">{playbackError}</div>
            ) : null}
          </div>
          <div className="mini-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" onClick={skipPrev} aria-label="Previous" type="button">
              <SkipBack fill="currentColor" size={18} />
            </button>
            <button className="mini-play-btn" onClick={togglePlay} disabled={isLoading} aria-label={isPlaying ? 'Pause' : 'Play'} type="button">
              {isLoading ? <div className="spinner spinner-sm" /> : isPlaying ? <Pause fill="currentColor" size={18} /> : <Play fill="currentColor" size={18} style={{ marginLeft: 2 }} />}
            </button>
            <button className="icon-btn" onClick={skipNext} aria-label="Next" type="button">
              <SkipForward fill="currentColor" size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Full-screen Player ─────────────────── */}
      <div className={`mobile-full-player ${isExpanded ? 'expanded' : ''}`}>
        {/* Blurred artwork background */}
        <div className="fp-bg">
          <img src={coverArt} alt="" className="fp-bg-img" onError={handleImageError} />
          <div className="fp-bg-overlay" />
          <div className="fp-bg-grain" />
        </div>

        {/* Content */}
        <div className="fp-content" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          {/* Header */}
          <div className="fp-header">
            <button className="fp-header-btn" onClick={() => setIsExpanded(false)} aria-label="Collapse player" type="button">
              <ChevronDown size={24} />
            </button>
            <div className="fp-header-center">
              <span className="fp-playing-from">PLAYING FROM</span>
              <span className="fp-source-name">{currentTrack.source === 'youtube' ? 'YouTube Music' : 'Saavn'}</span>
            </div>
            <button className="fp-header-btn" onClick={() => { setIsExpanded(false); onOpenQueue(); }} aria-label="Queue" type="button">
              <ListMusic size={20} />
            </button>
          </div>

          {/* Artwork */}
          <div className="fp-art-wrapper">
            <div className="fp-art-glow" style={{ background: glowColorStrong }} />
            <img
              ref={artRef}
              src={coverArt}
              alt=""
              className={`fp-artwork ${isPlaying ? 'fp-artwork-playing' : ''}`}
              onError={handleImageError}
            />
          </div>

          {/* Track Info */}
          <div className="fp-info">
            <div className="fp-info-text">
              <h2 className="fp-title">{currentTrack.title}</h2>
              <p className="fp-artist">{currentTrack.artist}</p>
              {playbackError ? (
                <p className="fp-error error-text" role="status" aria-live="polite">{playbackError}</p>
              ) : null}
            </div>
            <button
              className={`fp-like-btn ${autoRadioEnabled ? 'fp-like-active' : ''}`}
              onClick={toggleAutoRadio}
              aria-label="Autoplay similar"
              type="button"
            >
              <InfinityIcon size={22} />
            </button>
          </div>

          {/* Progress */}
          <div className="fp-progress">
            <input
              type="range"
              min={0}
              max={safeDuration || 100}
              value={Math.max(0, Math.min(progress, safeDuration || 100))}
              onChange={handleProgressScrub}
              className="fp-slider"
              style={{
                '--progress': `${progressPercent}%`,
              }}
              aria-label="Track progress"
            />
            <div className="fp-times">
              <span>{formatTime(progress)}</span>
              <span>{formatTime(safeDuration)}</span>
            </div>
          </div>

          {/* Main Controls */}
          <div className="fp-controls">
            <button className={`fp-ctrl-btn ${shuffleMode ? 'fp-ctrl-active' : ''}`} onClick={toggleShuffle} aria-label="Shuffle" type="button">
              <Shuffle size={22} />
            </button>
            <button className="fp-ctrl-btn fp-ctrl-skip" onClick={skipPrev} aria-label="Previous" type="button">
              <SkipBack fill="currentColor" size={28} />
            </button>
            <button className="fp-play-btn" onClick={togglePlay} disabled={isLoading} aria-label={isPlaying ? 'Pause' : 'Play'} type="button">
              {isLoading ? (
                <div className="spinner" />
              ) : isPlaying ? (
                <Pause fill="currentColor" size={32} />
              ) : (
                <Play fill="currentColor" size={32} style={{ marginLeft: 4 }} />
              )}
            </button>
            <button className="fp-ctrl-btn fp-ctrl-skip" onClick={skipNext} aria-label="Next" type="button">
              <SkipForward fill="currentColor" size={28} />
            </button>
            <button className={`fp-ctrl-btn ${repeatMode !== 'off' ? 'fp-ctrl-active' : ''}`} onClick={cycleRepeat} aria-label={`Repeat ${repeatMode}`} type="button">
              <RepeatIcon size={22} />
            </button>
          </div>

          {/* Bottom Actions */}
          <div className="fp-bottom">
            <button className="fp-bottom-btn" onClick={() => { setIsExpanded(false); onOpenLyrics(); }} aria-label="Lyrics" type="button">
              <FileText size={20} />
              <span>Lyrics</span>
            </button>
            <button className="fp-bottom-btn" onClick={handleShare} aria-label="Share" type="button">
              <Share2 size={20} />
              <span>Share</span>
            </button>
            <button className="fp-bottom-btn" onClick={() => { setIsExpanded(false); onOpenQueue(); }} aria-label="Queue" type="button">
              <ListMusic size={20} />
              <span>Queue</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

