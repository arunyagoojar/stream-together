const EMBED = 'https://vidapi.ru/embed'

function build(path, { startAt, autoplay = true } = {}) {
  const u = new URL(`${EMBED}/${path}`)
  u.searchParams.set('color', 'ffffff')
  u.searchParams.set('autoplay', autoplay ? '1' : '0')
  u.searchParams.set('ui', '0')         // hide player's own title overlay
  // Always set both startAt and resumeAt so the player never ignores the seek
  if (startAt != null && startAt > 0) {
    const t = Math.floor(startAt)
    u.searchParams.set('startAt', t)
    u.searchParams.set('resumeAt', t)
  }
  return u.toString()
}

export function movieEmbed(id, opts) {
  return build(`movie/${id}`, opts)
}

export function tvEmbed(id, season, episode, opts) {
  return build(`tv/${id}/${season}/${episode}`, opts)
}
