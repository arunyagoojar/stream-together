import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import Peer from 'peerjs'

const SyncContext = createContext(null)
export const useSync = () => useContext(SyncContext)

const PREFIX = 'streamtog-'
const makeCode = () => Math.random().toString(36).slice(2, 8)

export function SyncProvider({ children }) {
  const peerRef = useRef(null)
  const connsRef = useRef(new Map())
  const handlersRef = useRef(new Set())
  const hostStateRef = useRef(null)       // host's latest state snapshot
  const lastSyncStateRef = useRef(null)   // guest: last sync-state received (survives navigation)
  const [roomCode, setRoomCode] = useState(null)
  const [isHost, setIsHost] = useState(false)
  const [members, setMembers] = useState(0)
  const [status, setStatus] = useState('idle')
  const [selfId, setSelfId] = useState(null)

  const emitLocal = useCallback((msg) => {
    handlersRef.current.forEach((h) => h(msg))
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
        }
      })
      conn.on('data', (msg) => {
        // Host: handle request-state from guest
        if (asHost && msg.t === 'request-state') {
          const state = hostStateRef.current
          if (state) {
            const reply = { ...state, t: 'sync-state', sentAt: Date.now() }
            const conn2 = connsRef.current.get(msg.from)
            if (conn2?.open) conn2.send(reply)
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
    [emitLocal, refreshMembers],
  )

  const createRoom = useCallback(() => {
    const code = makeCode()
    const peer = new Peer(PREFIX + code)
    peerRef.current = peer
    setStatus('connecting')
    peer.on('open', (id) => {
      setSelfId(id)
      setRoomCode(code)
      setIsHost(true)
      setStatus('connected')
      refreshMembers()
    })
    peer.on('connection', (conn) => wireConn(conn, true))
    peer.on('error', (e) => { console.error('peer error', e); setStatus('error') })
    return code
  }, [wireConn, refreshMembers])

  const joinRoom = useCallback((code) => {
    const clean = code.trim().toLowerCase()
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
    peer.on('error', (e) => { console.error('peer error', e); setStatus('error') })
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
  }, [])

  const send = useCallback((msg) => {
    const full = { ...msg, from: selfId }
    connsRef.current.forEach((c) => { if (c.open) c.send(full) })
    return full
  }, [selfId])

  // Host: update snapshot and send to a specific peer (or all)
  const sendState = useCallback((state, peerId) => {
    hostStateRef.current = state
    const msg = { ...state, t: 'sync-state', sentAt: Date.now() }
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

  useEffect(() => () => peerRef.current?.destroy(), [])

  const value = {
    roomCode, isHost, members, status, selfId,
    inRoom: Boolean(roomCode),
    createRoom, joinRoom, leaveRoom,
    send, sendState, requestState, subscribe,
  }
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
