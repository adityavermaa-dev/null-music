import { query, pool } from '../backend/db/postgres.mjs';

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id BIGSERIAL PRIMARY KEY,
      track_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      features JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tracks_features ON tracks USING GIN (features);`);

  const result = await query(`SELECT to_regclass('public.tracks') AS table_name;`);
  console.log('tracks table status:', result.rows?.[0]?.table_name || null);
}

main()
  .catch((error) => {
    console.error('Failed to create tracks table:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
