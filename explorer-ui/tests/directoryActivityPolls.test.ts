import { describe, it, expect } from 'vitest'
import { countDirectoryActivityPoll, directoryActivityPollsSpent, resetDirectoryActivityPolls } from '../src/hooks/useExplorerData'

// The directory's activity-count polling must stop after 40 asks per row set. The
// counter once re-read itself after deleting its own entry, so every ask counted as
// the first and polling never stopped.
describe('directory activity poll budget', () => {
  it('counts every ask and is spent at the 40th', () => {
    const key = 'poll-budget-a'
    for (let i = 1; i <= 39; i++) {
      expect(countDirectoryActivityPoll(key)).toBe(i)
      expect(directoryActivityPollsSpent(key)).toBe(false)
    }
    expect(countDirectoryActivityPoll(key)).toBe(40)
    expect(directoryActivityPollsSpent(key)).toBe(true)
  })

  it('keeps counting per row set while other sets are asked in between', () => {
    const a = 'poll-budget-b', b = 'poll-budget-c'
    for (let i = 0; i < 40; i++) { countDirectoryActivityPoll(a); countDirectoryActivityPoll(b) }
    expect(directoryActivityPollsSpent(a)).toBe(true)
    expect(directoryActivityPollsSpent(b)).toBe(true)
  })

  it('a retry restarts the budget', () => {
    const key = 'poll-budget-d'
    for (let i = 0; i < 40; i++) countDirectoryActivityPoll(key)
    resetDirectoryActivityPolls(key)
    expect(directoryActivityPollsSpent(key)).toBe(false)
    expect(countDirectoryActivityPoll(key)).toBe(1)
  })
})
