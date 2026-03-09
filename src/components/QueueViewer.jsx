import React from 'react';
import { usePlayer } from '../context/PlayerContext';
import { Play } from 'lucide-react';

const FALLBACK_COVER = 'https://placehold.co/120x120/27272a/71717a?text=%E2%99%AA';

export default function QueueViewer({ isOpen, onClose }) {
  const { queue, queueIndex, playTrack, isPlaying } = usePlayer();

  if (!isOpen) return null;

  return (
    <>
      <div className="queue-overlay" onClick={onClose} />
      <div className="queue-drawer glass-panel" role="dialog" aria-modal="true" aria-labelledby="queue-title">
        <div className="queue-header">
          <h2 id="queue-title">Up Next</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close queue" type="button">
            &times;
          </button>
        </div>

        <div className="queue-list" role="listbox" aria-label="Queue tracks">
          {queue.length === 0 ? (
            <div className="empty-state">No tracks in queue.</div>
          ) : (
            queue.map((track, i) => {
              const isActive = i === queueIndex;
              return (
                <button
                  key={track.id + i}
                  className={`queue-item ${isActive ? 'active' : ''} queue-item-enter`}
                  onClick={() => playTrack(track, queue, { mode: 'list' })}
                  style={{ animationDelay: `${Math.min(i * 24, 220)}ms` }}
                  role="option"
                  aria-selected={isActive}
                  aria-label={`Play queued track ${track.title} by ${track.artist}`}
                  type="button"
                >
                  <div className="queue-cover">
                    <img
                      src={track.coverArt || FALLBACK_COVER}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.src = FALLBACK_COVER;
                      }}
                    />
                    {isActive && isPlaying && (
                      <div className="eq-overlay">
                        <span className="eq-bar small">
                          <span></span>
                          <span></span>
                          <span></span>
                        </span>
                      </div>
                    )}
                    {!isActive && (
                      <div className="play-overlay">
                        <Play fill="white" size={16} />
                      </div>
                    )}
                  </div>
                  <div className="queue-info">
                    <h4>{track.title}</h4>
                    <p>{track.artist}</p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
