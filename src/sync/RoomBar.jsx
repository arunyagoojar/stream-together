import { useEffect, useState } from 'react'
import { useSync } from './SyncContext.js'
import './RoomBar.css'

export default function RoomBar() {
  const { inRoom, roomCode, isHost, members, status, createRoom, joinRoom, leaveRoom, recentRooms, forgetRecentRoom } = useSync()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const visibleRecentRooms = recentRooms.filter((room) => room.code !== roomCode).slice(0, 3)
  const showShareCode = isHost && members <= 1

  const copyCode = () => {
    navigator.clipboard?.writeText(roomCode).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

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

  if (inRoom) {
    return (
      <div className="roombar">
        <div className="room-pill compact-room" title={`Room ${roomCode}`}>
          <span className={`dot ${status}`} />
          {showShareCode && (
            <button className="code-chip compact-code" onClick={copyCode} title="Copy room code">
              {roomCode}{copied ? ' ✓' : ''}
            </button>
          )}
          <span className="members">{members} in room</span>
          <button className="leave room-exit" onClick={leaveRoom} title="Leave room">×</button>
        </div>
      </div>
    )
  }

  return (
    <div className="roombar">
      {!open ? (
        <button className="room-open" onClick={() => setOpen(true)}>Watch together</button>
      ) : (
        <div className="room-menu">
          <div className="room-pill">
            <button className="room-action" onClick={createRoom}>Create room</button>
            <span className="or">or</span>
            <input
              className="room-input"
              placeholder="code"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinRoom(code)}
            />
            <button className="room-action" onClick={() => joinRoom(code)}>Join</button>
            <button className="leave" onClick={() => setOpen(false)}>×</button>
          </div>
          {visibleRecentRooms.length > 0 && (
            <div className="recent-rooms">
              {visibleRecentRooms.map((room) => (
                <span className="recent-room" key={room.code}>
                  <button type="button" onClick={() => joinRoom(room.code)} title={`Join ${room.code}`}>
                    {room.code}
                  </button>
                  <button type="button" className="recent-remove" onClick={() => forgetRecentRoom(room.code)} title="Forget room">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
