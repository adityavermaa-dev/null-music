import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../lib/logger.mjs';
import { getYtdlpProxy } from '../providers/ytdlpProvider.mjs';

const CACHE_DIR = path.resolve(process.env.AURA_AUDIO_CACHE_DIR || 'backend/cache/audio');
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const CACHE_EXTENSIONS = ['.m4a', '.webm', '.mp4', '.mp3', '.ogg', '.opus'];
const PARTIAL_SUFFIX = '.partial';
const LOCK_SUFFIX = '.lock';

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function lockPath(videoId) {
    return path.join(CACHE_DIR, `${videoId}${LOCK_SUFFIX}`);
}

function partialPrefix(videoId) {
    return `${videoId}${PARTIAL_SUFFIX}.`;
}

function partialTemplate(videoId) {
    return path.join(CACHE_DIR, `${partialPrefix(videoId)}%(ext)s`);
}

function listCacheFiles(dir = CACHE_DIR) {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

function findCachedEntry(videoId, dir = CACHE_DIR) {
    for (const ext of CACHE_EXTENSIONS) {
        const filePath = path.join(dir, `${videoId}${ext}`);
        if (fs.existsSync(filePath)) {
            return { filePath, ext };
        }
    }
    return null;
}

function findPartialEntry(videoId, dir = CACHE_DIR) {
    const prefix = partialPrefix(videoId);
    const files = listCacheFiles(dir)
        .filter((name) => name.startsWith(prefix))
        .sort();

    if (!files.length) return null;

    const filePath = path.join(dir, files[0]);
    return {
        filePath,
        ext: path.extname(filePath),
    };
}

function cleanupPartialFiles(videoId, dir = CACHE_DIR) {
    const prefix = partialPrefix(videoId);
    for (const file of listCacheFiles(dir)) {
        if (!file.startsWith(prefix)) continue;
        try {
            fs.unlinkSync(path.join(dir, file));
        } catch {
            // ignore cleanup errors
        }
    }
}

function touch(filePath) {
    const now = new Date();
    try {
        fs.utimesSync(filePath, now, now);
    } catch {
        // ignore touch failures
    }
}

export async function enforceCacheLimit() {
    try {
        const files = await fs.promises.readdir(CACHE_DIR);
        const fileStats = await Promise.all(files
            .filter((file) => !file.endsWith(LOCK_SUFFIX))
            .map(async (file) => {
                const filePath = path.join(CACHE_DIR, file);
                const stats = await fs.promises.stat(filePath);
                return { filePath, size: stats.size, mtime: stats.mtimeMs };
            }));

        let totalSize = fileStats.reduce((acc, curr) => acc + curr.size, 0);

        if (totalSize <= MAX_CACHE_BYTES) return;

        fileStats.sort((a, b) => a.mtime - b.mtime);

        for (const file of fileStats) {
            if (totalSize <= MAX_CACHE_BYTES) break;
            try {
                await fs.promises.unlink(file.filePath);
                totalSize -= file.size;
                logger.debug('cache', `Evicted ${path.basename(file.filePath)} (freed ${(file.size / 1024 / 1024).toFixed(2)} MB)`);
            } catch (err) {
                logger.error('cache', `Failed to evict ${file.filePath}`, err);
            }
        }

        logger.info('cache', `Cache limit enforced. Current size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
        logger.error('cache', 'Error enforcing cache limit', err);
    }
}

export function downloadToCache(videoId, ytdlpBin) {
    if (!videoId || !ytdlpBin) return;

    const existing = findCachedEntry(videoId);
    const lockFile = lockPath(videoId);
    if (existing || fs.existsSync(lockFile)) return;

    logger.debug('cache', `Starting background download for ${videoId}`);

    try {
        fs.writeFileSync(lockFile, String(Date.now()));
    } catch {
        return;
    }

    const args = [
        '--ignore-config',
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--output', partialTemplate(videoId),
        '--no-playlist',
        '--quiet',
        '--no-warnings',
    ];

    if (process.env.YT_COOKIES_FILE) {
        args.push('--cookies', process.env.YT_COOKIES_FILE);
    }

    if (process.env.YT_DLP_JS_RUNTIMES) {
        args.push('--js-runtimes', process.env.YT_DLP_JS_RUNTIMES);
    }

    const proxy = getYtdlpProxy();
    if (proxy) {
        args.push('--proxy', proxy);
    }

    args.push('--add-header', 'User-Agent: com.google.android.youtube/19.09.37 (Linux; Android 13)');
    args.push('--add-header', 'Accept-Language: en-US,en;q=0.9');

    const playerClient = process.env.YT_PLAYER_CLIENTS || 'mweb';
    const skipWebpage = process.env.YT_PLAYER_SKIP || '';
    const extractorParts = [`player_client=${playerClient}`];
    if (skipWebpage) extractorParts.push(`player_skip=${skipWebpage}`);
    args.push('--extractor-args', `youtube:${extractorParts.join(';')}`);

    if (process.env.YT_EXTRACTOR_ARGS) {
        args.push('--extractor-args', process.env.YT_EXTRACTOR_ARGS);
    }

    if (process.env.YT_SOURCE_ADDRESS) {
        args.push('--source-address', process.env.YT_SOURCE_ADDRESS);
    }

    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    const proc = spawn(ytdlpBin, args, { stdio: 'ignore', detached: true });
    proc.unref();

    const finalize = () => {
        try {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {
            // ignore cleanup errors
        }
    };

    proc.on('close', (code) => {
        try {
            const partial = findPartialEntry(videoId);
            if (code === 0 && partial?.filePath && fs.existsSync(partial.filePath)) {
                const finalPath = path.join(CACHE_DIR, `${videoId}${partial.ext}`);
                if (fs.existsSync(finalPath)) {
                    fs.unlinkSync(finalPath);
                }
                fs.renameSync(partial.filePath, finalPath);
                touch(finalPath);
                cleanupPartialFiles(videoId);
                logger.info('cache', `Successfully cached ${videoId}`, { ext: partial.ext });
                void enforceCacheLimit();
            } else {
                cleanupPartialFiles(videoId);
                logger.warn('cache', `Background download failed for ${videoId}`, { code });
            }
        } catch (err) {
            cleanupPartialFiles(videoId);
            logger.error('cache', `Failed to finalize cache for ${videoId}`, err);
        } finally {
            finalize();
        }
    });

    proc.on('error', (err) => {
        cleanupPartialFiles(videoId);
        finalize();
        logger.warn('cache', `Background download errored for ${videoId}`, { error: err?.message });
    });
}

export function getCachedFilePath(videoId) {
    const entry = findCachedEntry(videoId);
    if (!entry) return null;
    touch(entry.filePath);
    return entry.filePath;
}

export function getCacheStatus(videoId, dir = CACHE_DIR) {
    const entry = findCachedEntry(videoId, dir);
    if (entry?.filePath) {
        let sizeBytes = 0;
        try {
            sizeBytes = fs.statSync(entry.filePath).size;
        } catch {
            sizeBytes = 0;
        }
        return {
            cached: true,
            warming: false,
            path: entry.filePath,
            ext: entry.ext,
            sizeBytes,
        };
    }

    const warming = fs.existsSync(path.join(dir, `${videoId}${LOCK_SUFFIX}`));
    return {
        cached: false,
        warming,
        path: null,
        ext: null,
        sizeBytes: 0,
    };
}

export function findCachedFilePath(videoId, dir = CACHE_DIR) {
    return findCachedEntry(videoId, dir)?.filePath || null;
}
