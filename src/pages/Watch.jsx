import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { details, seasonEpisodes } from '../lib/tmdb.js'
import { movieEmbed, tvEmbed } from '../lib/vidapi.js'
import { useSync } from '../sync/SyncContext.js'
import confetti from 'canvas-confetti'
import './Watch.css'

// How long (ms) after last mouse movement before the overlay hides
const HIDE_DELAY = 3000
// Seconds to add to wall-clock offset to account for iframe load/buffer lag
const LOAD_BUFFER_S = 3
const ECHO_SUPPRESS_MS = 1200
const ECHO_PENDING_MS = 10000

export default function Watch() {
  const { type, id } = useParams()
  const navigate = useNavigate()
  const {
    inRoom, isHost, roomCode, members, status,
    createRoom, joinRoom, leaveRoom, recentRooms, forgetRecentRoom,
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
  const pausedRef = useRef(false)
  const [preparing, setPreparing] = useState(false)

  // Overlay auto-hide
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [navPinned, setNavPinned] = useState(false)
  const hideTimerRef = useRef(null)

  // Room join UI (when not yet in a room)
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
  const vidTimeRef = useRef(0)       // latest exact time from iframe (if available)
  const lastVidEventAtRef = useRef(null)
  const suppressBroadcastUntilRef = useRef(0)
  const pendingEchoRef = useRef(null)

  const getOffset = useCallback(() => {
    if (playStartRef.current == null) return vidTimeRef.current || pauseOffsetRef.current
    if (vidTimeRef.current > 0 && lastVidEventAtRef.current != null) {
      return Math.max(0, vidTimeRef.current + (Date.now() - lastVidEventAtRef.current) / 1000)
    }
    return Math.max(0, pauseOffsetRef.current + (Date.now() - playStartRef.current) / 1000)
  }, [])

  const buildSrc = useCallback((s, ep, at, autoplay, useStartAt = false, syncToken) => {
    const opts = { autoplay }
    if (useStartAt) opts.startAt = Math.max(0, Math.floor(at))
    if (syncToken) opts.syncToken = syncToken
    return type === 'tv' ? tvEmbed(id, s, ep, opts) : movieEmbed(id, opts)
  }, [type, id])

  const buildSyncState = useCallback((overrides = {}) => {
    const playing = !pausedRef.current
    return {
      path: `/watch/${type}/${id}`,
      type,
      id,
      season: seasonRef.current,
      episode: episodeRef.current,
      offset: getOffset(),
      playing,
      ...overrides,
    }
  }, [type, id, getOffset])

  const shouldSuppressPlayerEcho = useCallback((eventType, currentTime) => {
    const pending = pendingEchoRef.current
    if (!pending) return false

    if (Date.now() > pending.until) {
      pendingEchoRef.current = null
      return false
    }

    const expectedPrimary = pending.playing ? 'play' : 'pause'
    const closeToTarget = Math.abs(currentTime - pending.offset) <= Math.max(4, LOAD_BUFFER_S + 3)
    const shouldSuppress = eventType === expectedPrimary || (eventType === 'seeked' && closeToTarget)

    if (eventType === expectedPrimary) {
      pendingEchoRef.current = null
    }

    return shouldSuppress
  }, [])

  const applyPlaybackCommand = useCallback((msg, { addLatency = true, suppressEcho = true } = {}) => {
    const s = msg.season ?? seasonRef.current
    const ep = msg.episode ?? episodeRef.current
    const playing = Boolean(msg.playing)
    const latency = addLatency && playing
      ? Math.min((Date.now() - (msg.sentAt || Date.now())) / 1000, 5)
      : 0
    const at = Math.max(0, (msg.offset || 0) + latency)

    if (suppressEcho) {
      const now = Date.now()
      suppressBroadcastUntilRef.current = now + ECHO_SUPPRESS_MS
      pendingEchoRef.current = { offset: at, playing, until: now + ECHO_PENDING_MS }
    }

    setSeason(s)
    setEpisode(ep)
    vidTimeRef.current = at
    lastVidEventAtRef.current = null
    pauseOffsetRef.current = at
    playStartRef.current = playing ? Date.now() + LOAD_BUFFER_S * 1000 : null
    pausedRef.current = !playing
    setPaused(!playing)
    setIframeSrc(buildSrc(s, ep, at, playing, true, `${Date.now()}-${Math.round(at)}`))
  }, [buildSrc, setSeason, setEpisode])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

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

  // Broadcast Vidlink player actions from whichever peer caused them.
  useEffect(() => {
    const handleMessage = (e) => {
      if (e.origin !== 'https://vidlink.pro') return
      if (e.data?.type === 'PLAYER_EVENT') {
        const { event: eventType, currentTime } = e.data.data
        if (typeof currentTime === 'number') {
          vidTimeRef.current = currentTime
          lastVidEventAtRef.current = Date.now()

          if (eventType === 'play') {
            pausedRef.current = false
            setPaused(false)
            playStartRef.current = Date.now()
            pauseOffsetRef.current = currentTime
          } else if (eventType === 'pause') {
            pausedRef.current = true
            setPaused(true)
            playStartRef.current = null
            pauseOffsetRef.current = currentTime
          } else if (eventType === 'seeked') {
            pauseOffsetRef.current = currentTime
            if (!pausedRef.current) {
              playStartRef.current = Date.now()
            }
          }

          if (!inRoom || Date.now() < suppressBroadcastUntilRef.current || shouldSuppressPlayerEcho(eventType, currentTime)) return
          if (eventType !== 'play' && eventType !== 'pause' && eventType !== 'seeked') return

          const playing = eventType === 'play'
            ? true
            : eventType === 'pause'
              ? false
              : !pausedRef.current

          const msg = {
            t: 'playback',
            action: eventType,
            offset: currentTime,
            season: seasonRef.current,
            episode: episodeRef.current,
            playing,
            sentAt: Date.now(),
          }

          send(msg)

          if (isHost) {
            sendState(buildSyncState({ offset: currentTime, playing }), 'LOCAL_ONLY')
          }
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [isHost, inRoom, send, sendState, buildSyncState, shouldSuppressPlayerEcho])

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
      // Host in a room: let Vidlink load normally, then mirror events to guests.
      playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
      pauseOffsetRef.current = 0
      lastVidEventAtRef.current = null
      pausedRef.current = false
      setPaused(false)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, 0, true))
      sendState(buildSyncState({ offset: 0, playing: true }))
    } else {
      // Solo: autoplay, add buffer offset so wall-clock starts at right time
      playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
      pauseOffsetRef.current = 0
      lastVidEventAtRef.current = null
      pausedRef.current = false
      setPaused(false)
      setIframeSrc(buildSrc(seasonRef.current, episodeRef.current, 0, true))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  useEffect(() => {
    if (!info || !inRoom || !isHost) return
    sendState(buildSyncState(), 'LOCAL_ONLY')
  }, [info, inRoom, isHost, sendState, buildSyncState])

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

  // ── HOST: guest-joined/request-state → send state to that guest ───────────
  useEffect(() => {
    if (!inRoom || !isHost) return
    return subscribe((msg) => {
      if (msg.t !== 'guest-joined' && msg.t !== 'request-state') return
      const offset = getOffset()
      sendState(buildSyncState({
        offset,
        playing: !pausedRef.current,
      }), msg.peerId)
    })
  }, [inRoom, isHost, subscribe, getOffset, sendState, buildSyncState])

  // Periodically update hostStateRef so guests who join mid-stream get the right state
  useEffect(() => {
    if (!isHost || !inRoom) return
    const int = setInterval(() => {
      sendState(buildSyncState({
        offset: getOffset(),
        playing: !pausedRef.current,
      }), 'LOCAL_ONLY')
    }, 5000)
    return () => clearInterval(int)
  }, [isHost, inRoom, getOffset, sendState, buildSyncState])

  // ── GUEST: receive sync-state once, show "Preparing" ─────────────────────
  const guestInitRef = useRef(false)
  useEffect(() => {
    if (!inRoom || isHost) return
    guestInitRef.current = false
    setPreparing(true)
    setError(null)

    let retryTimer
    let timeoutTimer

    const unsub = subscribe((msg) => {
      if (msg.t !== 'sync-state' || guestInitRef.current) return
      guestInitRef.current = true
      clearInterval(retryTimer)
      clearTimeout(timeoutTimer)
      const latency = Math.min((Date.now() - (msg.sentAt || Date.now())) / 1000, 5)
      const at = Math.max(0, (msg.offset || 0) + latency)
      const shouldPlay = Boolean(msg.playing)
      setSeason(msg.season ?? 1)
      setEpisode(msg.episode ?? 1)
      pauseOffsetRef.current = at
      playStartRef.current = shouldPlay ? Date.now() + LOAD_BUFFER_S * 1000 : null
      setTimeout(() => {
        applyPlaybackCommand({
          ...msg,
          offset: at,
          playing: shouldPlay,
        }, { addLatency: false, suppressEcho: true })
        setPreparing(false)
      }, 400)
    })

    const askForState = () => {
      if (!guestInitRef.current) requestState()
    }

    const initialTimer = setTimeout(askForState, 100)
    retryTimer = setInterval(askForState, 1000)
    timeoutTimer = setTimeout(() => {
      if (guestInitRef.current) return
      setPreparing(false)
      setError('Could not get the host playback state. Ask the host to stay on the watch page, then try rejoining the room.')
    }, 15000)

    return () => {
      unsub()
      clearTimeout(initialTimer)
      clearInterval(retryTimer)
      clearTimeout(timeoutTimer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom, isHost, applyPlaybackCommand])

  // ── BOTH: react to playback / episode messages from peers ────────────────
  useEffect(() => {
    if (!inRoom) return
    return subscribe((msg) => {
      if (msg.t === 'playback') {
        applyPlaybackCommand(msg)
        if (isHost) {
          sendState(buildSyncState({
            season: msg.season ?? seasonRef.current,
            episode: msg.episode ?? episodeRef.current,
            offset: msg.offset ?? 0,
            playing: Boolean(msg.playing),
          }), 'LOCAL_ONLY')
        }
      }
      if (msg.t === 'play' || msg.t === 'pause') {
        const playing = msg.t === 'play'
        applyPlaybackCommand({ ...msg, t: 'playback', playing })
      }
      if (msg.t === 'episode') {
        setSeason(msg.season); setEpisode(msg.episode)
        pauseOffsetRef.current = 0
        playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
        lastVidEventAtRef.current = null
        pausedRef.current = false
        setPaused(false)
        setIframeSrc(buildSrc(msg.season, msg.episode, 0, true))
        if (isHost) {
          sendState(buildSyncState({
            season: msg.season,
            episode: msg.episode,
            offset: 0,
            playing: true,
          }), 'LOCAL_ONLY')
        }
      }
    })
  }, [inRoom, isHost, subscribe, buildSrc, setSeason, setEpisode, sendState, buildSyncState, applyPlaybackCommand])

  const togglePlay = useCallback(() => {
    const offset = getOffset()
    const playing = paused
    const msg = {
      t: 'playback',
      action: playing ? 'play' : 'pause',
      offset,
      season: seasonRef.current,
      episode: episodeRef.current,
      playing,
      sentAt: Date.now(),
    }

    applyPlaybackCommand(msg, { addLatency: false, suppressEcho: true })

    if (inRoom) send(msg)
    if (inRoom && isHost) sendState(buildSyncState({ offset, playing }), 'LOCAL_ONLY')
  }, [paused, inRoom, isHost, send, sendState, getOffset, buildSyncState, applyPlaybackCommand])

  // ── Episode/Season change ─────────────────────────────────────────────────
  const changeEpisode = useCallback((newSeason, newEpisode) => {
    if (inRoom && !isHost) return
    setSeason(newSeason); setEpisode(newEpisode)
    pauseOffsetRef.current = 0
    playStartRef.current = Date.now() + LOAD_BUFFER_S * 1000
    lastVidEventAtRef.current = null
    pausedRef.current = false
    setPaused(false)
    setEpOpen(false)
    setIframeSrc(buildSrc(newSeason, newEpisode, 0, true))
    if (inRoom) send({ t: 'episode', season: newSeason, episode: newEpisode, sentAt: Date.now() })
    if (inRoom && isHost) {
      sendState(buildSyncState({
        season: newSeason,
        episode: newEpisode,
        offset: 0,
        playing: true,
      }), 'LOCAL_ONLY')
    }
  }, [inRoom, isHost, send, sendState, buildSrc, buildSyncState, setSeason, setEpisode])

  const copyCode = useCallback(() => {
    navigator.clipboard?.writeText(roomCode).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [roomCode])

  // ── Render ────────────────────────────────────────────────────────────────
  const title = info?.title || info?.name || ''
  const seasons = (info?.seasons || []).filter((s) => s.season_number > 0)
  const canControl = !inRoom || isHost
  const currentEp = episodes.find((e) => e.episode_number === episode)
  const visibleRecentRooms = recentRooms.filter((room) => room.code !== roomCode).slice(0, 3)
  const showShareCode = isHost && members <= 1

  useEffect(() => {
    if (!showShareCode || !roomCode) {
      setCopied(false)
      return
    }

    navigator.clipboard?.writeText(roomCode).catch(() => {})
    setCopied(true)
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [showShareCode, roomCode])

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

      {/* Thin transparent strip at very top — catches hover when iframe steals events */}
      <div
        className="nav-hover-strip"
        onMouseEnter={keepVisible}
        onMouseMove={scheduleHide}
      />

      {/* Auto-hide nav overlay */}
      <nav className={`watch-nav${overlayVisible ? ' visible' : ''}`}>

        {/* Far left: Back */}
        <button className="nav-btn" onClick={() => {
          if (inRoom && isHost) send({ t: 'navigate', path: '/' })
          navigate('/')
        }}>
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
            <div className="room-pill-nav compact-room" title={`Room ${roomCode}`}>
              <span className={`dot dot-${status}`} />
              {showShareCode && (
                <button className="code-chip compact-code" onClick={copyCode} title="Copy room code">
                  {roomCode}{copied ? ' ✓' : ''}
                </button>
              )}
              <span className="members-badge">{members} in room</span>
              <button className="nav-btn leave-btn room-exit-btn" onClick={leaveRoom} title="Leave room">×</button>
            </div>
          ) : (
            <div className="room-join-stack">
              <div className="room-join-nav">
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
              {visibleRecentRooms.length > 0 && (
                <div className="recent-room-nav" aria-label="Recent rooms">
                  {visibleRecentRooms.map((room) => (
                    <span className="recent-room-chip" key={room.code}>
                      <button type="button" onClick={() => joinRoom(room.code)} title={`Join ${room.code}`}>
                        {room.code}
                      </button>
                      <button type="button" className="recent-room-remove" onClick={() => forgetRecentRoom(room.code)} title="Forget room">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
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
