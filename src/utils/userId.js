import { getAuthenticatedUserId } from './authSession';

export function getOrCreateUserId() {
  try {
    const authenticatedUserId = getAuthenticatedUserId();
    if (authenticatedUserId) {
      return authenticatedUserId;
    }

    const existing = localStorage.getItem('aura-user-id');
    if (existing) return existing;

    const id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem('aura-user-id', id);
    return id;
  } catch {
    return 'anonymous';
  }
}
