import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeUserLibraries, normalizeLibraryTrack } from '../shared/userLibrary.js';

test('normalizeLibraryTrack converts downloaded tracks into portable youtube library entries', () => {
  const normalized = normalizeLibraryTrack({
    id: 'download-abc123',
    originalId: 'abc123',
    title: 'Believer',
    artist: 'Imagine Dragons',
    source: 'downloaded',
    streamUrl: 'file:///local/song.m4a',
  });

  assert.equal(normalized.id, 'yt-abc123');
  assert.equal(normalized.videoId, 'abc123');
  assert.equal(normalized.originalId, 'abc123');
  assert.equal(normalized.source, 'youtube');
  assert.equal(normalized.streamUrl, undefined);
});

test('mergeUserLibraries combines favorites, history, and same-name playlists without duplicates', () => {
  const remote = {
    favorites: [
      { id: 'yt-a', title: 'Song A', artist: 'Artist 1', source: 'youtube' },
    ],
    playlists: [
      {
        id: 'remote-roadtrip',
        name: 'Road Trip',
        color: '#ef4444',
        tracks: [{ id: 'yt-a', title: 'Song A', artist: 'Artist 1', source: 'youtube' }],
      },
    ],
    history: [
      { id: 'yt-b', title: 'Song B', artist: 'Artist 2', source: 'youtube' },
    ],
  };

  const local = {
    favorites: [
      { id: 'download-c', originalId: 'c', title: 'Song C', artist: 'Artist 3', source: 'downloaded' },
      { id: 'yt-a', title: 'Song A', artist: 'Artist 1', source: 'youtube' },
    ],
    playlists: [
      {
        id: 'local-roadtrip',
        name: 'Road Trip',
        color: '#3b82f6',
        tracks: [{ id: 'yt-c', title: 'Song C', artist: 'Artist 3', source: 'youtube' }],
      },
    ],
    history: [
      { id: 'yt-d', title: 'Song D', artist: 'Artist 4', source: 'youtube' },
      { id: 'yt-b', title: 'Song B', artist: 'Artist 2', source: 'youtube' },
    ],
  };

  const merged = mergeUserLibraries(remote, local);

  assert.deepEqual(
    merged.favorites.map((track) => track.id),
    ['yt-c', 'yt-a'],
  );
  assert.equal(merged.playlists.length, 1);
  assert.equal(merged.playlists[0].name, 'Road Trip');
  assert.deepEqual(
    merged.playlists[0].tracks.map((track) => track.id),
    ['yt-c', 'yt-a'],
  );
  assert.deepEqual(
    merged.history.map((track) => track.id),
    ['yt-d', 'yt-b'],
  );
});
