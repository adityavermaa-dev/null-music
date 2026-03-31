import fs from 'node:fs/promises';
import path from 'node:path';

import { query, pool } from '../backend/db/postgres.mjs';

function resolveDataDir() {
  return process.env.AURA_DATA_DIR
    ? path.resolve(process.env.AURA_DATA_DIR)
    : path.join(process.cwd(), 'backend', 'data');
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      google_sub TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      password_salt TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_login_at BIGINT NOT NULL,
      library JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await query("CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (email) WHERE email <> ''");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uq ON users (phone) WHERE phone <> ''");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uq ON users (google_sub) WHERE google_sub <> ''");

  await query(`
    CREATE TABLE IF NOT EXISTS track_issues (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      track JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS track_issues_created_at_idx ON track_issues (created_at DESC)');
}

function normalizeText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  return fallback;
}

async function migrateUsers(users) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of users) {
    if (!raw || typeof raw !== 'object') {
      skipped += 1;
      continue;
    }

    const candidate = {
      id: normalizeText(raw.id),
      email: normalizeText(raw.email).trim().toLowerCase(),
      phone: normalizeText(raw.phone).trim(),
      name: normalizeText(raw.name).trim(),
      googleSub: normalizeText(raw.googleSub).trim(),
      passwordHash: normalizeText(raw.passwordHash),
      passwordSalt: normalizeText(raw.passwordSalt),
      createdAt: normalizeNumber(raw.createdAt, Date.now()),
      updatedAt: normalizeNumber(raw.updatedAt, Date.now()),
      lastLoginAt: normalizeNumber(raw.lastLoginAt, 0),
      library: normalizeJson(raw.library, {}),
    };

    if (!candidate.id) {
      skipped += 1;
      continue;
    }

    // Avoid unique index conflicts by looking up an existing user by auth identifiers.
    const lookup = async () => {
      if (candidate.googleSub) {
        const res = await query('SELECT id FROM users WHERE google_sub = $1 LIMIT 1', [candidate.googleSub]);
        if (res.rows[0]?.id) return String(res.rows[0].id);
      }
      if (candidate.email) {
        const res = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [candidate.email]);
        if (res.rows[0]?.id) return String(res.rows[0].id);
      }
      if (candidate.phone) {
        const res = await query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [candidate.phone]);
        if (res.rows[0]?.id) return String(res.rows[0].id);
      }
      return '';
    };

    const existingId = await lookup();
    const targetId = existingId || candidate.id;

    const res = await query(
      `
        INSERT INTO users (
          id, email, phone, name, google_sub, password_hash, password_salt,
          created_at, updated_at, last_login_at, library
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          name = EXCLUDED.name,
          google_sub = EXCLUDED.google_sub,
          password_hash = EXCLUDED.password_hash,
          password_salt = EXCLUDED.password_salt,
          updated_at = GREATEST(users.updated_at, EXCLUDED.updated_at),
          last_login_at = GREATEST(users.last_login_at, EXCLUDED.last_login_at),
          library = EXCLUDED.library
        RETURNING (xmax = 0) AS inserted;
      `,
      [
        targetId,
        candidate.email,
        candidate.phone,
        candidate.name,
        candidate.googleSub,
        candidate.passwordHash,
        candidate.passwordSalt,
        candidate.createdAt,
        candidate.updatedAt,
        candidate.lastLoginAt,
        JSON.stringify(candidate.library),
      ],
    );

    if (res.rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated, skipped };
}

async function migrateIssues(issues) {
  let inserted = 0;
  let skipped = 0;

  for (const raw of issues) {
    if (!raw || typeof raw !== 'object') {
      skipped += 1;
      continue;
    }

    const issue = {
      id: normalizeText(raw.id),
      type: normalizeText(raw.type) || 'other',
      note: normalizeText(raw.note).slice(0, 600),
      createdAt: normalizeNumber(raw.createdAt, Date.now()),
      source: normalizeText(raw.source) || 'app',
      userId: normalizeText(raw.userId),
      userEmail: normalizeText(raw.userEmail),
      track: normalizeJson(raw.track, {}),
    };

    if (!issue.id) {
      skipped += 1;
      continue;
    }

    const res = await query(
      `
        INSERT INTO track_issues (id, type, note, created_at, source, user_id, user_email, track)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO NOTHING
        RETURNING id;
      `,
      [
        issue.id,
        issue.type,
        issue.note,
        issue.createdAt,
        issue.source,
        issue.userId,
        issue.userEmail,
        JSON.stringify(issue.track),
      ],
    );

    if (res.rowCount) inserted += 1;
  }

  return { inserted, skipped };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to migrate JSON to Postgres.');
  }

  const dataDir = resolveDataDir();
  const usersPath = path.join(dataDir, 'users.json');
  const issuesPath = path.join(dataDir, 'track-issues.json');

  await ensureSchema();

  const usersDb = await readJsonFile(usersPath, { users: [] });
  const issuesDb = await readJsonFile(issuesPath, { issues: [] });

  const users = Array.isArray(usersDb?.users) ? usersDb.users : [];
  const issues = Array.isArray(issuesDb?.issues) ? issuesDb.issues : [];

  await query('BEGIN');
  try {
    const userResult = await migrateUsers(users);
    const issueResult = await migrateIssues(issues);
    await query('COMMIT');

    console.log('[migrate] done');
    console.log('[migrate] users:', userResult);
    console.log('[migrate] track_issues:', issueResult);
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err?.message || err);
  process.exitCode = 1;
});
