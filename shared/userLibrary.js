const MAX_FAVORITES = 500;
const MAX_PLAYLISTS = 50;
const MAX_PLAYLIST_TRACKS = 300;
const MAX_HISTORY = 200;
const YOUTUBE_PREFIX = 'yt-';
const DOWNLOAD_PREFIX = 'download-';

const DEFAULT_TRACK = {
  title: 'Unknown',
  artist: 'Unknown',
  album: '',
  coverArt: '',
  source: 'youtube',
  duration: 0,
};

function uniqueById(items) {
  const seen = new Set();
  const next = [];

  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    next.push(item);
  }

  return next;
}

function cleanString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeTrackKey(value) {
  return cleanString(value)
    .replace(new RegExp(`^${DOWNLOAD_PREFIX}`), '')
    .replace(new RegExp(`^${YOUTUBE_PREFIX}`), '');
}

function toCanonicalTrackIdentity(track) {
  const rawId = cleanString(track?.id);
  const rawSource = cleanString(track?.source).toLowerCase();
  const originalId = normalizeTrackKey(track?.originalId);
  const videoId = normalizeTrackKey(track?.videoId);
  const fallbackId = normalizeTrackKey(rawId);
  const downloadedSourceId = originalId || videoId || fallbackId;
  const isDownloaded = rawSource === 'downloaded' || rawId.startsWith(DOWNLOAD_PREFIX);

  if (isDownloaded && downloadedSourceId) {
    return {
      id: `${YOUTUBE_PREFIX}${downloadedSourceId}`,
      originalId: downloadedSourceId,
      videoId: downloadedSourceId,
      source: 'youtube',
      dropStreamUrl: true,
    };
  }

  return {
    id: rawId,
    originalId: originalId || '',
    videoId: videoId || '',
    source: rawSource || DEFAULT_TRACK.source,
    dropStreamUrl: false,
  };
}

export function normalizeLibraryTrack(track) {
  if (!track || typeof track !== 'object') return null;

  const identity = toCanonicalTrackIdentity(track);
  if (!identity.id) return null;

  const normalized = {
    id: identity.id,
    title: typeof track.title === 'string' && track.title.trim() ? track.title.trim() : DEFAULT_TRACK.title,
    artist: typeof track.artist === 'string' && track.artist.trim() ? track.artist.trim() : DEFAULT_TRACK.artist,
    album: typeof track.album === 'string' ? track.album : DEFAULT_TRACK.album,
    coverArt: typeof track.coverArt === 'string' ? track.coverArt : DEFAULT_TRACK.coverArt,
    source: identity.source,
    duration: Number.isFinite(Number(track.duration)) ? Number(track.duration) : DEFAULT_TRACK.duration,
  };

  const passthroughFields = ['videoId', 'originalId', 'permaUrl', 'streamUrl'];
  for (const key of passthroughFields) {
    if (track[key] == null) continue;
    if (key === 'streamUrl' && identity.dropStreamUrl) continue;
    normalized[key] = typeof track[key] === 'string' ? track[key] : String(track[key]);
  }

  if (identity.videoId) {
    normalized.videoId = identity.videoId;
  }

  if (identity.originalId) {
    normalized.originalId = identity.originalId;
  }

  return normalized;
}

export function normalizeFavoriteTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  return uniqueById(
    tracks.map(normalizeLibraryTrack).filter(Boolean)
  ).slice(0, MAX_FAVORITES);
}

function normalizePlaylistTrackList(tracks) {
  if (!Array.isArray(tracks)) return [];
  return uniqueById(
    tracks.map(normalizeLibraryTrack).filter(Boolean)
  ).slice(0, MAX_PLAYLIST_TRACKS);
}

export function normalizePlaylists(playlists) {
  if (!Array.isArray(playlists)) return [];

  return playlists
    .map((playlist, index) => {
      if (!playlist || typeof playlist !== 'object') return null;

      const name = typeof playlist.name === 'string' && playlist.name.trim()
        ? playlist.name.trim()
        : `Playlist ${index + 1}`;
      const id = playlist.id == null || String(playlist.id).trim() === ''
        ? `playlist-${index + 1}`
        : String(playlist.id).trim();

      return {
        id,
        name,
        color: typeof playlist.color === 'string' && playlist.color.trim() ? playlist.color : '#fc3c44',
        tracks: normalizePlaylistTrackList(playlist.tracks),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PLAYLISTS);
}

export function normalizeHistoryTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  return uniqueById(
    tracks.map(normalizeLibraryTrack).filter(Boolean)
  ).slice(0, MAX_HISTORY);
}

export function normalizeLibraryPayload(payload = {}) {
  const favorites = normalizeFavoriteTracks(payload.favorites);
  const playlists = normalizePlaylists(payload.playlists);
  const history = normalizeHistoryTracks(payload.history);

  return {
    favorites,
    playlists,
    history,
    updatedAt: Number.isFinite(Number(payload.updatedAt))
      ? Number(payload.updatedAt)
      : Date.now(),
  };
}

export function emptyUserLibrary() {
  return normalizeLibraryPayload({
    favorites: [],
    playlists: [],
    history: [],
    updatedAt: Date.now(),
  });
}

function playlistKey(playlist) {
  return cleanString(playlist?.name).toLowerCase() || cleanString(playlist?.id).toLowerCase();
}

function mergePlaylistList(playlists) {
  const next = [];
  const indexByKey = new Map();

  for (const playlist of playlists) {
    const normalized = playlist && typeof playlist === 'object'
      ? {
        id: cleanString(playlist.id),
        name: cleanString(playlist.name),
        color: cleanString(playlist.color),
        tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [],
      }
      : null;
    if (!normalized) continue;

    const key = playlistKey(normalized);
    if (!key) continue;

    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, next.length);
      next.push({
        ...normalized,
        tracks: normalizePlaylists([normalized])[0]?.tracks || [],
      });
      continue;
    }

    const existing = next[existingIndex];
    next[existingIndex] = {
      ...existing,
      tracks: normalizePlaylists([
        {
          ...existing,
          tracks: [...existing.tracks, ...normalized.tracks],
        },
      ])[0]?.tracks || existing.tracks,
    };
  }

  return normalizePlaylists(next);
}

export function mergeUserLibraries(...libraries) {
  const normalizedLibraries = libraries
    .map((library) => normalizeLibraryPayload(library))
    .filter(Boolean);

  const priorityOrdered = [...normalizedLibraries].reverse();

  return normalizeLibraryPayload({
    favorites: priorityOrdered.flatMap((library) => library.favorites),
    playlists: mergePlaylistList(priorityOrdered.flatMap((library) => library.playlists)),
    history: priorityOrdered.flatMap((library) => library.history),
    updatedAt: Math.max(Date.now(), ...normalizedLibraries.map((library) => Number(library.updatedAt) || 0)),
  });
}

export function isLibraryEmpty(library) {
  const normalized = normalizeLibraryPayload(library);
  return normalized.favorites.length === 0
    && normalized.playlists.length === 0
    && normalized.history.length === 0;
}
