import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import { emptyUserLibrary, normalizeLibraryPayload } from "../../shared/userLibrary.js";
import { query } from "../db/postgres.mjs";

const DATA_DIR = process.env.AURA_DATA_DIR
  ? path.resolve(process.env.AURA_DATA_DIR)
  : path.join(process.cwd(), "backend", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);

let schemaReadyPromise = null;

let mutationQueue = Promise.resolve();

function buildError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const compact = raw.replace(/[^\d+]/g, "");
  if (!compact) return "";

  if (compact.startsWith("00")) {
    return `+${compact.slice(2)}`;
  }

  if (compact.startsWith("+")) {
    return `+${compact.slice(1).replace(/\D/g, "")}`;
  }

  return compact.replace(/\D/g, "") ? `+${compact.replace(/\D/g, "")}` : "";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^\+\d{8,15}$/.test(phone);
}

function normalizeName(name, email, phone) {
  const cleaned = String(name || "").trim();
  if (cleaned) return cleaned.slice(0, 80);

  const localPart = normalizeEmail(email).split("@")[0];
  if (localPart) return localPart.slice(0, 80);
  if (phone) return `Listener ${phone.slice(-4)}`;
  return "Aura Listener";
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function createPasswordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function hasPasswordLogin(user) {
  return Boolean(user?.passwordHash && user?.passwordSalt);
}

function verifyPassword(password, user) {
  if (!hasPasswordLogin(user)) return false;

  const candidate = Buffer.from(hashPassword(password, user.passwordSalt), "hex");
  const stored = Buffer.from(String(user.passwordHash || ""), "hex");

  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

function getAuthMethods(user) {
  const methods = [];
  if (hasPasswordLogin(user)) methods.push("password");
  if (user?.googleSub) methods.push("google");
  if (user?.phone) methods.push("phone");
  return methods;
}

function toPublicUser(user) {
  return {
    id: String(user.id),
    email: String(user.email || ""),
    phone: String(user.phone || ""),
    name: String(user.name || ""),
    hasPassword: hasPasswordLogin(user),
    authMethods: getAuthMethods(user),
    createdAt: Number(user.createdAt) || Date.now(),
    updatedAt: Number(user.updatedAt) || Date.now(),
    lastLoginAt: Number(user.lastLoginAt) || null,
  };
}

function normalizeStoredUser(user) {
  if (!user || typeof user !== "object") return null;

  const email = normalizeEmail(user.email);
  const phone = normalizePhone(user.phone);
  if (!email && !phone) return null;

  return {
    id: String(user.id || randomUUID()),
    email,
    phone,
    name: normalizeName(user.name, email, phone),
    googleSub: String(user.googleSub || "").trim(),
    passwordHash: String(user.passwordHash || ""),
    passwordSalt: String(user.passwordSalt || ""),
    createdAt: Number(user.createdAt) || Date.now(),
    updatedAt: Number(user.updatedAt) || Date.now(),
    lastLoginAt: Number(user.lastLoginAt) || 0,
    library: normalizeLibraryPayload(user.library || emptyUserLibrary()),
  };
}

async function ensureUserSchema() {
  if (!USE_POSTGRES) return;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
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
  })();

  return schemaReadyPromise;
}

function rowToStoredUser(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    email: String(row.email || ''),
    phone: String(row.phone || ''),
    name: String(row.name || ''),
    googleSub: String(row.google_sub || ''),
    passwordHash: String(row.password_hash || ''),
    passwordSalt: String(row.password_salt || ''),
    createdAt: Number(row.created_at) || Date.now(),
    updatedAt: Number(row.updated_at) || Date.now(),
    lastLoginAt: Number(row.last_login_at) || 0,
    library: normalizeLibraryPayload(row.library || emptyUserLibrary()),
  };
}

async function getUserByLookup({ userId = '', email = '', phone = '', googleSub = '' }) {
  await ensureUserSchema();
  if (userId) {
    const res = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [String(userId)]);
    return rowToStoredUser(res.rows[0]);
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedGoogleSub = String(googleSub || '').trim();

  if (normalizedGoogleSub) {
    const res = await query('SELECT * FROM users WHERE google_sub = $1 LIMIT 1', [normalizedGoogleSub]);
    return rowToStoredUser(res.rows[0]);
  }
  if (normalizedEmail) {
    const res = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [normalizedEmail]);
    return rowToStoredUser(res.rows[0]);
  }
  if (normalizedPhone) {
    const res = await query('SELECT * FROM users WHERE phone = $1 LIMIT 1', [normalizedPhone]);
    return rowToStoredUser(res.rows[0]);
  }
  return null;
}

async function insertUser(user) {
  await ensureUserSchema();
  const stored = normalizeStoredUser(user);
  if (!stored) throw buildError('Invalid user payload.', 400);
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
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        last_login_at = EXCLUDED.last_login_at,
        library = EXCLUDED.library
      RETURNING *;
    `,
    [
      stored.id,
      stored.email,
      stored.phone,
      stored.name,
      stored.googleSub,
      stored.passwordHash,
      stored.passwordSalt,
      stored.createdAt,
      stored.updatedAt,
      stored.lastLoginAt,
      JSON.stringify(stored.library),
    ],
  );
  return rowToStoredUser(res.rows[0]);
}

async function ensureUsersFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(USERS_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.writeFile(USERS_FILE, JSON.stringify({ users: [] }, null, 2), "utf8");
  }
}

async function readUsersDb() {
  await ensureUsersFile();

  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed?.users)
        ? parsed.users.map(normalizeStoredUser).filter(Boolean)
        : [],
    };
  } catch {
    return { users: [] };
  }
}

async function writeUsersDb(data) {
  await ensureUsersFile();
  const tempFile = `${USERS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempFile, USERS_FILE);
}

function queueMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function validatePasswordStrength(password) {
  const normalizedPassword = String(password || "");
  if (normalizedPassword.length < 6) {
    throw buildError("Password must be at least 6 characters.", 400);
  }
  return normalizedPassword;
}

function findUserByEmailOrPhone(users, { email = "", phone = "", googleSub = "" }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedGoogleSub = String(googleSub || "").trim();

  return users.find((user) => (
    (normalizedGoogleSub && user.googleSub === normalizedGoogleSub)
    || (normalizedEmail && user.email === normalizedEmail)
    || (normalizedPhone && user.phone === normalizedPhone)
  )) || null;
}

export async function createUser({ email, password, name }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = validatePasswordStrength(password);

  if (!isValidEmail(normalizedEmail)) {
    throw buildError("Enter a valid email address.", 400);
  }

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const existing = await getUserByLookup({ email: normalizedEmail });
      if (existing) throw buildError('An account with this email already exists.', 409);

      const passwordRecord = createPasswordRecord(normalizedPassword);
      const now = Date.now();
      const inserted = await insertUser({
        id: randomUUID(),
        email: normalizedEmail,
        phone: '',
        name: normalizeName(name, normalizedEmail, ''),
        googleSub: '',
        passwordHash: passwordRecord.hash,
        passwordSalt: passwordRecord.salt,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        library: emptyUserLibrary(),
      });

      return {
        user: toPublicUser(inserted),
        library: normalizeLibraryPayload(inserted.library),
      };
    }

    const db = await readUsersDb();
    if (db.users.some((user) => user.email === normalizedEmail)) {
      throw buildError("An account with this email already exists.", 409);
    }

    const passwordRecord = createPasswordRecord(normalizedPassword);
    const now = Date.now();
    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      phone: "",
      name: normalizeName(name, normalizedEmail, ""),
      googleSub: "",
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      library: emptyUserLibrary(),
    };

    db.users.push(user);
    await writeUsersDb(db);

    return {
      user: toPublicUser(user),
      library: normalizeLibraryPayload(user.library),
    };
  });
}

export async function loginUser({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || "");

  if (!normalizedEmail || !normalizedPassword) {
    throw buildError("Email and password are required.", 400);
  }

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const user = await getUserByLookup({ email: normalizedEmail });

      if (!user || !verifyPassword(normalizedPassword, user)) {
        throw buildError('Invalid email or password.', 401);
      }

      const now = Date.now();
      const res = await query(
        'UPDATE users SET last_login_at = $2, updated_at = $2 WHERE id = $1 RETURNING *',
        [user.id, now],
      );
      const updated = rowToStoredUser(res.rows[0]);

      return {
        user: toPublicUser(updated),
        library: normalizeLibraryPayload(updated.library),
      };
    }

    const db = await readUsersDb();
    const user = db.users.find((candidate) => candidate.email === normalizedEmail);

    if (!user || !verifyPassword(normalizedPassword, user)) {
      throw buildError("Invalid email or password.", 401);
    }

    user.lastLoginAt = Date.now();
    user.updatedAt = user.lastLoginAt;
    await writeUsersDb(db);

    return {
      user: toPublicUser(user),
      library: normalizeLibraryPayload(user.library),
    };
  });
}

export async function createOrUpdateGoogleUser({ email, name, googleSub }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedGoogleSub = String(googleSub || "").trim();

  if (!normalizedEmail || !isValidEmail(normalizedEmail) || !normalizedGoogleSub) {
    throw buildError("Google sign-in payload is invalid.", 400);
  }

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const now = Date.now();

      let user = await getUserByLookup({ googleSub: normalizedGoogleSub });
      if (!user) user = await getUserByLookup({ email: normalizedEmail });

      if (!user) {
        const inserted = await insertUser({
          id: randomUUID(),
          email: normalizedEmail,
          phone: '',
          name: normalizeName(name, normalizedEmail, ''),
          googleSub: normalizedGoogleSub,
          passwordHash: '',
          passwordSalt: '',
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
          library: emptyUserLibrary(),
        });

        return {
          user: toPublicUser(inserted),
          library: normalizeLibraryPayload(inserted.library),
        };
      }

      const nextName = name ? normalizeName(name, normalizedEmail, user.phone) : user.name;
      const res = await query(
        `
          UPDATE users SET
            email = $2,
            google_sub = $3,
            name = $4,
            last_login_at = $5,
            updated_at = $5
          WHERE id = $1
          RETURNING *;
        `,
        [user.id, normalizedEmail, normalizedGoogleSub, nextName, now],
      );
      const updated = rowToStoredUser(res.rows[0]);
      return {
        user: toPublicUser(updated),
        library: normalizeLibraryPayload(updated.library),
      };
    }

    const db = await readUsersDb();
    const now = Date.now();
    let user = findUserByEmailOrPhone(db.users, { email: normalizedEmail, googleSub: normalizedGoogleSub });

    if (!user) {
      user = {
        id: randomUUID(),
        email: normalizedEmail,
        phone: "",
        name: normalizeName(name, normalizedEmail, ""),
        googleSub: normalizedGoogleSub,
        passwordHash: "",
        passwordSalt: "",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        library: emptyUserLibrary(),
      };
      db.users.push(user);
    } else {
      user.email = normalizedEmail;
      user.googleSub = normalizedGoogleSub;
      if (name) user.name = normalizeName(name, normalizedEmail, user.phone);
      user.lastLoginAt = now;
      user.updatedAt = now;
    }

    await writeUsersDb(db);

    return {
      user: toPublicUser(user),
      library: normalizeLibraryPayload(user.library),
    };
  });
}

export async function createOrUpdatePhoneUser({ phone, name }) {
  const normalizedPhone = normalizePhone(phone);

  if (!isValidPhone(normalizedPhone)) {
    throw buildError("Enter a valid phone number in international format.", 400);
  }

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const now = Date.now();
      let user = await getUserByLookup({ phone: normalizedPhone });

      if (!user) {
        const inserted = await insertUser({
          id: randomUUID(),
          email: '',
          phone: normalizedPhone,
          name: normalizeName(name, '', normalizedPhone),
          googleSub: '',
          passwordHash: '',
          passwordSalt: '',
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
          library: emptyUserLibrary(),
        });
        return {
          user: toPublicUser(inserted),
          library: normalizeLibraryPayload(inserted.library),
        };
      }

      const nextName = name ? normalizeName(name, user.email, normalizedPhone) : user.name;
      const res = await query(
        `
          UPDATE users SET
            phone = $2,
            name = $3,
            last_login_at = $4,
            updated_at = $4
          WHERE id = $1
          RETURNING *;
        `,
        [user.id, normalizedPhone, nextName, now],
      );
      const updated = rowToStoredUser(res.rows[0]);
      return {
        user: toPublicUser(updated),
        library: normalizeLibraryPayload(updated.library),
      };
    }

    const db = await readUsersDb();
    const now = Date.now();
    let user = findUserByEmailOrPhone(db.users, { phone: normalizedPhone });

    if (!user) {
      user = {
        id: randomUUID(),
        email: "",
        phone: normalizedPhone,
        name: normalizeName(name, "", normalizedPhone),
        googleSub: "",
        passwordHash: "",
        passwordSalt: "",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        library: emptyUserLibrary(),
      };
      db.users.push(user);
    } else {
      if (name) user.name = normalizeName(name, user.email, normalizedPhone);
      user.phone = normalizedPhone;
      user.lastLoginAt = now;
      user.updatedAt = now;
    }

    await writeUsersDb(db);

    return {
      user: toPublicUser(user),
      library: normalizeLibraryPayload(user.library),
    };
  });
}

export async function updateUserPassword({ userId, currentPassword, newPassword }) {
  if (!userId) {
    throw buildError("User id is required.", 400);
  }

  const validatedPassword = validatePasswordStrength(newPassword);

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const user = await getUserByLookup({ userId: String(userId) });
      if (!user) throw buildError('Account not found.', 404);

      if (hasPasswordLogin(user) && !verifyPassword(String(currentPassword || ''), user)) {
        throw buildError('Current password is incorrect.', 401);
      }

      const passwordRecord = createPasswordRecord(validatedPassword);
      const now = Date.now();
      const res = await query(
        `
          UPDATE users SET
            password_hash = $2,
            password_salt = $3,
            updated_at = $4
          WHERE id = $1
          RETURNING *;
        `,
        [String(userId), passwordRecord.hash, passwordRecord.salt, now],
      );
      const updated = rowToStoredUser(res.rows[0]);
      return toPublicUser(updated);
    }

    const db = await readUsersDb();
    const user = db.users.find((candidate) => candidate.id === String(userId));

    if (!user) {
      throw buildError("Account not found.", 404);
    }

    if (hasPasswordLogin(user) && !verifyPassword(String(currentPassword || ""), user)) {
      throw buildError("Current password is incorrect.", 401);
    }

    const passwordRecord = createPasswordRecord(validatedPassword);
    user.passwordHash = passwordRecord.hash;
    user.passwordSalt = passwordRecord.salt;
    user.updatedAt = Date.now();
    await writeUsersDb(db);

    return toPublicUser(user);
  });
}

export async function getUserById(userId) {
  if (!userId) return null;
  if (USE_POSTGRES) {
    const user = await getUserByLookup({ userId: String(userId) });
    return user ? toPublicUser(user) : null;
  }
  const db = await readUsersDb();
  const user = db.users.find((candidate) => candidate.id === String(userId));
  return user ? toPublicUser(user) : null;
}

export async function getUserLibrary(userId) {
  if (!userId) return emptyUserLibrary();
  if (USE_POSTGRES) {
    await ensureUserSchema();
    const res = await query('SELECT library FROM users WHERE id = $1 LIMIT 1', [String(userId)]);
    const row = res.rows[0];
    return row?.library ? normalizeLibraryPayload(row.library) : emptyUserLibrary();
  }
  const db = await readUsersDb();
  const user = db.users.find((candidate) => candidate.id === String(userId));
  return user ? normalizeLibraryPayload(user.library) : emptyUserLibrary();
}

export async function updateUserLibrary(userId, library) {
  if (!userId) {
    throw buildError("User id is required.", 400);
  }

  const normalizedLibrary = normalizeLibraryPayload(library);

  return queueMutation(async () => {
    if (USE_POSTGRES) {
      await ensureUserSchema();
      const now = Date.now();
      const res = await query(
        `
          UPDATE users SET
            library = $2::jsonb,
            updated_at = $3
          WHERE id = $1
          RETURNING library;
        `,
        [String(userId), JSON.stringify(normalizedLibrary), now],
      );
      const row = res.rows[0];
      if (!row) throw buildError('Account not found.', 404);
      return normalizeLibraryPayload(row.library);
    }

    const db = await readUsersDb();
    const user = db.users.find((candidate) => candidate.id === String(userId));

    if (!user) {
      throw buildError("Account not found.", 404);
    }

    user.library = normalizedLibrary;
    user.updatedAt = Date.now();
    await writeUsersDb(db);
    return normalizeLibraryPayload(user.library);
  });
}
