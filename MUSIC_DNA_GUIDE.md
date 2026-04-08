# 🧬 Music DNA Feature

A unique, personalized music profile that analyzes a user's listening history and creates a visual representation of their musical identity.

## Overview

Music DNA builds a comprehensive profile of your musical taste by analyzing:
- **Genres** - Your genre distribution and preferences
- **Energy Levels** - How energetic or mellow your music is
- **Mood (Valence)** - How happy/sad or positive/negative
- **Danceability** - How groove-focused your taste is
- **Acousticness** - How acoustic vs. electronic your preferences lean
- **Tempo** - Your average BPM preference
- **Key & Time Signatures** - Musical technical preferences
- **Artist Types** - Innovators, rebels, classics, mainstream
- **Sonic Twins** - Similar artists you've never heard of

## Components

### Frontend Components

1. **DNAProfile** (`src/components/DNAProfile.jsx`)
   - Main container component
   - Manages data fetching and UI state
   - Tab navigation for different views

2. **DNAHelix** (`src/components/DNAHelix.jsx`)
   - Animated SVG visualization of the DNA profile
   - Color-coding based on energy and mood
   - Rotates continuously for visual engagement

3. **GenreBreakdown** (`src/components/GenreBreakdown.jsx`)
   - Genre distribution charts
   - Top artists list
   - Decade preferences
   - Artist archetypes

4. **SonicTwins** (`src/components/SonicTwins.jsx`)
   - Similar artists recommendations
   - Match percentage for each artist
   - Search integration for discovering new music

5. **UserDNACard** (`src/components/UserDNACard.jsx`)
   - Shareable card format
   - Export/download capabilities
   - Quick stats summary

### Backend Services

1. **musicDna.mjs** (`backend/reco/musicDna.mjs`)
   - `calculateUserDNA(userId)` - Compute DNA from play history
   - `getUserDNA(userId)` - Fetch cached DNA profile
   - `findSonicTwins(userId, limit)` - Find similar artists
   - `invalidateUserDNA(userId)` - Clear cache on library changes

2. **musicDnaSchema.mjs** (`backend/db/musicDnaSchema.mjs`)
   - Database schema initialization
   - Creates necessary tables and indexes

## API Endpoints

### GET `/api/user/dna`
Fetch user's music DNA profile

**Headers:**
```
Authorization: Bearer {token}
```

**Response:**
```json
{
  "ok": true,
  "dna": {
    "genres": [
      { "genre": "indie", "percentage": 35 },
      { "genre": "alt-rock", "percentage": 25 }
    ],
    "energyAverage": 0.65,
    "energyRange": [0.2, 0.9],
    "valenceAverage": 0.55,
    "danceabilityAverage": 0.45,
    "tempoAverage": 115,
    "topArtists": ["Artist 1", "Artist 2"],
    "trackCount": 245,
    "calculatedAt": "2024-01-15T10:30:00Z"
  }
}
```

### POST `/api/user/dna/refresh`
Recalculate user's DNA (force refresh)

**Headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Response:**
Same as GET endpoint

### GET `/api/user/sonic-twins?limit=10`
Get similar artists based on DNA profile

**Query Parameters:**
- `limit` (optional, default: 10, max: 50) - Number of recommendations

**Headers:**
```
Authorization: Bearer {token}
```

**Response:**
```json
{
  "ok": true,
  "sonicTwins": [
    {
      "artist": "Similar Artist Name",
      "matchPercentage": 87,
      "reason": "Matches your indie taste"
    }
  ]
}
```

## Database Schema

### user_dna_profiles
```sql
CREATE TABLE user_dna_profiles (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  dna_id TEXT NOT NULL,
  profile_data JSONB NOT NULL,
  calculated_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### user_tracks
```sql
CREATE TABLE user_tracks (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  features JSONB,
  completion_ratio NUMERIC DEFAULT 0,
  play_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, track_id)
);
```

### tracks
Enhanced with:
```sql
ALTER TABLE tracks ADD COLUMN features JSONB;
CREATE INDEX idx_tracks_features ON tracks USING GIN (features);
```

## Feature Analysis

Each track stores the following audio features (from Spotify API or computed):

```javascript
{
  energy: 0-1,              // 0 = quiet/calm, 1 = loud/energetic
  valence: 0-1,             // 0 = sad, 1 = happy
  acousticness: 0-1,        // 0 = electric, 1 = acoustic
  danceability: 0-1,        // 0 = not danceable, 1 = very danceable
  tempo: number,            // BPM (beats per minute)
  key: string,              // C, C#, D, etc.
  timeSignature: number,    // 3, 4, 5, etc.
  genres: string[],         // ['indie', 'rock']
  releaseYear: number,      // YYYY
  artistArchetype: string   // 'innovator', 'rebel', 'classic', 'mainstream'
}
```

## Integration Guide

### 1. Install Database Schema

Run the migration on startup or manually:

```javascript
import { pool } from './backend/db/postgres.mjs';
import { initializeMusicDNASchema } from './backend/db/musicDnaSchema.mjs';

await initializeMusicDNASchema(pool);
```

### 2. Import Components in React

```javascript
import { DNAProfile } from './components/DNAProfile';
import './components/musicDna.css';

function App() {
  return <DNAProfile />;
}
```

### 3. Hook into Playback Events

When a track completes, update the `user_tracks` table:

```javascript
// After track completion
await fetch('/api/user-tracks/update', {
  method: 'POST',
  body: JSON.stringify({
    trackId: track.id,
    completionRatio: playedSeconds / totalSeconds,
    title: track.title,
    artist: track.artist,
    features: spotifyFeatures, // from Spotify API
  })
});

// Invalidate cache so DNA recalculates on next fetch
await fetch('/api/user/dna/refresh', { method: 'POST' });
```

### 4. Add Navigation Link

```jsx
<Link to="/dna">🧬 My DNA</Link>
```

## Performance Considerations

1. **Caching**: DNA profiles are cached for 24 hours. Change via `CACHE_TTL_SECONDS` env var.
2. **Lazy Loading**: Only compute when requested; store results in DB
3. **Feature Extraction**: Precompute features when importing tracks
4. **Sonic Twins**: Cached calculation; ranks top 1000 artists max

## Environment Variables

```env
# DNA Cache TTL (seconds, default: 86400 = 24 hours)
DNA_CACHE_TTL_SECONDS=86400
```

## Spotify Integration (Optional)

For more accurate track features, integrate with Spotify API:

```javascript
// Get track features from Spotify
const response = await fetch('https://api.spotify.com/v1/audio-features/{id}', {
  headers: { 'Authorization': `Bearer ${spotifyToken}` }
});
const features = await response.json();
```

## Future Enhancements

1. **Time-based Analysis**
   - Track how your taste has evolved over time
   - "Your taste in 2023" vs "Now"

2. **Mood Playlists**
   - Generate playlists matching specific DNA segments
   - "Play like my energy level" mode

3. **Social DNA**
   - Compare DNA with friends
   - Find users with similar taste

4. **Export Formats**
   - PDF report
   - Shareable images
   - Spotify playlist export

5. **Real-time Updates**
   - Update DNA as user plays tracks
   - Daily notification of taste changes

## Troubleshooting

### DNA profile not loading
1. Check user is authenticated
2. Verify database tables exist: `SELECT * FROM user_dna_profiles;`
3. Check browser console for API errors

### Sonic twins empty
1. Need at least 50+ tracks in user's history
2. Check `user_tracks` table has data
3. May need to populate track features from Spotify

### Slow performance
1. Check database indexes exist
2. Consider caching with Redis
3. Limit calculations to once per 24 hours

## Testing

```bash
# Test DNA calculation
curl -X GET http://localhost:3001/api/user/dna \
  -H "Authorization: Bearer {token}"

# Test sonic twins
curl -X GET http://localhost:3001/api/user/sonic-twins?limit=5 \
  -H "Authorization: Bearer {token}"

# Refresh DNA
curl -X POST http://localhost:3001/api/user/dna/refresh \
  -H "Authorization: Bearer {token}"
```

## License

Part of Null Music - MIT License
