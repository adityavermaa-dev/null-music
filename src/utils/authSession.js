export const AUTH_SESSION_STORAGE_KEY = 'aura-auth-session';

function normalizeAuthUser(user) {
  if (!user || typeof user !== 'object') return null;

  const id = user.id == null ? '' : String(user.id).trim();
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  const phone = typeof user.phone === 'string' ? user.phone.trim() : '';

  if (!id || (!email && !phone)) return null;

  return {
    id,
    email,
    phone,
    name: typeof user.name === 'string' ? user.name.trim() : '',
    hasPassword: Boolean(user.hasPassword),
    authMethods: Array.isArray(user.authMethods) ? user.authMethods.map((item) => String(item)) : [],
    createdAt: Number.isFinite(Number(user.createdAt)) ? Number(user.createdAt) : null,
    updatedAt: Number.isFinite(Number(user.updatedAt)) ? Number(user.updatedAt) : null,
    lastLoginAt: Number.isFinite(Number(user.lastLoginAt)) ? Number(user.lastLoginAt) : null,
  };
}

export function normalizeAuthSession(session) {
  if (!session || typeof session !== 'object') return null;

  const token = typeof session.token === 'string' ? session.token.trim() : '';
  const user = normalizeAuthUser(session.user);

  if (!token || !user) return null;

  return { token, user };
}

export function getStoredAuthSession() {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
    if (!raw) return null;
    return normalizeAuthSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function persistAuthSession(session) {
  const normalized = normalizeAuthSession(session);

  if (typeof window === 'undefined') {
    return normalized;
  }

  try {
    if (!normalized) {
      window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      return null;
    }

    window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return normalized;
  }
}

export function clearStoredAuthSession() {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function getAuthenticatedUserId() {
  return getStoredAuthSession()?.user?.id || null;
}
