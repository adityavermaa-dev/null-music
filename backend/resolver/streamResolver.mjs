import { retry } from '../lib/retry.mjs';
import { logger } from '../lib/logger.mjs';
import { youtubeiGetAudioUrl } from '../providers/youtubeiProvider.mjs';
import { ytdlpGetUrl } from '../providers/ytdlpProvider.mjs';
import { ytdlpQueue } from '../queue/ytdlpQueue.mjs';

const TTL_SECONDS = Math.max(60, Number(process.env.STREAM_CACHE_TTL_SECONDS || 1800));
const CACHE_NAMESPACE = (process.env.CACHE_NAMESPACE || 'aura').trim() || 'aura';

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

  // 1) Cache
  const cached = await cache.get(key);
  if (cached && typeof cached === 'string' && cached.trim()) {
    return cached;
  }

  // 2) YouTubei primary (fast, no external process)
  const primary = async () => {
    if (!innertube) return null;
    return await youtubeiGetAudioUrl(innertube, videoId);
  };

  // 3) yt-dlp fallback (queued + retried)
  const fallback = async () => {
    if (!ytdlpBin) return null;

    // Try android_vr first
    const url1 = await ytdlpQueue.add(() => ytdlpGetUrl(ytdlpBin, videoId, { playerClient: 'android_vr' }));
    if (url1) return url1;

    // Then default client with node JS runtime
    const url2 = await ytdlpQueue.add(() => ytdlpGetUrl(ytdlpBin, videoId, { jsRuntimeNode: true }));
    return url2;
  };

  let url = null;

  try {
    url = await retry(primary, 2, {
      delayMs: 150,
      onError: (err) => logger.warn('resolver', 'youtubei failed', { videoId, error: err?.message }),
    });
  } catch {
    // ignore
  }

  if (!url) {
    try {
      url = await retry(fallback, 3, {
        delayMs: 250,
        onError: (err) => logger.warn('resolver', 'yt-dlp attempt failed', { videoId, error: err?.message }),
      });
    } catch {
      // ignore
    }
  }

  if (!url) {
    throw new Error('Stream unavailable');
  }

  await cache.set(key, url, TTL_SECONDS);
  return url;
}
