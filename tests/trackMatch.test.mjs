import test from 'node:test';
import assert from 'node:assert/strict';

import { pickBestTrackMatch, scoreTrackCandidate } from '../shared/trackMatch.js';

test('pickBestTrackMatch keeps a close title and artist match', () => {
  const expected = {
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh',
  };

  const candidates = [
    { title: 'Tum Hi Ho (Official Audio)', artist: 'Arijit Singh' },
    { title: 'Some Other Song', artist: 'Random Artist' },
  ];

  const match = pickBestTrackMatch(candidates, expected);
  assert.ok(match);
  assert.equal(match.candidate.title, 'Tum Hi Ho (Official Audio)');
});

test('pickBestTrackMatch rejects low-confidence cross-catalog mismatches', () => {
  const expected = {
    title: 'Kesariya',
    artist: 'Arijit Singh',
  };

  const candidates = [
    { title: 'Kesariya Remix', artist: 'DJ Nights' },
    { title: 'Heeriye', artist: 'Arijit Singh' },
  ];

  const match = pickBestTrackMatch(candidates, expected);
  assert.equal(match, null);
});

test('scoreTrackCandidate tolerates common metadata noise words', () => {
  const score = scoreTrackCandidate(
    { title: 'Apna Bana Le', artist: 'Arijit Singh' },
    { title: 'Apna Bana Le [Official Lyric Video]', artist: 'Arijit Singh Topic' }
  );

  assert.equal(score.isConfident, true);
  assert.ok(score.titleScore >= 0.72);
});
