import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlaybackSession,
  buildHistory,
  cycleSleepTimerValue,
  getNextListIndex,
  getPreviousQueueIndex,
  insertTrackNext,
  parseStoredSession,
  serializeSession,
} from '../src/utils/playerState.js';

const trackA = { id: 'a', title: 'Track A' };
const trackB = { id: 'b', title: 'Track B' };
const trackC = { id: 'c', title: 'Track C' };

test('buildPlaybackSession keeps search play in radio mode as a one-track seed queue', () => {
  const result = buildPlaybackSession({
    track: trackB,
    trackList: [trackA, trackB, trackC],
    mode: 'radio',
  });

  assert.equal(result.queueMode, 'radio');
  assert.deepEqual(result.queue, [trackB]);
  assert.equal(result.queueIndex, 0);
});

test('buildPlaybackSession keeps list mode queue and selected index', () => {
  const result = buildPlaybackSession({
    track: trackB,
    trackList: [trackA, trackB, trackC],
    mode: 'list',
  });

  assert.equal(result.queueMode, 'list');
  assert.deepEqual(result.queue, [trackA, trackB, trackC]);
  assert.equal(result.queueIndex, 1);
});

test('insertTrackNext places a selected track immediately after current queue index', () => {
  const queue = insertTrackNext([trackA, trackB, trackC], 0, trackC);
  assert.deepEqual(queue, [trackA, trackC, trackB]);
});

test('queue navigation helpers support next, wrap, and previous', () => {
  assert.equal(getNextListIndex({ queueIndex: 0, queueLength: 3, repeatMode: 'off' }), 1);
  assert.equal(getNextListIndex({ queueIndex: 2, queueLength: 3, repeatMode: 'all' }), 0);
  assert.equal(getNextListIndex({ queueIndex: 2, queueLength: 3, repeatMode: 'off' }), null);
  assert.equal(getPreviousQueueIndex({ queueIndex: 0, queueLength: 3, queueMode: 'list', repeatMode: 'all' }), 2);
  assert.equal(getPreviousQueueIndex({ queueIndex: 0, queueLength: 3, queueMode: 'radio', repeatMode: 'all' }), null);
});

test('sleep timer cycles through supported values', () => {
  assert.equal(cycleSleepTimerValue(null), 15);
  assert.equal(cycleSleepTimerValue(15), 30);
  assert.equal(cycleSleepTimerValue(30), 60);
  assert.equal(cycleSleepTimerValue(60), null);
});

test('session serialization and parsing restore queue state safely', () => {
  const raw = serializeSession({
    queue: [trackA, trackB],
    queueIndex: 1,
    currentTrack: trackB,
  });

  assert.deepEqual(parseStoredSession(raw), {
    queue: [trackA, trackB],
    queueIndex: 1,
    currentTrack: trackB,
  });

  assert.equal(parseStoredSession('not-json'), null);
});

test('buildHistory keeps latest track first and removes duplicates', () => {
  const result = buildHistory([trackA, trackB, trackA], trackA, 3);
  assert.deepEqual(result, [trackA, trackB]);
});
