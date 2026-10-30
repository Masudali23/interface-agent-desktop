import { createContext, useContext } from 'react'
import type { Member } from '@shared/types'

/** Room facts every transcript row needs. Kept apart from the room object, which changes
 *  on every streamed token, so unchanged rows can skip rendering. */
export interface TranscriptEnv {
  roomId: string
  folder: string
  members: Member[]
  maxHops: number
  team: boolean
}

export const TranscriptContext = createContext<TranscriptEnv>({ roomId: '', folder: '', members: [], maxHops: 0, team: false })

export function useTranscript(): TranscriptEnv {
  return useContext(TranscriptContext)
}
