import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhoneNumber } from '../backend/auth/phoneOtp.mjs';

test('normalizePhoneNumber keeps international phone numbers in E.164-style format', () => {
  assert.equal(normalizePhoneNumber('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhoneNumber('0091-9876543210'), '+919876543210');
  assert.equal(normalizePhoneNumber('98765 43210'), '+9876543210');
});

test('normalizePhoneNumber returns an empty string for invalid values', () => {
  assert.equal(normalizePhoneNumber(''), '');
  assert.equal(normalizePhoneNumber('abc'), '');
});
