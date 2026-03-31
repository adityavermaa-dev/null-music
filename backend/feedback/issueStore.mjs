import fs from "node:fs/promises";
import path from "node:path";

import { query } from "../db/postgres.mjs";

const DATA_DIR = process.env.AURA_DATA_DIR
  ? path.resolve(process.env.AURA_DATA_DIR)
  : path.join(process.cwd(), "backend", "data");
const ISSUE_FILE = path.join(DATA_DIR, "track-issues.json");

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);

let schemaReadyPromise = null;

async function ensureIssueSchema() {
  if (!USE_POSTGRES) return;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
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
  })();

  return schemaReadyPromise;
}

async function ensureIssueFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(ISSUE_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.writeFile(ISSUE_FILE, JSON.stringify({ issues: [] }, null, 2), "utf8");
  }
}

async function readIssueDb() {
  await ensureIssueFile();

  try {
    const raw = await fs.readFile(ISSUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      issues: Array.isArray(parsed?.issues) ? parsed.issues : [],
    };
  } catch {
    return { issues: [] };
  }
}

async function writeIssueDb(data) {
  await ensureIssueFile();
  const tempFile = `${ISSUE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempFile, ISSUE_FILE);
}

export async function recordTrackIssue(payload = {}) {
  const track = payload?.track && typeof payload.track === "object" ? payload.track : {};
  const issue = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: String(payload.type || "other").trim() || "other",
    note: String(payload.note || "").trim().slice(0, 600),
    createdAt: Date.now(),
    source: String(payload.source || "app").trim() || "app",
    userId: payload.userId ? String(payload.userId) : "",
    userEmail: payload.userEmail ? String(payload.userEmail) : "",
    track: {
      id: track?.id ? String(track.id) : "",
      title: track?.title ? String(track.title) : "",
      artist: track?.artist ? String(track.artist) : "",
      album: track?.album ? String(track.album) : "",
      source: track?.source ? String(track.source) : "",
      videoId: track?.videoId ? String(track.videoId) : "",
      originalId: track?.originalId ? String(track.originalId) : "",
    },
  };

  if (USE_POSTGRES) {
    await ensureIssueSchema();
    await query(
      `
        INSERT INTO track_issues (id, type, note, created_at, source, user_id, user_email, track)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO NOTHING;
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
    return issue;
  }

  const db = await readIssueDb();
  db.issues.unshift(issue);
  db.issues = db.issues.slice(0, 5000);
  await writeIssueDb(db);
  return issue;
}
