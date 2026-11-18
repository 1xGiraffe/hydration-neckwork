import { useEffect } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { govApi } from '../api/explorer'
import { reconnectRemembered, useChainWallets } from '../chainWallet'
import type { ChainAccount } from '../chainWallet'
import type { AccountRef } from '../types'
import type { AccountGovernance } from '../governanceTypes'
import { readActor, runtimeAccountOf, toSs58 } from './chainWrite'
import type { ProxyType } from './chainWrite'
import { proxiesToOffer, proxyBlockReason } from '../governanceProxies'
import { useGovClock } from '../hooks/useGovernance'

// Who the reader can vote as: every connected account (an EVM address as the
// Hydration account it maps to), and every account one of them is a Governance or
// Any proxy for (from the indexed Proxy.Proxies, re-checked on chain when a vote is
// reviewed). A delayed proxy is listed but disabled: it would have to announce
// first, which is not supported. One more hop is offered too: an account reached
// through an account the signer is an ANY proxy of (only Any's filter lets the
// outer proxy.proxy carry the inner one) — signer → via → account.

export interface Voter {
  /** `${actorId}|${signerAccountId}` — the same actor can be reachable through two signers. */
  key: string
  actorId: string
  actorAddress: string
  ref: AccountRef | null
  signer: ChainAccount
  signerId: string
  proxy: { proxyType: ProxyType } | null
  /** The account in between, for a two-hop proxy chain (signer is its Any proxy). */
  via: { real: string; proxyType: 'Any'; ref: AccountRef } | null
  disabled: string | null
}

const MAX_SECOND_HOP_LOOKUPS = 20

export function useSignerIds(accounts: ChainAccount[]) {
  return useQueries({
    queries: accounts.map(a => ({
      queryKey: ['vote-signer-id', a.id],
      queryFn: () => runtimeAccountOf(a),
      enabled: a.kind !== 'substrate-h160',
      staleTime: Infinity,
      retry: 1,
    })),
  })
}

export function useVoters(): { voters: Voter[]; loading: boolean; accounts: ChainAccount[]; governance: Map<string, AccountGovernance> } {
  const { accounts } = useChainWallets()
  useEffect(() => { void reconnectRemembered() }, [])
  const ids = useSignerIds(accounts)
  const signers = accounts.map((a, i) => ({ account: a, id: ids[i]?.data ?? null }))
  const msPerBlock = useGovClock().data?.msPerBlock ?? null
  const govs = useQueries({
    queries: signers.map(s => ({
      queryKey: ['gov-account', s.id ? toSs58(s.id) : null],
      queryFn: ({ signal }: { signal: AbortSignal }) => govApi.accountGovernance(toSs58(s.id as string), signal),
      enabled: !!s.id,
      staleTime: 30_000,
      retry: 2,
    })),
  })
  const governance = new Map<string, AccountGovernance>()
  govs.forEach((g, i) => { const id = signers[i].id; if (id && g.data) governance.set(id, g.data) })
  // The accounts each signer is an Any proxy of (no delay), whose own proxies give the second hop.
  const anyHops = [...new Map(signers.flatMap((_s, i) => (govs[i]?.data?.proxies.canActFor ?? [])
    .filter(p => p.proxyType === 'Any' && p.canVote && /^0x[0-9a-f]{64}$/i.test(p.account.accountId))
    .map(p => [p.account.accountId, p.account] as const))).values()].slice(0, MAX_SECOND_HOP_LOOKUPS)
  const hopGovs = useQueries({
    queries: anyHops.map(a => ({
      queryKey: ['gov-account', a.address],
      queryFn: ({ signal }: { signal: AbortSignal }) => govApi.accountGovernance(a.address, signal),
      staleTime: 60_000,
      retry: 1,
    })),
  })
  const hopOf = new Map(anyHops.map((a, i) => [a.accountId.toLowerCase(), hopGovs[i]?.data ?? null]))
  const voters = (() => {
    const out: Voter[] = []
    const seen = new Set<string>()
    signers.forEach((s, i) => {
      if (!s.id) return
      const g = govs[i]?.data
      const key = `${s.id}|${s.id}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ key, actorId: s.id, actorAddress: g?.account.address ?? toSs58(s.id), ref: g?.account ?? null, signer: s.account, signerId: s.id, proxy: null, via: null, disabled: null })
      }
      // One relation per account (governanceProxies.ts proxiesToOffer): the one that can
      // vote, Any over Governance; a delayed one is listed, disabled, with its reason.
      for (const p of proxiesToOffer(g?.proxies.canActFor ?? [], s.id)) {
        const actorId = p.account.accountId
        const k = `${actorId}|${s.id}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push({
          key: k, actorId, actorAddress: p.account.address, ref: p.account, signer: s.account, signerId: s.id,
          proxy: { proxyType: p.proxyType as ProxyType },
          via: null,
          disabled: p.canVote ? null : proxyBlockReason(p, msPerBlock),
        })
      }
    })
    // Second hop: signer → (Any) → middle → (Any/Governance, no delay) → account.
    signers.forEach((s, i) => {
      if (!s.id) return
      for (const mid of govs[i]?.data?.proxies.canActFor ?? []) {
        if (mid.proxyType !== 'Any' || !mid.canVote || (mid.holder && mid.holder.toLowerCase() !== s.id.toLowerCase())) continue
        for (const p of proxiesToOffer(hopOf.get(mid.account.accountId.toLowerCase())?.proxies.canActFor ?? [], mid.account.accountId)) {
          const actorId = p.account.accountId
          if (!p.canVote) continue
          if (actorId.toLowerCase() === s.id.toLowerCase() || seen.has(`${actorId}|${s.id}`)) continue
          const k = `${actorId}|${s.id}|${mid.account.accountId}`
          if (seen.has(k)) continue
          seen.add(k)
          out.push({
            key: k, actorId, actorAddress: p.account.address, ref: p.account, signer: s.account, signerId: s.id,
            proxy: { proxyType: p.proxyType as ProxyType },
            via: { real: mid.account.accountId, proxyType: 'Any', ref: mid.account },
            disabled: null,
          })
        }
      }
    })
    return out
  })()
  const loading = ids.some(q => q.isLoading) || govs.some(q => q.isLoading)
  return { voters, loading, accounts, governance }
}

/** Fresh chain state of an account (balances, locks, votes, fee currency) for the composer. */
export function useActorState(actorId: string | null) {
  return useQuery({
    queryKey: ['vote-actor', actorId],
    queryFn: () => readActor(actorId as string),
    enabled: !!actorId,
    staleTime: 12_000,
    refetchInterval: 30_000,
  })
}

/** Everything a signed vote changes, refreshed now and again as the indexer catches up. */
export function useRefreshAfterWrite() {
  const qc = useQueryClient()
  return (indices: number[]) => {
    const run = () => {
      void qc.invalidateQueries({ queryKey: ['vote-actor'] })
      void qc.invalidateQueries({ queryKey: ['gov-account'] })
      void qc.invalidateQueries({ queryKey: ['gov-needs-vote'] })
      for (const i of indices) {
        void qc.invalidateQueries({ queryKey: ['referendum', 'opengov', i] })
        void qc.invalidateQueries({ queryKey: ['referendum-votes', 'opengov', i] })
        void qc.invalidateQueries({ queryKey: ['gov-tally-history', 'opengov', i] })
        void qc.invalidateQueries({ queryKey: ['vote-referendum', i] })
      }
    }
    run()
    for (const ms of [6_000, 20_000, 60_000]) setTimeout(run, ms)
  }
}
