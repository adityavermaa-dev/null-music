import React from 'react';

/**
 * UserDNACard Component
 * Displays a shareable card view of the user's music DNA
 */
export function UserDNACard({ dna }) {
  if (!dna) return null;

  const topGenres = dna.genres?.slice(0, 3)?.map(g => g.genre).join(', ') || 'Various';
  const vibe = getMainVibe(dna);
  const shareText = [
    'My Music DNA',
    `Top genres: ${topGenres}`,
    `Vibe: ${vibe}`,
    `Tracks analyzed: ${dna.trackCount || 0}`,
  ].join('\n');

  async function handleShare() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'My Music DNA',
          text: shareText,
        });
        return;
      }

      await navigator.clipboard?.writeText(shareText);
      showDownloadOption(shareText);
    } catch (error) {
      console.error('Error sharing DNA card:', error);
      showDownloadOption(shareText);
    }
  }

  return (
    <div className="dna-card-container">
      <div className="dna-card">
        <div className="card-header">
          <h2>🧬 My Music DNA</h2>
        </div>

        <div className="card-content">
          <div className="card-stat">
            <span className="stat-label">Primary Genres</span>
            <span className="stat-value">{topGenres}</span>
          </div>

          <div className="card-stat">
            <span className="stat-label">Energy</span>
            <div className="mini-bar">
              <div
                className="mini-fill"
                style={{ width: `${(dna.energyAverage || 0.5) * 100}%` }}
              />
            </div>
            <span className="stat-value">{Math.round((dna.energyAverage || 0.5) * 100)}%</span>
          </div>

          <div className="card-stat">
            <span className="stat-label">Mood</span>
            <div className="mini-bar">
              <div
                className="mini-fill mood"
                style={{ width: `${(dna.valenceAverage || 0.5) * 100}%` }}
              />
            </div>
            <span className="stat-value">{getMoodEmoji(dna.valenceAverage)}</span>
          </div>

          <div className="card-stat">
            <span className="stat-label">Vibe</span>
            <span className="stat-value vibe-text">{vibe}</span>
          </div>

          <div className="card-stat">
            <span className="stat-label">Tracks Analyzed</span>
            <span className="stat-value">{dna.trackCount || 0}</span>
          </div>
        </div>

        <div className="card-footer">
          <p>Generated on {new Date(dna.calculatedAt).toLocaleDateString()}</p>
          <p className="app-mention">Powered by Null Music</p>
        </div>
      </div>

      <div className="card-actions">
        <button onClick={handleShare} className="share-btn">
          📤 Share
        </button>
        <button onClick={handleDownload} className="download-btn">
          ⬇️ Download
        </button>
      </div>
    </div>
  );
}

/**
 * Get main vibe description
 */
function getMainVibe(dna) {
  const energy = dna.energyAverage || 0.5;
  const valence = dna.valenceAverage || 0.5;
  const dance = dna.danceabilityAverage || 0.5;

  if (energy > 0.7 && valence > 0.6 && dance > 0.6) {
    return '🔥 High-energy Party';
  } else if (energy > 0.7 && valence < 0.4) {
    return '⚡ Intense & Moody';
  } else if (energy < 0.3 && valence > 0.6) {
    return '🌸 Calm & Positive';
  } else if (energy < 0.3 && valence < 0.4) {
    return '🌙 Melancholic & Deep';
  } else if (dance > 0.75) {
    return '🎵 Groovy & Danceable';
  } else if (dna.acousticnessAverage > 0.6) {
    return '🎸 Acoustic & Raw';
  } else {
    return '🎶 Balanced & Versatile';
  }
}

/**
 * Get mood emoji
 */
function getMoodEmoji(valence) {
  if (valence > 0.7) return '😊 Happy';
  if (valence > 0.5) return '🙂 Positive';
  if (valence > 0.3) return '😐 Neutral';
  return '😔 Melancholic';
}

/**
 * Handle downloading DNA card as image
 */
function handleDownload() {
  const data = JSON.stringify({
    title: 'My Music DNA',
    generatedAt: new Date().toISOString(),
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'my-music-dna.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

/**
 * Show download option (fallback)
 */
function showDownloadOption(textData) {
  const link = document.createElement('a');
  const blob = new Blob([textData], { type: 'text/plain' });
  link.href = URL.createObjectURL(blob);
  link.download = 'my-music-dna.txt';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
