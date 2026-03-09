export const buildHistory = (prevHistory = [], currentTrack, limit = 20) => {
  if (!currentTrack) return prevHistory;
  const filtered = prevHistory.filter((track) => track.id !== currentTrack.id);
  return [currentTrack, ...filtered].slice(0, limit);
};

export const buildPlaybackSession = ({ track, trackList = [], mode = 'list' }) => {
  if (!track) {
    return {
      queue: [],
      queueIndex: -1,
      queueMode: 'list',
    };
  }

  const queueMode = mode === 'radio' ? 'radio' : 'list';
  if (queueMode === 'radio') {
    return {
      queue: [track],
      queueIndex: 0,
      queueMode,
    };
  }

  const queue = Array.isArray(trackList) && trackList.length > 0 ? trackList : [track];
  const selectedIndex = queue.findIndex((item) => item.id === track.id);

  return {
    queue,
    queueIndex: selectedIndex >= 0 ? selectedIndex : 0,
    queueMode,
  };
};

export const insertTrackNext = (queue = [], queueIndex, track) => {
  if (!Array.isArray(queue) || queue.length === 0 || !track) {
    return queue;
  }

  const existingIndex = queue.findIndex((item) => item.id === track.id);
  const baseQueue = existingIndex >= 0 ? queue.filter((_, index) => index !== existingIndex) : queue;
  const insertPosition = Math.min(Math.max((queueIndex ?? -1) + 1, 0), baseQueue.length);

  return [
    ...baseQueue.slice(0, insertPosition),
    track,
    ...baseQueue.slice(insertPosition),
  ];
};

export const getNextListIndex = ({ queueIndex, queueLength, repeatMode = 'off' }) => {
  if (!queueLength) return null;
  const nextIndex = queueIndex + 1;
  if (nextIndex < queueLength) return nextIndex;
  if (repeatMode === 'all') return 0;
  return null;
};

export const getPreviousQueueIndex = ({ queueIndex, queueLength, queueMode = 'list', repeatMode = 'off' }) => {
  if (!queueLength) return null;
  const previousIndex = queueIndex - 1;
  if (previousIndex >= 0) return previousIndex;
  if (queueMode !== 'radio' && repeatMode === 'all') return queueLength - 1;
  return null;
};

export const cycleSleepTimerValue = (previousValue) => {
  if (previousValue == null) return 15;
  if (previousValue === 15) return 30;
  if (previousValue === 30) return 60;
  return null;
};

export const serializeSession = ({ queue = [], queueIndex = -1, currentTrack = null }) => JSON.stringify({
  queue,
  queueIndex,
  currentTrack,
});

export const parseStoredSession = (rawValue) => {
  try {
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue);
    return {
      queue: Array.isArray(parsed?.queue) ? parsed.queue : [],
      queueIndex: typeof parsed?.queueIndex === 'number' ? parsed.queueIndex : -1,
      currentTrack: parsed?.currentTrack || null,
    };
  } catch {
    return null;
  }
};
