import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthToken, verifyAuthToken } from '../backend/auth/token.mjs';

test('createAuthToken and verifyAuthToken round-trip a signed session payload', async () => {
  const token = await createAuthToken(
    { id: 'user-123', email: 'listener@example.com', name: 'Listener' },
    { secret: 'test-secret', nowMs: 1_700_000_000_000 },
  );

  const verified = await verifyAuthToken(token, { secret: 'test-secret', nowMs: 1_700_000_100_000 });

  assert.equal(verified.userId, 'user-123');
  assert.equal(verified.email, 'listener@example.com');
  assert.equal(verified.name, 'Listener');
});

test('verifyAuthToken rejects expired or tampered tokens', async () => {
  const token = await createAuthToken(
    { id: 'user-999', email: 'listener@example.com', name: 'Listener' },
    { secret: 'test-secret', nowMs: 1_700_000_000_000 },
  );

  const [payload, signature] = token.split('.');
  const tampered = `${payload}.broken${signature}`;

  const expired = await verifyAuthToken(token, {
    secret: 'test-secret',
    nowMs: 1_700_000_000_000 + (60 * 60 * 24 * 31 * 1000),
  });
  const invalid = await verifyAuthToken(tampered, { secret: 'test-secret', nowMs: 1_700_000_000_100 });

  assert.equal(expired, null);
  assert.equal(invalid, null);
});
