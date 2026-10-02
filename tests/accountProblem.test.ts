import { describe, expect, it } from 'vitest'
import { accountProblem } from '../src/renderer/src/lib/format'

describe('accountProblem', () => {
  it('reports accounts that are not signed in', () => {
    expect(accountProblem({ loggedIn: false, limits: [], notes: [] })).toMatch(/Not signed in/)
  })

  it('reports a used-up limit with its reset time', () => {
    const resetsAt = Date.now() + (105 * 60 + 30) * 1000
    const problem = accountProblem({ loggedIn: true, limits: [{ id: 'session', label: '5-hour session', percent: 100, resetsAt }], notes: [] })
    expect(problem).toMatch(/^5-hour session limit reached, resets in 1 hr 4[56] min$/)
  })

  it('accepts usable accounts and unknown state', () => {
    expect(accountProblem({ loggedIn: true, limits: [{ id: 'weekly', label: 'Weekly', percent: 37 }], notes: [] })).toBeUndefined()
    expect(accountProblem(undefined)).toBeUndefined()
  })
})
