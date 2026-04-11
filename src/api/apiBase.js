// Base URL for API calls.
//
// - Default: same-origin `/api` (works in dev with Vite proxy and in prod when served by server.mjs)
// - Override at build-time with: VITE_API_BASE=https://example.com/api
const META_ENV = import.meta?.env || {};
export const API_BASE = (META_ENV.VITE_API_BASE || '/api').replace(/\/$/, '');
const API_ORIGIN = (META_ENV.VITE_PUBLIC_API_ORIGIN || META_ENV.VITE_API_ORIGIN || '').replace(/\/$/, '');
const ABSOLUTE_URL_RE = /^[a-z][a-z\d+\-.]*:\/\//i;

export const isAbsoluteUrl = (value = '') => ABSOLUTE_URL_RE.test(String(value));

export function buildApiUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const combined = `${API_BASE}${normalizedPath}`;

  if (isAbsoluteUrl(combined)) {
    return combined;
  }

  if (isAbsoluteUrl(API_ORIGIN)) {
    return new URL(combined, `${API_ORIGIN}/`).toString();
  }

  if (typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin || '')) {
    return new URL(combined, window.location.origin).toString();
  }

  return combined;
}
