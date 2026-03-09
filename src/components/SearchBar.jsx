import { Search, Loader, Music, Disc, User as UserIcon, RefreshCw, AlertCircle } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { saavnApi } from '../api/saavn';
import { youtubeApi } from '../api/youtube';

export default function SearchBar({ onSearch }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [suggestionError, setSuggestionError] = useState(null);

  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const fetchTokenRef = useRef(0);
  const allowSuggestionsRef = useRef(true);
  const suggestionCacheRef = useRef(new Map());

  const fetchSuggestions = useCallback((q, options = {}) => {
    const { force = false } = options;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!allowSuggestionsRef.current && !force) {
      return;
    }

    if (!q.trim() || q.trim().length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      setSelectedIdx(-1);
      setSuggestionError(null);
      return;
    }

    const searchTerm = q.trim();
    if (!force) {
      const cached = suggestionCacheRef.current.get(searchTerm);
      if (cached) {
        setSuggestions(cached);
        setShowSuggestions(true);
        setSelectedIdx(-1);
        setSuggestionError(null);
        return;
      }
    }

    const myToken = ++fetchTokenRef.current;
    debounceRef.current = setTimeout(async () => {
      const [saavnRes, ytRes] = await Promise.all([
        saavnApi.getSearchSuggestionsSafe(searchTerm),
        youtubeApi.getSearchSuggestionsSafe(searchTerm),
      ]);

      if (!allowSuggestionsRef.current && !force) {
        return;
      }
      if (myToken !== fetchTokenRef.current) {
        return;
      }

      const merged = [
        ...(saavnRes.data || []).slice(0, 5),
        ...(ytRes.data || []).slice(0, 5),
      ];

      const unique = [];
      const titles = new Set();
      for (const item of merged) {
        const lowerTitle = item.title?.toLowerCase();
        if (!titles.has(lowerTitle)) {
          titles.add(lowerTitle);
          unique.push(item);
        }
      }

      if (!saavnRes.ok && !ytRes.ok) {
        const combinedError = [saavnRes.error, ytRes.error].filter(Boolean).join(' | ');
        setSuggestionError(combinedError || 'Suggestions are unavailable.');
      } else {
        setSuggestionError(null);
      }

      suggestionCacheRef.current.set(searchTerm, unique);
      setSuggestions(unique);
      setShowSuggestions(true);
      setSelectedIdx(-1);
    }, 300);
  }, []);

  useEffect(() => {
    fetchSuggestions(query);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchSuggestions]);

  useEffect(() => {
    const handleOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const doSearch = async (q) => {
    const term = q || query;
    if (!term.trim()) return;

    allowSuggestionsRef.current = false;
    fetchTokenRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedIdx(-1);
    setSuggestionError(null);
    setLoading(true);

    try {
      await onSearch(term.trim());
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!showSuggestions) setShowSuggestions(true);
      setSelectedIdx((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter') {
      if (selectedIdx >= 0 && suggestions[selectedIdx]) {
        const selectedTitle = suggestions[selectedIdx].title;
        setQuery(selectedTitle);
        doSearch(selectedTitle);
      } else {
        doSearch();
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const getTypeIcon = (type) => {
    switch (type) {
      case 'song':
        return <Music size={14} />;
      case 'album':
        return <Disc size={14} />;
      case 'artist':
        return <UserIcon size={14} />;
      default:
        return <Search size={14} />;
    }
  };

  return (
    <div className="search-wrapper" ref={containerRef}>
      <div className="search-container" role="search" aria-label="Song search">
        {loading ? <Loader className="search-icon spin-icon" size={18} /> : <Search className="search-icon" size={18} />}
        <input
          id="search-input"
          type="text"
          className="search-input"
          placeholder="Search for songs, artists, albums…"
          value={query}
          onChange={(e) => {
            allowSuggestionsRef.current = true;
            setQuery(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (allowSuggestionsRef.current && (suggestions.length > 0 || suggestionError)) {
              setShowSuggestions(true);
            }
          }}
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls="search-suggestions-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            selectedIdx >= 0 && suggestions[selectedIdx] ? `suggestion-${selectedIdx}` : undefined
          }
        />
      </div>

      {showSuggestions && (
        <div
          id="search-suggestions-listbox"
          className="suggestions-dropdown glass-panel"
          role="listbox"
          aria-label="Search suggestions"
        >
          {suggestionError && (
            <div className="suggestion-error" role="status" aria-live="polite">
              <AlertCircle size={14} />
              <span>{suggestionError}</span>
              <button
                type="button"
                className="suggestion-retry-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  allowSuggestionsRef.current = true;
                  fetchSuggestions(query, { force: true });
                }}
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          )}

          {suggestions.length === 0 && !suggestionError && (
            <div className="suggestion-empty" role="status">
              Start typing to get suggestions.
            </div>
          )}

          {suggestions.map((item, idx) => (
            <div
              key={`${item.id}-${idx}`}
              id={`suggestion-${idx}`}
              className={`suggestion-item ${idx === selectedIdx ? 'suggestion-active' : ''}`}
              role="option"
              aria-selected={idx === selectedIdx}
              onMouseEnter={() => setSelectedIdx(idx)}
              onMouseDown={() => {
                setQuery(item.title);
                doSearch(item.title);
              }}
            >
              {item.image ? (
                <img src={item.image} alt="" className="suggestion-img" />
              ) : (
                <div className="suggestion-img suggestion-img-placeholder">{getTypeIcon(item.type)}</div>
              )}
              <div className="suggestion-text">
                <span className="suggestion-title">{item.title}</span>
                {item.description && <span className="suggestion-desc">{item.description}</span>}
              </div>
              <span className={`suggestion-type suggestion-type--${item.type}`}>{item.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
