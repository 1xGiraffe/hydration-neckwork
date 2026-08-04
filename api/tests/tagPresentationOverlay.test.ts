import { describe, it, expect } from 'vitest'
import { withTagPresentation } from '../src/services/explorerService.ts'
import type { TagDetail } from '../src/services/explorerService.ts'

// A tag's name, colour, icon and note are canonical in CODE — there is no edit
// API — but the tag detail page can be served from a multi-megabyte ClickHouse
// snapshot whose payload was serialized with whatever presentation was current
// when it was computed. Its key is (tag_id, membership_key), so editing only the
// presentation does not change the key and the stale payload keeps being served
// until membership happens to change.
//
// Observed: correcting the bil-originator note reached the table and the
// in-memory record (the ?summary=1 path returned the new text immediately), yet
// the detail page still served a note computed 2 hours earlier. That is the
// failure reconcileTagPresentation exists to prevent, one layer further out.
//
// Presentation is display-only — everything else in the payload derives from the
// member set — so the fix is to stamp the current presentation over whatever the
// snapshot carried, rather than to invalidate a snapshot that is otherwise valid.
const CURRENT = { tagId: 'bil-originator', name: 'Decentral (BIL)', color: '#009739', icon: 'bil.svg', note: 'the uBIL issuance contract' }

const snapshot = (over: Partial<TagDetail> = {}) => ({
  tagId: 'bil-originator',
  name: 'Decentral (BIL)',
  color: '#009739',
  icon: 'bil.svg',
  note: 'the forwarder that sweeps them',
  members: [{ accountId: '0x01' }],
  totalValueUsd: 1234,
  ...over,
}) as unknown as TagDetail

describe('serving a tag detail snapshot', () => {
  it('replaces a stale note with the current one', () => {
    expect(withTagPresentation(snapshot(), CURRENT).note).toBe('the uBIL issuance contract')
  })

  it('replaces a stale name, colour and icon too', () => {
    const stale = snapshot({ name: 'Old Name', color: '#000000', icon: 'old.svg' } as Partial<TagDetail>)

    const served = withTagPresentation(stale, CURRENT)

    expect(served.name).toBe('Decentral (BIL)')
    expect(served.color).toBe('#009739')
    expect(served.icon).toBe('bil.svg')
  })

  it('keeps every derived field the snapshot exists to cache', () => {
    const served = withTagPresentation(snapshot(), CURRENT) as unknown as Record<string, unknown>

    expect(served.members).toEqual([{ accountId: '0x01' }])
    expect(served.totalValueUsd).toBe(1234)
  })

  it('does not mutate the snapshot object it was handed', () => {
    const stale = snapshot()

    withTagPresentation(stale, CURRENT)

    expect((stale as unknown as { note: string }).note).toBe('the forwarder that sweeps them')
  })
})
