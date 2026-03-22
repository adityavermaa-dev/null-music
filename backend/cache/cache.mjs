import Redis from 'ioredis';

import { logger } from '../lib/logger.mjs';

class MemoryCache {
  constructor() {
    this._map = new Map();
  }

  async get(key) {
    const v = this._map.get(key);
    if (!v) return null;
    if (v.expiry && v.expiry <= Date.now()) {
      this._map.delete(key);
      return null;
    }
    return v.value;
  }

  async set(key, value, ttlSeconds) {
    const expiry = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this._map.set(key, { value, expiry });
  }
}

class RedisCache {
  constructor(url) {
    this._redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  async _ensure() {
    if (this._redis.status === 'ready') return;
    if (this._redis.status === 'connecting') return;
    try {
      await this._redis.connect();
    } catch {
      // ignore
    }
  }

  async get(key) {
    try {
      await this._ensure();
      const raw = await this._redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    } catch (err) {
      logger.warn('cache', 'Redis get failed (treating as miss)', { key, error: err?.message });
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    try {
      await this._ensure();
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      if (ttlSeconds) {
        await this._redis.set(key, raw, 'EX', ttlSeconds);
      } else {
        await this._redis.set(key, raw);
      }
    } catch (err) {
      logger.warn('cache', 'Redis set failed (skipping)', { key, error: err?.message });
    }
  }
}

export async function createCache() {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info('cache', 'Using in-memory cache');
    return new MemoryCache();
  }

  try {
    const cache = new RedisCache(url);
    logger.info('cache', 'Using Redis cache', { url: url.replace(/:\/\/.*@/, '://***@') });
    return cache;
  } catch (err) {
    logger.warn('cache', 'Redis unavailable, falling back to memory', { error: err?.message });
    return new MemoryCache();
  }
}
