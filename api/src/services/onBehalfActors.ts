import type { ClickHouseClient } from '../db/client.ts'

// The account a dispatch ran AS, when it was not the signatory's own.
//
// A swap dispatched through a proxy or a multisig moves the funds of the account the
// call ran as, never those of the signatory who submitted it. The innermost proxy
// wins: Multisig.as_multi → Proxy.proxy(real=X) executes its batch with X's origin,
// so X is whose HUSDT left. Call addresses form a path tree ('root', '0', '0.0', …),
// so depth is the dot count and 'root' is shallowest.
//
// With no proxy, the multisig account itself is the actor. With neither, there is no
// on-behalf account and the signer stands.
//
// This is ONE rule for every surface: the block, extrinsic and global feeds apply it
// per rendered row (`actorsFor` in explorerService), and the account-first swap
// projection applies it when a swap is keyed to its account (`accountSwapQueue`), so
// the account page, its counts, the directory total and a tag's feed agree with the
// extrinsic page about whose trade a proxied swap is.
export interface OnBehalfCandidateSet {
  proxies?: { callAddress: string; account: string }[]
  multisig?: string
}
export function onBehalfActor(candidates: OnBehalfCandidateSet): string | undefined {
  const depth = (callAddress: string) => callAddress === 'root' ? 0 : callAddress.split('.').length
  const innermost = (candidates.proxies ?? [])
    .filter(p => p.account)
    .sort((l, r) => depth(r.callAddress) - depth(l.callAddress))[0]
  return innermost?.account || candidates.multisig || undefined
}

export interface ProxyCallRow { block_height: number; extrinsic_index: number; call_address: string; real_account: string }
export interface MultisigExecutedRow { block_height: number; extrinsic_index: number; multisig: string }

const tupleKey = (block: number, index: number) => `${block}:${index}`

// Fold the two on-behalf read models into one candidate set per (block, extrinsic):
// every proxy dispatch of the extrinsic with its call address, and the multisig it
// executed as, if any.
export function onBehalfCandidates(proxies: ProxyCallRow[], multisigs: MultisigExecutedRow[]): Map<string, OnBehalfCandidateSet> {
  const candidates = new Map<string, OnBehalfCandidateSet>()
  for (const r of proxies) {
    const key = tupleKey(r.block_height, r.extrinsic_index)
    const at = candidates.get(key) ?? {}
    ;(at.proxies ??= []).push({ callAddress: r.call_address, account: r.real_account })
    candidates.set(key, at)
  }
  for (const r of multisigs) {
    const key = tupleKey(r.block_height, r.extrinsic_index)
    const at = candidates.get(key) ?? {}
    at.multisig ??= r.multisig
    candidates.set(key, at)
  }
  return candidates
}

// Map (block_height, extrinsic_index) → the account each extrinsic dispatched AS.
// Both reads are purpose-built on-behalf models rather than the raw call args, which
// would need a JSON path per nesting depth. Neither is keyed on (block, extrinsic),
// so each is a full scan — of a few thousand rows, because only proxied/multisig
// dispatches land in them at all, against the ~2M swap extrinsics that do not.
export async function onBehalfActorsFor(client: ClickHouseClient, pairs: [number, number | null][]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => tupleKey(h, i!)))]
  if (!keys.length) return out
  for (let start = 0; start < keys.length; start += 5_000) {
    const tuples = keys.slice(start, start + 5_000).map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const [proxyRes, msRes] = await Promise.all([
      client.query({
        query: `SELECT block_height, extrinsic_index, call_address, real_account
                FROM price_data.proxy_call_activity
                WHERE (block_height, extrinsic_index) IN (${tuples})`,
        format: 'JSONEachRow',
      }),
      client.query({
        // The column is selected raw and assumeNotNull applied only in the predicate:
        // aliasing the wrapped expression back to `extrinsic_index` makes the later
        // reference resolve to the alias rather than to the column. The predicate's own
        // tuple keys are non-null by construction, so only real rows match.
        query: `SELECT block_height, extrinsic_index, multisig
                FROM price_data.multisig_event_activity
                WHERE (block_height, assumeNotNull(extrinsic_index)) IN (${tuples})
                  AND event_name = 'Multisig.MultisigExecuted' AND multisig != ''`,
        format: 'JSONEachRow',
      }),
    ])
    const candidates = onBehalfCandidates(await proxyRes.json<ProxyCallRow>(), await msRes.json<MultisigExecutedRow>())
    for (const [key, set] of candidates) {
      const actor = onBehalfActor(set)
      if (actor) out.set(key, actor)
    }
  }
  return out
}
