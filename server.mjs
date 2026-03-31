// ═══════════════════════════════════════════════════════
// Aura Music Server
// YouTube Music backend using youtubei.js + yt-dlp
// ═══════════════════════════════════════════════════════

import express from "express";
import { Innertube } from "youtubei.js";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
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
import { buildYtdlpArgs } from "./backend/providers/ytdlpProvider.mjs";
import { spawnWithTimeout } from "./backend/lib/spawnWithTimeout.mjs";
import { logger } from "./backend/lib/logger.mjs";
import { metrics } from "./backend/lib/metrics.mjs";
import { getRecommendations, trackUserAction } from "./backend/reco/recommendations.mjs";
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
const shouldSkipRequestTimeout = (req) =>
    req.path.startsWith("/api/yt/stream/") ||
    req.path.startsWith("/api/yt/pipe/") ||
    req.path.startsWith("/api/yt/download/") ||
    req.path.startsWith("/api/yt/cache/");

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

// Optional yt-dlp cookies for sign-in/age-gated content.
// If provided, `backend/providers/ytdlpProvider.mjs` will add `--cookies <file>`.
if (process.env.YT_COOKIES_FILE) {
    logger.info("config", "Using YT_COOKIES_FILE for yt-dlp", { file: process.env.YT_COOKIES_FILE });
}

logger.info("config", "yt-dlp runtime configuration", {
    bin: YT_DLP_BIN,
    jsRuntimes: YT_DLP_JS_RUNTIMES,
    hasCookiesFile: Boolean(process.env.YT_COOKIES_FILE),
});

// resolve dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Convenience: if no env var is set, look for a cookies export in the project root.
// Note: for production, prefer setting an absolute `YT_COOKIES_FILE` path explicitly.
if (!process.env.YT_COOKIES_FILE) {
    const candidates = [
        path.join(process.cwd(), 'cookies.txt'),
    ];

    const found = candidates.find((p) => {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    });

    if (found) {
        process.env.YT_COOKIES_FILE = found;
        logger.info('config', 'Auto-detected cookies file', { file: found });
    }
}

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
            title: typeof song.title === 'string' ? song.title : (song.title?.toString?.() || song.title?.text || "Unknown"),
            artist:
                song.artists?.map((a) => a.name).join(", ") || "Unknown",
            artists:
                song.artists?.map((a) => ({
                    name: a.name,
                    id: a.channel_id,
                })) || [],
            album: song.album?.name || "YouTube Music",
            duration: parseDuration(song.duration?.text),
            durationText: song.duration?.text || "",
            thumbnail: song.thumbnails?.[0]?.url || "",
            thumbnails: song.thumbnails || [],
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
        const cache = await cachePromise;

        let title, author, duration, thumbnail;
        try {
            const info = await innertube.music.getInfo(videoId);
            title = info.basic_info?.title;
            author = info.basic_info?.author;
            duration = info.basic_info?.duration;
            thumbnail = info.basic_info?.thumbnail?.[0]?.url;
        } catch { /* metadata is optional but needed for soundcloud fallback */ }

        let streamUrl = null;
        let responseDataStreamSource = null;
        const cacheStatus = getCacheStatus(videoId);
        
        if (cacheStatus.cached) {
            // Serve from our reliable disk cache
            streamUrl = `${req.protocol}://${req.get('host')}/api/yt/cache/${videoId}`;
            logger.info("stream", "Serving from local disk cache", { videoId });
        } else {
            // Not cached locally yet. Resolve direct URL for instant playback...
            const resolved = await resolveStreamWithMeta({
                innertube,
                ytdlpBin: YT_DLP_BIN,
                cache,
                videoId,
                title,
                artist: author
            });
            streamUrl = resolved?.url || null;
            // ...and spawn the background downloader for next time!
            downloadToCache(videoId, YT_DLP_BIN);
            responseDataStreamSource = resolved?.source || null;
        }

        const responseData = {
            videoId,
            title,
            author,
            duration,
            thumbnail,
            streamUrl,
            cacheState: cacheStatus.cached ? "disk" : "warming",
            cached: cacheStatus.cached,
            cacheSizeBytes: cacheStatus.sizeBytes || 0,
            streamSource: cacheStatus.cached ? "disk-cache" : (typeof responseDataStreamSource === "string" ? responseDataStreamSource : "unknown"),
        };

        res.json(responseData);
    } catch (err) {
        logger.error("stream", "Stream error", { videoId, error: err?.message });
        res.status(500).json({ streamUrl: null, error: "Stream unavailable" });
    }
});

// ─────────────────────────────────────────────
// local disk cache static server
// ─────────────────────────────────────────────

app.get("/api/yt/cache/:videoId", (req, res) => {
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
    const { videoId } = req.params;
    const status = getCacheStatus(videoId);
    res.json({
        videoId,
        ...status,
    });
});

app.get("/api/yt/download/:videoId", async (req, res) => {
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
                        title: typeof item.title === 'string' ? item.title : (item.title?.toString?.() || item.title?.text || "Unknown"),
                        artist:
                            item.artists?.map((a) => a.name).join(", ") || "",
                        thumbnail: item.thumbnail?.[0]?.url,
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
                const match = Array.isArray(results) ? results[0] : null;
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

    // Strategy 1: resolve a URL via resolver/cache and proxy it (fast path)
    try {
        const innertube = await getYT();
        const cache = await cachePromise;
        
        let title, author;
        try {
            const info = await innertube.music.getInfo(videoId);
            title = info.basic_info?.title;
            author = info.basic_info?.author;
        } catch { /* metadata is optional but used for fallback routing */ }

        const freshUrl = await resolveStreamUrl({
            innertube,
            ytdlpBin: YT_DLP_BIN,
            cache,
            videoId,
            title,
            artist: author
        });
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        };
        if (req.headers.range) headers.Range = req.headers.range;

        const upstreamTimeoutMs = Math.max(1000, Number(process.env.UPSTREAM_FETCH_TIMEOUT_MS || 12000));
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch { }
        }, upstreamTimeoutMs);

        const upstream = await fetch(freshUrl, { headers, signal: controller.signal }).finally(() => {
            clearTimeout(timer);
        });

        if (upstream.ok || upstream.status === 206) {
            return pipeUpstream(upstream, res);
        }
    } catch (urlErr) {
        logger.warn("pipe", "URL-based stream failed; falling back to yt-dlp pipe", { videoId, error: urlErr?.message });
    }

    // Strategy 2: queued yt-dlp process piping (last resort; concurrency-limited)
    await pipeYtdlpToResponse({ req, res, videoId });
});

async function pipeYtdlpToResponse({ req, res, videoId, contentDisposition = "" }) {
    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Accept-Ranges", "none");
    if (contentDisposition) {
        res.setHeader("Content-Disposition", contentDisposition);
    }

    try {
        res.flushHeaders?.();
    } catch {
        // ignore
    }

    const startTimeoutMs = Math.max(1000, Number(process.env.YTDLP_PIPE_START_TIMEOUT_MS || 8000));

    await ytdlpQueue.add(async () => {
        const pipeAttempt = (opts) => new Promise((resolve) => {
            const args = buildYtdlpArgs(videoId, {
                extractorArgs: YT_EXTRACTOR_ARGS,
                sourceAddress: YT_SOURCE_ADDRESS,
                outputToStdout: true,
                ...opts,
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

        const first = await pipeAttempt({ playerClient: "android_vr" });
        if (first.ok) {
            if (!res.writableEnded) res.end();
            return;
        }

        const second = await pipeAttempt({ playerClient: "android" });
        if (second.ok) {
            if (!res.writableEnded) res.end();
            return;
        }

        if (!res.headersSent) {
            logger.error("pipe", "yt-dlp pipe failed", { videoId, stderr: (second.stderr || first.stderr || '').slice(0, 500) });
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
                    title: typeof item.title === 'string' ? item.title : (item.title?.toString?.() || item.title?.text || "Unknown"),
                    artist:
                        item.artists
                            ?.map((a) => a.name?.text || a.name || "")
                            .join(", ") ||
                        item.author?.text ||
                        item.author ||
                        "Unknown",
                    artists:
                        item.artists?.map((a) => ({
                            name: a.name?.text || a.name,
                            id: a.channel_id,
                        })) || [],
                    album:
                        item.album?.name?.text ||
                        item.album?.name ||
                        item.album?.text ||
                        "YouTube Music",
                    duration: parseDuration(
                        item.duration?.text || item.duration
                    ),
                    durationText:
                        item.duration?.text || item.duration || "",
                    thumbnail: item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url || "",
                    thumbnails: item.thumbnail || item.thumbnails || [],
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
    const cookiesFile = process.env.YT_COOKIES_FILE || "";
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
            hasCookiesFile: Boolean(cookiesFile),
            cookiesFileExists: cookiesFile ? fs.existsSync(cookiesFile) : false,
        },
    });
});

app.get("/api/yt/health/extract", async (req, res) => {
    const videoId = String(req.query?.videoId || "").trim();
    if (!videoId) {
        return res.status(400).json({ ok: false, error: "videoId query parameter is required" });
    }

    const cookiesFile = process.env.YT_COOKIES_FILE || "";
    const args = buildYtdlpArgs(videoId, {
        getUrl: true,
        playerClient: "android_vr",
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
            code,
            hasUrl: Boolean(url),
            urlPreview: url ? `${url.slice(0, 120)}...` : "",
            ytdlp: {
                bin: YT_DLP_BIN,
                jsRuntimes: YT_DLP_JS_RUNTIMES,
                hasCookiesFile: Boolean(cookiesFile),
                cookiesFileExists: cookiesFile ? fs.existsSync(cookiesFile) : false,
            },
            stderr: stderr.slice(-1500),
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            videoId,
            error: error?.message || "yt-dlp health check failed",
            ytdlp: {
                bin: YT_DLP_BIN,
                jsRuntimes: YT_DLP_JS_RUNTIMES,
                hasCookiesFile: Boolean(cookiesFile),
                cookiesFileExists: cookiesFile ? fs.existsSync(cookiesFile) : false,
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

function sanitizeFilename(value) {
    return String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

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

    getYT().catch((err) =>
        console.error("Session init error:", err.message)
    );
});

