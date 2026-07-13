import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { trending, search, img, hasKey } from '../lib/tmdb.js'
import { useDebounce } from '../hooks/useDebounce.js'
import { useSync } from '../sync/SyncProvider.jsx'
import './Home.css'

export default function Home() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [trend, setTrend] = useState([])
  const [error, setError] = useState(hasKey() ? null : 'Add VITE_TMDB_API_KEY to .env, then restart the dev server.')
  const [loading, setLoading] = useState(false)
  const debounced = useDebounce(query)
  const navigate = useNavigate()
  const { inRoom, send } = useSync()

  useEffect(() => {
    if (!hasKey()) return
    trending().then(setTrend).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    if (!hasKey()) return
    const q = debounced.trim()
    if (!q) {
      setResults([])
      return
    }
    setLoading(true)
    search(q)
      .then(setResults)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [debounced])

  const shown = query.trim() ? results : trend
  const wall = useMemo(() => trend.filter((t) => t.poster_path).slice(0, 18), [trend])

  const open = (item) => {
    const type = item.media_type === 'tv' ? 'tv' : 'movie'
    const path = `/watch/${type}/${item.id}`
    if (inRoom) send({ t: 'navigate', path })
    navigate(path)
  }

  return (
    <div className="home">
      <div className="poster-wall" aria-hidden="true">
        {wall.map((t) => (
          <div key={t.id} className="wall-tile" style={{ backgroundImage: `url(${img(t.poster_path, 'w342')})` }} />
        ))}
      </div>
      <div className="wall-fade" aria-hidden="true" />

      <main className="home-content">
        <h1 className="brand">Stream Together</h1>
        <div className="search-glass">
          <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            type="text"
            placeholder="Search movies and TV shows"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && <p className="notice">{error}</p>}

        <div className="grid">
          {shown.map((item) => (
            <button key={`${item.media_type}-${item.id}`} className="card" onClick={() => open(item)}>
              <div className="card-poster" style={{ backgroundImage: `url(${img(item.poster_path, 'w342')})` }}>
                <span className="card-type">{item.media_type === 'tv' ? 'TV' : 'Film'}</span>
              </div>
              <span className="card-title">{item.title || item.name}</span>
            </button>
          ))}
        </div>

        {!loading && query.trim() && !results.length && !error && (
          <p className="notice">No results for “{query}”.</p>
        )}
      </main>
    </div>
  )
}
