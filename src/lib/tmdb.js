// Falls back to the widely-used public TMDB demo key so the app runs with no setup.
// Override with your own key via VITE_TMDB_API_KEY in .env.
const API_KEY = import.meta.env.VITE_TMDB_API_KEY || '3fd2be6f0c70a2a598f084ddfb75487c'
const BASE = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p'

export const hasKey = () => Boolean(API_KEY)

export const img = (path, size = 'w500') => (path ? `${IMG}/${size}${path}` : null)

async function get(path, params = {}) {
  if (!API_KEY) throw new Error('Missing VITE_TMDB_API_KEY — add it to .env')
  const url = new URL(BASE + path)
  url.searchParams.set('api_key', API_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`TMDB request failed (${res.status})`)
  return res.json()
}

export async function trending() {
  const data = await get('/trending/all/week')
  return data.results.filter((r) => r.media_type !== 'person')
}

export async function search(query) {
  if (!query.trim()) return []
  const data = await get('/search/multi', { query, include_adult: 'false' })
  return data.results.filter(
    (r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path,
  )
}

export function details(type, id) {
  return get(`/${type}/${id}`)
}

export function seasonEpisodes(id, seasonNumber) {
  return get(`/tv/${id}/season/${seasonNumber}`)
}
