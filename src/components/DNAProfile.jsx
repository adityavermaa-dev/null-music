import React, { useEffect, useState } from 'react';
import { DNAHelix } from './DNAHelix';
import { GenreBreakdown } from './GenreBreakdown';
import { SonicTwins } from './SonicTwins';
import { UserDNACard } from './UserDNACard';
import { buildApiUrl } from '../api/apiBase';
import { getStoredAuthSession } from '../utils/authSession';
import './musicDna.css';

/**
 * DNAProfile Component
 * Main display for user's music DNA profile
 */
export function DNAProfile() {
  const [dna, setDNA] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    fetchDNA();
  }, []);

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

  async function fetchDNA() {
    try {
      setLoading(true);
      const response = await fetch(buildApiUrl('/user/dna'), {
        headers: {
          ...getAuthHeaders(),
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch DNA: ${response.statusText}`);
      }

      const data = await parseJsonOrThrow(response, 'Music DNA service returned an invalid response. Check API base URL.');
      setDNA(data.dna);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load DNA profile');
      console.error('Error fetching DNA:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshDNA() {
    try {
      setLoading(true);
      const response = await fetch(buildApiUrl('/user/dna/refresh'), {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to refresh DNA: ${response.statusText}`);
      }

      const data = await parseJsonOrThrow(response, 'Music DNA refresh returned an invalid response. Check API base URL.');
      setDNA(data.dna);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to refresh DNA profile');
      console.error('Error refreshing DNA:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="dna-profile loading">
        <div className="spinner">Analyzing your music...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dna-profile error">
        <div className="error-message">{error}</div>
        <button onClick={fetchDNA} className="retry-btn">
          Retry
        </button>
      </div>
    );
  }

  if (!dna) {
    return (
      <div className="dna-profile empty">
        <p>No DNA data available. Start playing tracks to build your profile.</p>
      </div>
    );
  }

  return (
    <div className="dna-profile">
      <div className="dna-header">
        <h1>🧬 Your Music DNA</h1>
        <p className="dna-subtitle">Your unique musical fingerprint based on {dna.trackCount || 0} tracks</p>
        <button onClick={handleRefreshDNA} className="refresh-btn">
          ↻ Refresh
        </button>
      </div>

      <UserDNACard dna={dna} />

      <div className="dna-tabs">
        <button
          className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`tab-btn ${activeTab === 'genres' ? 'active' : ''}`}
          onClick={() => setActiveTab('genres')}
        >
          Genres
        </button>
        <button
          className={`tab-btn ${activeTab === 'twins' ? 'active' : ''}`}
          onClick={() => setActiveTab('twins')}
        >
          Sonic Twins
        </button>
      </div>

      {activeTab === 'overview' && (
        <div className="dna-section overview">
          <div className="dna-helix-container">
            <DNAHelix dna={dna} />
          </div>

          <div className="dna-stats">
            <div className="stat">
              <label>Energy Level</label>
              <div className="stat-bar">
                <div 
                  className="stat-fill" 
                  style={{ width: `${(dna.energyAverage || 0.5) * 100}%` }}
                />
              </div>
              <span>{Math.round((dna.energyAverage || 0.5) * 100)}%</span>
            </div>

            <div className="stat">
              <label>Mood (Positivity)</label>
              <div className="stat-bar">
                <div 
                  className="stat-fill mood" 
                  style={{ width: `${(dna.valenceAverage || 0.5) * 100}%` }}
                />
              </div>
              <span>{Math.round((dna.valenceAverage || 0.5) * 100)}%</span>
            </div>

            <div className="stat">
              <label>Danceability</label>
              <div className="stat-bar">
                <div 
                  className="stat-fill dance" 
                  style={{ width: `${(dna.danceabilityAverage || 0.5) * 100}%` }}
                />
              </div>
              <span>{Math.round((dna.danceabilityAverage || 0.5) * 100)}%</span>
            </div>

            <div className="stat">
              <label>Acoustic Feel</label>
              <div className="stat-bar">
                <div 
                  className="stat-fill acoustic" 
                  style={{ width: `${(dna.acousticnessAverage || 0.3) * 100}%` }}
                />
              </div>
              <span>{Math.round((dna.acousticnessAverage || 0.3) * 100)}%</span>
            </div>

            <div className="stat">
              <label>Average Tempo</label>
              <div className="stat-value">{dna.tempoAverage || 120} BPM</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'genres' && (
        <div className="dna-section genres">
          <GenreBreakdown dna={dna} />
        </div>
      )}

      {activeTab === 'twins' && (
        <div className="dna-section twins">
          <SonicTwins />
        </div>
      )}

      <div className="dna-footer">
        <p className="calculated-at">
          Calculated: {new Date(dna.calculatedAt).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}
