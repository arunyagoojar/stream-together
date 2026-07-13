const EMBED = 'https://vidlink.pro'

function build(path, { startAt, autoplay = true } = {}) {
  const u = new URL(`${EMBED}/${path}`)
  u.searchParams.set('primaryColor', 'ffffff')
  u.searchParams.set('autoplay', autoplay ? 'true' : 'false')
  // vidlink doesn't document startAt, but we can try setting it, or just rely on postMessage later if needed.
  if (startAt != null && startAt > 0) {
    const t = Math.floor(startAt)
    u.searchParams.set('startAt', t) // Try it, no harm
  }
  return u.toString()
}

export function movieEmbed(id, opts) {
  return build(`movie/${id}`, opts)
}

export function tvEmbed(id, season, episode, opts) {
  return build(`tv/${id}/${season}/${episode}`, opts)
}
