import { Music, TrendingUp, Library, Heart, Plus, X, Clock } from 'lucide-react';
import { useState } from 'react';

const NAV_ITEMS = [
  { id: 'discover', label: 'Discover', icon: Music },
  { id: 'trending', label: 'Trending', icon: TrendingUp },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'history', label: 'Recently Played', icon: Clock },
  { id: 'most-played', label: 'Most Played', icon: TrendingUp },
  { id: 'short-tracks', label: 'Short Tracks', icon: Music },
];

export default function Sidebar({
  activeTab,
  setActiveTab,
  playlists,
  onCreatePlaylist,
  onDeletePlaylist,
}) {
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState('');

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    onCreatePlaylist(name);
    setNewName('');
    setShowModal(false);
  };

  return (
    <aside className="sidebar glass-panel" aria-label="Sidebar navigation">
      <div className="logo-container">
        <h1 className="logo-text">Aura</h1>
      </div>

      <nav className="nav-menu" aria-label="Main sections">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => setActiveTab(item.id)}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
            >
              <Icon className="icon" size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="playlists-section">
        <div className="playlists-header">
          <h3 className="section-title">YOUR PLAYLISTS</h3>
          <button
            className="icon-btn add-playlist-btn"
            onClick={() => setShowModal(true)}
            title="Create Playlist"
            aria-label="Create playlist"
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>

        <button
          className={`playlist-item ${activeTab === 'favorites' ? 'active-playlist' : ''}`}
          onClick={() => setActiveTab('favorites')}
          type="button"
          aria-current={activeTab === 'favorites' ? 'page' : undefined}
        >
          <Heart size={14} style={{ color: 'var(--primary-500)', flexShrink: 0 }} />
          <span>Favorites</span>
        </button>

        {playlists.map((pl) => (
          <div
            key={pl.id}
            className={`playlist-item ${activeTab === `playlist-${pl.id}` ? 'active-playlist' : ''}`}
            role="group"
            aria-label={`Playlist ${pl.name}`}
          >
            <button
              type="button"
              className="playlist-open-btn"
              onClick={() => setActiveTab(`playlist-${pl.id}`)}
              aria-current={activeTab === `playlist-${pl.id}` ? 'page' : undefined}
            >
              <span className="playlist-color" style={{ backgroundColor: pl.color }} />
              <span className="playlist-name">{pl.name}</span>
            </button>
            <button
              className="playlist-delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDeletePlaylist(pl.id);
              }}
              title="Delete playlist"
              aria-label={`Delete playlist ${pl.name}`}
              type="button"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div
            className="modal glass-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-playlist-title"
          >
            <h3 id="create-playlist-title">Create Playlist</h3>
            <input
              className="modal-input"
              type="text"
              placeholder="Playlist name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
              aria-label="Playlist name"
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowModal(false)} type="button">
                Cancel
              </button>
              <button className="btn-primary" onClick={handleCreate} type="button">
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
