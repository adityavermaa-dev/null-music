import React from 'react';

/**
 * GenreBreakdown Component
 * Shows genre distribution as a pie/bar chart
 */
export function GenreBreakdown({ dna }) {
  if (!dna || !dna.genres || dna.genres.length === 0) {
    return (
      <div className="genre-breakdown empty">
        <p>No genre data available yet</p>
      </div>
    );
  }

  const totalPercentage = dna.genres.reduce((sum, g) => sum + g.percentage, 0);
  const otherPercentage = Math.max(0, 100 - totalPercentage);

  return (
    <div className="genre-breakdown">
      <h3>Your Genre Mix</h3>

      <div className="genre-chart">
        <div className="bar-container">
          {dna.genres.map((genre, idx) => (
            <div key={idx} className="genre-bar-wrapper">
              <div className="genre-bar">
                <div
                  className="genre-fill"
                  style={{
                    width: `${genre.percentage}%`,
                    backgroundColor: getGenreColor(genre.genre, idx),
                  }}
                >
                  {genre.percentage > 5 && (
                    <span className="genre-label">{genre.percentage}%</span>
                  )}
                </div>
              </div>
              <label className="genre-name">{genre.genre}</label>
            </div>
          ))}

          {otherPercentage > 0 && (
            <div className="genre-bar-wrapper">
              <div className="genre-bar">
                <div
                  className="genre-fill other"
                  style={{ width: `${otherPercentage}%` }}
                >
                  {otherPercentage > 5 && (
                    <span className="genre-label">{otherPercentage}%</span>
                  )}
                </div>
              </div>
              <label className="genre-name">Other</label>
            </div>
          )}
        </div>
      </div>

      {dna.topArtists && dna.topArtists.length > 0 && (
        <div className="top-artists">
          <h4>Top Artists</h4>
          <ul>
            {dna.topArtists.slice(0, 10).map((artist, idx) => (
              <li key={idx}>{artist}</li>
            ))}
          </ul>
        </div>
      )}

      {dna.decadePreferences && dna.decadePreferences.length > 0 && (
        <div className="decade-preferences">
          <h4>Music Eras</h4>
          <div className="timeline">
            {dna.decadePreferences.map((pref, idx) => (
              <div key={idx} className="decade">
                <label>{Math.floor(pref.year / 10) * 10}s</label>
                <div className="decade-bar">
                  <div
                    className="decade-fill"
                    style={{ width: `${pref.percentage}%` }}
                  />
                </div>
                <span className="percentage">{pref.percentage}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {dna.archetypes && dna.archetypes.length > 0 && (
        <div className="artist-archetypes">
          <h4>Artist Types</h4>
          <div className="archetypes-grid">
            {dna.archetypes.map((arch, idx) => (
              <div key={idx} className="archetype-badge">
                <span className="archetype-icon">
                  {getArchetypeIcon(arch.archetype)}
                </span>
                <span className="archetype-name">{arch.archetype}</span>
                <span className="archetype-percent">{arch.percentage}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Get color for genre
 */
function getGenreColor(genre, index) {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B88B', '#85C1E2',
  ];
  return colors[index % colors.length];
}

/**
 * Get icon for archetype
 */
function getArchetypeIcon(archetype) {
  const icons = {
    innovator: '🚀',
    classic: '👑',
    rebel: '⚡',
    mainstream: '📻',
  };
  return icons[archetype] || '🎵';
}
