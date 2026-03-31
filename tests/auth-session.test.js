import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_SESSION_STORAGE_KEY,
  clearStoredAuthSession,
  getStoredAuthSession,
  persistAuthSession,
} from '../src/utils/authSession.js';

function createMockStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

test('persistAuthSession stores users that sign in with phone-based auth', () => {
  globalThis.window = { localStorage: createMockStorage() };

  const session = persistAuthSession({
    token: 'token-123',
    user: {
      id: 'user-phone',
      phone: '+919876543210',
      name: 'Aura Listener',
      authMethods: ['phone'],
    },
  });

  assert.equal(session.user.phone, '+919876543210');
  assert.equal(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) !== null, true);
  assert.equal(getStoredAuthSession().user.phone, '+919876543210');

  clearStoredAuthSession();
  assert.equal(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY), null);

  delete globalThis.window;
});

test('persistAuthSession rejects invalid session payloads', () => {
  globalThis.window = { localStorage: createMockStorage() };

  const session = persistAuthSession({
    token: 'token-123',
    user: {
      id: '',
      email: '',
      phone: '',
    },
  });

  assert.equal(session, null);
  assert.equal(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY), null);

  delete globalThis.window;
});
