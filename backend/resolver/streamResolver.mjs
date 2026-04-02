import { retry } from '../lib/retry.mjs';
import { logger } from '../lib/logger.mjs';
import { withTimeout } from '../lib/withTimeout.mjs';
import { dedupe } from '../lib/dedupe.mjs';
import { metrics } from '../lib/metrics.mjs';
import { invidiousGetAudioUrl } from '../providers/invidiousProvider.mjs';
import { pipedGetAudioUrl } from '../providers/pipedProvider.mjs';
import { saavnGetAudioUrl } from '../providers/saavnProvider.mjs';
import { soundcloudGetAudioUrl } from '../providers/soundcloudProvider.mjs';
import { ytdlCoreGetAudioUrl } from '../providers/ytdlCoreProvider.mjs';
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
const YTDLP_CLIENTS = String(process.env.YT_DLP_FALLBACK_CLIENTS || 'tv,mweb,web_embedded')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

let ytdlpFailureCount = 0;
const YTDLP_CB_THRESHOLD = Math.max(1, Number(process.env.YTDLP_CB_THRESHOLD || 5));
const YTDLP_CB_COOLDOWN_MS = Math.max(5_000, Number(process.env.YTDLP_CB_COOLDOWN_MS || 60_000));
let ytdlpCircuitOpenedAt = 0;

function isQueueTimeoutError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('task timed out');
}

async function resolveProvider(name, provider, { timeoutMs, videoId, metric, validate = true }) {
  logger.info('resolver', `${name} fallback started`, { videoId });

  try {
    const url = await withTimeout(
      retry(provider, 1, {
        delayMs: 0,
        onError: (err) => logger.warn('resolver', `${name} attempt failed`, {
          videoId,
          error: err?.message,
        }),
      }),
      timeoutMs
    );

    if (!url) {
      logger.info('resolver', `${name} returned no stream`, { videoId });
      return null;
    }

    if (validate) {
      const ok = await withTimeout(isStreamAlive(url), VALIDATION_TIMEOUT_MS).catch(() => false);
      if (!ok) {
        logger.warn('resolver', `${name} returned an invalid stream URL`, { videoId });
        return null;
      }
    }

    logger.info('resolver', `${name} fallback resolved stream`, { videoId });
    if (metric) metrics.increment(metric);
    return { url, source: name };
  } catch (error) {
    logger.warn('resolver', `${name} fallback failed`, {
      videoId,
      error: error?.message,
    });
    return null;
  }
}

function streamKey(videoId) {
  return `${CACHE_NAMESPACE}:stream:${videoId}`;
}

async function resolveStreamWithMetaInternal({
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

    // 2) yt-dlp primary for YouTube playback
    const primary = async () => {
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
        if (isQueueTimeoutError(error)) {
          logger.warn('resolver', 'yt-dlp queue timeout; continuing to fallback providers', {
            videoId,
            error: error?.message,
          });
          return null;
        }
        throw error;
      }
    };

    const ytdlCoreFallback = async () => {
      return await ytdlCoreGetAudioUrl(videoId);
    };

    const pipedFallback = async () => {
      return await pipedGetAudioUrl(videoId);
    };

    const invidiousFallback = async () => {
      return await invidiousGetAudioUrl(videoId);
    };

    const saavnFallback = async () => {
      return await saavnGetAudioUrl(videoId, title, artist);
    };

    const soundcloudFallback = async () => {
      const url = await soundcloudGetAudioUrl(videoId, title, artist);
      if (!url) return null;
      return url;
    };

    let resolved = null;

    try {
      const url = await withTimeout(
        retry(primary, 2, {
          delayMs: 150,
          onError: (err) => logger.warn('resolver', 'yt-dlp attempt failed', { videoId, error: err?.message }),
        }),
        FALLBACK_TIMEOUT_MS
      );
      if (url) {
        const ok = await withTimeout(isStreamAlive(url), VALIDATION_TIMEOUT_MS).catch(() => false);
        if (ok) {
          resolved = { url, source: 'yt-dlp' };
        } else {
          logger.warn('resolver', 'yt-dlp produced an invalid stream after resolution', { videoId });
        }
      }
    } catch {
      // ignore
    }

    if (resolved?.url) {
      metrics.increment('resolver.primary.success');
    }

    const fallbacks = [
      {
        name: 'saavn',
        metric: 'resolver.secondary.success',
        fn: saavnFallback,
      },
      {
        name: 'soundcloud',
        metric: 'resolver.fallback.used',
        fn: soundcloudFallback,
      },
      {
        name: 'ytdl-core',
        metric: 'resolver.fallback.used',
        fn: ytdlCoreFallback,
      },
      {
        name: 'piped',
        metric: 'resolver.fallback.used',
        fn: pipedFallback,
      },
      {
        name: 'invidious',
        metric: 'resolver.fallback.used',
        fn: invidiousFallback,
      },
    ];

    for (const fallback of fallbacks) {
      if (resolved?.url) break;
      resolved = await resolveProvider(fallback.name, fallback.fn, {
        timeoutMs: PRIMARY_TIMEOUT_MS,
        videoId,
        metric: fallback.metric,
      });
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
