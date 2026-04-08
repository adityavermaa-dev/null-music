/**
 * Database schema migration for Music DNA feature
 * Run this to set up the necessary tables
 */

export async function initializeMusicDNASchema(pool) {
  const client = await pool.connect();
  
  try {
    // Create user_dna_profiles table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_dna_profiles (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        dna_id TEXT NOT NULL,
        profile_data JSONB NOT NULL,
        calculated_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_dna_profiles_user_id ON user_dna_profiles(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_dna_profiles_calculated_at ON user_dna_profiles(calculated_at);
    `);

    // Try to add features column to tracks table if it exists
    try {
      await client.query(`
        ALTER TABLE tracks 
        ADD COLUMN IF NOT EXISTS features JSONB;
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tracks_features ON tracks USING GIN (features);
      `);
    } catch (err) {
      // Tracks table may not exist, which is fine for Music DNA feature
      console.log('[Aura] Note: tracks table not found, skipping features column');
    }

    // Create user_tracks to store features
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_tracks (
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
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_tracks_user_id ON user_tracks(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_tracks_completion ON user_tracks(completion_ratio);
    `);

    console.log('✓ Music DNA schema initialized successfully');
  } catch (err) {
    console.error('[Aura][Error initializing Music DNA schema:]', err.message);
    throw err;
  } finally {
    client.release();
  }
}
