/**
 * MUSIC DNA INTEGRATION EXAMPLE
 * 
 * This file shows how to integrate the Music DNA feature into your app.
 * Copy relevant sections into your App.jsx or route setup.
 */

// ═══════════════════════════════════════════════════════
// 1. ADD IMPORT AT TOP OF APP.JSX
// ═══════════════════════════════════════════════════════

import { DNAProfile } from './components/DNAProfile';
import './components/musicDna.css'; // Import styles


// ═══════════════════════════════════════════════════════
// 2. ADD TO ROUTING (if using React Router)
// ═══════════════════════════════════════════════════════

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

function App() {
  return (
    <Router>
      <Routes>
        {/* ... existing routes ... */}
        
        {/* Add Music DNA route */}
        <Route path="/dna" element={
          <ProtectedRoute>
            <DNAProfile />
          </ProtectedRoute>
        } />
        
        {/* ... other routes ... */}
      </Routes>
    </Router>
  );
}


// ═══════════════════════════════════════════════════════
// 3. ADD NAVIGATION LINK IN SIDEBAR.JSX
// ═══════════════════════════════════════════════════════

import { Link } from 'react-router-dom';

export function Sidebar() {
  return (
    <aside className="sidebar">
      <nav className="nav-menu">
        {/* ... existing nav items ... */}
        
        {/* Add DNA link */}
        <Link to="/dna" className="nav-item">
          <span className="icon">🧬</span>
          <span className="label">My DNA</span>
        </Link>
        
        {/* ... other nav items ... */}
      </nav>
    </aside>
  );
}


// ═══════════════════════════════════════════════════════
// 4. INTEGRATE TRACK PLAY RECORDING
// ═══════════════════════════════════════════════════════

// In your PlaybackBar or Player component:

import { recordTrackPlay } from '../api/trackPlayLogger';

export function Player() {
  const handleTrackEnded = async (track, playedSeconds, totalSeconds) => {
    const completionRatio = playedSeconds / totalSeconds;

    // Only record if played >30%
    if (completionRatio > 0.3) {
      try {
        // Fetch track features from Spotify if available
        const features = await getTrackFeatures(track);

        // Record the play
        await recordTrackPlay({
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          completionRatio,
          features,
        });

        // Invalidate DNA cache so it recalculates
        // (Optional - can also wait 24 hours for automatic refresh)
        // await invalidateDNACache();
      } catch (error) {
        console.error('Error recording track play:', error);
        // Continue playback even if logging fails
      }
    }
  };

  return (
    <div className="player">
      <audio 
        onEnded={() => handleTrackEnded(currentTrack, audio.currentTime, audio.duration)}
        {...audioProps}
      />
    </div>
  );
}


// ═══════════════════════════════════════════════════════
// 5. TRACK FEATURES HELPER FUNCTION
// ═══════════════════════════════════════════════════════

/**
 * Get/generate audio features for a track
 */
async function getTrackFeatures(track) {
  // If features already cached in track object
  if (track.features) {
    return track.features;
  }

  // Try to get from Spotify API
  if (track.spotifyId) {
    try {
      const response = await fetch(
        `/api/track/features?spotifyId=${track.spotifyId}`
      );
      if (response.ok) {
        const data = await response.json();
        return data.features;
      }
    } catch (error) {
      console.warn('Could not fetch Spotify features:', error);
    }
  }

  // Generate basic features based on metadata
  return generateDefaultFeatures(track);
}

/**
 * Generate default features when Spotify data unavailable
 */
function generateDefaultFeatures(track) {
  // Parse genre and create basic features
  const genres = track.genres || [];
  const isAcoustic = track.title?.includes('Acoustic') || genres.includes('acoustic');
  const isFast = (track.duration || 0) < 150; // < 2:30 min tends to be fast

  return {
    energy: isFast ? 0.6 : 0.4,
    valence: 0.5, // Neutral default
    acousticness: isAcoustic ? 0.7 : 0.2,
    danceability: 0.5,
    tempo: isFast ? 130 : 100,
    key: 'C', // Default
    timeSignature: 4,
    genres: genres,
    releaseYear: track.year || new Date().getFullYear(),
    artistArchetype: inferArchetype(track.artist, genres),
  };
}

/**
 * Infer artist archetype from name and genres
 */
function inferArchetype(artist, genres = []) {
  if (!artist) return 'mainstream';

  const name = artist.toLowerCase();
  const genreStr = genres.join(' ').toLowerCase();

  if (genreStr.includes('indie') || genreStr.includes('alternative')) {
    return 'innovator';
  }
  if (genreStr.includes('classic') || genreStr.includes('rock') || ['beatles', 'pink floyd'].includes(name)) {
    return 'classic';
  }
  if (name.includes('remix') || genreStr.includes('electronic')) {
    return 'innovator';
  }
  if (genreStr.includes('metal') || genreStr.includes('punk')) {
    return 'rebel';
  }

  return 'mainstream'; // Default
}


// ═══════════════════════════════════════════════════════
// 6. API HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Record a track play on the server
 */
export async function recordTrackPlay(trackData) {
  const token = localStorage.getItem('auth_token');

  const response = await fetch('/api/track/play', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(trackData),
  });

  if (!response.ok) {
    throw new Error(`Failed to record track play: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Get user's DNA profile
 */
export async function getUserDNA() {
  const token = localStorage.getItem('auth_token');

  const response = await fetch('/api/user/dna', {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch DNA: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Refresh user's DNA profile
 */
export async function refreshUserDNA() {
  const token = localStorage.getItem('auth_token');

  const response = await fetch('/api/user/dna/refresh', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh DNA: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Get sonic twins (similar artists)
 */
export async function getSonicTwins(limit = 10) {
  const token = localStorage.getItem('auth_token');

  const response = await fetch(`/api/user/sonic-twins?limit=${limit}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch sonic twins: ${response.statusText}`);
  }

  return await response.json();
}


// ═══════════════════════════════════════════════════════
// 7. CONTEXT/HOOK FOR DNA STATE (Optional)
// ═══════════════════════════════════════════════════════

import { createContext, useState, useEffect, useContext } from 'react';

const DNAContext = createContext();

export function DNAProvider({ children }) {
  const [dna, setDNA] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchDNA = async () => {
    try {
      setLoading(true);
      const data = await getUserDNA();
      setDNA(data.dna);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DNAContext.Provider value={{ dna, loading, error, fetchDNA }}>
      {children}
    </DNAContext.Provider>
  );
}

export function useDNA() {
  return useContext(DNAContext);
}

// Usage in App:
// <DNAProvider>
//   <App />
// </DNAProvider>


// ═══════════════════════════════════════════════════════
// 8. SERVER-SIDE: ADD TRACK PLAY ENDPOINT TO server.mjs
// ═══════════════════════════════════════════════════════

// Add this to server.mjs after auth endpoints:

import { recordTrackPlay } from './backend/reco/trackPlayLogger.mjs';

/**
 * POST /api/track/play
 * Record a track play event
 */
app.post('/api/track/play', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { trackId, title, artist, completionRatio, features } = req.body;

    if (!userId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const recorded = await recordTrackPlay(userId, {
      id: trackId,
      title,
      artist,
    }, completionRatio, features);

    res.json({ ok: true, recorded });
  } catch (error) {
    logger.error('Error recording track play:', error);
    res.status(500).json({ error: 'Failed to record play' });
  }
});


// ═══════════════════════════════════════════════════════
// 9. INITIALIZE DATABASE ON STARTUP
// ═══════════════════════════════════════════════════════

// In server.mjs startup code:

import { initializeMusicDNASchema } from './backend/db/musicDnaSchema.mjs';

// Run on server start
async function initializeApp() {
  try {
    await initializeMusicDNASchema(pool);
    console.log('✓ Music DNA database schema ready');
  } catch (error) {
    logger.error('Failed to initialize Music DNA schema:', error);
  }
}

initializeApp();


// ═══════════════════════════════════════════════════════
// 10. EXAMPLE: CREATE TEST DATA
// ═══════════════════════════════════════════════════════

/**
 * For development/testing: Create sample DNA profile
 */
async function createTestDNAData() {
  const userId = 'test-user-123';
  const testTracks = [
    {
      id: 'track1',
      title: 'Song 1',
      artist: 'Artist A',
      completionRatio: 1.0,
      features: {
        energy: 0.7,
        valence: 0.8,
        genres: ['indie'],
        tempo: 120,
      },
    },
    // Add 50+ more tracks...
  ];

  for (const track of testTracks) {
    await recordTrackPlay(userId, track, track.completionRatio, track.features);
  }

  // Calculate DNA
  const { calculateUserDNA } = await import('./backend/reco/musicDna.mjs');
  const dna = await calculateUserDNA(userId);

  console.log('Test DNA created:', dna);
}

// Call: createTestDNAData()


// ═══════════════════════════════════════════════════════
// SUMMARY OF FILES TO MODIFY
// ═══════════════════════════════════════════════════════

/*

1. app.jsx (or main router)
   - Import DNAProfile component
   - Add /dna route
   - Wrap with ProtectedRoute

2. Sidebar.jsx (or nav component)
   - Add link to /dna

3. PlaybackBar.jsx (or similar)
   - Import recordTrackPlay
   - Call on track completion
   - Get/generate track features

4. server.mjs
   - Add imports for Music DNA modules
   - Add POST /api/track/play endpoint
   - Run initializeMusicDNASchema() on startup

5. index.css or App.css
   - Import musicDna.css

*/
