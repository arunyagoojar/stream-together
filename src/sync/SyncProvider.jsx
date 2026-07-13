import { useCallback, useEffect, useRef, useState } from 'react'
import Peer from 'peerjs'
import { SyncContext } from './SyncContext.js'

const PREFIX = 'streamtog-'
const RECENT_ROOMS_KEY = 'streamTogetherRecentRooms'
const ACTIVE_ROOM_KEY = 'streamTogetherActiveRoom'
const makeCode = () => Math.random().toString(36).slice(2, 8)

const cleanCode = (code) => (typeof code === 'string' ? code.trim().toLowerCase() : '')

function loadRecentRooms() {
  try {
    const raw = localStorage.getItem(RECENT_ROOMS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function loadActiveRoom() {
  try {
    const raw = localStorage.getItem(ACTIVE_ROOM_KEY)
    const active = raw ? JSON.parse(raw) : null
    const code = cleanCode(active?.code)
    if (!code || (active.role !== 'host' && active.role !== 'guest')) return null
    return { code, role: active.role }
  } catch {
    return null
  }
}

function saveActiveRoom(code, role) {
  const clean = cleanCode(code)
  if (!clean) return
  localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({
    code: clean,
    role,
    savedAt: Date.now(),
  }))
}

function clearActiveRoom() {
  localStorage.removeItem(ACTIVE_ROOM_KEY)
}

export function SyncProvider({ children }) {
  const peerRef = useRef(null)
  const connsRef = useRef(new Map())
  const handlersRef = useRef(new Set())
  const hostStateRef = useRef(null)       // host's latest state snapshot
  const lastSyncStateRef = useRef(null)   // guest: last sync-state received (survives navigation)
  const restoreAttemptedRef = useRef(false)
  const [roomCode, setRoomCode] = useState(null)
  const [isHost, setIsHost] = useState(false)
  const [members, setMembers] = useState(0)
  const [status, setStatus] = useState('idle')
  const [selfId, setSelfId] = useState(null)
  const [recentRooms, setRecentRooms] = useState(loadRecentRooms)

  const emitLocal = useCallback((msg) => {
    handlersRef.current.forEach((h) => h(msg))
  }, [])

  const rememberRoom = useCallback((code, role) => {
    if (!code) return
    const clean = cleanCode(code)
    if (!clean) return
    setRecentRooms((rooms) => {
      const next = [
        { code: clean, role, lastConnectedAt: Date.now() },
        ...rooms.filter((room) => room.code !== clean),
      ].slice(0, 5)
      localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const forgetRecentRoom = useCallback((code) => {
    setRecentRooms((rooms) => {
      const next = rooms.filter((room) => room.code !== code)
      localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const refreshMembers = useCallback(() => {
    setMembers(connsRef.current.size + 1)
  }, [])

  const wireConn = useCallback(
    (conn, asHost) => {
      conn.on('open', () => {
        connsRef.current.set(conn.peer, conn)
        refreshMembers()
        setStatus('connected')
        if (asHost) {
          // Notify host's own Watch page that a guest just connected
          emitLocal({ t: 'guest-joined', peerId: conn.peer })
        } else {
          if (conn.peer?.startsWith(PREFIX)) {
            const code = conn.peer.slice(PREFIX.length)
            rememberRoom(code, 'guest')
            saveActiveRoom(code, 'guest')
          }
          conn.send({ t: 'request-state' })
        }
      })
      conn.on('data', (msg) => {
        // Host: handle request-state from guest
        if (asHost && msg.t === 'request-state') {
          const peerId = msg.from || conn.peer
          const state = hostStateRef.current
          if (state) {
            const reply = { ...state, t: 'sync-state', sentAt: Date.now() }
            const conn2 = connsRef.current.get(peerId)
            if (conn2?.open) conn2.send(reply)
          } else {
            emitLocal({ t: 'request-state', peerId })
          }
          return // don't relay request-state to others
        }

        // Store sync-state for guest (survives re-mounts)
        if (!asHost && msg.t === 'sync-state') {
          lastSyncStateRef.current = msg
        }

        emitLocal(msg)

        if (asHost) {
          // Relay to all other peers
          connsRef.current.forEach((c, pid) => {
            if (pid !== conn.peer && c.open) c.send(msg)
          })
        }
      })
      const drop = () => {
        connsRef.current.delete(conn.peer)
        refreshMembers()
      }
      conn.on('close', drop)
      conn.on('error', drop)
    },
    [emitLocal, refreshMembers, rememberRoom],
  )

  const createRoom = useCallback((preferredCode) => {
    const code = cleanCode(preferredCode) || makeCode()
    const peer = new Peer(PREFIX + code)
    peerRef.current = peer
    setStatus('connecting')
    peer.on('open', (id) => {
      setSelfId(id)
      setRoomCode(code)
      setIsHost(true)
      setStatus('connected')
      rememberRoom(code, 'host')
      saveActiveRoom(code, 'host')
      refreshMembers()
    })
    peer.on('connection', (conn) => wireConn(conn, true))
    peer.on('error', (e) => { console.error('peer error', e); setStatus('error') })
    return code
  }, [wireConn, refreshMembers, rememberRoom])

  const joinRoom = useCallback((code) => {
    const clean = cleanCode(code)
    if (!clean) return
    const peer = new Peer()
    peerRef.current = peer
    setStatus('connecting')
    peer.on('open', (id) => {
      setSelfId(id)
      const conn = peer.connect(PREFIX + clean, { reliable: true })
      wireConn(conn, false)
      setRoomCode(clean)
      setIsHost(false)
      lastSyncStateRef.current = null // reset on new join
    })
    peer.on('error', (e) => {
      console.error('peer error', e)
      if (e?.type === 'peer-unavailable' || String(e?.message || '').includes('Could not connect to peer')) {
        clearActiveRoom()
      }
      setStatus('error')
    })
  }, [wireConn])

  const leaveRoom = useCallback(() => {
    connsRef.current.forEach((c) => c.close())
    connsRef.current.clear()
    peerRef.current?.destroy()
    peerRef.current = null
    setRoomCode(null)
    setIsHost(false)
    setMembers(0)
    setStatus('idle')
    setSelfId(null)
    hostStateRef.current = null
    lastSyncStateRef.current = null
    clearActiveRoom()
  }, [])

  const send = useCallback((msg) => {
    const full = { ...msg, from: selfId }
    connsRef.current.forEach((c) => { if (c.open) c.send(full) })
    return full
  }, [selfId])

  // Host: update snapshot and send to a specific peer (or all)
  const sendState = useCallback((state, peerId) => {
    const nextState = { ...(hostStateRef.current || {}), ...state }
    hostStateRef.current = nextState
    const msg = { ...nextState, t: 'sync-state', sentAt: Date.now() }
    if (peerId === 'LOCAL_ONLY') return msg
    if (peerId) {
      const conn = connsRef.current.get(peerId)
      if (conn?.open) conn.send(msg)
    } else {
      connsRef.current.forEach((c) => { if (c.open) c.send(msg) })
    }
  }, [])

  // Guest: request state from host (used when Watch mounts and state already passed)
  const requestState = useCallback(() => {
    // If we already have a cached state, emit it locally immediately
    if (lastSyncStateRef.current) {
      // Re-emit so Watch.jsx subscription catches it
      handlersRef.current.forEach((h) => h(lastSyncStateRef.current))
      return
    }
    // Otherwise ask the host
    const msg = { t: 'request-state', from: selfId }
    connsRef.current.forEach((c) => { if (c.open) c.send(msg) })
  }, [selfId])

  const subscribe = useCallback((handler) => {
    handlersRef.current.add(handler)
    return () => handlersRef.current.delete(handler)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (restoreAttemptedRef.current || peerRef.current || roomCode) return
      const active = loadActiveRoom()
      if (!active) return

      restoreAttemptedRef.current = true
      if (active.role === 'host') createRoom(active.code)
      else joinRoom(active.code)
    }, 500)

    return () => clearTimeout(timer)
  }, [createRoom, joinRoom, roomCode])

  useEffect(() => () => peerRef.current?.destroy(), [])

  const value = {
    roomCode, isHost, members, status, selfId,
    inRoom: Boolean(roomCode),
    recentRooms,
    createRoom, joinRoom, leaveRoom,
    forgetRecentRoom,
    send, sendState, requestState, subscribe,
  }
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
