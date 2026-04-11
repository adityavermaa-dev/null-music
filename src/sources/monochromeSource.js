import { logInfo } from '../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 6500;
const MAX_CANDIDATES = 40;
const DEFAULT_MONOCHROME_ENDPOINTS = [
  'https://monochrome-api.samidy.com',
  'https://api.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://wolf.qqdl.site',
  'https://maus.qqdl.site',
  'https://vogel.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://tidal.kinoplus.online',
  'https://tidal-uptime.jiffy-puffs-1j.workers.dev',
  'https://tidal-uptime.props-76styles.workers.dev',
];

const latencyState = new Map();

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function splitCsv(value = '') {
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeComparableText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreManifestCandidate(item, context = {}) {
  const seedTitle = normalizeComparableText(context?.title || '');
  const seedArtist = normalizeComparableText(context?.artist || '');
  const candidateTitle = normalizeComparableText(item?.title || item?.name || '');
  const candidateArtist = normalizeComparableText(item?.artist || item?.artistName || item?.artists || '');

  let score = 0;
  if (seedTitle && candidateTitle) {
    if (candidateTitle === seedTitle) score += 5;
    else if (candidateTitle.includes(seedTitle) || seedTitle.includes(candidateTitle)) score += 3;
  }

  if (seedArtist && candidateArtist) {
    if (candidateArtist === seedArtist) score += 4;
    else if (candidateArtist.includes(seedArtist) || seedArtist.includes(candidateArtist)) score += 2;
  }

  if (Number(item?.allowStreaming) !== 0 && item?.allowStreaming !== false) score += 0.5;
  return score;
}

function looksLikeManifestUrl(value = '') {
  const url = String(value || '').toLowerCase();
  return url.includes('.mpd') || url.includes('.m3u8') || url.includes('/manifests/');
}

function withTimeout(promiseFactory, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return promiseFactory(controller.signal)
    .finally(() => {
      clearTimeout(timer);
    });
}

function extractStreamUrl(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();

  const direct = [
    payload.streamUrl,
    payload.url,
    payload.audioUrl,
    payload.directUrl,
    payload?.data?.streamUrl,
    payload?.data?.url,
  ].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()));

  return direct ? direct.trim() : '';
}

function extractApiHosts(payload) {
  const items = Array.isArray(payload?.api) ? payload.api : [];
  return items
    .map((item) => (typeof item?.url === 'string' ? item.url.trim() : ''))
    .filter((url) => /^https?:\/\//i.test(url));
}

async function resolveFromEndpoint(endpointUrl, timeoutMs) {
  return withTimeout(async (signal) => {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Endpoint responded ${response.status}`);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const apiHosts = extractApiHosts(payload);
      if (apiHosts.length) {
        const error = new Error('Monochrome API index payload');
        error.apiHosts = apiHosts;
        throw error;
      }
      const streamUrl = extractStreamUrl(payload);
      if (!streamUrl) throw new Error('No stream URL in JSON payload');
      return streamUrl;
    }

    const text = (await response.text()).trim();
    if (/^https?:\/\//i.test(text)) return text;
    throw new Error('Unsupported endpoint response format');
  }, timeoutMs);
}

async function verifyStreamUrl(streamUrl, timeoutMs = 5000) {
  if (!/^https?:\/\//i.test(streamUrl || '')) return false;

  try {
    const ok = await withTimeout(async (signal) => {
      const headResponse = await fetch(streamUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal,
      });

      if (!headResponse.ok) return false;
      const contentType = String(headResponse.headers.get('content-type') || '').toLowerCase();
      if (!contentType) return true;
      return (
        contentType.startsWith('audio/') ||
        contentType.includes('octet-stream') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('application/dash+xml') ||
        looksLikeManifestUrl(streamUrl)
      );
    }, timeoutMs);

    if (ok) return true;
  } catch {
    // Some hosts reject HEAD. Fall through to a byte-range probe.
  }

  try {
    return await withTimeout(async (signal) => {
      const rangeResponse = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1',
        },
        redirect: 'follow',
        signal,
      });
      return rangeResponse.ok || rangeResponse.status === 206;
    }, timeoutMs);
  } catch {
    return false;
  }
}

function pickManifestUri(payload) {
  return [
    payload?.data?.data?.attributes?.uri,
    payload?.data?.attributes?.uri,
    payload?.attributes?.uri,
    payload?.uri,
    payload?.data?.uri,
  ].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim())) || '';
}

async function resolveFromHifiApiBase(baseUrl, context, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return '';

  const query = String(context?.query || `${context?.title || ''} ${context?.artist || ''}` || '').trim();
  if (!query) return '';

  const searchUrl = `${base}/search/?s=${encodeURIComponent(query)}&limit=5`;
  const searchResp = await withTimeout(async (signal) => {
    return fetch(searchUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      },
      signal,
    });
  }, timeoutMs);

  if (!searchResp.ok) return '';
  const searchPayload = await searchResp.json();
  const items = Array.isArray(searchPayload?.data?.items) ? searchPayload.data.items : [];
  const rankedItems = items
    .filter((item) => Number(item?.id) > 0)
    .map((item) => ({
      item,
      score: scoreManifestCandidate(item, context),
    }))
    .sort((left, right) => right.score - left.score);
  const chosen = rankedItems[0]?.item || items[0];
  const trackId = chosen?.id;
  if (!trackId) return '';

  const manifestUrl = `${base}/trackManifests/?id=${encodeURIComponent(trackId)}&formats=HEAACV1`;
  const manifestResp = await withTimeout(async (signal) => {
    return fetch(manifestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      },
      signal,
    });
  }, timeoutMs);

  if (!manifestResp.ok) return '';
  const manifestPayload = await manifestResp.json();
  const uri = pickManifestUri(manifestPayload).trim();
  if (!uri) return '';

  const verified = await verifyStreamUrl(uri, timeoutMs);
  return verified
    ? {
      streamUrl: uri,
      resolutionMode: 'search-fallback',
    }
    : null;
}

function buildCandidates(videoId, endpointsCsv) {
  const envEndpoints = import.meta?.env?.VITE_MONOCHROME_ENDPOINTS || '';
  const configured = splitCsv(endpointsCsv || envEndpoints || '');
  const hasWindowRuntime = typeof window !== 'undefined';
  const rawEndpoints = configured.length
    ? configured
    : hasWindowRuntime
      ? DEFAULT_MONOCHROME_ENDPOINTS
      : [];

  const candidates = [];
  for (const endpoint of rawEndpoints) {
    if (endpoint.includes('{videoId}')) {
      candidates.push(endpoint.replaceAll('{videoId}', encodeURIComponent(videoId)));
      continue;
    }

    const base = normalizeBaseUrl(endpoint);
    if (!base) continue;

    candidates.push(base);
    candidates.push(`${base}/stream/${encodeURIComponent(videoId)}`);
    candidates.push(`${base}/api/stream/${encodeURIComponent(videoId)}`);
    candidates.push(`${base}/resolve/${encodeURIComponent(videoId)}`);
  }

  const unique = [...new Set(candidates)].slice(0, MAX_CANDIDATES);
  unique.sort((left, right) => {
    const leftMs = latencyState.get(left) ?? Number.POSITIVE_INFINITY;
    const rightMs = latencyState.get(right) ?? Number.POSITIVE_INFINITY;
    return leftMs - rightMs;
  });
  return unique;
}

async function probeEndpoint(endpointUrl, videoId, timeoutMs, context = {}) {
  const startedAt = nowMs();
  let streamUrl;
  let resolutionMode = 'id-endpoint';

  try {
    streamUrl = await resolveFromEndpoint(endpointUrl, timeoutMs);
  } catch (error) {
    const apiHosts = Array.isArray(error?.apiHosts) ? error.apiHosts : [];
    if (apiHosts.length) {
      for (const host of apiHosts) {
        const base = normalizeBaseUrl(host);
        if (!base) continue;

        const variants = [
          `${base}/stream/${encodeURIComponent(videoId)}`,
          `${base}/api/stream/${encodeURIComponent(videoId)}`,
          `${base}/resolve/${encodeURIComponent(videoId)}`,
        ];

        for (const variant of variants) {
          try {
            streamUrl = await resolveFromEndpoint(variant, timeoutMs);
            if (streamUrl) break;
          } catch {
            // continue probing derived hosts
          }
        }

        if (!streamUrl) {
          try {
            const fallbackResult = await resolveFromHifiApiBase(base, context, timeoutMs);
            streamUrl = fallbackResult?.streamUrl || '';
            if (streamUrl) {
              resolutionMode = fallbackResult?.resolutionMode || 'search-fallback';
            }
          } catch {
            streamUrl = '';
          }
        }

        if (streamUrl) break;
      }

      if (!streamUrl) {
        throw new Error('No stream URL from Monochrome API index hosts');
      }
    } else {
      const endpointLooksLikeBase = /^https?:\/\//i.test(endpointUrl) && !endpointUrl.includes('/stream/') && !endpointUrl.includes('/resolve/') && !endpointUrl.includes('{videoId}');
      if (!endpointLooksLikeBase) throw error;

      const base = normalizeBaseUrl(endpointUrl);
      const variants = [
        `${base}/stream/${encodeURIComponent(videoId)}`,
        `${base}/api/stream/${encodeURIComponent(videoId)}`,
        `${base}/resolve/${encodeURIComponent(videoId)}`,
      ];

      for (const variant of variants) {
        try {
          streamUrl = await resolveFromEndpoint(variant, timeoutMs);
          if (streamUrl) break;
        } catch {
          // continue to search-based resolution
        }
      }

      if (!streamUrl) {
        const fallbackResult = await resolveFromHifiApiBase(endpointUrl, context, timeoutMs);
        streamUrl = fallbackResult?.streamUrl || '';
        if (streamUrl) {
          resolutionMode = fallbackResult?.resolutionMode || 'search-fallback';
        }
      }
      if (!streamUrl) {
        throw error;
      }
    }
  }

  const verified = await verifyStreamUrl(streamUrl);
  if (!verified) {
    throw new Error('Resolved URL failed verification');
  }

  const elapsed = Math.max(1, Math.round(nowMs() - startedAt));
  const previous = latencyState.get(endpointUrl);
  const smoothed = previous ? Math.round(previous * 0.65 + elapsed * 0.35) : elapsed;
  latencyState.set(endpointUrl, smoothed);

  return {
    endpointUrl,
    streamUrl,
    elapsedMs: elapsed,
    resolutionMode,
  };
}

export async function resolveMonochromeStream(videoId, options = {}) {
  if (!videoId) return null;

  const candidates = buildCandidates(videoId, options.endpoints);
  if (!candidates.length) return null;

  const timeoutMs = Math.max(1200, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const context = {
    query: String(options.query || '').trim(),
    title: String(options.title || '').trim(),
    artist: String(options.artist || '').trim(),
  };
  if (!context.query) {
    context.query = `${context.title} ${context.artist}`.trim() || videoId;
  }

  const probes = candidates.map((endpointUrl) => probeEndpoint(endpointUrl, videoId, timeoutMs, context));

  try {
    const best = await Promise.any(probes);
    logInfo('monochrome', 'Selected fastest working endpoint', {
      videoId,
      endpoint: best.endpointUrl,
      elapsedMs: best.elapsedMs,
    });

    return {
      streamUrl: best.streamUrl,
      streamSource: 'monochrome',
      endpoint: best.endpointUrl,
      measuredLatencyMs: best.elapsedMs,
      resolutionMode: best.resolutionMode || 'id-endpoint',
      verified: true,
    };
  } catch {
    return null;
  }
}
