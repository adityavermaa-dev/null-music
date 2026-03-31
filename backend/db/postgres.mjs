import pg from 'pg';

const { Pool } = pg;

function shouldUseSsl(connectionString) {
    const explicit = (process.env.DATABASE_SSL ?? '').toString().trim().toLowerCase();
    if (explicit === '0' || explicit === 'false' || explicit === 'off' || explicit === 'no') return false;
    if (explicit === '1' || explicit === 'true' || explicit === 'on' || explicit === 'yes') return true;

    const value = (connectionString ?? '').toString();
    if (!value) return false;

    // Local dev Postgres typically has no TLS.
    if (value.includes('localhost') || value.includes('127.0.0.1')) return false;

    return true;
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    max: 10,
});

export async function query(text, params = []) {
    return pool.query(text, params);
}
