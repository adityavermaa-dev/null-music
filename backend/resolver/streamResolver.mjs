import { retry } from '../lib/retry.mjs';
import { logger } from '../lib/logger.mjs';
import { withTimeout } from '../lib/withTimeout.mjs';
import { dedupe } from '../lib/dedupe.mjs';
import { metrics } from '../lib/metrics.mjs';
import { youtubeiGetAudioUrl } from '../providers/youtubeiProvider.mjs';
import { ytdlpGetUrl } from '../providers/ytdlpProvider.mjs';
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

let ytdlpFailureCount = 0;
const YTDLP_CB_THRESHOLD = Math.max(1, Number(process.env.YTDLP_CB_THRESHOLD || 5));

function streamKey(videoId) {
  return `${CACHE_NAMESPACE}:stream:${videoId}`;
}

export async function resolveStreamUrl({
  innertube,
  ytdlpBin,
  cache,
  videoId,
}) {
  const key = streamKey(videoId);

  return dedupe(key, async () => {
    // 1) Cache (validated)
    const cached = await cache.get(key);
    if (cached && typeof cached === 'string' && cached.trim()) {
      const ok = await withTimeout(isStreamAlive(cached), VALIDATION_TIMEOUT_MS).catch(() => false);
      if (ok) {
        metrics.increment('resolver.cache.hit');
        return cached;
      }
      metrics.increment('resolver.cache.stale');
    } else {
      metrics.increment('resolver.cache.miss');
    }

    // 2) YouTubei primary (fast, no external process) + validation
    const primary = async () => {
      if (!innertube) return null;
      const url = await youtubeiGetAudioUrl(innertube, videoId);
      if (!url) return null;
      const ok = await withTimeout(isStreamAlive(url), VALIDATION_TIMEOUT_MS).catch(() => false);
      return ok ? url : null;
    };

    // 3) yt-dlp fallback (queued + retried) + validation + circuit breaker
    const guardedFallback = async () => {
      if (!ytdlpBin) return null;
      if (ytdlpFailureCount > YTDLP_CB_THRESHOLD) {
        metrics.increment('resolver.circuit.open');
        throw new Error('yt-dlp temporarily disabled');
      }

      try {
        // Try multiple cookie-free player clients first (most reliable without cookies)
        const url1 = await ytdlpQueue.add(() => ytdlpGetUrl(ytdlpBin, videoId, { playerClient: 'android_vr,ios,android' }));
        if (url1) {
          const ok1 = await withTimeout(isStreamAlive(url1), VALIDATION_TIMEOUT_MS).catch(() => false);
          if (ok1) {
            ytdlpFailureCount = 0;
            return url1;
          }
        }

        // Then retry with Node JS runtime (some environments need it), still cookie-free.
        const url2 = await ytdlpQueue.add(() => ytdlpGetUrl(ytdlpBin, videoId, { jsRuntimeNode: true, playerClient: 'android_vr,ios,android' }));
        if (url2) {
          const ok2 = await withTimeout(isStreamAlive(url2), VALIDATION_TIMEOUT_MS).catch(() => false);
          if (ok2) {
            ytdlpFailureCount = 0;
            return url2;
          }
        }

        // If we got here, we failed to produce a validated URL.
        ytdlpFailureCount++;
        return null;
      } catch (e) {
        ytdlpFailureCount++;
        throw e;
      }
    };

    let url = null;

    try {
      url = await withTimeout(
        retry(primary, 2, {
          delayMs: 150,
          onError: (err) => logger.warn('resolver', 'youtubei failed', { videoId, error: err?.message }),
        }),
        PRIMARY_TIMEOUT_MS
      );
    } catch {
      // ignore
    }

    if (url) {
      metrics.increment('resolver.primary.success');
    }

    if (!url) {
      try {
        url = await withTimeout(
          retry(guardedFallback, 3, {
            delayMs: 250,
            onError: (err) => logger.warn('resolver', 'yt-dlp attempt failed', { videoId, error: err?.message }),
          }),
          FALLBACK_TIMEOUT_MS
        );
      } catch {
        // ignore
      }
      if (url) metrics.increment('resolver.fallback.used');
    }

    if (!url) {
      metrics.increment('resolver.failure');
      throw new Error('Stream unavailable');
    }

    // 4) Cache stampede protection via jittered TTL
    const ttl = TTL_SECONDS + Math.floor(Math.random() * 120);
    await cache.set(key, url, ttl);
    return url;
  });
}
