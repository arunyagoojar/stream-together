import { useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Watch from './pages/Watch.jsx'
import RoomBar from './sync/RoomBar.jsx'
import { useSync } from './sync/SyncContext.js'

export default function App() {
  const { inRoom, isHost, subscribe } = useSync()
  const navigate = useNavigate()
  const location = useLocation()
  const isWatch = location.pathname.startsWith('/watch/')

  useEffect(() => {
    if (!inRoom || isHost) return
    return subscribe((msg) => {
      const path = msg.path
      if ((msg.t === 'navigate' || msg.t === 'sync-state') && path && path !== location.pathname) {
        navigate(path)
      }
    })
  }, [inRoom, isHost, subscribe, navigate, location.pathname])

  return (
    <>
      {/* RoomBar only shown on Home — Watch has its own inline room UI */}
      {!isWatch && <RoomBar />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/watch/:type/:id" element={<Watch />} />
      </Routes>
    </>
  )
}
