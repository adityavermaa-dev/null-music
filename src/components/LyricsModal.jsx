import React, { useEffect, useState, useCallback } from 'react';
import { saavnApi } from '../api/saavn';
import { usePlayer } from '../context/PlayerContext';

const LyricsModal = ({ isOpen, onClose }) => {
  const { currentTrack } = usePlayer();
  const [lyrics, setLyrics] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadLyrics = useCallback(async () => {
    if (!isOpen || !currentTrack) return;

    if (currentTrack.source !== 'saavn') {
      setLyrics('Lyrics are only available for Saavn tracks.');
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await saavnApi.getLyricsSafe(currentTrack.id);
      if (!result.ok) {
        setError(result.error || 'Failed to load lyrics.');
        setLyrics(null);
      } else if (result.data) {
        const cleanLyrics = result.data.replace(/<br\s*[/]?>/gi, '\n');
        setLyrics(cleanLyrics);
      } else {
        setLyrics('No lyrics found for this track.');
      }
    } catch {
      setError('Failed to load lyrics.');
      setLyrics(null);
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, currentTrack]);

  useEffect(() => {
    loadLyrics();
  }, [loadLyrics]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content lyrics-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lyrics-title"
      >
        <div className="modal-header">
          <h2 id="lyrics-title">Lyrics - {currentTrack?.title}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close lyrics" type="button">
            &times;
          </button>
        </div>
        <div className="modal-body lyrics-body">
          {isLoading ? (
            <div className="spinner"></div>
          ) : error ? (
            <div className="lyrics-error-state">
              <p className="error-text">{error}</p>
              <button type="button" className="btn-secondary" onClick={loadLyrics}>
                Retry
              </button>
            </div>
          ) : (
            <pre className="lyrics-text">{lyrics}</pre>
          )}
        </div>
      </div>
    </div>
  );
};

export default LyricsModal;

