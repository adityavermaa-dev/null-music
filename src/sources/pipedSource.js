import { validateStreamUrl } from '../api/endpointClient.js';

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_PIPED_ENDPOINTS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.darkness.services',
  'https://pipedapi.drgns.space',
  'https://pipedapi.smnz.de',
];

function splitCsv(value = '') {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getCandidates() {
  const configured = splitCsv(import.meta?.env?.VITE_PIPED_ENDPOINTS || '');
  return configured.length ? configured : DEFAULT_PIPED_ENDPOINTS;
}

function pickBestAudioStream(payload) {
  const streams = Array.isArray(payload?.audioStreams) ? payload.audioStreams : [];
  if (!streams.length) return '';

  // Prefer mp4/m4a for broad compatibility; fall back to first available audio stream.
  const mp4 = streams.find((stream) => String(stream?.mimeType || '').includes('audio/mp4'));
  const webm = streams.find((stream) => String(stream?.mimeType || '').includes('audio/webm'));
  const chosen = mp4 || webm || streams[0];
  return typeof chosen?.url === 'string' ? chosen.url.trim() : '';
}

async function fetchFromInstance(baseUrl, videoId, timeoutMs) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/streams/${encodeURIComponent(videoId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const payload = await response.json();
    const streamUrl = pickBestAudioStream(payload);
    if (!streamUrl) return null;

    const valid = await validateStreamUrl(streamUrl, timeoutMs);
    if (!valid) return null;

    return {
      streamUrl,
      streamSource: 'piped',
      endpoint,
      verified: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePipedStream(videoId, options = {}) {
  if (!videoId) return null;

  const timeoutMs = Math.max(1200, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const instances = getCandidates();

  for (const instance of instances) {
    const resolved = await fetchFromInstance(instance, videoId, timeoutMs);
    if (resolved?.streamUrl) return resolved;
  }

  return null;
}