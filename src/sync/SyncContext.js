import { createContext, useContext } from 'react'

export const SyncContext = createContext(null)
export const useSync = () => useContext(SyncContext)
