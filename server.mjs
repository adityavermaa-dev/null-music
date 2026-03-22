// ═══════════════════════════════════════════════════════
// Aura Music Server
// YouTube Music backend using youtubei.js + yt-dlp
// ═══════════════════════════════════════════════════════

import express from "express";
import { Innertube } from "youtubei.js";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import rateLimit from "express-rate-limit";
import timeout from "connect-timeout";

import { createCache } from "./backend/cache/cache.mjs";
import { resolveStreamUrl } from "./backend/resolver/streamResolver.mjs";
import { ytdlpQueue } from "./backend/queue/ytdlpQueue.mjs";
import { buildYtdlpArgs } from "./backend/providers/ytdlpProvider.mjs";
import { spawnWithTimeout } from "./backend/lib/spawnWithTimeout.mjs";
import { logger } from "./backend/lib/logger.mjs";
import { metrics } from "./backend/lib/metrics.mjs";
import { getRecommendations, trackUserAction } from "./backend/reco/recommendations.mjs";

const PORT = process.env.PORT || 3001;
const app = express();

// JSON body parsing (used by /api/track)
app.use(express.json({ limit: "50kb" }));

// basic health endpoint (deployment / load balancers)
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// request timeout (prevents long-hanging requests)
const requestTimeout = process.env.REQUEST_TIMEOUT || "10s";
app.use(timeout(requestTimeout));
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

// Cookies are intentionally disabled (yt-dlp runs without cookies).
if (process.env.YT_COOKIES_FILE) {
    logger.warn("config", "Ignoring YT_COOKIES_FILE: cookies are disabled in this backend");
}

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
    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key, x-api-key"
    );
    next();
});

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
// saavn proxy
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
// search songs
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// user tracking + recommendations
// ─────────────────────────────────────────────

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
            title: song.title || "Unknown",
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

        const streamUrl = await resolveStreamUrl({
            innertube,
            ytdlpBin: YT_DLP_BIN,
            cache,
            videoId,
        });

        // Fetch metadata from youtubei.js (still works for info, just not stream URLs)
        let title, author, duration, thumbnail;
        try {
            const info = await innertube.music.getInfo(videoId);
            title = info.basic_info?.title;
            author = info.basic_info?.author;
            duration = info.basic_info?.duration;
            thumbnail = info.basic_info?.thumbnail?.[0]?.url;
        } catch { /* metadata is optional */ }

        const responseData = {
            videoId,
            title,
            author,
            duration,
            thumbnail,
            streamUrl,
        };

        res.json(responseData);
    } catch (err) {
        logger.error("stream", "Stream error", { videoId, error: err?.message });
        res.status(500).json({ streamUrl: null, error: "Stream unavailable" });
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
                if (item.id && item.title) {
                    songs.push({
                        id: item.id,
                        title: item.title,
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

    // Strategy 1: resolve a URL via resolver/cache and proxy it (fast path)
    try {
        const innertube = await getYT();
        const cache = await cachePromise;
        const freshUrl = await resolveStreamUrl({
            innertube,
            ytdlpBin: YT_DLP_BIN,
            cache,
            videoId,
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
    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Accept-Ranges", "none");

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

        const second = await pipeAttempt({ jsRuntimeNode: true });
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
});

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
                    title: item.title?.text || item.title || "Unknown",
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
                    thumbnail: item.thumbnails?.[0]?.url || "",
                    thumbnails: item.thumbnails || [],
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
    });
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

