import React, { useState, useEffect } from 'react';
import { usePlayer } from '../context/PlayerContext';
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Repeat, Shuffle, ListMusic, FileText, Infinity as InfinityIcon } from 'lucide-react';

const FALLBACK_COVER = 'https://placehold.co/500x500/27272a/71717a?text=%E2%99%AA';

export default function MobilePlayer({ onOpenLyrics, onOpenQueue }) {
  const {
    currentTrack,
    isPlaying,
    progress,
    duration,
    isLoading,
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

  const glowColor = dominantColor.replace('rgb', 'rgba').replace(')', ', 0.6)');

  return (
    <div className="mobile-player-wrapper" aria-live="polite">
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
        <div className="mini-progress-bar" style={{ width: `${progressPercent}%` }} />
        <div className="mini-content">
          <img src={coverArt} alt="" className="mini-cover" onError={handleImageError} />
          <div className="mini-info">
            <div className="mini-title">{currentTrack.title}</div>
            <div className="mini-artist">{currentTrack.artist}</div>
          </div>
          <div className="mini-controls" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" onClick={togglePlay} disabled={isLoading} aria-label={isPlaying ? 'Pause' : 'Play'} type="button">
              {isLoading ? <div className="spinner" /> : isPlaying ? <Pause fill="currentColor" size={24} /> : <Play fill="currentColor" size={24} />}
            </button>
          </div>
        </div>
      </div>

      <div
        className={`mobile-full-player ${isExpanded ? 'expanded' : ''}`}
        style={{
          background: `linear-gradient(to bottom, ${glowColor} 0%, var(--surface-100) 80%)`,
        }}
      >
        <div className="full-header">
          <button className="icon-btn" onClick={() => setIsExpanded(false)} aria-label="Collapse player" type="button">
            <ChevronDown size={28} />
          </button>
          <span className="now-playing-text">Now Playing</span>
          <div style={{ width: 28 }} />
        </div>

        <div className="full-art-container">
          <img src={coverArt} alt="" className="full-cover" onError={handleImageError} />
        </div>

        <div className="full-info">
          <h2 className="full-title">{currentTrack.title}</h2>
          <p className="full-artist">{currentTrack.artist}</p>
        </div>

        <div className="full-progress">
          <input
            type="range"
            min={0}
            max={safeDuration || 100}
            value={Math.max(0, Math.min(progress, safeDuration || 100))}
            onChange={handleProgressScrub}
            className="mobile-progress-slider"
            style={{
              background: `linear-gradient(to right, var(--text-100) ${progressPercent}%, rgba(255,255,255,0.2) ${progressPercent}%)`,
            }}
            aria-label="Track progress"
          />
          <div className="time-labels">
            <span>{formatTime(progress)}</span>
            <span>{formatTime(safeDuration)}</span>
          </div>
        </div>

        <div className="full-controls-main">
          <button className={`icon-btn ${shuffleMode ? 'control-active' : ''}`} onClick={toggleShuffle} aria-label="Toggle shuffle" type="button">
            <Shuffle size={24} />
          </button>
          <button className="icon-btn" onClick={skipPrev} aria-label="Previous track" type="button">
            <SkipBack fill="currentColor" size={32} />
          </button>
          <button className="play-pause-btn-large" onClick={togglePlay} disabled={isLoading} aria-label={isPlaying ? 'Pause' : 'Play'} type="button">
            {isLoading ? <div className="spinner" /> : isPlaying ? <Pause fill="currentColor" size={36} /> : <Play fill="currentColor" size={36} style={{ marginLeft: 4 }} />}
          </button>
          <button className="icon-btn" onClick={skipNext} aria-label="Next track" type="button">
            <SkipForward fill="currentColor" size={32} />
          </button>
          <button className={`icon-btn ${repeatMode !== 'off' ? 'control-active' : ''}`} onClick={cycleRepeat} aria-label={`Repeat mode ${repeatMode}`} type="button">
            <Repeat size={24} />
          </button>
        </div>

        <div className="full-controls-bottom">
          <button
            className={`icon-btn ${autoRadioEnabled ? 'control-active' : ''}`}
            onClick={toggleAutoRadio}
            aria-label="Autoplay similar songs"
            type="button"
          >
            <InfinityIcon size={22} />
          </button>
          <button className="icon-btn" onClick={() => { setIsExpanded(false); onOpenLyrics(); }} aria-label="Open lyrics" type="button">
            <FileText size={24} />
          </button>
          <button className="icon-btn" onClick={() => { setIsExpanded(false); onOpenQueue(); }} aria-label="Open queue" type="button">
            <ListMusic size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}

