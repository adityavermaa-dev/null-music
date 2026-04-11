import test from 'node:test';
import assert from 'node:assert/strict';

import { createMusicSources } from '../src/sources/musicSources.js';
import { saavnApi } from '../src/api/saavn.js';

function mockSaavn({ data = [] } = {}) {
  const originalSearch = saavnApi.searchSongsSafe;
  const originalFormat = saavnApi.formatTrack;

  saavnApi.searchSongsSafe = async () => ({ ok: true, data, error: null });
  saavnApi.formatTrack = (item) => item;

  return () => {
    saavnApi.searchSongsSafe = originalSearch;
    saavnApi.formatTrack = originalFormat;
  };
}

test('youtube source uses monochrome resolver as primary source', async () => {
  const youtubeApi = {
    async searchSongsSafe() {
      return { ok: true, data: [] };
    },
  };

  const sources = createMusicSources({
    youtubeApi,
    monochromeResolver: async () => ({
      streamUrl: 'https://media.example/mono-audio.webm',
      streamSource: 'monochrome',
    }),
  });
  const resolved = await sources.youtube.getStreamUrl({ id: 'yt-abc123def45', title: 'Song', artist: 'Artist' });

  assert.ok(resolved);
  assert.equal(resolved.streamUrl, 'https://media.example/mono-audio.webm');
  assert.equal(resolved.streamSource, 'monochrome');
});

test('youtube source falls back to piped resolver after monochrome fails', async () => {
  const restoreSaavn = mockSaavn({ data: [] });
  try {
    const youtubeApi = {
      async searchSongsSafe() {
        return { ok: true, data: [] };
      },
    };

    let pipedCalls = 0;

    const sources = createMusicSources({
      youtubeApi,
      monochromeResolver: async () => null,
      pipedResolver: async () => {
        pipedCalls += 1;
        return {
          streamUrl: 'https://piped.example/audio.webm',
          streamSource: 'piped',
        };
      },
    });

    const resolved = await sources.youtube.getStreamUrl({ id: 'yt-xyz98765432', title: 'Song', artist: 'Artist' });
    assert.ok(resolved);
    assert.equal(resolved.streamUrl, 'https://piped.example/audio.webm');
    assert.equal(resolved.streamSource, 'piped');
    assert.equal(pipedCalls, 1);
  } finally {
    restoreSaavn();
  }
});

test('youtube source prefers saavn when monochrome uses risky search fallback mode', async () => {
  const restoreSaavn = mockSaavn({
    data: [
      {
        id: 'saavn-1',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        streamUrl: 'https://saavn.example/full-track.mp3',
        duration: 201,
        source: 'saavn',
      },
    ],
  });

  try {
    const youtubeApi = {
      async searchSongsSafe() {
        return { ok: true, data: [] };
      },
    };

    const sources = createMusicSources({
      youtubeApi,
      monochromeResolver: async () => ({
        streamUrl: 'https://media.example/risky.webm',
        streamSource: 'monochrome',
        resolutionMode: 'search-fallback',
      }),
    });

    const resolved = await sources.youtube.getStreamUrl({
      id: 'yt-abc123def45',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
    });

    assert.ok(resolved);
    assert.equal(resolved.streamUrl, 'https://saavn.example/full-track.mp3');
    assert.equal(resolved.streamSource, 'saavn');
  } finally {
    restoreSaavn();
  }
});

test('monochrome source resolves youtube ids', async () => {
  const youtubeApi = {
    async searchSongsSafe() {
      return { ok: true, data: [] };
    },
  };

  const sources = createMusicSources({
    youtubeApi,
    monochromeResolver: async () => null,
  });
  const resolved = await sources.monochrome.getStreamUrl({ id: 'yt-11111111111' });

  assert.equal(resolved, null);
});

test('jamendo source resolves stream with jamendo api', async () => {
  const youtubeApi = {
    async searchSongsSafe() {
      return { ok: true, data: [] };
    },
  };

  const jamendoApi = {
    async searchSongsSafe() {
      return {
        ok: true,
        data: [
          {
            id: 'jm-1',
            originalId: '1',
            title: 'Jamendo Song',
            artist: 'Jamendo Artist',
            source: 'jamendo',
            streamUrl: 'https://jamendo.example/audio.mp3',
          },
        ],
      };
    },
    async resolveStreamSafe() {
      return {
        ok: true,
        data: {
          streamUrl: 'https://jamendo.example/audio.mp3',
          streamSource: 'jamendo',
        },
      };
    },
  };

  const sources = createMusicSources({ youtubeApi, jamendoApi });
  const search = await sources.jamendo.search('jam', 1);
  assert.equal(search.ok, true);
  assert.equal(search.data.length, 1);

  const resolved = await sources.jamendo.getStreamUrl(search.data[0]);
  assert.equal(resolved.streamUrl, 'https://jamendo.example/audio.mp3');
  assert.equal(resolved.streamSource, 'jamendo');
});

test('soundcloud source resolves stream with soundcloud api', async () => {
  const youtubeApi = {
    async searchSongsSafe() {
      return { ok: true, data: [] };
    },
  };

  const soundcloudApi = {
    async searchSongsSafe() {
      return {
        ok: true,
        data: [
          {
            id: 'sc-42',
            originalId: '42',
            title: 'SC Song',
            artist: 'SC Artist',
            source: 'soundcloud',
            transcodings: [],
          },
        ],
      };
    },
    async resolveStreamSafe() {
      return {
        ok: true,
        data: {
          streamUrl: 'https://soundcloud.example/audio.mp3',
          streamSource: 'soundcloud',
        },
      };
    },
  };

  const sources = createMusicSources({ youtubeApi, soundcloudApi });
  const search = await sources.soundcloud.search('sc', 1);
  assert.equal(search.ok, true);
  assert.equal(search.data.length, 1);

  const resolved = await sources.soundcloud.getStreamUrl(search.data[0]);
  assert.equal(resolved.streamUrl, 'https://soundcloud.example/audio.mp3');
  assert.equal(resolved.streamSource, 'soundcloud');
});
