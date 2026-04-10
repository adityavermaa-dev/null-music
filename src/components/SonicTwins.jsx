import React, { useCallback, useEffect, useState } from 'react';
import { buildApiUrl } from '../api/apiBase';
import { getStoredAuthSession } from '../utils/authSession';

const TWINS_CACHE_KEY = 'null-music-dna-twins-cache';
const TWINS_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

/**
 * SonicTwins Component
 * Shows similar artists based on user's DNA profile
 */
export function SonicTwins() {
  const [twins, setTwins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;

  function getAuthHeaders() {
    const token = getStoredAuthSession()?.token || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function parseJsonOrThrow(response, fallbackMessage) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      throw new Error(fallbackMessage);
    }
    return response.json();
  }

  async function parseErrorBody(response, fallbackMessage) {
    try {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const body = await response.json();
        return body?.error || body?.hint || fallbackMessage;
      }
    } catch {
      // ignore parse failures
    }
    return fallbackMessage;
  }

  function readCachedTwins() {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(TWINS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.twins) || !parsed?.savedAt) return null;
      if (Date.now() - Number(parsed.savedAt) > TWINS_CACHE_TTL_MS) return null;
      return parsed.twins;
    } catch {
      return null;
    }
  }

  function saveCachedTwins(nextTwins) {
    if (typeof window === 'undefined' || !Array.isArray(nextTwins)) return;
    try {
      window.localStorage.setItem(TWINS_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        twins: nextTwins,
      }));
    } catch {
      // ignore storage failures
    }
  }

  const fetchSonicTwins = useCallback(async () => {
    try {
      const cachedTwins = readCachedTwins();
      if (cachedTwins && isOffline) {
        setTwins(cachedTwins);
        setError('You are offline. Showing your last saved sonic twins.');
        setLoading(false);
        return;
      }

      if (cachedTwins && !isOffline) {
        setTwins(cachedTwins);
        setLoading(false);
      } else {
        setLoading(true);
      }

      const response = await fetch(buildApiUrl('/user/sonic-twins?limit=20'), {
        headers: {
          ...getAuthHeaders(),
        },
      });

      if (!response.ok) {
        if (cachedTwins) {
          setTwins(cachedTwins);
          setError('Music DNA service is unavailable. Showing cached sonic twins.');
          setLoading(false);
          return;
        }
        const message = await parseErrorBody(response, `Failed to fetch sonic twins (${response.status || 'unknown'})`);
        throw new Error(message);
      }

      const data = await parseJsonOrThrow(response, 'Sonic Twins service returned an invalid response. Check API base URL.');
      setTwins(data.sonicTwins || []);
      saveCachedTwins(data.sonicTwins || []);
      setError(null);
    } catch (err) {
      const cachedTwins = readCachedTwins();
      if (cachedTwins) {
        setTwins(cachedTwins);
        setError('Music DNA is offline. Showing your cached sonic twins.');
      } else {
        setError(err.message || 'Failed to load sonic twins');
      }
      console.error('Error fetching sonic twins:', err);
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void fetchSonicTwins();
  }, [fetchSonicTwins]);

  if (loading) {
    return (
      <div className="sonic-twins loading">
        <div className="spinner">Finding your sonic twins...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sonic-twins error">
        <div className="offline-banner">{isOffline ? 'Offline mode' : 'Music DNA notice'}</div>
        <p>{error}</p>
        <button onClick={fetchSonicTwins} className="retry-btn" type="button">Retry</button>
      </div>
    );
  }

  if (!twins || twins.length === 0) {
    return (
      <div className="sonic-twins empty">
        <p>No sonic twins found yet. Play more tracks to discover artists like you!</p>
      </div>
    );
  }

  return (
    <div className="sonic-twins">
      <h3>🌟 Your Sonic Twins</h3>
      <p className="subtitle">
        Artists who share your musical DNA – discover your next favorite artist
      </p>

      <div className="twins-grid">
        {twins.map((twin, idx) => (
          <div key={idx} className="twin-card">
            <div className="twin-rank">{idx + 1}</div>
            <div className="twin-info">
              <h4>{twin.artist}</h4>
              <p className="match-score">
                <span className="percentage">{twin.matchPercentage}%</span>
                <span className="label">match</span>
              </p>
              <p className="reason">{twin.reason || 'Musical match'}</p>
            </div>
            <div className="twin-actions">
              <button className="search-btn" onClick={() => handleSearchArtist(twin.artist)}>
                🔍 Find
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="twins-info">
        <h4>What are Sonic Twins?</h4>
        <p>
          Based on your music DNA (energy, mood, genres, and artist preferences),
          these are artists you've never heard of but would likely love. Each match
          is calculated using advanced similarity algorithms.
        </p>
      </div>
    </div>
  );
}

/**
 * Handle searching for an artist
 */
function handleSearchArtist(artist) {
  // Dispatch search event or navigate to search results
  const searchEvent = new CustomEvent('search-artist', { detail: { artist } });
  window.dispatchEvent(searchEvent);
}
