import type { ReactNode } from 'react'
import { dayText } from './GovUi'

// The governance terms, defined once: the page's "Terms on this page" fold
// (Disclosure.tsx GovTerms) and an ⓘ next to a term both read them from here.

export type TermKey = 'approval' | 'support' | 'confirming' | 'conviction' | 'locks' | 'tracks' | 'deposit' | 'delegation' | 'turnout'

/** The definitions, written once; `days` is the conviction ladder's lock length in days (index 0–6). */
export function termText(key: TermKey, days?: number[] | null): { dt: string; dd: ReactNode } {
  const d = days && days.length >= 7 ? days : null
  switch (key) {
    case 'approval': return { dt: 'Approval', dd: <>The share of the conviction-weighted votes that are aye: 75% means three quarters of the voting power said yes.</> }
    case 'support': return { dt: 'Support', dd: <>How much HDX voted aye (or abstain), before conviction, as a share of all HDX issued. It shows how many holders took part, not how they split.</> }
    case 'confirming': return { dt: 'Confirming', dd: <>A referendum passes when approval and support both stay above their bars for the whole confirmation period. The bars start high and fall over the decision period, so one that is short today can still pass later.</> }
    case 'conviction': return { dt: 'Conviction', dd: <>A multiplier on your vote, paid for with a longer lock after the referendum ends: 0.1× counts a tenth of your HDX and locks nothing afterwards; 1× locks it {d ? `about ${dayText(d[1])}` : 'one locking period'}, and each step up to 6× ({d ? `about ${dayText(d[6])}` : '32 periods'}) doubles the lock.</> }
    case 'locks': return { dt: 'Vote locks', dd: <>Voting locks HDX in place; it is never moved or spent, and you can still stake it. A winning vote stays locked for its conviction’s period after the referendum ends (on Hydration, the staked part stays locked either way). Then it is unlockable: remove the finished vote and unlock. Figures here come from indexed chain state; the voting screen checks them on chain before you sign.</> }
    case 'tracks': return { dt: 'Track', dd: <>The kind of change (treasury spend, economic parameters, root …). Each track has its own deposit, timings and approval and support bars.</> }
    case 'deposit': return { dt: 'Decision deposit', dd: <>HDX someone places so a referendum can be decided; without it the referendum times out. It is refunded once the referendum concludes.</> }
    case 'delegation': return { dt: 'Delegation', dd: <>An account can lend its voting power on a track to another account; the delegate’s vote then counts for both. Delegating earns no rewards on Hydration.</> }
    case 'turnout': return { dt: 'Turnout', dd: <>The accounts with a vote standing when a referendum concluded, and the HDX behind each side before conviction — the referendum page’s own count. Delegated votes are not in it; support as a share of issuance is not shown for past referenda, because active issuance is not indexed for each block.</> }
  }
}

/** How a referendum's tally chart reads: under the chart, or once in the page's Terms where the page states it there. */
export function tallyChartLegend(live: boolean): string {
  return live
    ? 'Solid: the tally so far, replayed from every vote. Dashed line: the threshold it must stay above. Dashed level: where it ends if no one else votes. The tinted area is where it would pass.'
    : 'Solid: the tally over the referendum’s life, replayed from every vote. Dashed: the threshold it had to stay above; the tinted area is where it would have passed.'
}
