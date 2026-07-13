import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { details, seasonEpisodes } from '../lib/tmdb.js'
import { movieEmbed, tvEmbed } from '../lib/vidapi.js'
import { useSync } from '../sync/SyncProvider.jsx'
import confetti from 'canvas-confetti'
import './Watch.css'

// How long (ms) after last mouse movement before the overlay hides
const HIDE_DELAY = 3000
// Seconds to add to wall-clock offset to account for iframe load/buffer lag
const LOAD_BUFFER_S = 3

export default function Watch() {
  const { type, id } = useParams()
  const navigate = useNavigate()
  const {
    inRoom, isHost, roomCode, members, status,
    createRoom, joinRoom, leaveRoom,
    send, sendState, requestState, subscribe,
  } = useSync()
  const stageRef = useRef(null)

  // Media metadata
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const [episodes, setEpisodes] = useState([])

  // Playback UI state
  const [iframeSrc, setIframeSrc] = useState(null)
  const [paused, setPaused] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [syncFlash, setSyncFlash] = useState(false)

  // Overlay auto-hide
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [navPinned, setNavPinned] = useState(false)
  const hideTimerRef = useRef(null)

  // Room join UI (when not yet in a room)
  const [roomOpen, setRoomOpen] = useState(false)
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [copied, setCopied] = useState(false)

  // Episode dropdown
  const [epOpen, setEpOpen] = useState(false)

  // Season/episode — keep refs in sync so subscribe closures see fresh values
  const [season, _setSeason] = useState(1)
  const [episode, _setEpisode] = useState(1)
  const seasonRef = useRef(1)
  const episodeRef = useRef(1)
  const setSeason = useCallback((v) => { seasonRef.current = v; _setSeason(v) }, [])
  const setEpisode = useCallback((v) => { episodeRef.current = v; _setEpisode(v) }, [])

  // Wall-clock playback tracking (no cross-origin iframe access)
  // playStartRef stores (Date.now() + LOAD_BUFFER_S*1000) so getOffset()
  // naturally subtracts buffering lag from elapsed time.
  const playStartRef = useRef(null)  // effective start time (ms)
  const pauseOffsetRef = useRef(0)   // accumulated seconds at last pause

  const getOffset = useCallback(() => {
    if (playStartRef.current == null) return pauseOffsetRef.current
    return Math.max(0, pauseOffsetRef.current + (Date.now() - playStartRef.current) / 1000)
  }, [])

  const buildSrc = useCallback((s, ep, at, autoplay) => {
    const opts = { startAt: Math.max(0, Math.floor(at)), autoplay }
    return type === 'tv' ? tvEmbed(id, s, ep, opts) : movieEmbed(id, opts)
  }, [type, id])

  const flashSynced = useCallback(() => {
    setSyncFlash(true)
    setTimeout(() => setSyncFlash(false), 2200)
  }, [])

  // ── Overlay auto-hide ─────────────────────────────────────────────────────
  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimerRef.current)
    setOverlayVisible(true)
    if (paused || preparing || navPinned) return
    hideTimerRef.current = setTimeout(() => setOverlayVisible(false), HIDE_DELAY)
  }, [paused, preparing, navPinned])

  const keepVisible = useCallback(() => {
    clearTimeout(hideTimerRef.current)
    setOverlayVisible(true)
  }, [])

  useEffect(() => {
    scheduleHide()
    return () => clearTimeout(hideTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Always show overlay when paused, preparing or pinned
  useEffect(() => {
    if (paused || preparing || navPinned) keepVisible()
    else scheduleHide()
  }, [paused, preparing, navPinned, keepVisible, scheduleHide])

  // ── Load media info ───────────────────────────────────────────────────────
  useEffect(() => {
    details(type, id).then(setInfo).catch((e) => setError(e.message))
  }, [type, id])

  useEffect(() => {
    if (type !== 'tv' || !info) return
    seasonEpisodes(id, season)
      .then((s) => setEpisodes(s.episodes || []))
      .catch(() => setEpisodes([]))
  }, [type, id, season, info])

  // ── HOST: load iframe as soon as info arrives ─────────────────────────────
  useEffect(() => {
    if (!info) return
    if (inRoom && !isHost) return // guest waits for sync-state instead

    if (inRoom) {
      // Host in a room: start paused and broadcast state to guests
      playStartRef.current = null
      pauseOffsetRef.current = 0
      setPaused(true)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, 0, false))
      sendState({
        path: `/watch/${type}/${id}`,
        type, id,
        season: seasonRef.current,
        episode: episodeRef.current,
        offset: 0,
        playing: false,
      })
    } else {
      // Solo: autoplay, add buffer offset so wall-clock starts at right time
      playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
      pauseOffsetRef.current = 0
      setPaused(false)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, 0, true))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  // Confetti celebration on join
  useEffect(() => {
    if (inRoom) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.1, x: 0.8 },
        colors: ['#22c55e', '#ffffff', '#10b981'],
        zIndex: 9999
      })
    }
  }, [inRoom])

  // ── HOST: guest-joined → pause + send state to that guest ─────────────────
  useEffect(() => {
    if (!inRoom || !isHost) return
    return subscribe((msg) => {
      if (msg.t !== 'guest-joined') return
      const offset = getOffset()
      pauseOffsetRef.current = offset
      playStartRef.current = null
      setPaused(true)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, offset, false))
      sendState({
        path: `/watch/${type}/${id}`,
        type, id,
        season: seasonRef.current,
        episode: episodeRef.current,
        offset,
        playing: false,
        sentAt: Date.now(),
      }, msg.peerId)
    })
  }, [inRoom, isHost, subscribe, getOffset, buildSrc, sendState, type, id])

  // ── GUEST: receive sync-state once, show "Preparing" ─────────────────────
  const guestInitRef = useRef(false)
  useEffect(() => {
    if (!inRoom || isHost) return
    guestInitRef.current = false
    setPreparing(true)

    const unsub = subscribe((msg) => {
      if (msg.t !== 'sync-state' || guestInitRef.current) return
      guestInitRef.current = true
      const latency = Math.min((Date.now() - (msg.sentAt || Date.now())) / 1000, 5)
      const at = Math.max(0, (msg.offset || 0) + latency)
      setSeason(msg.season ?? 1)
      setEpisode(msg.episode ?? 1)
      pauseOffsetRef.current = at
      playStartRef.current = null
      setTimeout(() => {
        setIframeSrc(buildSrc(msg.season ?? 1, msg.episode ?? 1, at, false))
        setPaused(true)
        setPreparing(false)
        flashSynced()
      }, 400)
    })

    const t = setTimeout(() => requestState(), 100)
    return () => { unsub(); clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom, isHost])

  // ── BOTH: react to play / pause / episode messages from peers ────────────
  useEffect(() => {
    if (!inRoom) return
    return subscribe((msg) => {
      if (msg.t === 'play') {
        const latency = (Date.now() - (msg.sentAt || Date.now())) / 1000
        const at = Math.max(0, (msg.offset || 0) + latency)
        const s = msg.season ?? seasonRef.current
        const ep = msg.episode ?? episodeRef.current
        pauseOffsetRef.current = at
        playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
        setSeason(s); setEpisode(ep)
        setPaused(false)
        setIframeSrc(buildSrc(s, ep, at, true))
      }
      if (msg.t === 'pause') {
        const at = msg.offset ?? 0
        pauseOffsetRef.current = at
        playStartRef.current = null
        setPaused(true)
        setIframeSrc(buildSrc(
          msg.season ?? seasonRef.current,
          msg.episode ?? episodeRef.current,
          at, false,
        ))
      }
      if (msg.t === 'episode') {
        setSeason(msg.season); setEpisode(msg.episode)
        pauseOffsetRef.current = 0
        playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
        setPaused(false)
        setIframeSrc(buildSrc(msg.season, msg.episode, 0, true))
      }
    })
  }, [inRoom, subscribe, buildSrc, setSeason, setEpisode])

  // ── Toggle play/pause ─────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    if (paused) {
      const at = pauseOffsetRef.current
      playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
      setPaused(false)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, at, true))
      if (inRoom) send({ t: 'play', offset: at, season: seasonRef.current, episode: episodeRef.current, sentAt: Date.now() })
    } else {
      const at = getOffset()
      pauseOffsetRef.current = at
      playStartRef.current = null
      setPaused(true)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, at, false))
      if (inRoom) send({ t: 'pause', offset: at, season: seasonRef.current, episode: episodeRef.current, sentAt: Date.now() })
    }
  }, [paused, inRoom, send, getOffset, buildSrc])

  // ── Episode/Season change ─────────────────────────────────────────────────
  const changeEpisode = useCallback((newSeason, newEpisode) => {
    if (inRoom && !isHost) return
    setSeason(newSeason); setEpisode(newEpisode)
    pauseOffsetRef.current = 0
    playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
    setPaused(false)
    setEpOpen(false)
    setIframeSrc(buildSrc(newSeason, newEpisode, 0, true))
    if (inRoom) send({ t: 'episode', season: newSeason, episode: newEpisode, sentAt: Date.now() })
  }, [inRoom, isHost, send, buildSrc, setSeason, setEpisode])

  const copyCode = useCallback(() => {
    navigator.clipboard?.writeText(roomCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [roomCode])

  // ── Render ────────────────────────────────────────────────────────────────
  const title = info?.title || info?.name || ''
  const seasons = (info?.seasons || []).filter((s) => s.season_number > 0)
  const canControl = !inRoom || isHost
  const currentEp = episodes.find((e) => e.episode_number === episode)

  return (
    <div
      className="watch"
      ref={stageRef}
      onMouseMove={scheduleHide}
      onMouseLeave={() => !paused && !preparing && !navPinned && setOverlayVisible(false)}
      onTouchStart={scheduleHide}
    >
      {/* Iframe fills entire viewport */}
      {iframeSrc && (
        <iframe
          src={iframeSrc}
          title={title}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          referrerPolicy="origin"
          className="watch-iframe"
        />
      )}

      {/* Guest "Preparing" overlay */}
      {preparing && (
        <div className="sync-overlay">
          <div className="sync-spinner" />
          <p className="sync-label">Preparing your room…</p>
          <p className="sync-sub">Waiting for host's playback position</p>
        </div>
      )}

      {/* Centered click-overlay — clicking toggles play/pause */}
      {iframeSrc && !preparing && inRoom && (
        <div className="click-overlay" onClick={togglePlay} />
      )}

      {/* Thin transparent strip at very top — catches hover when iframe steals events */}
      <div
        className="nav-hover-strip"
        onMouseEnter={keepVisible}
        onMouseMove={scheduleHide}
      />

      {/* Auto-hide nav overlay */}
      <nav className={`watch-nav${overlayVisible ? ' visible' : ''}`}>

        {/* Far left: Back */}
        <button className="nav-btn" onClick={() => navigate('/')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        {/* Centre (absolute): Sync status — click to play/pause */}
        {inRoom && (
          <button
            className={`sync-status-btn${paused ? ' sync-paused' : ' sync-playing'}`}
            onClick={iframeSrc ? togglePlay : undefined}
            title={paused ? 'Paused — click to play' : 'Playing — click to pause'}
          >
            <span className="sync-dot" />
            {paused ? 'Sync' : 'Synced'}
          </button>
        )}

        {/* Far right: Episodes + Room UI + Fullscreen */}
        <div className="nav-right">

          {/* TV episode picker */}
          {type === 'tv' && seasons.length > 0 && (
            <div className="ep-wrap">
              <button
                className="nav-btn ep-trigger"
                onClick={() => setEpOpen((o) => !o)}
                disabled={!canControl}
                title="Episodes"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
                {currentEp ? `S${season} · E${episode}` : `Season ${season}`}
                <svg className={`caret${epOpen ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {epOpen && (
                <div className="ep-dropdown">
                  <div className="ep-season-row">
                    {seasons.map((s) => (
                      <button
                        key={s.id}
                        className={`ep-season-btn${s.season_number === season ? ' active' : ''}`}
                        onClick={() => setSeason(s.season_number)}
                      >
                        S{s.season_number}
                      </button>
                    ))}
                  </div>
                  <div className="ep-list">
                    {episodes.map((ep) => (
                      <button
                        key={ep.id}
                        className={`ep-item${ep.episode_number === episode ? ' active' : ''}`}
                        onClick={() => changeEpisode(season, ep.episode_number)}
                      >
                        <span className="ep-num">E{ep.episode_number}</span>
                        <span className="ep-name">{ep.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Room UI */}
          {inRoom ? (
            <div className="room-pill-nav joined-success">
              <span className={`dot dot-${status}`} />
              <button className="code-chip" onClick={copyCode} title="Copy room code">
                {roomCode}&nbsp;{copied ? '✓' : '⧉'}
              </button>
              <span className="members-badge">{members} watching</span>
              <span className="role-badge">{isHost ? 'host' : 'guest'}</span>
              <button className="nav-btn leave-btn" onClick={leaveRoom}>Leave</button>
            </div>
          ) : (
            <div className="room-join-nav">
              <button className={`nav-btn${roomOpen ? ' active' : ''}`} onClick={() => setRoomOpen(!roomOpen)}>
                Watch Together {roomOpen ? '✕' : ''}
              </button>
              <div className={`room-join-expand${roomOpen ? ' open' : ''}`}>
                <div className="room-join-inner">
                  <button className="nav-btn" onClick={createRoom}>Create Room</button>
                  <input
                    className="room-input-nav"
                    placeholder="code"
                    value={roomCodeInput}
                    maxLength={6}
                    onChange={(e) => setRoomCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && joinRoom(roomCodeInput)}
                  />
                  <button className="nav-btn" onClick={() => joinRoom(roomCodeInput)}>Join</button>
                </div>
              </div>
            </div>
          )}

          {/* Fullscreen */}
          <button
            className="nav-btn nav-icon"
            onClick={() => stageRef.current?.requestFullscreen?.()}
            title="Fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>

          {/* Pin Nav */}
          <button
            className={`nav-btn nav-icon${navPinned ? ' active' : ''}`}
            onClick={() => setNavPinned(p => !p)}
            title={navPinned ? "Unpin navbar" : "Pin navbar"}
          >
            {navPinned ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="2" x2="22" y2="22"></line>
                <path d="M12 17v5"></path>
                <path d="M5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v3.76a2 2 0 0 1-.53 1.34z"></path>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5"/>
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
              </svg>
            )}
          </button>
        </div>
      </nav>



      {error && <p className="watch-error">{error}</p>}
    </div>
  )
}
