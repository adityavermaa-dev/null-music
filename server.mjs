// ═══════════════════════════════════════════════════════
// Aura Music Server
// YouTube Music backend using youtubei.js
// ═══════════════════════════════════════════════════════

import express from "express";
import { Innertube, Platform } from "youtubei.js";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";

const PORT = process.env.PORT || 3001;
const app = express();

// resolve dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cache for stream urls
const streamCache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

// ─────────────────────────────────────────────
// youtube url decipher shim
// ─────────────────────────────────────────────

Platform.shim.eval = async (data, env) => {
    const properties = [];
    if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
    if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);

    const code = `${data.output}\nreturn { ${properties.join(", ")} }`;
    return new Function(code)();
};

let yt = null;

async function getYT() {
    if (!yt) {
        console.log("Creating Innertube session...");

        yt = await Innertube.create({
            lang: "en",
            location: "IN",
            retrieve_player: true,
            generate_session_locally: true,
        });

        console.log("YouTube session ready");
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
        "Origin, X-Requested-With, Content-Type, Accept"
    );
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
        pathRewrite: {
            "^/api/saavn": "/api"
        }
    })
);

// ─────────────────────────────────────────────
// search songs
// ─────────────────────────────────────────────

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

    const cached = streamCache.get(videoId);

    if (cached && cached.expiry > Date.now()) {
        return res.json(cached.data);
    }

    try {
        const innertube = await getYT();
        const info = await innertube.music.getInfo(videoId);

        const best = info.chooseFormat({ type: 'audio', quality: 'best' });

        if (!best) {
            return res.json({
                videoId,
                streamUrl: null,
            });
        }

        let streamUrl = best.url;

        if (!streamUrl && best.decipher) {
            streamUrl = await best.decipher(innertube.session?.player);
        }

        const responseData = {
            videoId,
            title: info.basic_info?.title,
            author: info.basic_info?.author,
            duration: info.basic_info?.duration,
            thumbnail: info.basic_info?.thumbnail?.[0]?.url,
            streamUrl: String(streamUrl),
            mimeType: best.mime_type,
            bitrate: best.bitrate,
        };

        streamCache.set(videoId, {
            data: responseData,
            expiry: Date.now() + CACHE_TTL,
        });

        res.json(responseData);
    } catch (err) {
        console.error("Stream error:", err.message);
        res.status(500).json({ streamUrl: null });
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
// proxy stream
// ─────────────────────────────────────────────

app.get("/api/yt/proxy-stream", async (req, res) => {
    const { url } = req.query;

    if (!url) return res.status(400).send("URL required");

    try {
        const response = await fetch(url, {
            headers: {
                Range: req.headers.range || "bytes=0-",
                "User-Agent": "Mozilla/5.0",
            },
        });

        res.status(response.status);

        response.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });

        response.body.pipeTo(
            new WritableStream({
                write(chunk) {
                    res.write(chunk);
                },
                close() {
                    res.end();
                },
            })
        );
    } catch (err) {
        console.error("Proxy error:", err.message);
        res.status(500).send("Proxy error");
    }
});

// ─────────────────────────────────────────────
// health
// ─────────────────────────────────────────────

app.get("/api/yt/health", (req, res) => {
    res.json({
        status: "ok",
        cacheSize: streamCache.size,
        hasSession: !!yt,
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
app.get(/^\/(?!api).*/, (req, res) => {
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