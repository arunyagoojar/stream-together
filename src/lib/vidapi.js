const EMBED = 'https://vidlink.pro'

function build(path, { startAt, autoplay = true } = {}) {
  const u = new URL(`${EMBED}/${path}`)
  u.searchParams.set('primaryColor', 'ffffff')
  u.searchParams.set('autoplay', autoplay ? 'true' : 'false')
  // Room sync reloads the iframe at a shared timestamp.
  if (startAt != null && startAt > 0) {
    const t = Math.floor(startAt)
    u.searchParams.set('startAt', t)
  }
  return u.toString()
}

export function movieEmbed(id, opts) {
  return build(`movie/${id}`, opts)
}

export function tvEmbed(id, season, episode, opts) {
  return build(`tv/${id}/${season}/${episode}`, opts)
}
