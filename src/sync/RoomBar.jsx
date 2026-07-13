import { useState } from 'react'
import { useSync } from './SyncProvider.jsx'
import './RoomBar.css'

export default function RoomBar() {
  const { inRoom, roomCode, isHost, members, status, createRoom, joinRoom, leaveRoom } = useSync()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard?.writeText(roomCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (inRoom) {
    return (
      <div className="roombar">
        <div className="room-pill">
          <span className={`dot ${status}`} />
          <button className="code-chip" onClick={copy} title="Copy code">
            {roomCode} {copied ? '✓' : '⧉'}
          </button>
          <span className="members">{members} watching</span>
          <span className="role">{isHost ? 'host' : 'guest'}</span>
          <button className="leave" onClick={leaveRoom}>Leave</button>
        </div>
      </div>
    )
  }

  return (
    <div className="roombar">
      {!open ? (
        <button className="room-open" onClick={() => setOpen(true)}>Watch together</button>
      ) : (
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
          <button className="leave" onClick={() => setOpen(false)}>✕</button>
        </div>
      )}
    </div>
  )
}
