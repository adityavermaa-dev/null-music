import { usePlayer } from '../context/PlayerContext';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  Volume1,
  VolumeX,
  Shuffle,
  Repeat,
  Repeat1,
  Infinity as InfinityIcon,
  MoonStar,
  ListMusic,
  FileText,
} from 'lucide-react';

const FALLBACK_COVER = 'https://placehold.co/300x300/27272a/71717a?text=%E2%99%AA';

export default function PlaybackBar({ onOpenLyrics, onOpenQueue }) {
  const {
    currentTrack,
    isPlaying,
    progress,
    duration,
    volume,
    isLoading,
    playbackError,
    shuffleMode,
    repeatMode,
    autoRadioEnabled,
    sleepTimerMinutes,
    dominantColor,
    togglePlay,
    setVolume,
    seekTo,
    skipNext,
    skipPrev,
    toggleShuffle,
    cycleRepeat,
    toggleAutoRadio,
    cycleSleepTimer,
  } = usePlayer();

  const formatTime = (seconds) => {
    if (isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleProgressClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    if (duration) seekTo(pct * duration);
  };

  const handleVolumeClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setVolume(Math.max(0, Math.min(1, x / rect.width)));
  };

  const RepeatIcon = repeatMode === 'one' ? Repeat1 : Repeat;
  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const progressPct = duration ? (progress / duration) * 100 : 0;
  const glowColor = dominantColor?.replace('rgb', 'rgba').replace(')', ', 0.12)') || 'transparent';

  return (
    <footer className="playback-bar" style={{ '--bar-glow': glowColor }} aria-label="Playback controls">
      {/* ── Now Playing ── */}
      <div className="pb-now">
        {currentTrack ? (
          <>
            <div
              className="pb-cover"
              style={{
                backgroundImage: `url(${currentTrack.coverArt || FALLBACK_COVER})`,
              }}
            />
            <div className="pb-track-info">
              <h4 className="pb-title">{currentTrack.title}</h4>
              <p className="pb-artist">{currentTrack.artist}</p>
              {playbackError ? (
                <p className="pb-error error-text" role="status" aria-live="polite">{playbackError}</p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="pb-empty">Select a track to play</div>
        )}
      </div>

      {/* ── Center: Controls + Progress ── */}
      <div className="pb-center">
        <div className="pb-buttons">
          <button
            className={`pb-btn icon-btn ${shuffleMode ? 'control-active' : ''}`}
            onClick={toggleShuffle}
            title="Shuffle"
            aria-label="Toggle shuffle"
            type="button"
          >
            <Shuffle size={16} />
          </button>

          <button className="pb-btn icon-btn" onClick={skipPrev} title="Previous" aria-label="Previous track" type="button">
            <SkipBack size={18} fill="currentColor" />
          </button>

          <button
            className="pb-play-btn"
            onClick={togglePlay}
            disabled={!currentTrack}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            type="button"
          >
            {isLoading ? (
              <div className="spinner" />
            ) : isPlaying ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
            )}
          </button>

          <button className="pb-btn icon-btn" onClick={skipNext} title="Next" aria-label="Next track" type="button">
            <SkipForward size={18} fill="currentColor" />
          </button>

          <button
            className={`pb-btn icon-btn ${repeatMode !== 'off' ? 'control-active' : ''}`}
            onClick={cycleRepeat}
            title={`Repeat: ${repeatMode}`}
            aria-label={`Repeat mode ${repeatMode}`}
            type="button"
          >
            <RepeatIcon size={16} />
          </button>
        </div>

        <div className="pb-progress">
          <span className="pb-time">{formatTime(progress)}</span>
          <div
            className="pb-progress-bar"
            onClick={handleProgressClick}
            role="slider"
            tabIndex={0}
            aria-label="Track progress"
            aria-valuemin={0}
            aria-valuemax={Math.max(duration || 0, 1)}
            aria-valuenow={Math.min(progress || 0, duration || 0)}
            onKeyDown={(e) => {
              if (!duration) return;
              if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(Math.min(duration, (progress || 0) + 5)); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(Math.max(0, (progress || 0) - 5)); }
            }}
          >
            <div className="pb-progress-fill" style={{ width: `${progressPct}%` }}>
              <div className="pb-progress-thumb" />
            </div>
          </div>
          <span className="pb-time">{formatTime(duration || currentTrack?.duration || 0)}</span>
        </div>
      </div>

      {/* ── Right: Extra Controls ── */}
      <div className="pb-extra">
        <button
          className={`icon-btn ${autoRadioEnabled ? 'control-active' : ''}`}
          onClick={toggleAutoRadio}
          title="Autoplay similar"
          aria-label="Toggle autoplay"
          type="button"
        >
          <InfinityIcon size={18} />
        </button>
        <button
          className={`icon-btn ${sleepTimerMinutes ? 'control-active' : ''}`}
          onClick={cycleSleepTimer}
          title={`Sleep: ${sleepTimerMinutes ? `${sleepTimerMinutes}m` : 'Off'}`}
          aria-label={`Sleep timer ${sleepTimerMinutes ? `${sleepTimerMinutes} minutes` : 'off'}`}
          type="button"
        >
          <MoonStar size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenLyrics}
          title="Lyrics"
          disabled={!currentTrack || currentTrack.source !== 'saavn' || !currentTrack.hasLyrics}
          style={{ opacity: !currentTrack || currentTrack.source !== 'saavn' || !currentTrack.hasLyrics ? 0.3 : 1 }}
          aria-label="Lyrics"
          type="button"
        >
          <FileText size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenQueue} title="Queue" aria-label="Queue" type="button">
          <ListMusic size={18} />
        </button>

        <div className="pb-vol-group">
          <button className="icon-btn" onClick={() => setVolume(volume > 0 ? 0 : 0.8)} aria-label={volume === 0 ? 'Unmute' : 'Mute'} type="button">
            <VolumeIcon size={18} />
          </button>
          <div
            className="pb-vol-bar"
            onClick={handleVolumeClick}
            role="slider"
            tabIndex={0}
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(volume * 100)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setVolume(Math.min(1, volume + 0.05)); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setVolume(Math.max(0, volume - 0.05)); }
            }}
          >
            <div className="pb-vol-fill" style={{ width: `${volume * 100}%` }}>
              <div className="pb-progress-thumb" />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}


