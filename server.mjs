// ═══════════════════════════════════════════════════════
// Aura Music Server
// YouTube Music backend using youtubei.js + yt-dlp
// ═══════════════════════════════════════════════════════

import 'dotenv/config.js';

import express from "express";
import { Innertube } from "youtubei.js";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";
import rateLimit from "express-rate-limit";
import timeout from "connect-timeout";
import { createCache } from "./backend/cache/cache.mjs";
import { createAuthToken, extractBearerToken, verifyAuthToken } from "./backend/auth/token.mjs";
import {
    createOrUpdateEmailUser,
    createUser,
    getUserById,
    getUserLibrary,
    loginUser,
    updateUserLibrary,
    updateUserPassword,
} from "./backend/auth/userStore.mjs";
import { sendEmailOtp, verifyEmailOtpCode } from "./backend/auth/emailOtp.mjs";
import { recordTrackIssue } from "./backend/feedback/issueStore.mjs";

import { resolveStreamUrl, resolveStreamWithMeta } from "./backend/resolver/streamResolver.mjs";
import { downloadToCache, getCachedFilePath, getCacheStatus } from "./backend/cache/audioCache.mjs";
import { ytdlpQueue } from "./backend/queue/ytdlpQueue.mjs";
import { buildYtdlpArgs, getYtdlpProxy } from "./backend/providers/ytdlpProvider.mjs";
import { spawnWithTimeout } from "./backend/lib/spawnWithTimeout.mjs";
import { logger } from "./backend/lib/logger.mjs";
import { metrics } from "./backend/lib/metrics.mjs";
import { scheduleYtdlpAutoUpdate } from "./backend/lib/ytdlpAutoUpdate.mjs";
import { getRecommendations, trackUserAction } from "./backend/reco/recommendations.mjs";
import { calculateUserDNA, getUserDNA, findSonicTwins, invalidateUserDNA } from "./backend/reco/musicDna.mjs";
import { initializeMusicDNASchema } from "./backend/db/musicDnaSchema.mjs";
import { pool } from "./backend/db/postgres.mjs";
import { normalizeLibraryPayload } from "./shared/userLibrary.js";

const PORT = process.env.PORT || 3001;
const app = express();

// If this server is behind a reverse proxy (Nginx/Cloudflare/Traefik), Express must
// trust the proxy in order to correctly interpret `X-Forwarded-For` and avoid
// express-rate-limit's proxy safety checks.
//
// - Set `TRUST_PROXY=1` (single proxy hop) or `TRUST_PROXY=true` (any number)
// - If unset, we default to 1 in production for typical deployments.
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY ?? '').toString().trim();
if (TRUST_PROXY_RAW) {
    const v = TRUST_PROXY_RAW.toLowerCase();
    if (v === 'true') app.set('trust proxy', true);
    else if (v === 'false') app.set('trust proxy', false);
    else if (!Number.isNaN(Number(v))) app.set('trust proxy', Number(v));
    else app.set('trust proxy', TRUST_PROXY_RAW);
} else if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    app.set('trust proxy', 1);
}

// JSON body parsing (used by /api/* endpoints)
app.use(express.json({ limit: "512kb" }));

// basic health endpoint (deployment / load balancers)
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// request timeout (prevents long-hanging requests)
const requestTimeout = process.env.REQUEST_TIMEOUT || "10s";
const timeoutMiddleware = timeout(requestTimeout);
const BACKEND_STREAMING_ENABLED = String(process.env.BACKEND_STREAMING_ENABLED || '').trim().toLowerCase() === 'true';
const shouldSkipRequestTimeout = (req) =>
    req.path.startsWith("/api/yt/stream/") ||
    (BACKEND_STREAMING_ENABLED && (
        req.path.startsWith("/api/yt/pipe/") ||
        req.path.startsWith("/api/yt/download/") ||
        req.path.startsWith("/api/yt/cache/")
    ));

app.use((req, res, next) => {
    if (shouldSkipRequestTimeout(req)) {
        req.setTimeout?.(0);
        res.setTimeout?.(0);
        return next();
    }
    return timeoutMiddleware(req, res, next);
});
app.use((req, res, next) => {
    if (req.timedout) {
        if (!res.headersSent) res.status(503).json({ error: "Request timeout" });
        return;
    }
    next();
});

const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
const YT_SOURCE_ADDRESS = process.env.YT_SOURCE_ADDRESS;
const YT_EXTRACTOR_ARGS = process.env.YT_EXTRACTOR_ARGS || "";
const YT_DLP_JS_RUNTIMES = process.env.YT_DLP_JS_RUNTIMES || "node";
const YT_DLP_PROXY = getYtdlpProxy();
const YT_PLAYER_SKIP = process.env.YT_PLAYER_SKIP || "webpage,configs";
const HTTP_UA = process.env.HTTP_UA || "NullMusicPlayer/1.0 (+https://github.com)";

const SPOTIFY_CLIENT_ID = String(process.env.SPOTIFY_CLIENT_ID || "").trim();
const SPOTIFY_CLIENT_SECRET = String(process.env.SPOTIFY_CLIENT_SECRET || "").trim();
const SPOTIFY_TOKEN_ENDPOINT = String(process.env.SPOTIFY_TOKEN_ENDPOINT || "https://accounts.spotify.com/api/token").trim();
const SPOTIFY_API_BASE = String(process.env.SPOTIFY_API_BASE || "https://api.spotify.com/v1").replace(/\/+$/, "");

const LASTFM_API_KEY = String(process.env.LASTFM_API_KEY || "").trim();
const LASTFM_API_SECRET = String(process.env.LASTFM_API_SECRET || "").trim();
const LASTFM_SESSION_KEY = String(process.env.LASTFM_SESSION_KEY || "").trim();
const LASTFM_API_BASE = String(process.env.LASTFM_API_BASE || "https://ws.audioscrobbler.com/2.0/").trim();

let spotifyTokenCache = {
    accessToken: "",
    expiresAt: 0,
};

const RECO_API_KEY = process.env.RECO_API_KEY || "";

function requireRecoApiKey(req, res, next) {
    if (!RECO_API_KEY) return next();

    const headerKey = req.get("x-api-key") || req.get("x-api-key".toUpperCase());
    const auth = req.get("authorization") || "";
    const bearerKey = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const queryKey = req.query?.apiKey ? String(req.query.apiKey) : "";
    const provided = headerKey || bearerKey || queryKey;

    if (!provided || provided !== RECO_API_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    return next();
}

logger.info("config", "yt-dlp runtime configuration", {
    bin: YT_DLP_BIN,
    jsRuntimes: YT_DLP_JS_RUNTIMES,
    backendStreamingEnabled: BACKEND_STREAMING_ENABLED,
    hasProxy: Boolean(YT_DLP_PROXY),
    playerSkip: YT_PLAYER_SKIP,
    extractorArgs: YT_EXTRACTOR_ARGS || "",
});

// resolve dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cachePromise = createCache();

// ─────────────────────────────────────────────
// Note: youtubei.js handles URL deciphering natively on Node.js
// ─────────────────────────────────────────────

let yt = null;

async function getYT() {
    if (!yt) {
        logger.info("yt", "Creating Innertube session...");

        yt = await Innertube.create({
            lang: "en",
            location: "IN",
            retrieve_player: true,
            generate_session_locally: true,
        });

        logger.info("yt", "YouTube session ready");
    }

    return yt;
}

// ─────────────────────────────────────────────
// basic cors
// ─────────────────────────────────────────────

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key, x-api-key"
    );
    res.header("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

async function requireAuth(req, res, next) {
    try {
        const token = extractBearerToken(req.get("authorization") || "");
        const auth = await verifyAuthToken(token);

        if (!auth?.userId) {
            return res.status(401).json({ ok: false, error: "Please sign in again." });
        }

        const user = await getUserById(auth.userId);
        if (!user?.id) {
            return res.status(401).json({ ok: false, error: "Please sign in again." });
        }

        req.auth = {
            ...auth,
            user,
        };
        return next();
    } catch (error) {
        logger.warn("auth", "Authentication failed", { error: error?.message });
        return res.status(401).json({ ok: false, error: "Please sign in again." });
    }
}

function getErrorStatus(error, fallback = 500) {
    return Number(error?.status) || fallback;
}

function getErrorMessage(error, fallback = "Something went wrong.") {
    const status = getErrorStatus(error, 500);
    if (status >= 500) return fallback;
    return error?.message || fallback;
}

async function buildSessionPayload(session) {
    const token = await createAuthToken(session.user);
    return {
        ok: true,
        token,
        user: session.user,
        library: session.library,
    };
}

// ─────────────────────────────────────────────
// saavn proxy (placed BEFORE rate limiter so fallback requests aren't throttled)
// ─────────────────────────────────────────────

app.use(
    "/api/saavn",
    createProxyMiddleware({
        target: "https://saavn.sumit.co",
        changeOrigin: true,
        // Express strips the mount path (`/api/saavn`) before proxying,
        // so we must prepend `/api` for the upstream Saavn API.
        pathRewrite: (path) => `/api${path}`
    })
);

// ─────────────────────────────────────────────
// rate limiting (basic protection)
// ─────────────────────────────────────────────

// Production default: 60 req/min per IP (override via env)
const windowMs = Math.max(1, Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000));
const maxReq = Math.max(1, Number(process.env.RATE_LIMIT_MAX || 60));

app.use(
    "/api/",
    rateLimit({
        windowMs,
        max: maxReq,
        standardHeaders: true,
        legacyHeaders: false,
        // If `trust proxy` isn't enabled, a reverse proxy may still add X-Forwarded-For.
        // Disable the strict header validation in that case to prevent a hard crash.
        validate: {
            xForwardedForHeader: !!app.get('trust proxy'),
        },
    })
);

// request logging (cheap)
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        const ms = Date.now() - start;
        logger.info("http", `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
});

// ─────────────────────────────────────────────
// search songs
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// user tracking + recommendations
// ─────────────────────────────────────────────

app.post("/api/auth/signup", async (req, res) => {
    try {
        const { email, password, name } = req.body || {};
        const created = await createUser({ email, password, name });
        return res.status(201).json(await buildSessionPayload(created));
    } catch (error) {
        logger.warn("auth", "Signup failed", { error: error?.message });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Unable to create account right now."),
        });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const session = await loginUser({ email, password });
        return res.json(await buildSessionPayload(session));
    } catch (error) {
        logger.warn("auth", "Login failed", { error: error?.message });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Unable to sign in right now."),
        });
    }
});

app.post("/api/auth/email/send-otp", async (req, res) => {
    try {
        const { email, name } = req.body || {};
        const result = await sendEmailOtp(email, { name });
        return res.json({ ok: true, email: result.email, status: result.status });
    } catch (error) {
        logger.warn("auth", "Email OTP send failed", { error: error?.message });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Email OTP is unavailable right now."),
        });
    }
});

app.post("/api/auth/email/verify-otp", async (req, res) => {
    try {
        const { email, code, name } = req.body || {};
        const verification = await verifyEmailOtpCode(email, code);
        const session = await createOrUpdateEmailUser({
            email: verification.email,
            name: name || verification.name,
        });
        return res.json(await buildSessionPayload(session));
    } catch (error) {
        logger.warn("auth", "Email OTP verify failed", { error: error?.message });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Email OTP verification failed."),
        });
    }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
    return res.json({
        ok: true,
        user: req.auth.user,
    });
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        const user = await updateUserPassword({
            userId: req.auth.user.id,
            currentPassword,
            newPassword,
        });
        return res.json({ ok: true, user });
    } catch (error) {
        logger.warn("auth", "Password change failed", { error: error?.message, userId: req.auth?.user?.id });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Password update failed."),
        });
    }
});

app.get("/api/library", requireAuth, async (req, res) => {
    try {
        const library = await getUserLibrary(req.auth.user.id);
        return res.json({ ok: true, library });
    } catch (error) {
        logger.warn("library", "Failed to load user library", { error: error?.message, userId: req.auth?.user?.id });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Unable to load your library right now."),
        });
    }
});

app.put("/api/library", requireAuth, async (req, res) => {
    try {
        const library = normalizeLibraryPayload(req.body || {});
        const saved = await updateUserLibrary(req.auth.user.id, library);
        return res.json({ ok: true, library: saved });
    } catch (error) {
        logger.warn("library", "Failed to update user library", { error: error?.message, userId: req.auth?.user?.id });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Unable to save your library right now."),
        });
    }
});

app.post("/api/feedback/track-issue", async (req, res) => {
    try {
        const token = extractBearerToken(req.get("authorization") || "");
        const auth = token ? await verifyAuthToken(token) : null;
        const issue = await recordTrackIssue({
            ...(req.body || {}),
            userId: auth?.userId || req.body?.userId || "",
            userEmail: auth?.email || "",
            source: "app",
        });
        return res.status(201).json({ ok: true, issueId: issue.id });
    } catch (error) {
        logger.warn("feedback", "Track issue report failed", { error: error?.message });
        return res.status(getErrorStatus(error, 500)).json({
            ok: false,
            error: getErrorMessage(error, "Could not send the issue report right now."),
        });
    }
});

app.post("/api/track", requireRecoApiKey, async (req, res) => {
    try {
        const { userId, songId, artist, action, song } = req.body || {};

        if (!userId || !action) {
            return res.status(400).json({ error: "userId and action required" });
        }

        // Minimal song payload (prefer explicit 'song' from client).
        const normalizedSong = song && typeof song === 'object'
            ? song
            : {
                id: songId,
                artist,
            };

        await trackUserAction({ userId, song: normalizedSong, action });
        res.json({ ok: true });
    } catch (err) {
        logger.warn("reco", "track endpoint failed", { error: err?.message });
        res.status(500).json({ error: "Internal error" });
    }
});

app.get("/api/recommendations", requireRecoApiKey, async (req, res) => {
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    try {
        const innertube = await getYT();
        const cache = await cachePromise;

        const data = await getRecommendations({
            userId: String(userId),
            innertube,
            cache,
        });

        res.json({ ok: true, ...data });
    } catch (err) {
        logger.warn("reco", "recommendations failed", { userId, error: err?.message });
        res.status(500).json({ ok: false, error: "Recommendations unavailable" });
    }
});

app.get("/api/yt/search", async (req, res) => {
    const { query, limit = 20 } = req.query;

    if (!query) return res.json({ results: [] });

    try {
        const innertube = await getYT();

        const searchResults = await innertube.music.search(query, {
            type: "song",
        });

        const songs = searchResults.songs?.contents || [];

        const results = songs.slice(0, parseInt(limit)).map((song) => ({
            id: song.id,
            title: pickText(song.title, song.name) || "Unknown Title",
            artist: pickArtistName(song).join(", ") || "Unknown Artist",
            artists: pickArtists(song),
            album: pickText(song.album?.name, song.album?.text, song.album),
            duration: parseDuration(song.duration?.text || song.duration),
            durationText: song.duration?.text || "",
            thumbnail: pickThumbnailUrl(song),
            thumbnails: [
                ...(Array.isArray(song.thumbnails) ? song.thumbnails : []),
                ...(Array.isArray(song.thumbnail) ? song.thumbnail : []),
            ],
        }));

        res.json({ results });
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ results: [] });
    }
});

// ─────────────────────────────────────────────
// stream endpoint with cache
// ─────────────────────────────────────────────

app.get("/api/yt/stream/:videoId", async (req, res) => {
    const { videoId } = req.params;

    if (!videoId) return res.status(400).json({ error: "videoId required" });

    try {
        const innertube = await getYT();
        const requestedTitle = String(req.query?.title || '').trim();
        const requestedArtist = String(req.query?.artist || '').trim();

        const findAlternateVideoIds = async ({ seedTitle = '', seedArtist = '', excludeId = '' }) => {
            const base = `${seedTitle} ${seedArtist}`.trim();
            if (!base) return [];

            const queries = [
                base,
                seedTitle ? `${seedTitle} official audio` : '',
                seedArtist ? `${seedArtist} popular songs` : '',
            ].filter(Boolean);

            const ids = new Set();

            for (const query of queries) {
                try {
                    const searchResults = await innertube.music.search(query, { type: "song" });
                    const songs = searchResults?.songs?.contents || [];
                    for (const item of songs.slice(0, 8)) {
                        const id = String(item?.id || '').trim();
                        if (!id || id === excludeId || id.length !== 11) continue;
                        ids.add(id);
                        if (ids.size >= 8) return [...ids];
                    }
                } catch {
                    // ignore one failed query and continue
                }
            }

            return [...ids];
        };

        let title, author, duration, thumbnail;
        try {
            const info = await innertube.music.getInfo(videoId);
            title = info.basic_info?.title;
            author = info.basic_info?.author;
            duration = info.basic_info?.duration;
            thumbnail = info.basic_info?.thumbnail?.[0]?.url;
        } catch {
            try {
                const info = await innertube.getInfo(videoId);
                title = info?.basic_info?.title;
                author = info?.basic_info?.author;
                duration = info?.basic_info?.duration;
                thumbnail = info?.basic_info?.thumbnail?.[0]?.url;
            } catch {
                // Metadata is optional for stream URL resolution.
            }
        }

        const cache = await cachePromise;
        let resolved = null;
        let resolvedVideoId = videoId;

        try {
            resolved = await resolveStreamWithMeta({
                innertube,
                ytdlpBin: YT_DLP_BIN,
                cache,
                videoId,
                title: requestedTitle || title,
                artist: requestedArtist || author,
            });
        } catch {
            resolved = null;
        }

        if (!resolved?.url) {
            const alternates = await findAlternateVideoIds({
                seedTitle: requestedTitle || title || '',
                seedArtist: requestedArtist || author || '',
                excludeId: videoId,
            });

            for (const altVideoId of alternates) {
                try {
                    const altResolved = await resolveStreamWithMeta({
                        innertube,
                        ytdlpBin: YT_DLP_BIN,
                        cache,
                        videoId: altVideoId,
                        title: requestedTitle || title,
                        artist: requestedArtist || author,
                    });

                    if (altResolved?.url) {
                        resolved = {
                            ...altResolved,
                            source: `${altResolved.source || 'unknown'}-alt`,
                        };
                        resolvedVideoId = altVideoId;
                        break;
                    }
                } catch {
                    // continue trying alternates
                }
            }
        }

        if (!resolved?.url) {
            return res.status(502).json({ error: "Stream unavailable" });
        }

        const responseData = {
            videoId: resolvedVideoId,
            title,
            author,
            duration,
            thumbnail,
            streamUrl: resolved.url,
            cacheState: "remote",
            cached: false,
            cacheSizeBytes: 0,
            streamSource: resolved.source || "unknown",
        };

        res.json(responseData);
    } catch (err) {
        logger.error("stream", "Stream error", { videoId, error: err?.message });
        res.status(502).json({
            videoId,
            error: "Stream unavailable",
        });
    }
});

// ─────────────────────────────────────────────
// local disk cache static server
// ─────────────────────────────────────────────

app.get("/api/yt/cache/:videoId", (req, res) => {
    if (!BACKEND_STREAMING_ENABLED) {
        return res.status(410).json({
            error: "Backend audio cache serving is disabled. Resolve and stream directly from client sources.",
        });
    }

    const { videoId } = req.params;
    const cachedPath = getCachedFilePath(videoId);
    if (cachedPath) {
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.sendFile(cachedPath);
    } else {
        res.status(404).send("Not found in cache");
    }
});

app.get("/api/yt/cache-status/:videoId", (req, res) => {
    if (!BACKEND_STREAMING_ENABLED) {
        return res.json({
            videoId: req.params.videoId,
            cached: false,
            warming: false,
            path: null,
            disabled: true,
        });
    }

    const { videoId } = req.params;
    const status = getCacheStatus(videoId);
    res.json({
        videoId,
        ...status,
    });
});

app.get("/api/yt/download/:videoId", async (req, res) => {
    if (!BACKEND_STREAMING_ENABLED) {
        return res.status(410).json({
            error: "YouTube download endpoint is disabled. Only direct legal source downloads are allowed on client.",
        });
    }

    const { videoId } = req.params;

    if (!videoId) return res.status(400).json({ error: "videoId required" });

    let title = `track-${videoId}`;
    let author = "Aura Music";

    try {
        const innertube = await getYT();
        const info = await innertube.music.getInfo(videoId);
        title = info.basic_info?.title || title;
        author = info.basic_info?.author || author;
    } catch {
        // Metadata is optional for downloads.
    }

    const cacheStatus = getCacheStatus(videoId);
    const cachedPath = cacheStatus.path;
    const filenameExt = cacheStatus.ext || '.m4a';
    const filename = `${sanitizeFilename(`${author} - ${title}`) || `aura-${videoId}`}${filenameExt}`;

    if (cachedPath) {
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.sendFile(cachedPath);
    }

    try {
        const innertube = await getYT();
        const cache = await cachePromise;
        const streamUrl = await resolveStreamUrl({
            innertube,
            ytdlpBin: YT_DLP_BIN,
            cache,
            videoId,
            title,
            artist: author,
        });

        downloadToCache(videoId, YT_DLP_BIN);

        const upstream = await fetch(streamUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        });

        if (!upstream.ok && upstream.status !== 206) {
            throw new Error(`Download upstream failed with ${upstream.status}`);
        }

        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return pipeUpstream(upstream, res);
    } catch (err) {
        logger.warn("download", "Direct download stream failed; falling back to yt-dlp pipe", { videoId, error: err?.message });
        try {
            return await pipeYtdlpToResponse({
                req,
                res,
                videoId,
                contentDisposition: `attachment; filename="${filename}"`,
            });
        } catch (pipeErr) {
            logger.error("download", "Download failed", { videoId, error: pipeErr?.message || err?.message });
            return res.status(500).json({ error: "Download unavailable" });
        }
    }
});

// ─────────────────────────────────────────────
// suggestions
// ─────────────────────────────────────────────

app.get("/api/yt/suggestions", async (req, res) => {
    const { query } = req.query;

    if (!query) return res.json({ suggestions: [] });

    try {
        const innertube = await getYT();
        const raw = await innertube.music.getSearchSuggestions(query);

        const suggestions = [];

        for (const section of raw || []) {
            for (const item of section.contents || []) {
                if (item.type === "SearchSuggestion") {
                    suggestions.push({
                        type: "query",
                        text: item.suggestion?.text || "",
                        title: item.suggestion?.text || "",
                    });
                } else if (item.type === "MusicResponsiveListItem") {
                    const title = pickText(item.name, item.title, item.flex_columns?.[0]?.title);
                    if (!title) continue;
                    
                    let type = "query";
                    if (item.item_type === "artist") type = "artist";
                    else if (item.item_type === "album") type = "album";
                    else if (item.item_type === "song") type = "song";
                    
                    const subText = pickText(item.flex_columns?.[1]?.title);
                    if (type === "query") {
                        if (/song/i.test(subText)) type = "song";
                        if (/album/i.test(subText)) type = "album";
                        if (/artist/i.test(subText)) type = "artist";
                        if (/video/i.test(subText)) type = "song";
                    }

                    const desc = subText || pickText(item.subtitle) || "";
                    const thumbnail = pickThumbnailUrl(item) || "";

                    suggestions.push({
                        type,
                        text: title,
                        title,
                        description: desc,
                        image: thumbnail,
                    });
                }
            }
        }

        res.json({ suggestions: suggestions.slice(0, 10) });
    } catch {
        res.json({ suggestions: [] });
    }
});

// ─────────────────────────────────────────────
// trending songs
// ─────────────────────────────────────────────

app.get("/api/yt/trending", async (req, res) => {
    try {
        const innertube = await getYT();
        const home = await innertube.music.getHomeFeed();

        const songs = [];

        for (const section of home.sections || []) {
            for (const item of section.contents || []) {
                // Video IDs are exactly 11 characters. PLaylist IDs are longer (PL... or VLPL...)
                if (item.id && item.id.length === 11 && item.title) {
                    songs.push({
                        id: item.id,
                        title: pickText(item.title, item.name) || "Unknown Title",
                        artist: pickArtistName(item).join(", "),
                        thumbnail: pickThumbnailUrl(item),
                    });
                }
            }
        }

        res.json({ results: songs.slice(0, 20) });
    } catch {
        res.json({ results: [] });
    }
});

// ─────────────────────────────────────────────
// lyrics api
// ─────────────────────────────────────────────

app.get("/api/yt/lyrics", async (req, res) => {
    const { artist, title } = req.query;

    if (!artist || !title) return res.json({ lyrics: "" });

    try {
        const r = await fetch(
            `https://api.lyrics.ovh/v1/${artist}/${title}`
        );

        const data = await r.json();

        res.json(data);
    } catch {
        res.json({ lyrics: "" });
    }
});

app.get("/api/lyrics", async (req, res) => {
    const { artist, title, album, duration } = req.query;

    if (!artist || !title) {
        return res.json({ ok: true, plainLyrics: "", syncedLyrics: "", source: "none" });
    }

    const params = new URLSearchParams({
        artist_name: String(artist),
        track_name: String(title),
    });

    if (album) params.set("album_name", String(album));
    if (duration && Number.isFinite(Number(duration))) {
        params.set("duration", String(Math.round(Number(duration))));
    }

    try {
        const lrclibResp = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
            headers: {
                "User-Agent": HTTP_UA,
                "Accept": "application/json",
            },
        });

        if (lrclibResp.ok) {
            const data = await lrclibResp.json();
            if ((!data?.syncedLyrics || !String(data.syncedLyrics).trim()) && data?.plainLyrics) {
                // Try searching for an alternate match that has synced lines.
                const searchResp = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
                    headers: {
                        "User-Agent": HTTP_UA,
                        "Accept": "application/json",
                    },
                });
                if (searchResp.ok) {
                    const searchResults = await searchResp.json();
                    const syncedCandidate = Array.isArray(searchResults)
                        ? searchResults.find((item) => String(item?.syncedLyrics || '').trim())
                        : null;
                    if (syncedCandidate) {
                        return res.json({
                            ok: true,
                            plainLyrics: syncedCandidate?.plainLyrics || data?.plainLyrics || "",
                            syncedLyrics: syncedCandidate?.syncedLyrics || "",
                            source: "lrclib",
                        });
                    }
                }
            }
            return res.json({
                ok: true,
                plainLyrics: data?.plainLyrics || "",
                syncedLyrics: data?.syncedLyrics || "",
                source: "lrclib",
            });
        }

        if (lrclibResp.status === 404) {
            const searchResp = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
                headers: {
                    "User-Agent": HTTP_UA,
                    "Accept": "application/json",
                },
            });

            if (searchResp.ok) {
                const results = await searchResp.json();
                const match = Array.isArray(results)
                    ? (results.find((item) => String(item?.syncedLyrics || '').trim()) || results[0])
                    : null;
                if (match) {
                    return res.json({
                        ok: true,
                        plainLyrics: match?.plainLyrics || "",
                        syncedLyrics: match?.syncedLyrics || "",
                        source: "lrclib",
                    });
                }
            }
        }
    } catch {
        // Fall through to plain lyrics fallback.
    }

    try {
        const ovhResp = await fetch(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(String(artist))}/${encodeURIComponent(String(title))}`
        );
        const data = await ovhResp.json();
        return res.json({
            ok: true,
            plainLyrics: data?.lyrics || "",
            syncedLyrics: "",
            source: "lyrics.ovh",
        });
    } catch {
        return res.json({ ok: true, plainLyrics: "", syncedLyrics: "", source: "none" });
    }
});

// ─────────────────────────────────────────────
// stream URL extraction is handled by backend/resolver/streamResolver.mjs

// ─────────────────────────────────────────────
// pipe stream — yt-dlp spawns and pipes audio directly
// ─────────────────────────────────────────────

app.get("/api/yt/pipe/:videoId", async (req, res) => {
    if (!BACKEND_STREAMING_ENABLED) {
        return res.status(410).json({
            error: "Backend audio proxy is disabled. Use client-side source resolution.",
        });
    }

    const { videoId } = req.params;
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
        return res.status(400).send("Invalid videoId");
    }

    // Note: This is a streaming endpoint. `curl -I` (HEAD) is not a reliable test.
    // We still handle HEAD quickly to avoid apparent hangs during debugging.
    if (req.method === 'HEAD') {
        res.status(200);
        res.setHeader('Content-Type', 'audio/webm');
        res.setHeader('Accept-Ranges', 'none');
        return res.end();
    }

    const cachedPath = getCachedFilePath(videoId);
    if (cachedPath) {
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.sendFile(cachedPath);
    }

    // Strategy 1: queued yt-dlp process piping
    await pipeYtdlpToResponse({ req, res, videoId });
});

async function pipeYtdlpToResponse({ req, res, videoId, contentDisposition = "" }) {
    const startTimeoutMs = Math.max(1000, Number(process.env.YTDLP_PIPE_START_TIMEOUT_MS || 8000));

    await ytdlpQueue.add(async () => {
        let headersCommitted = false;

        const commitHeaders = (contentType) => {
            if (headersCommitted || res.headersSent) return;
            res.setHeader("Content-Type", contentType || "audio/mp4");
            res.setHeader("Accept-Ranges", "none");
            if (contentDisposition) {
                res.setHeader("Content-Disposition", contentDisposition);
            }
            try {
                res.flushHeaders?.();
            } catch {
                // ignore
            }
            headersCommitted = true;
        };

        const pipeAttempt = (opts) => new Promise((resolve) => {
            const args = buildYtdlpArgs(videoId, {
                extractorArgs: YT_EXTRACTOR_ARGS,
                format: opts.format,
                sourceAddress: YT_SOURCE_ADDRESS,
                outputToStdout: true,
                playerClient: opts.playerClient,
            });

            const { proc } = spawnWithTimeout(
                YT_DLP_BIN,
                args,
                { timeoutMs: Number(process.env.YTDLP_PIPE_TIMEOUT_MS || 0) || 24 * 60 * 60 * 1000 }
            );

            let hasData = false;
            let stderrBuf = "";
            const startTimer = setTimeout(() => {
                if (!hasData) {
                    try { proc.kill("SIGKILL"); } catch { }
                }
            }, startTimeoutMs);

            proc.stdout.on("data", (chunk) => {
                if (!hasData) {
                    hasData = true;
                    clearTimeout(startTimer);
                    commitHeaders(opts.contentType);
                    logger.info("pipe", "yt-dlp pipe started streaming", {
                        videoId,
                        playerClient: opts.playerClient,
                        contentType: opts.contentType,
                        format: opts.format,
                    });
                }
                if (!res.writableEnded) res.write(chunk);
            });

            proc.stderr.on("data", (chunk) => {
                stderrBuf += chunk.toString();
                if (stderrBuf.length > 10_000) stderrBuf = stderrBuf.slice(-10_000);
            });

            proc.on("close", () => {
                clearTimeout(startTimer);
                resolve({ ok: hasData, stderr: stderrBuf });
            });

            proc.on("error", (err) => {
                clearTimeout(startTimer);
                resolve({ ok: false, stderr: `${stderrBuf}\n${err?.message || ''}`.trim() });
            });

            req.on("close", () => {
                try {
                    proc.kill("SIGTERM");
                } catch {
                    // ignore
                }
            });
        });

        const first = await pipeAttempt({
            playerClient: "web",
            format: "251/250/249/140/139/bestaudio",
            contentType: "audio/webm",
        });
        if (first.ok) {
            if (!res.writableEnded) res.end();
            return;
        }

        const second = await pipeAttempt({
            playerClient: "tv",
            format: "251/250/249/140/139/bestaudio",
            contentType: "audio/webm",
        });
        if (second.ok) {
            if (!res.writableEnded) res.end();
            return;
        }

        const third = await pipeAttempt({
            playerClient: "mweb",
            format: "251/250/249/140/139/bestaudio",
            contentType: "audio/webm",
        });
        if (third.ok) {
            if (!res.writableEnded) res.end();
            return;
        }

        // Strategy 2: resolve a direct stream URL through provider fallback chain.
        // This prevents hard 502s when yt-dlp pipe gets bot-blocked for specific videos.
        try {
            const innertube = await getYT();
            const cache = await cachePromise;
            const fallbackUrl = await resolveStreamUrl({
                innertube,
                ytdlpBin: YT_DLP_BIN,
                cache,
                videoId,
                title: null,
                artist: null,
            });

            if (fallbackUrl) {
                const upstream = await fetch(fallbackUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                });

                if (upstream.ok || upstream.status === 206) {
                    logger.warn("pipe", "yt-dlp pipe failed; serving resolver fallback stream", {
                        videoId,
                        status: upstream.status,
                    });
                    return pipeUpstream(upstream, res);
                }
            }
        } catch (fallbackErr) {
            logger.warn("pipe", "resolver fallback failed after yt-dlp pipe failure", {
                videoId,
                error: fallbackErr?.message,
            });
        }

        if (!res.headersSent) {
            logger.error("pipe", "yt-dlp pipe failed", {
                videoId,
                stderr: (third.stderr || second.stderr || first.stderr || '').slice(0, 500),
            });
            res.status(502).json({ error: "Stream unavailable" });
        } else {
            res.end();
        }
    });
}

function pipeUpstream(upstream, res) {
    res.status(upstream.status);
    const fwd = ["content-type", "content-length", "content-range", "accept-ranges"];
    fwd.forEach((h) => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    });
    if (!upstream.headers.get("accept-ranges")) {
        res.setHeader("Accept-Ranges", "bytes");
    }

    // Flush headers early so clients/proxies don't wait for the first chunk.
    try {
        res.flushHeaders?.();
    } catch {
        // ignore
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
        while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(value)) {
                await new Promise((r) => res.once("drain", r));
            }
        }
    };
    pump().catch(() => res.end());
}

// ─────────────────────────────────────────────
// up-next / radio recommendations
// ─────────────────────────────────────────────

app.get("/api/yt/up-next/:videoId", async (req, res) => {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ results: [] });

    try {
        const innertube = await getYT();
        const upNext = await innertube.music.getUpNext(videoId, true);
        const items = upNext?.contents || [];
        const results = [];

        for (const item of items) {
            try {
                const id = item.video_id || item.id;
                if (!id || id === videoId) continue;

                results.push({
                    id,
                    title: pickText(item.title, item.name) || "Unknown Title",
                    artist: pickArtistName(item).join(", ") || "Unknown Artist",
                    artists: pickArtists(item),
                    album: pickText(item.album?.name, item.album?.text, item.album),
                    duration: parseDuration(
                        item.duration?.text || item.duration
                    ),
                    durationText:
                        item.duration?.text || item.duration || "",
                    thumbnail: pickThumbnailUrl(item),
                    thumbnails: [
                        ...(Array.isArray(item.thumbnail) ? item.thumbnail : []),
                        ...(Array.isArray(item.thumbnails) ? item.thumbnails : []),
                    ],
                });
            } catch {
                // skip malformed items
            }
        }

        res.json({ results: results.slice(0, 25) });
    } catch (err) {
        console.error("Up-next error:", err.message);
        res.json({ results: [] });
    }
});

// ─────────────────────────────────────────────
// health
// ─────────────────────────────────────────────

app.get("/api/yt/health", (req, res) => {
    res.json({
        status: "ok",
        cache: {
            type: process.env.REDIS_URL ? "redis" : "memory",
            namespace: process.env.CACHE_NAMESPACE || "aura",
        },
        hasSession: !!yt,
        ytdlp: {
            bin: YT_DLP_BIN,
            jsRuntimes: YT_DLP_JS_RUNTIMES,
            hasProxy: Boolean(YT_DLP_PROXY),
            playerSkip: YT_PLAYER_SKIP,
            extractorArgs: YT_EXTRACTOR_ARGS || "",
            backendStreamingEnabled: BACKEND_STREAMING_ENABLED,
        },
    });
});

app.get("/api/yt/health/extract", async (req, res) => {
    const videoId = String(req.query?.videoId || "").trim();
    const requestedClient = String(req.query?.client || "").trim();
    const playerClient = requestedClient || "tv";
    if (!videoId) {
        return res.status(400).json({ ok: false, error: "videoId query parameter is required" });
    }

    const args = buildYtdlpArgs(videoId, {
        getUrl: true,
        playerClient,
        extractorArgs: YT_EXTRACTOR_ARGS,
        sourceAddress: YT_SOURCE_ADDRESS,
        jsRuntimes: YT_DLP_JS_RUNTIMES,
    });

    try {
        const { proc, done } = spawnWithTimeout(YT_DLP_BIN, args, {
            timeoutMs: Math.max(3000, Number(process.env.YTDLP_HEALTH_TIMEOUT_MS || 20000)),
        });

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 4096) stdout = stdout.slice(-4096);
        });
        proc.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 12000) stderr = stderr.slice(-12000);
        });

        const { code } = await done;
        const url = stdout.trim().split(/\r?\n/)[0]?.trim() || "";

        return res.json({
            ok: Boolean(url),
            videoId,
            playerClient,
            code,
            hasUrl: Boolean(url),
            urlPreview: url ? `${url.slice(0, 120)}...` : "",
            ytdlp: {
                bin: YT_DLP_BIN,
                jsRuntimes: YT_DLP_JS_RUNTIMES,
                hasProxy: Boolean(YT_DLP_PROXY),
                playerSkip: YT_PLAYER_SKIP,
                extractorArgs: YT_EXTRACTOR_ARGS || "",
            },
            stderr: stderr.slice(-1500),
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            videoId,
            playerClient,
            error: error?.message || "yt-dlp health check failed",
            ytdlp: {
                bin: YT_DLP_BIN,
                jsRuntimes: YT_DLP_JS_RUNTIMES,
                hasProxy: Boolean(YT_DLP_PROXY),
                playerSkip: YT_PLAYER_SKIP,
                extractorArgs: YT_EXTRACTOR_ARGS || "",
            },
        });
    }
});

app.get("/api/metrics", (req, res) => {
    res.json({
        status: "ok",
        metrics: metrics.snapshot(),
    });
});

// ─────────────────────────────────────────────
// duration parser
// ─────────────────────────────────────────────

function parseDuration(text) {
    if (!text) return 0;

    const parts = text.split(":").map(Number);

    if (parts.length === 3)
        return parts[0] * 3600 + parts[1] * 60 + parts[2];

    if (parts.length === 2)
        return parts[0] * 60 + parts[1];

    return parts[0] || 0;
}

function decodeHtml(value) {
    return String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
}

function pickText(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return decodeHtml(value);
        if (value && typeof value === "object") {
            if (typeof value.text === "string" && value.text.trim()) return decodeHtml(value.text);
            if (typeof value.name === "string" && value.name.trim()) return decodeHtml(value.name);
            if (typeof value.toString === "function") {
                const text = value.toString();
                if (typeof text === "string" && text.trim() && text !== "[object Object]") {
                    return decodeHtml(text);
                }
            }
        }
    }
    return "";
}

function pickArtists(item) {
    const artists = Array.isArray(item?.artists) ? item.artists : [];
    const names = artists
        .map((artist) => ({
            name: pickText(artist?.name, artist?.text, artist),
            id: artist?.channel_id || artist?.id || "",
        }))
        .filter((artist) => artist.name);

    if (names.length) return names;

    const fallback = pickText(item?.artist, item?.author, item?.subtitle);
    return fallback ? [{ name: fallback, id: "" }] : [];
}

function pickArtistName(item) {
    return pickArtists(item).map((artist) => artist.name).filter(Boolean);
}

function pickThumbnailUrl(item) {
    const candidates = [
        ...(Array.isArray(item?.thumbnails) ? item.thumbnails : []),
        ...(Array.isArray(item?.thumbnail) ? item.thumbnail : []),
    ].filter((entry) => entry?.url);

    if (!candidates.length) return "";

    candidates.sort((a, b) => {
        const areaA = Number(a.width || 0) * Number(a.height || 0);
        const areaB = Number(b.width || 0) * Number(b.height || 0);
        return areaB - areaA;
    });

    return candidates[0]?.url || "";
}

function sanitizeFilename(value) {
    return String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

function hasEnv(value) {
    return String(value || "").trim().length > 0;
}

function extractYoutubePlaylistId(value) {
    const text = String(value || "").trim();
    if (!text) return "";

    let decoded = text;
    try {
        decoded = decodeURIComponent(text);
    } catch {
        decoded = text;
    }

    const match = decoded.match(/(?:[?&]list=|\blist=)([a-zA-Z0-9_-]+)/);
    if (match?.[1]) return String(match[1]).trim();

    try {
        const parsed = new URL(decoded.startsWith("http") ? decoded : `https://www.youtube.com/playlist?list=${decoded}`);
        const id = String(parsed.searchParams.get("list") || "").trim();
        if (id) return id;
    } catch {
        // Ignore URL parser failures and continue with raw-id checks.
    }

    if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text;
    return "";
}

function buildLastfmApiSig(params, secret) {
    const keys = Object.keys(params)
        .filter((key) => key !== "format" && key !== "callback" && params[key] != null)
        .sort();
    const raw = keys.map((key) => `${key}${params[key]}`).join("") + secret;
    return createHash("md5").update(raw).digest("hex");
}

async function fetchPlaylistEntriesFromHtml(playlistId, maxEntries = 120) {
    const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
    const response = await fetch(playlistUrl, {
        headers: {
            "User-Agent": HTTP_UA,
            "Accept": "text/html,application/xhtml+xml",
        },
    });

    if (!response.ok) {
        throw new Error(`Playlist page responded with ${response.status}`);
    }

    const html = await response.text();
    const idMatches = html.matchAll(/"videoId":"([\\w-]{11})"/g);
    const ids = [];
    const seen = new Set();

    for (const match of idMatches) {
        const id = String(match?.[1] || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= maxEntries) break;
    }

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const rawTitle = String(titleMatch?.[1] || "").trim();
    const title = rawTitle
        ? rawTitle.replace(/\s*-\s*YouTube\s*$/i, '').trim()
        : null;

    return {
        title,
        entries: ids.map((videoId) => ({ videoId, title: null, duration: null, channel: null })),
    };
}

async function getSpotifyAccessToken() {
    const now = Date.now();
    if (spotifyTokenCache.accessToken && spotifyTokenCache.expiresAt > now + 15_000) {
        return spotifyTokenCache.accessToken;
    }

    if (!hasEnv(SPOTIFY_CLIENT_ID) || !hasEnv(SPOTIFY_CLIENT_SECRET)) {
        throw new Error("Spotify credentials are not configured.");
    }

    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${auth}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!response.ok) {
        throw new Error(`Spotify token endpoint responded with ${response.status}`);
    }

    const payload = await response.json();
    const token = String(payload?.access_token || "").trim();
    const expiresIn = Math.max(30, Number(payload?.expires_in || 3600));
    if (!token) {
        throw new Error("Spotify token payload did not include access_token.");
    }

    spotifyTokenCache = {
        accessToken: token,
        expiresAt: Date.now() + expiresIn * 1000,
    };

    return spotifyTokenCache.accessToken;
}

// ─────────────────────────────────────────────
// plugin proxy routes (client-query compatible)
// ─────────────────────────────────────────────

app.get("/api/plugins/spotify-metadata", async (req, res) => {
    const title = String(req.query?.title || "").trim();
    const artist = String(req.query?.artist || "").trim();

    if (!title || !artist) {
        return res.status(400).json({ ok: false, error: "title and artist query parameters are required." });
    }

    if (!hasEnv(SPOTIFY_CLIENT_ID) || !hasEnv(SPOTIFY_CLIENT_SECRET)) {
        return res.status(503).json({ ok: false, error: "Spotify credentials are not configured on server." });
    }

    try {
        const token = await getSpotifyAccessToken();
        const query = `track:${title} artist:${artist}`;
        const url = new URL(`${SPOTIFY_API_BASE}/search`);
        url.searchParams.set("type", "track");
        url.searchParams.set("limit", "1");
        url.searchParams.set("q", query);

        const response = await fetch(url.toString(), {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/json",
            },
        });

        if (!response.ok) {
            return res.status(response.status).json({ ok: false, error: `Spotify responded with ${response.status}` });
        }

        const payload = await response.json();
        const track = Array.isArray(payload?.tracks?.items) ? payload.tracks.items[0] : null;

        return res.json({
            ok: true,
            trackId: track?.id || null,
            album: track?.album?.name || null,
            releaseDate: track?.album?.release_date || null,
            popularity: Number(track?.popularity || 0) || null,
            coverArt: track?.album?.images?.[0]?.url || null,
            previewUrl: track?.preview_url || null,
        });
    } catch (error) {
        logger.warn("plugins", "spotify metadata proxy failed", { error: error?.message });
        return res.status(502).json({ ok: false, error: "Spotify metadata unavailable." });
    }
});

app.post("/api/plugins/lastfm", async (req, res) => {
    const method = String(req.body?.method || "").trim();
    const track = String(req.body?.track || "").trim();
    const artist = String(req.body?.artist || "").trim();
    const album = String(req.body?.album || "").trim();
    const allowedMethods = new Set(["track.updateNowPlaying", "track.scrobble"]);

    if (!allowedMethods.has(method)) {
        return res.status(400).json({ ok: false, error: "Unsupported Last.fm method." });
    }

    if (!track || !artist) {
        return res.status(400).json({ ok: false, error: "track and artist are required." });
    }

    if (!hasEnv(LASTFM_API_KEY) || !hasEnv(LASTFM_API_SECRET) || !hasEnv(LASTFM_SESSION_KEY)) {
        return res.status(503).json({ ok: false, error: "Last.fm credentials are not configured on server." });
    }

    const params = {
        method,
        api_key: LASTFM_API_KEY,
        sk: LASTFM_SESSION_KEY,
        track,
        artist,
    };

    if (album) params.album = album;

    if (method === "track.updateNowPlaying") {
        const durationSec = Number(req.body?.durationSec || 0);
        if (Number.isFinite(durationSec) && durationSec > 0) {
            params.duration = String(Math.round(durationSec));
        }
    }

    if (method === "track.scrobble") {
        const rawTs = Number(req.body?.timestamp || Math.floor(Date.now() / 1000));
        const timestamp = Number.isFinite(rawTs) && rawTs > 0
            ? Math.floor(rawTs)
            : Math.floor(Date.now() / 1000);
        params.timestamp = String(timestamp);
    }

    params.api_sig = buildLastfmApiSig(params, LASTFM_API_SECRET);
    params.format = "json";

    try {
        const response = await fetch(LASTFM_API_BASE, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "User-Agent": HTTP_UA,
            },
            body: new URLSearchParams(params),
        });

        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { raw: text };
        }

        if (!response.ok || payload?.error) {
            return res.status(response.ok ? 502 : response.status).json({
                ok: false,
                error: payload?.message || `Last.fm responded with ${response.status}`,
                details: payload,
            });
        }

        return res.json({ ok: true, data: payload });
    } catch (error) {
        logger.warn("plugins", "lastfm proxy failed", { error: error?.message, method });
        return res.status(502).json({ ok: false, error: "Last.fm proxy unavailable." });
    }
});

app.get("/api/plugins/youtube-playlist", async (req, res) => {
    const input = String(req.query?.list || "").trim();
    const playlistId = extractYoutubePlaylistId(input);
    if (!playlistId) {
        return res.status(400).json({ ok: false, error: "Invalid YouTube playlist URL or ID." });
    }

    const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
    const maxEntries = Math.max(1, Math.min(200, Number(req.query?.max || 120)));
    const args = [
        "--ignore-config",
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-end",
        String(maxEntries),
        "--no-warnings",
        playlistUrl,
    ];

    const tryYtdlp = async () => {
        const { proc, done } = spawnWithTimeout(YT_DLP_BIN, args, {
            timeoutMs: Math.max(4_000, Number(process.env.YT_PLAYLIST_IMPORT_TIMEOUT_MS || 20_000)),
        });

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
        });
        proc.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
        });

        const { code } = await done;
        if (code !== 0) {
            throw new Error(stderr.slice(-4000) || "yt-dlp playlist import failed");
        }

        const payload = JSON.parse(stdout || "{}");
        return {
            title: String(payload?.title || "").trim() || null,
            entries: (Array.isArray(payload?.entries) ? payload.entries : [])
            .map((entry) => ({
                videoId: String(entry?.id || "").trim(),
                title: String(entry?.title || "").trim() || null,
                duration: Number(entry?.duration || 0) || null,
                channel: String(entry?.channel || entry?.uploader || "").trim() || null,
            }))
            .filter((entry) => entry.videoId),
        };
    };

    try {
        let imported = null;

        try {
            imported = await tryYtdlp();
        } catch (ytdlpError) {
            logger.warn("plugins", "yt-dlp playlist import failed, trying HTML fallback", {
                playlistId,
                error: ytdlpError?.message,
            });

            imported = await fetchPlaylistEntriesFromHtml(playlistId, maxEntries);
        }

        const entries = Array.isArray(imported?.entries) ? imported.entries.filter((entry) => entry?.videoId) : [];
        if (!entries.length) {
            return res.status(502).json({ ok: false, error: "Playlist import returned no tracks." });
        }

        return res.json({
            ok: true,
            playlistId,
            title: imported?.title || null,
            entries,
        });
    } catch (error) {
        logger.warn("plugins", "youtube playlist import failed", {
            playlistId,
            error: error?.message,
        });
        return res.status(502).json({ ok: false, error: "YouTube playlist import unavailable." });
    }
});

// ─────────────────────────────────────────────
// Music DNA endpoints
// ─────────────────────────────────────────────

/**
 * GET /api/user/dna
 * Get user's music DNA profile
 */
app.get("/api/user/dna", requireAuth, async (req, res) => {
    try {
        const userId = req.auth?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const dna = await getUserDNA(userId);
        res.json({ ok: true, dna });
    } catch (error) {
        logger.error("Error fetching user DNA:", error);
        
        // Check if it's a database connection error
        if (error?.code === 'ECONNREFUSED' || error?.message?.includes('does not exist')) {
            return res.status(503).json({ 
                error: "Music DNA feature is temporarily unavailable",
                reason: "database_not_configured",
                hint: "Please set DATABASE_URL environment variable or ensure PostgreSQL is running on localhost:5432"
            });
        }
        
        res.status(500).json({ error: "Failed to fetch DNA profile" });
    }
});

/**
 * POST /api/user/dna/refresh
 * Recalculate user's music DNA
 */
app.post("/api/user/dna/refresh", requireAuth, async (req, res) => {
    try {
        const userId = req.auth?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const dna = await calculateUserDNA(userId);
        res.json({ ok: true, dna });
    } catch (error) {
        logger.error("Error calculating user DNA:", error);
        
        // Check if it's a database connection error
        if (error?.code === 'ECONNREFUSED' || error?.message?.includes('does not exist')) {
            return res.status(503).json({ 
                error: "Music DNA feature is temporarily unavailable",
                reason: "database_not_configured",
                hint: "Please set DATABASE_URL environment variable or ensure PostgreSQL is running on localhost:5432"
            });
        }
        
        res.status(500).json({ error: "Failed to calculate DNA profile" });
    }
});

/**
 * GET /api/user/sonic-twins
 * Get sonic twin artists recommendations
 */
app.get("/api/user/sonic-twins", requireAuth, async (req, res) => {
    try {
        const userId = req.auth?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const limit = Math.min(50, Math.max(5, Number(req.query?.limit || 10)));
        const twins = await findSonicTwins(userId, limit);
        
        res.json({ ok: true, sonicTwins: twins });
    } catch (error) {
        logger.error("Error finding sonic twins:", error);
        
        // Check if it's a database connection error
        if (error?.code === 'ECONNREFUSED' || error?.message?.includes('does not exist')) {
            return res.status(503).json({ 
                error: "Music DNA feature is temporarily unavailable",
                reason: "database_not_configured",
                hint: "Please set DATABASE_URL environment variable or ensure PostgreSQL is running on localhost:5432"
            });
        }
        
        res.status(500).json({ error: "Failed to find sonic twins" });
    }
});

// ─────────────────────────────────────────────
// serve frontend

// ─────────────────────────────────────────────
// serve frontend
// ─────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback (but ignore API routes)
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ─────────────────────────────────────────────
// start server
// ─────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Aura server running on port ${PORT}`);

    // Initialize Music DNA schema
    initializeMusicDNASchema(pool).catch((err) => {
        console.error("[Aura][Error initializing Music DNA schema:]", err?.message || err);
    });

    scheduleYtdlpAutoUpdate(YT_DLP_BIN);

    getYT().catch((err) =>
        console.error("Session init error:", err.message)
    );
});

