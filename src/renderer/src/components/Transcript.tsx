import { useMemo, useRef } from 'react'
import type { Message, Room } from '@shared/types'
import { buildTimeline, reuseItems, type TimelineItem } from '../lib/timeline'
import { Icon } from './Icon'
import { AgentSegment, UserMessage } from './MessageView'
import { TranscriptContext, type TranscriptEnv } from './TranscriptContext'

interface Props {
  room: Room
  messages: Message[]
  /** Ids of each agent's newest reply. */
  latest: Set<string>
  roomBusy: boolean
  /** Set inside an agent panel: other agents' turns fold away behind a hand-off line. */
  paneMemberId?: string
}

/** A conversation in time order: your messages where you sent them, agents' work around them. */
export function Transcript({ room, messages, latest, roomBusy, paneMemberId }: Props) {
  const env = useMemo<TranscriptEnv>(
    () => ({ roomId: room.id, folder: room.folder, members: room.members, maxHops: room.maxHops, team: room.members.length > 1 }),
    [room.id, room.folder, room.members, room.maxHops]
  )
  const previous = useRef<TimelineItem[]>([])
  const items = useMemo(() => {
    const next = reuseItems(previous.current, buildTimeline(messages, paneMemberId))
    previous.current = next
    return next
  }, [messages, paneMemberId])

  return (
    <TranscriptContext.Provider value={env}>
      {items.map((item) => {
        if (item.kind === 'user') return <UserMessage key={item.key} message={item.message} roomBusy={roomBusy} />
        const foreign = !!paneMemberId && item.message.author !== paneMemberId
        const segment = <AgentSegment key={item.key} item={item} latestOfAuthor={latest.has(item.message.id)} roomBusy={roomBusy} showHeader={paneMemberId ? foreign : env.team} />
        if (!foreign) return segment
        const from = room.members.find((m) => m.id === item.message.author)?.name ?? item.message.authorName ?? 'another agent'
        return (
          <details key={item.key} className="tx-pane-handoff">
            <summary>
              <Icon name="arrowRight" size={13} />
              <span>
                From {from}
                <small>{item.message.handoff?.text || 'Shared an update'}</small>
              </span>
            </summary>
            {segment}
          </details>
        )
      })}
    </TranscriptContext.Provider>
  )
}
