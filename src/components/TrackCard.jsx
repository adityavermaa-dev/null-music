import { Heart } from 'lucide-react';
import { usePlayer } from '../context/PlayerContext';

const FALLBACK_COVER = 'https://placehold.co/300x300/27272a/71717a?text=%E2%99%AA';

export default function TrackCard({
  track,
  isFavorite,
  onToggleFavorite,
  trackList,
  playMode = 'list',
  onContextMenu,
  index,
}) {
  const { currentTrack, isPlaying, playTrack } = usePlayer();
  const isActive = currentTrack?.id === track.id;

  const title = track?.title || 'Unknown Track';
  const artist = track?.artist || 'Unknown Artist';
  const coverArt = track?.coverArt || FALLBACK_COVER;

  const handlePlay = () => {
    playTrack(track, trackList, { mode: playMode });
  };

  const openKeyboardContextMenu = () => {
    if (!onContextMenu) return;
    onContextMenu(
      {
        preventDefault: () => {},
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2,
      },
      track,
      trackList
    );
  };

  return (
    <div
      className={`track-card glass-panel ${isActive ? 'track-card--active' : ''}`}
      onClick={handlePlay}
      onContextMenu={(e) => {
        e.preventDefault();
        if (onContextMenu) {
          onContextMenu(e, track, trackList);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Play ${title} by ${artist}`}
      aria-pressed={isActive && isPlaying}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlePlay();
        }
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault();
          openKeyboardContextMenu();
        }
      }}
      style={typeof index === 'number' ? { animationDelay: `${Math.min(index * 30, 240)}ms` } : undefined}
    >
      <div
        className="cover-art"
        style={{
          backgroundImage: `url(${coverArt})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative',
        }}
      >
        <span className={`source-badge ${track.source === 'youtube' ? 'badge-yt' : 'badge-sv'}`}>
          {track.source === 'youtube' ? 'YT' : 'SV'}
        </span>

        {isActive && isPlaying && (
          <div className="playing-overlay">
            <div className="eq-bar">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      <div className="track-info">
        <div className="track-text">
          <h4 className="track-title" title={title}>
            {title}
          </h4>
          <p className="artist-name" title={artist}>
            {artist}
          </p>
        </div>
        <button
          className={`fav-btn ${isFavorite ? 'fav-btn--active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(track);
          }}
          aria-label={isFavorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
          aria-pressed={isFavorite}
          type="button"
        >
          <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  );
}
