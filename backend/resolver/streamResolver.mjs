import { retry } from '../lib/retry.mjs';
import { logger } from '../lib/logger.mjs';
import { withTimeout } from '../lib/withTimeout.mjs';
import { dedupe } from '../lib/dedupe.mjs';
import { metrics } from '../lib/metrics.mjs';
import { youtubeiGetAudioUrl } from '../providers/youtubeiProvider.mjs';
import { pipedGetAudioUrl } from '../providers/pipedProvider.mjs';
import { ytdlCoreGetAudioUrl } from '../providers/ytdlCoreProvider.mjs';
import { soundcloudGetAudioUrl } from '../providers/soundcloudProvider.mjs';
import { ytdlpGetUrl } from '../providers/ytdlpProvider.mjs';
import { invidiousGetAudioUrl } from '../providers/invidiousProvider.mjs';
import { ytdlpQueue } from '../queue/ytdlpQueue.mjs';
import { isStreamAlive } from '../utils/validateStream.mjs';

const TTL_SECONDS = Math.max(60, Number(process.env.STREAM_CACHE_TTL_SECONDS || 1800));
const CACHE_NAMESPACE = (process.env.CACHE_NAMESPACE || 'aura').trim() || 'aura';
const VALIDATION_TIMEOUT_MS = Math.max(500, Number(process.env.STREAM_VALIDATE_TIMEOUT_MS || 4000));
const PRIMARY_TIMEOUT_MS = Math.max(500, Number(process.env.PRIMARY_TIMEOUT_MS || 8000));
const FALLBACK_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.YTDLP_TIMEOUT_MS || process.env.YTDLP_TIMEOUT || 8000)
);
const YTDLP_CLIENTS = String(process.env.YT_DLP_FALLBACK_CLIENTS || 'mweb,tv,web_creator')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

let ytdlpFailureCount = 0;
const YTDLP_CB_THRESHOLD = Math.max(1, Number(process.env.YTDLP_CB_THRESHOLD || 5));
const YTDLP_CB_COOLDOWN_MS = Math.max(5_000, Number(process.env.YTDLP_CB_COOLDOWN_MS || 60_000));
let ytdlpCircuitOpenedAt = 0;

function streamKey(videoId) {
  return `${CACHE_NAMESPACE}:stream:${videoId}`;
}

async function resolveStreamWithMetaInternal({
  innertube,
  ytdlpBin,
  cache,
  videoId,
  title,
  artist
}) {
  const key = streamKey(videoId);

  return dedupe(key, async () => {
    // 1) Cache (validated)
    const cached = await cache.get(key);
    if (cached && typeof cached === 'string' && cached.trim()) {
      const ok = await withTimeout(isStreamAlive(cached), VALIDATION_TIMEOUT_MS).catch(() => false);
      if (ok) {
        metrics.increment('resolver.cache.hit');
        return { url: cached, source: 'resolver-cache' };
      }
      metrics.increment('resolver.cache.stale');
    } else {
      metrics.increment('resolver.cache.miss');
    }

    // 2) YouTubei primary (fast, no external process)
    const primary = async () => {
      if (!innertube) return null;
      const url = await youtubeiGetAudioUrl(innertube, videoId);
      if (!url) return null;
      // Trust primary URLs for speed; validation is reserved for cached/fallback URLs.
      return url;
    };

    // 3) yt-dlp secondary (uses player_skip=webpage to avoid 429 on datacenter IPs)
    const secondary = async () => {
      if (!ytdlpBin) return null;
      const now = Date.now();
      if (ytdlpCircuitOpenedAt && (now - ytdlpCircuitOpenedAt) >= YTDLP_CB_COOLDOWN_MS) {
        ytdlpCircuitOpenedAt = 0;
        ytdlpFailureCount = 0;
      }

      if (ytdlpFailureCount > YTDLP_CB_THRESHOLD) {
        metrics.increment('resolver.circuit.open');
        throw new Error('yt-dlp temporarily disabled');
      }

      try {
        for (const playerClient of YTDLP_CLIENTS) {
          const url = await ytdlpQueue.add(() => ytdlpGetUrl(ytdlpBin, videoId, { playerClient }));
          if (!url) continue;

          const ok = await withTimeout(isStreamAlive(url), VALIDATION_TIMEOUT_MS).catch(() => false);
          if (ok) {
            ytdlpFailureCount = 0;
            ytdlpCircuitOpenedAt = 0;
            return url;
          }

          logger.warn('resolver', 'yt-dlp returned a URL that failed validation', {
            videoId,
            playerClient,
          });
        }

        ytdlpFailureCount++;
        if (ytdlpFailureCount > YTDLP_CB_THRESHOLD && !ytdlpCircuitOpenedAt) {
          ytdlpCircuitOpenedAt = Date.now();
        }
        return null;
      } catch (error) {
        ytdlpFailureCount++;
        if (ytdlpFailureCount > YTDLP_CB_THRESHOLD && !ytdlpCircuitOpenedAt) {
          ytdlpCircuitOpenedAt = Date.now();
        }
        throw error;
      }
    };

    // 4) Piped API tertiary (public instances are flaky; keep behind yt-dlp)
    const tertiary = async () => {
      const url = await pipedGetAudioUrl(videoId);
      if (!url) return null;
      return url;
    };

    // 5) Invidious API (another free YouTube frontend, separate from Piped)
    const invidiousFallback = async () => {
      const url = await invidiousGetAudioUrl(videoId);
      if (!url) return null;
      return url;
    };

    // 6) ytdl-core (often blocked by bot checks)
    const quaternary = async () => {
      const url = await ytdlCoreGetAudioUrl(videoId);
      if (!url) return null;
      return url;
    };

    // 6) SoundCloud API final fallback (best-effort only)
    const quinary = async () => {
      const url = await soundcloudGetAudioUrl(videoId, title, artist);
      if (!url) return null;
      return url;
    };

    let resolved = null;

    try {
      const url = await withTimeout(
        retry(primary, 2, {
          delayMs: 150,
          onError: (err) => logger.warn('resolver', 'youtubei failed', { videoId, error: err?.message }),
        }),
        PRIMARY_TIMEOUT_MS
      );
      if (url) resolved = { url, source: 'youtubei' };
    } catch {
      // ignore
    }

    if (resolved?.url) {
      metrics.increment('resolver.primary.success');
    }

    if (!resolved?.url) {
      try {
        const url = await withTimeout(
          retry(secondary, 2, {
            delayMs: 150,
            onError: (err) => logger.warn('resolver', 'piped api attempt failed', { videoId, error: err?.message }),
          }),
          PRIMARY_TIMEOUT_MS
        );
        if (url) resolved = { url, source: 'piped' };
      } catch {
        // ignore
      }
      if (resolved?.url) metrics.increment('resolver.secondary.success');
    }

    if (!resolved?.url) {
      try {
        const url = await withTimeout(
          retry(tertiary, 1, {
            delayMs: 150,
            onError: (err) => logger.warn('resolver', 'piped api attempt failed', { videoId, error: err?.message }),
          }),
          PRIMARY_TIMEOUT_MS
        );
        if (url) resolved = { url, source: 'piped' };
      } catch {
        // ignore
      }
      if (resolved?.url) metrics.increment('resolver.tertiary.success');
    }

    if (!resolved?.url) {
      try {
        const url = await withTimeout(
          retry(invidiousFallback, 1, {
            delayMs: 150,
            onError: (err) => logger.warn('resolver', 'invidious attempt failed', { videoId, error: err?.message }),
          }),
          PRIMARY_TIMEOUT_MS
        );
        if (url) resolved = { url, source: 'invidious' };
      } catch {
        // ignore
      }
      if (resolved?.url) metrics.increment('resolver.invidious.success');
    }

    // 5) ytdl-core (often blocked by bot checks, but try it anyway)
    if (!resolved?.url) {
      try {
        const url = await withTimeout(
          retry(quaternary, 1, {
            delayMs: 0,
            onError: (err) => logger.warn('resolver', 'ytdl-core attempt failed', { videoId, error: err?.message }),
          }),
          PRIMARY_TIMEOUT_MS
        );
        if (url) resolved = { url, source: 'ytdl-core' };
      } catch {
        // ignore
      }
      if (resolved?.url) metrics.increment('resolver.quaternary.success');
    }

    if (!resolved?.url) {
      try {
        const url = await withTimeout(
          retry(quinary, 1, {
            delayMs: 0,
            onError: (err) => logger.warn('resolver', 'soundcloud attempt failed', { videoId, error: err?.message }),
          }),
          PRIMARY_TIMEOUT_MS
        );
        if (url) resolved = { url, source: 'soundcloud' };
      } catch {
        // ignore
      }
      if (resolved?.url) metrics.increment('resolver.fallback.used');
    }

    if (!resolved?.url) {
      metrics.increment('resolver.failure');
      throw new Error('Stream unavailable');
    }

    // 4) Cache stampede protection via jittered TTL
    const ttl = TTL_SECONDS + Math.floor(Math.random() * 120);
    await cache.set(key, resolved.url, ttl);
    return resolved;
  });
}

export async function resolveStreamWithMeta(options) {
  return await resolveStreamWithMetaInternal(options);
}

export async function resolveStreamUrl(options) {
  const resolved = await resolveStreamWithMetaInternal(options);
  return resolved?.url || null;
}
