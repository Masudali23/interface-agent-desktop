import { describe, expect, it } from 'vitest'
import { activeMemberIds, defaultRecipients } from '../src/shared/types'

const room = (active?: string[]) => ({ members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never[], active })

describe('ticked agents', () => {
  it('means everyone when nothing is saved', () => {
    expect(activeMemberIds(room())).toEqual(['a', 'b', 'c'])
  })
  it('keeps only the ticked agents', () => {
    expect(activeMemberIds(room(['b']))).toEqual(['b'])
  })
  it('drops agents that left the session and never comes back empty', () => {
    expect(activeMemberIds(room(['gone', 'c']))).toEqual(['c'])
    expect(activeMemberIds(room(['gone']))).toEqual(['a', 'b', 'c'])
    expect(activeMemberIds(room([]))).toEqual(['a', 'b', 'c'])
  })
})

describe('default recipients', () => {
  it('preserves parallel delivery for existing rooms without a dispatch setting', () => {
    expect(defaultRecipients(room())).toEqual(['a', 'b', 'c'])
    expect(defaultRecipients(room(['b', 'c']))).toEqual(['b', 'c'])
    expect(defaultRecipients({ ...room(['b', 'c']), dispatch: 'parallel', leadId: 'b' })).toEqual(['b', 'c'])
  })

  it('sends unmentioned lead-mode messages to the selected lead only', () => {
    expect(defaultRecipients({ ...room(), dispatch: 'lead', leadId: 'b' })).toEqual(['b'])
    expect(defaultRecipients({ ...room(['a', 'c']), dispatch: 'lead', leadId: 'c' })).toEqual(['c'])
  })

  it('falls back to a participating agent when the lead is inactive or removed', () => {
    expect(defaultRecipients({ ...room(['c', 'a']), dispatch: 'lead', leadId: 'b' })).toEqual(['c'])
    expect(defaultRecipients({ ...room(['b']), dispatch: 'lead', leadId: 'removed' })).toEqual(['b'])
    expect(defaultRecipients({ ...room(), dispatch: 'lead' })).toEqual(['a'])
    expect(defaultRecipients({ members: [], dispatch: 'lead', leadId: 'removed' })).toEqual([])
  })
})
