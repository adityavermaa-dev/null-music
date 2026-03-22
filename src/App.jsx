import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Play, User, Shuffle, ListPlus } from 'lucide-react';
import { usePlayer } from './context/PlayerContext';
import { saavnApi } from './api/saavn';
import { youtubeApi } from './api/youtube';
import { recommendationsApi } from './api/recommendations';
import { useLocalStorage } from './hooks/useLocalStorage';
import { buildHistory, insertTrackNext } from './utils/playerState';
import { getOrCreateUserId } from './utils/userId';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import TrackCard from './components/TrackCard';
import PlaybackBar from './components/PlaybackBar';
import LyricsModal from './components/LyricsModal';
import QueueViewer from './components/QueueViewer';
import MobilePlayer from './components/MobilePlayer';
import AsyncState from './components/AsyncState';
import { logError } from './utils/logger';

const COLORS = ['#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#8b5cf6', '#06b6d4'];
const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

function App() {
  const {
    playTrack,
    currentTrack,
    dominantColor,
    getRecommendationsFor,
    togglePlay,
    skipNext,
    skipPrev,
    queue,
    queueIndex,
    setQueue,
  } = usePlayer();

  const [activeTab, setActiveTab] = useState('home');
  const [topTracks, setTopTracks] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [discoverSections, setDiscoverSections] = useState([]);
  const [personalMix, setPersonalMix] = useState(null);
  const [dailyMix, setDailyMix] = useState(null);
  const [madeForYou, setMadeForYou] = useState(null);
  const [basedOnRecent, setBasedOnRecent] = useState(null);
  const [isLyricsOpen, setIsLyricsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isTrendingLoading, setIsTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState(null);
  const [isDiscoverLoading, setIsDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [contextMenu, setContextMenu] = useState({
    open: false,
    x: 0,
    y: 0,
    track: null,
    trackList: [],
  });
  const [contextMenuFocusIndex, setContextMenuFocusIndex] = useState(0);
  const contextMenuActionRefs = useRef([]);

  const [favorites, setFavorites] = useLocalStorage('aura-favorites', []);
  const [playlists, setPlaylists] = useLocalStorage('aura-playlists', []);
  const [history, setHistory] = useLocalStorage('aura-history', []);
  const [searchCache, setSearchCache] = useState({});

  const listeningStats = useMemo(() => {
    if (!history || history.length === 0) {
      return {
        totalMinutes: 0,
        totalPlays: 0,
        topTracks: [],
        topArtists: [],
      };
    }

    let totalDuration = 0;
    const trackMap = new Map();
    const artistMap = new Map();

    for (const track of history) {
      if (!track) continue;
      totalDuration += track.duration || 0;

      if (track.id) {
        const existing = trackMap.get(track.id) || { track, count: 0 };
        existing.count += 1;
        trackMap.set(track.id, existing);
      }

      if (track.artist) {
        artistMap.set(track.artist, (artistMap.get(track.artist) || 0) + 1);
      }
    }

    return {
      totalMinutes: Math.round(totalDuration / 60),
      totalPlays: history.length,
      topTracks: Array.from(trackMap.values()).sort((a, b) => b.count - a.count).slice(0, 3),
      topArtists: Array.from(artistMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    };
  }, [history]);

  useEffect(() => {
    if (!currentTrack) return;
    setHistory((previousHistory) => buildHistory(previousHistory, currentTrack));
  }, [currentTrack, setHistory]);

  const loadTrending = useCallback(async () => {
    setIsTrendingLoading(true);
    setTrendingError(null);

    try {
      // Prefer backend "global plays" trending (fast + cached). If empty, fall back to Saavn.
      const userId = getOrCreateUserId();
      const recoRes = await recommendationsApi.getRecommendationsSafe(userId);
      if (recoRes.ok && recoRes.data?.trending?.length) {
        setTopTracks(recoRes.data.trending);
        return;
      }

      const result = await saavnApi.getTrendingSafe();
      if (!result.ok) {
        setTopTracks([]);
        setTrendingError(result.error || 'Unable to load trending songs.');
      } else {
        setTopTracks((result.data || []).map(saavnApi.formatTrack));
      }
    } catch (error) {
      logError('app.loadTrending', error);
      setTopTracks([]);
      setTrendingError('Unable to load trending songs.');
    } finally {
      setIsTrendingLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTrending();
  }, [loadTrending]);

  const loadDiscover = useCallback(async () => {
    setIsDiscoverLoading(true);
    setDiscoverError(null);

    try {
      const [newRes, popularRes] = await Promise.all([
        saavnApi.searchSongsSafe('new releases 2026', 8),
        saavnApi.searchSongsSafe('popular hits', 8),
      ]);

      if (!newRes.ok && !popularRes.ok) {
        setDiscoverError('We could not load curated discover sections.');
      }

      setDiscoverSections([
        { title: 'New Releases', tracks: (newRes.data || []).map(saavnApi.formatTrack) },
        { title: 'Popular Right Now', tracks: (popularRes.data || []).map(saavnApi.formatTrack) },
      ]);

      const seedTrack = favorites[0] || history[0] || null;
      if (seedTrack && getRecommendationsFor) {
        try {
          const recommendations = await getRecommendationsFor(seedTrack);
          setPersonalMix(
            recommendations?.length
              ? { title: `Because you listened to ${seedTrack.title}`, tracks: recommendations }
              : null
          );
        } catch (error) {
          logError('app.personalMix', error, { seed: seedTrack?.id });
          setPersonalMix(null);
        }
      } else {
        setPersonalMix(null);
      }

      const seenIds = new Set();
      const dailyMixTracks = [];
      for (const track of [...favorites, ...history]) {
        if (!track?.id || seenIds.has(track.id)) continue;
        seenIds.add(track.id);
        dailyMixTracks.push(track);
        if (dailyMixTracks.length >= 30) break;
      }

      setDailyMix(dailyMixTracks.length ? { title: 'Daily Mix', tracks: dailyMixTracks } : null);

      // Backend recommendations (cache-first)
      try {
        const userId = getOrCreateUserId();
        const recoRes = await recommendationsApi.getRecommendationsSafe(userId);
        if (recoRes.ok && recoRes.data) {
          setMadeForYou(recoRes.data.madeForYou?.length ? { title: 'Made for you', tracks: recoRes.data.madeForYou } : null);
          setBasedOnRecent(recoRes.data.basedOnRecent?.length ? { title: 'Based on your recent plays', tracks: recoRes.data.basedOnRecent } : null);
        } else {
          setMadeForYou(null);
          setBasedOnRecent(null);
        }
      } catch {
        setMadeForYou(null);
        setBasedOnRecent(null);
      }
    } catch (error) {
      logError('app.loadDiscover', error);
      setDiscoverError('Discover is unavailable right now.');
      setDiscoverSections([]);
      setPersonalMix(null);
      setDailyMix(null);
      setMadeForYou(null);
      setBasedOnRecent(null);
    } finally {
      setIsDiscoverLoading(false);
    }
  }, [favorites, history, getRecommendationsFor]);

  useEffect(() => {
    if (activeTab !== 'home') return;
    loadDiscover();
  }, [activeTab, loadDiscover]);

  useEffect(() => {
    const handler = (event) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        skipNext();
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        skipPrev();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, skipNext, skipPrev]);

  const handleSearch = useCallback(async (query, options = {}) => {
    const { force = false } = options;
    setSearchQuery(query);
    setActiveTab('search');

    const term = query.trim();
    if (!term) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }

    if (!force && searchCache[term]) {
      setSearchResults(searchCache[term]);
      setSearchError(null);
      return;
    }

    setIsSearchLoading(true);
    setSearchError(null);

    try {
      const [saavnRes, ytRes] = await Promise.all([
        saavnApi.searchSongsSafe(term),
        youtubeApi.searchSongsSafe(term, 10),
      ]);

      if (!saavnRes.ok && !ytRes.ok) {
        setSearchResults([]);
        setSearchError([saavnRes.error, ytRes.error].filter(Boolean).join(' | ') || 'Search is unavailable right now.');
        return;
      }

      const combinedResults = [
        ...(saavnRes.data || []).map(saavnApi.formatTrack),
        ...(ytRes.data || []),
      ];

      setSearchResults(combinedResults);
      setSearchCache((previousCache) => ({
        ...previousCache,
        [term]: combinedResults,
      }));
    } catch (error) {
      logError('app.handleSearch', error, { term });
      setSearchResults([]);
      setSearchError('Search is unavailable right now.');
    } finally {
      setIsSearchLoading(false);
    }
  }, [searchCache]);

  const toggleFavorite = useCallback((track) => {
    setFavorites((previousFavorites) => {
      if (previousFavorites.some((favoriteTrack) => favoriteTrack.id === track.id)) {
        return previousFavorites.filter((favoriteTrack) => favoriteTrack.id !== track.id);
      }
      return [...previousFavorites, track];
    });
  }, [setFavorites]);

  const createPlaylist = (name) => {
    const newPlaylist = { id: Date.now().toString(), name, color: randomColor(), tracks: [] };
    setPlaylists([...playlists, newPlaylist]);
  };

  const deletePlaylist = (id) => {
    setPlaylists(playlists.filter((playlist) => playlist.id !== id));
    if (activeTab === `playlist-${id}`) {
      setActiveTab('trending');
    }
  };

  let displayedTracks = [];
  let sectionTitle = 'Top Tracks';
  const playlistMatch = activeTab.match(/^playlist-(.+)$/);

  if (activeTab === 'search') {
    displayedTracks = searchResults;
    sectionTitle = `Results for "${searchQuery}"`;
  } else if (activeTab === 'favorites') {
    displayedTracks = favorites;
    sectionTitle = 'Your Favorites';
  } else if (activeTab === 'history') {
    displayedTracks = history;
    sectionTitle = 'Recently Played';
  } else if (activeTab === 'most-played') {
    const counts = new Map();
    for (const track of history) {
      if (!track?.id) continue;
      const existing = counts.get(track.id) || { track, count: 0 };
      existing.count += 1;
      counts.set(track.id, existing);
    }
    displayedTracks = Array.from(counts.values()).sort((a, b) => b.count - a.count).map((entry) => entry.track);
    sectionTitle = 'Most Played';
  } else if (activeTab === 'short-tracks') {
    displayedTracks = favorites.filter((track) => (track.duration || 0) > 0 && track.duration <= 180);
    sectionTitle = 'Short & Sweet (under 3 min)';
  } else if (playlistMatch) {
    const playlist = playlists.find((item) => item.id === playlistMatch[1]);
    displayedTracks = playlist?.tracks || [];
    sectionTitle = playlist?.name || 'Playlist';
  } else if (activeTab === 'home' || activeTab === 'your-library') {
    displayedTracks = topTracks;
    sectionTitle = activeTab === 'your-library' ? 'Your Library' : 'Top Tracks';
  }

  const renderedTracks = displayedTracks.slice(0, 150);
  const glowColor = dominantColor.replace('rgb', 'rgba').replace(')', ', 0.15)');

  const handleTrackContextMenu = (event, track, trackList) => {
    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      track,
      trackList: trackList || [],
    });
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu((previous) => ({ ...previous, open: false, track: null }));
    setPlaylistSubOpen(false);
  }, []);

  const handlePlayNextFromMenu = useCallback(() => {
    const track = contextMenu.track;
    if (!track) return;

    if (!queue?.length || queueIndex < 0) {
      playTrack(track, [track]);
      closeContextMenu();
      return;
    }

    setQueue((previousQueue) => insertTrackNext(previousQueue, queueIndex, track));
    closeContextMenu();
  }, [closeContextMenu, contextMenu.track, playTrack, queue, queueIndex, setQueue]);

  const handleStartRadioFromMenu = useCallback(() => {
    const track = contextMenu.track;
    if (!track) return;
    playTrack(track, contextMenu.trackList || [], { mode: 'radio' });
    closeContextMenu();
  }, [closeContextMenu, contextMenu.track, contextMenu.trackList, playTrack]);

  const handleToggleFavoriteFromMenu = useCallback(() => {
    const track = contextMenu.track;
    if (!track) return;
    toggleFavorite(track);
    closeContextMenu();
  }, [closeContextMenu, contextMenu.track, toggleFavorite]);

  const [playlistSubOpen, setPlaylistSubOpen] = useState(false);

  const handleAddToPlaylist = useCallback((playlistId) => {
    const track = contextMenu.track;
    if (!track) return;
    setPlaylists((prev) =>
      prev.map((pl) =>
        pl.id === playlistId && !pl.tracks.some((t) => t.id === track.id)
          ? { ...pl, tracks: [...pl.tracks, track] }
          : pl
      )
    );
    setPlaylistSubOpen(false);
    closeContextMenu();
  }, [closeContextMenu, contextMenu.track, setPlaylists]);

  const handlePlayAll = useCallback(() => {
    if (renderedTracks.length > 0) {
      playTrack(renderedTracks[0], renderedTracks);
    }
  }, [renderedTracks, playTrack]);

  const handleShuffleAll = useCallback(() => {
    if (renderedTracks.length > 0) {
      const shuffled = [...renderedTracks].sort(() => Math.random() - 0.5);
      playTrack(shuffled[0], shuffled);
    }
  }, [renderedTracks, playTrack]);

  const contextMenuActions = [handlePlayNextFromMenu, handleStartRadioFromMenu, handleToggleFavoriteFromMenu];

  useEffect(() => {
    if (!contextMenu.open) return;
    setContextMenuFocusIndex(0);
    const timer = window.setTimeout(() => {
      contextMenuActionRefs.current[0]?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [contextMenu.open]);

  const tabContentKey = activeTab === 'search' ? `search-${searchQuery}` : activeTab;
  const sectionError = activeTab === 'search'
    ? searchError
    : activeTab === 'home' || activeTab === 'your-library'
    ? trendingError
    : null;
  const sectionLoading = activeTab === 'search'
    ? isSearchLoading
    : activeTab === 'home' || activeTab === 'your-library'
    ? isTrendingLoading
    : false;

  return (
    <div className="app-container" style={{ '--dominant-color': glowColor }}>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        playlists={playlists}
        onCreatePlaylist={createPlaylist}
        onDeletePlaylist={deletePlaylist}
      />

      <main className="main-content">
        <header className="top-bar">
          <SearchBar onSearch={handleSearch} />
          <div className="user-profile" aria-label="User profile">
            <div className="avatar">
              <User size={20} color="white" />
            </div>
          </div>
        </header>

        <div className="content-scroll">
          <div key={tabContentKey} className="tab-content-enter">
            {activeTab === 'home' && (
              <div className="discover-view">
                {isDiscoverLoading && !discoverSections.length && !personalMix && !dailyMix && (
                  <AsyncState state="loading" title="Preparing Discover" message="Building your mixes and fresh picks..." />
                )}

                {!isDiscoverLoading && discoverError && !discoverSections.length && !personalMix && !dailyMix && (
                  <AsyncState
                    state="error"
                    title="Discover is having trouble"
                    message={discoverError}
                    onRetry={loadDiscover}
                    retryLabel="Reload Discover"
                  />
                )}

                {!isDiscoverLoading && !discoverError && !discoverSections.length && !personalMix && !dailyMix && (
                  <AsyncState
                    state="empty"
                    title="No discover picks yet"
                    message="Start listening to a few songs and we will build personalized sections here."
                  />
                )}

                {dailyMix && (
                  <section className="track-section">
                    <div className="section-header">
                      <h2>{dailyMix.title}</h2>
                    </div>
                    <div className="track-grid">
                      {dailyMix.tracks.map((track, index) => (
                        <TrackCard
                          key={track.id + index}
                          track={track}
                          trackList={dailyMix.tracks}
                          playMode="list"
                          isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                          onToggleFavorite={toggleFavorite}
                          onContextMenu={handleTrackContextMenu}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {madeForYou && (
                  <section className="track-section">
                    <div className="section-header">
                      <h2>{madeForYou.title}</h2>
                    </div>
                    <div className="track-grid">
                      {madeForYou.tracks.map((track, index) => (
                        <TrackCard
                          key={track.id + index}
                          track={track}
                          trackList={madeForYou.tracks}
                          playMode="list"
                          isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                          onToggleFavorite={toggleFavorite}
                          onContextMenu={handleTrackContextMenu}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {basedOnRecent && (
                  <section className="track-section">
                    <div className="section-header">
                      <h2>{basedOnRecent.title}</h2>
                    </div>
                    <div className="track-grid">
                      {basedOnRecent.tracks.map((track, index) => (
                        <TrackCard
                          key={track.id + index}
                          track={track}
                          trackList={basedOnRecent.tracks}
                          playMode="list"
                          isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                          onToggleFavorite={toggleFavorite}
                          onContextMenu={handleTrackContextMenu}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {personalMix && (
                  <section className="track-section">
                    <div className="section-header">
                      <h2>{personalMix.title}</h2>
                    </div>
                    <div className="track-grid">
                      {personalMix.tracks.map((track, index) => (
                        <TrackCard
                          key={track.id + index}
                          track={track}
                          trackList={personalMix.tracks}
                          playMode="list"
                          isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                          onToggleFavorite={toggleFavorite}
                          onContextMenu={handleTrackContextMenu}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {history.length > 0 && (
                  <section className="track-section">
                    <div className="section-header">
                      <h2>Recently Played</h2>
                    </div>
                    <div className="track-grid">
                      {history.slice(0, 10).map((track, index) => (
                        <TrackCard
                          key={track.id + index}
                          track={track}
                          trackList={history}
                          isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                          onToggleFavorite={toggleFavorite}
                          onContextMenu={handleTrackContextMenu}
                          index={index}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {discoverSections.map((section, sectionIndex) => (
                  <section key={sectionIndex} className="track-section">
                    <div className="section-header">
                      <h2>{section.title}</h2>
                    </div>
                    {section.tracks.length > 0 ? (
                      <div className="track-grid">
                        {section.tracks.map((track, index) => (
                          <TrackCard
                            key={track.id + index}
                            track={track}
                            trackList={section.tracks}
                            isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                            onToggleFavorite={toggleFavorite}
                            onContextMenu={handleTrackContextMenu}
                            index={index}
                          />
                        ))}
                      </div>
                    ) : (
                      <AsyncState compact state="empty" title="No tracks in this section" message="Try refreshing discover to pull a new set." />
                    )}
                  </section>
                ))}
              </div>
            )}

            {activeTab === 'trending' && (
              <section className="hero-section glass-panel">
                <div className="hero-content">
                  <h2>Trending Now</h2>
                  <p>Discover the most played tracks globally</p>
                  <button className="play-button" onClick={() => topTracks.length > 0 && playTrack(topTracks[0], topTracks)} type="button">
                    <Play size={18} style={{ marginRight: 8, display: 'inline', verticalAlign: 'text-bottom' }} />
                    Play Top Chart
                  </button>
                </div>
                <div className="hero-decoration" />
              </section>
            )}

            {activeTab !== 'discover' && (
              <section className="track-section">
                <div className="section-header">
                  <h2>{sectionTitle}</h2>
                  <div className="section-header-actions">
                    {renderedTracks.length > 1 && (
                      <>
                        <button className="section-action-btn" onClick={handlePlayAll} aria-label="Play all" type="button">
                          <Play size={16} /> Play All
                        </button>
                        <button className="section-action-btn" onClick={handleShuffleAll} aria-label="Shuffle all" type="button">
                          <Shuffle size={16} /> Shuffle
                        </button>
                      </>
                    )}
                    {playlistMatch && playlists.find((playlist) => playlist.id === playlistMatch[1]) && (
                      <span className="track-count">{displayedTracks.length} tracks</span>
                    )}
                  </div>
                </div>

                {activeTab === 'history' && history.length > 0 && (
                  <div className="history-stats glass-panel">
                    <div className="history-stats-main">
                      <h3>Listening summary</h3>
                      <p>{listeningStats.totalMinutes} min listened · {listeningStats.totalPlays} plays</p>
                    </div>
                    <div className="history-stats-meta">
                      {listeningStats.topArtists.length > 0 && (
                        <div className="history-stat-column">
                          <span className="history-stat-label">Top artists</span>
                          <span className="history-stat-value">
                            {listeningStats.topArtists.map((artist) => `${artist.name} (${artist.count})`).join(', ')}
                          </span>
                        </div>
                      )}
                      {listeningStats.topTracks.length > 0 && (
                        <div className="history-stat-column">
                          <span className="history-stat-label">Top tracks</span>
                          <span className="history-stat-value">
                            {listeningStats.topTracks.map((trackStat) => `${trackStat.track.title} (${trackStat.count})`).join(', ')}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {sectionLoading && <AsyncState state="loading" title="Loading tracks" message="This can take a few seconds..." />}

                {!sectionLoading && sectionError && renderedTracks.length === 0 && (
                  <AsyncState
                    state="error"
                    title="Could not load tracks"
                    message={sectionError}
                    onRetry={() => {
                      if (activeTab === 'search') {
                        handleSearch(searchQuery, { force: true });
                      } else {
                        loadTrending();
                      }
                    }}
                  />
                )}

                {!sectionLoading && !sectionError && renderedTracks.length === 0 && (
                  <AsyncState
                    state="empty"
                    title={activeTab === 'search'
                      ? 'No results found'
                      : activeTab === 'favorites'
                      ? 'No favorites yet'
                      : playlistMatch
                      ? 'This playlist is empty'
                      : 'No tracks available'}
                    message={activeTab === 'search'
                      ? 'Try a different artist or song title.'
                      : activeTab === 'favorites'
                      ? 'Tap the heart icon on tracks to save them here.'
                      : playlistMatch
                      ? 'Search for songs and add them using the context menu.'
                      : 'Try again in a few moments.'}
                  />
                )}

                {renderedTracks.length > 0 && (
                  <div className="track-grid" role="list" aria-label={`${sectionTitle} tracks`}>
                    {renderedTracks.map((track, index) => (
                      <TrackCard
                        key={track.id + index}
                        track={track}
                        trackList={renderedTracks}
                        playMode={activeTab === 'search' ? 'radio' : 'list'}
                        isFavorite={favorites.some((favoriteTrack) => favoriteTrack.id === track.id)}
                        onToggleFavorite={toggleFavorite}
                        onContextMenu={handleTrackContextMenu}
                        index={index}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </main>

      <PlaybackBar onOpenLyrics={() => setIsLyricsOpen(true)} onOpenQueue={() => setIsQueueOpen(true)} />
      <MobilePlayer onOpenLyrics={() => setIsLyricsOpen(true)} onOpenQueue={() => setIsQueueOpen(true)} />
      <LyricsModal isOpen={isLyricsOpen} onClose={() => setIsLyricsOpen(false)} />
      <QueueViewer isOpen={isQueueOpen} onClose={() => setIsQueueOpen(false)} />

      {contextMenu.open && contextMenu.track && (
        <div className="track-context-menu-overlay" onClick={closeContextMenu}>
          <div
            className="track-context-menu glass-panel"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(event) => event.stopPropagation()}
            role="menu"
            aria-label="Track options"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeContextMenu();
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                const nextIndex = (contextMenuFocusIndex + 1) % contextMenuActions.length;
                setContextMenuFocusIndex(nextIndex);
                contextMenuActionRefs.current[nextIndex]?.focus();
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                const nextIndex = (contextMenuFocusIndex - 1 + contextMenuActions.length) % contextMenuActions.length;
                setContextMenuFocusIndex(nextIndex);
                contextMenuActionRefs.current[nextIndex]?.focus();
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                contextMenuActions[contextMenuFocusIndex]?.();
              }
            }}
          >
            <button
              className="track-context-item"
              onClick={handlePlayNextFromMenu}
              role="menuitem"
              ref={(element) => {
                contextMenuActionRefs.current[0] = element;
              }}
              type="button"
            >
              Play next
            </button>
            <button
              className="track-context-item"
              onClick={handleStartRadioFromMenu}
              role="menuitem"
              ref={(element) => {
                contextMenuActionRefs.current[1] = element;
              }}
              type="button"
            >
              Start song radio
            </button>
            <button
              className="track-context-item"
              onClick={handleToggleFavoriteFromMenu}
              role="menuitem"
              ref={(element) => {
                contextMenuActionRefs.current[2] = element;
              }}
              type="button"
            >
              {favorites.some((favoriteTrack) => favoriteTrack.id === contextMenu.track.id)
                ? 'Remove from favorites'
                : 'Add to favorites'}
            </button>
            {playlists.length > 0 && (
              <div className="ctx-playlist-group">
                <button
                  className="track-context-item ctx-playlist-toggle"
                  onClick={() => setPlaylistSubOpen((p) => !p)}
                  role="menuitem"
                  type="button"
                >
                  <ListPlus size={16} />
                  Add to playlist
                </button>
                {playlistSubOpen && (
                  <div className="ctx-playlist-sub">
                    {playlists.map((pl) => (
                      <button
                        key={pl.id}
                        className="track-context-item ctx-playlist-item"
                        onClick={() => handleAddToPlaylist(pl.id)}
                        role="menuitem"
                        type="button"
                      >
                        <span className="ctx-playlist-dot" style={{ background: pl.color }} />
                        {pl.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
