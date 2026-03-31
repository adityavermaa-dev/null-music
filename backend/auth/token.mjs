import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DATA_DIR = process.env.AURA_DATA_DIR
  ? path.resolve(process.env.AURA_DATA_DIR)
  : path.join(process.cwd(), "backend", "data");
const SECRET_FILE = path.join(DATA_DIR, "auth-secret.txt");
const TOKEN_TTL_SECONDS = Math.max(60, Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30));

let secretPromise = null;

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function getSigningSecret(explicitSecret = "") {
  if (explicitSecret) return explicitSecret;
  if (process.env.AUTH_TOKEN_SECRET) return process.env.AUTH_TOKEN_SECRET;
  if (secretPromise) return secretPromise;

  secretPromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
      const existing = await fs.readFile(SECRET_FILE, "utf8");
      const secret = existing.trim();
      if (secret) return secret;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const generated = randomBytes(48).toString("hex");
    await fs.writeFile(SECRET_FILE, `${generated}\n`, "utf8");
    return generated;
  })();

  return secretPromise;
}

function signPayload(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function buildPayload(user, nowSeconds) {
  return {
    sub: String(user?.id || ""),
    email: typeof user?.email === "string" ? user.email : "",
    phone: typeof user?.phone === "string" ? user.phone : "",
    name: typeof user?.name === "string" ? user.name : "",
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
}

export function extractBearerToken(headerValue = "") {
  if (typeof headerValue !== "string") return "";
  return headerValue.toLowerCase().startsWith("bearer ")
    ? headerValue.slice(7).trim()
    : "";
}

export async function createAuthToken(user, options = {}) {
  const nowSeconds = Math.floor((options.nowMs || Date.now()) / 1000);
  const payload = buildPayload(user, nowSeconds);
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const secret = await getSigningSecret(options.secret);
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifyAuthToken(token, options = {}) {
  if (!token || typeof token !== "string") return null;

  const [encodedPayload, receivedSignature] = token.split(".");
  if (!encodedPayload || !receivedSignature) return null;

  const secret = await getSigningSecret(options.secret);
  const expectedSignature = signPayload(encodedPayload, secret);
  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    receivedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    const nowSeconds = Math.floor((options.nowMs || Date.now()) / 1000);

    if (!payload?.sub || !payload?.exp || Number(payload.exp) <= nowSeconds) {
      return null;
    }

    return {
      userId: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : "",
      phone: typeof payload.phone === "string" ? payload.phone : "",
      name: typeof payload.name === "string" ? payload.name : "",
      issuedAt: Number(payload.iat) || 0,
      expiresAt: Number(payload.exp) || 0,
    };
  } catch {
    return null;
  }
}
