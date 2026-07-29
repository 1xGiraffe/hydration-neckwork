import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

function accountsPageBody(): string {
  const at = explorerService.indexOf('async function accountsPage(')
  expect(at).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

// The accounts directory's anonymous path (getAccounts → accountsPage with no
// viewerFold) is REQUIRED to stay byte-identical: same SQL string, same cache
// key, same snapshot/prewarm behaviour. Every fold-specific addition is
// written as a conditional whose FALSE branch is exactly the original
// expression — these pin that branch, one splice at a time, so a future edit
// that widens the "absent" case fails here instead of only showing up as a
// production behaviour change for logged-out traffic.
describe('the accounts-directory viewer fold cannot drift the anonymous path', () => {
  it('accountsPage takes viewerFold as an additive, optional 5th parameter', () => {
    expect(explorerService).toContain(
      'async function accountsPage(offset: number, limit: number, sort: AccountSort, refresh: boolean, viewerFold?: ViewerFold): Promise<AccountsPage> {',
    )
  })

  // Every CTE's own group-by key used to be `if(t.lid = '', <id>, t.lid)`
  // inline; gkeySql(idExpr) now builds it, but its no-fold branch is required
  // to reduce to that exact string — not an equivalent-looking rewrite.
  it('gkeySql degrades to the original inline expression when no fold is passed', () => {
    const body = accountsPageBody()
    const at = body.indexOf('const gkeySql = ')
    expect(at).toBeGreaterThan(-1)
    const fn = body.slice(at, body.indexOf('\n    }', at) + 6)
    expect(fn).toContain(`if (!viewerFold) return \`if(t.lid = '', \${idExpr}, t.lid)\``)
  })

  // All five sites that used to spell out `if(t.lid = '', <id>, t.lid) AS gkey`
  // inline now call the one shared helper instead — never a second, divergent
  // copy of the fold-aware expression.
  it('every gkey site in the query routes through gkeySql, and none still inlines the old expression', () => {
    const body = accountsPageBody()
    const calls = [...body.matchAll(/\$\{gkeySql\('([a-zA-Z_.]+)'\)\} AS gkey/g)].map(m => m[1])
    expect(calls.sort()).toEqual(['a.account_id', 'latest.account_id', 'p.account_id', 'v.account_id', 'v.account_id'].sort())
    expect(body).not.toContain("if(t.lid = '', v.account_id, t.lid) AS gkey")
    expect(body).not.toContain("if(t.lid = '', p.account_id, t.lid) AS gkey")
    expect(body).not.toContain("if(t.lid = '', latest.account_id, t.lid) AS gkey")
    expect(body).not.toContain("if(t.lid = '', a.account_id, t.lid) AS gkey")
  })

  // C1 fix: `grouped`'s OTHER half of the same grouping key. gkeySql alone
  // only overrides `gkey` — but directoryFoldFor can legitimately fold an
  // account that STILL carries a real system label_id (a personal list
  // outranks the reserved 'system' slot by default), and `grouped` groups by
  // `(gkey, label_id)`. Without also neutralizing label_id, one fold key
  // would split into one row per distinct label_id among its members, and
  // the gkey-only satellite joins (mm_grouped, lp_grouped, trade_volume,
  // liquidation_volume) would then hand EACH split row the whole group's
  // totals — see the 'C1 regression' suite below for the concrete proof.
  it('labelIdSql degrades to the original bare `t.lid` when no fold is passed, and grouped routes through it', () => {
    const body = accountsPageBody()
    const at = body.indexOf('const labelIdSql = ')
    expect(at).toBeGreaterThan(-1)
    const fn = body.slice(at, body.indexOf('\n    }', at) + 6)
    expect(fn).toContain('if (!viewerFold) return \'t.lid\'')
    expect(body).toContain('${labelIdSql(\'latest.account_id\')} AS label_id,')
    expect(body).not.toContain('t.lid AS label_id,')
    // Still the exact original grouping clause — only the SELECTed label_id
    // expression feeding it changed, not the GROUP BY itself.
    expect(body).toContain('GROUP BY gkey, label_id')
  })

  // The extra `gkey` projection and the disp_name/has_identity overrides are
  // pure additive splices: each one's ABSENT-fold branch has to be the exact
  // original text, not merely something that happens to evaluate the same.
  it('the extra gkey column and the disp_name/has_identity overrides are empty-string splices absent a fold', () => {
    const body = accountsPageBody()
    expect(body).toContain("const gkeySelect = viewerFold ? 'g.gkey AS gkey,\\n            ' : ''")
    expect(body).toContain(
      "? \`if(\${groupNameExpr} != '' OR g.label_id != '' OR ident.account_id != '', 1, 0) AS has_identity\`\n      : \`if(g.label_id != '' OR ident.account_id != '', 1, 0) AS has_identity\`",
    )
    expect(body).toContain(
      "? \`multiIf(\${groupNameExpr} != '', \${groupNameExpr}, g.label_id != '', g.lname, ident.display != '', ident.display, '') AS disp_name\`\n      : \`multiIf(g.label_id != '', g.lname, ident.display != '', ident.display, '') AS disp_name\`",
    )
    // Spliced into the SELECT list exactly where the two literals used to sit.
    expect(body).toContain('${gkeySelect}g.label_id, g.lname, g.color, g.icon, g.members, g.sample, g.last_block, g.usd AS usd,')
    expect(body).toContain('${hasIdentitySql},\n            ${dispNameSql},')
  })

  // query_params only grows when a fold is present — the anonymous call site
  // never sends fold_ids/fold_keys/fold_group_keys/fold_group_names at all,
  // so ClickHouse never even sees an unused parameter on that path.
  it('fold_ids/fold_keys/fold_group_keys/fold_group_names are added to query_params only when viewerFold is present', () => {
    const body = accountsPageBody()
    const at = body.indexOf('query_params: {')
    const params = body.slice(at, body.indexOf('},\n        format:', at))
    expect(params).toContain('limit, offset,')
    expect(params).toContain('...(viewerFold ? {')
    expect(params).toContain('fold_ids: viewerFold.ids, fold_keys: viewerFold.keys,')
    expect(params).toContain('fold_group_keys: [...viewerFold.groups.keys()], fold_group_names: [...viewerFold.groups.values()].map(g => g.name),')
  })

  // The shared snapshot load/persist is skipped by an early branch, not a
  // rewrite — the anonymous call (`!viewerFold`) still runs the exact same
  // two lines it always did.
  it('the persisted snapshot load/persist is skipped only by wrapping the ORIGINAL lines in `if (!viewerFold)`', () => {
    const body = accountsPageBody()
    expect(body).toContain("if (!viewerFold) {\n      const current = await loadAccountDirectorySnapshot(snapshotKey, true).catch(() => null)\n      if (current) return current.page\n    }")
    expect(body).toContain('if (!viewerFold) await persistAccountDirectorySnapshot(snapshotKey, page).catch(err => console.error(\'[accounts] snapshot persist failed:\', err))')
  })

  // A viewer's fold never touches the shared entry (own key prefix), but DOES
  // reuse the shared stale-while-revalidate mechanism — a hard-TTL cached()
  // equal to the client's own poll interval would force a blocking rebuild on
  // nearly every poll (I1). `generation` is passed to cachedSwr rather than
  // folded into the key, so a generation advance marks the entry stale
  // (served immediately, refreshed in the background) rather than absent.
  it('a viewerFold request returns via cachedSwr(..., generation) before the shared cacheRefresh/cachedSwr calls, on its own key prefix without generation baked in', () => {
    const body = accountsPageBody()
    const foldReturn = body.indexOf('if (viewerFold) {')
    const cacheRefreshCall = body.indexOf('if (refresh) return cacheRefresh(key,')
    expect(foldReturn).toBeGreaterThan(-1)
    expect(cacheRefreshCall).toBeGreaterThan(foldReturn)
    expect(body).toContain('const viewerKey = `user-accounts:${modelVersion}:${viewerFold.fingerprint}:${sort}:${offset}:${limit}`')
    expect(body).toContain('return cachedSwr(viewerKey, ACCOUNTS_FRESH_MS, ACCOUNTS_STALE_MS, build, generation)')
  })

  // Pinned so the shared cache-key/generation wiring test (accountDirectoryGenerations.test.ts)
  // keeps meaning what it says: the shared `explorer:accounts:...` key is
  // built in exactly the one place it always was, and the viewer key never
  // uses that prefix (so it can never be counted as a second site there).
  it('the per-viewer key never shares the shared directory\'s `explorer:accounts:` prefix', () => {
    expect(explorerService).not.toContain('`explorer:accounts:${modelVersion}:${sort}:${offset}:${limit}:${viewerFold')
    const viewerKeySites = [...explorerService.matchAll(/`user-accounts:[^`]*`/g)]
    expect(viewerKeySites).toHaveLength(1)
  })

  // The three best-effort enrichment passes (sparkline, activity/volume
  // counters, top-asset refinement) each re-derive "which accounts does this
  // row cover" — a viewer-fold row carries no system label, so without this
  // they would silently narrow a multi-member fold down to its one sampled
  // account. All three take the SAME foldMembersByKey map.
  it('every per-row enrichment pass accepts foldMembersByKey and is called with it', () => {
    expect(explorerService).toContain('function rowMemberAccounts(r: { label_id: string; sample: string; gkey?: string }, foldMembersByKey: Map<string, string[]> | null): string[] {')
    for (const fn of ['enrichTopAssets', 'enrichAccountRows', 'enrichAccountSparklines']) {
      const at = explorerService.indexOf(`async function ${fn}(`)
      expect(at, fn).toBeGreaterThan(-1)
      const sig = explorerService.slice(at, explorerService.indexOf('): Promise<void> {', at))
      expect(sig, fn).toContain('foldMembersByKey: Map<string, string[]> | null = null')
    }
    const body = accountsPageBody()
    expect(body).toContain('await enrichAccountRows(raw, rows, foldMembersByKey)')
    expect(body).toContain('await enrichAccountSparklines(raw, rows, foldMembersByKey)')
    expect(body).toContain('await enrichTopAssets(raw, rows, prices, foldMembersByKey)')
  })

  // getAccountsForViewerFold falls back to the plain shared path — not a
  // parallel per-viewer computation of the same thing — whenever the fold has
  // no pairs, so a defensive/empty fold costs exactly what the shared
  // endpoint already costs.
  it('getAccountsForViewerFold falls back to getAccounts for an empty fold', () => {
    const at = explorerService.indexOf('export function getAccountsForViewerFold(')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('if (!fold.ids.length) return getAccounts(offset, limit, sort)')
    expect(body).toContain('return accountsPage(offset, limit, sort, false, fold)')
  })
})

// C1 regression — a mixed-membership fold (one user tag holding both a
// system-tagged account and a system-tagless one) must collapse to exactly
// one (gkey, label_id) group, not one per distinct label_id among its
// members. There is no fake-ClickHouse harness for accountsPage's assembled
// SQL (building one was judged disproportionate to this codebase's own
// precedent for this function — see accountDirectoryGenerations.test.ts's
// source-text pins), and the e2e mock's buildAccountsForViewer is
// structurally unable to reproduce this (no label_id notion at all — see its
// own comment in tests/fixtures/mockApi.ts). So this transcribes gkeySql's
// and labelIdSql's real fold-branch semantics (`if`, and ClickHouse
// `transform(id, from, to, '')`, whose default is '' on no match) 1:1 and
// runs them against a synthetic `latest ⋈ tags` row set shaped exactly like
// the real query's inputs — proving the fix's actual decision function, not
// just pinning more source text.
describe('C1 — a mixed-membership fold groups to exactly one row', () => {
  const TAG = 'tag-uuid'
  const TREASURY = '0x' + '11'.repeat(32)
  const WHALE = '0x' + '22'.repeat(32)
  const foldIds = [TREASURY, WHALE]
  const foldKeys = [`u:${TAG}`, `u:${TAG}`]

  // ClickHouse `transform(id, from, to, '')`: '' (the declared default) on
  // no match — never null, never an error.
  function transform(id: string, from: string[], to: string[]): string {
    const i = from.indexOf(id)
    return i === -1 ? '' : to[i]
  }
  // gkeySql's fold-present branch, transcribed from the pinned source above.
  function gkey(id: string, lid: string): string {
    const userKey = transform(id, foldIds, foldKeys)
    return userKey !== '' ? userKey : (lid === '' ? id : lid)
  }
  // labelIdSql's fold-present branch, transcribed from the pinned source above.
  function labelId(id: string, lid: string): string {
    const userKey = transform(id, foldIds, foldKeys)
    return userKey !== '' ? '' : lid
  }

  const rows = [
    { id: TREASURY, lid: 'treasury', usd: 980_000 },   // carries a real system label_id
    { id: WHALE, lid: '', usd: 250_000 },               // no system tag at all
  ]

  it('the fix: gkey AND label_id both route through the fold, so the two members share one (gkey, label_id) pair', () => {
    const grouped = rows.map(r => ({ gkey: gkey(r.id, r.lid), labelId: labelId(r.id, r.lid), usd: r.usd }))
    const pairs = new Set(grouped.map(g => `${g.gkey}|${g.labelId}`))

    expect(pairs.size).toBe(1)
    expect([...pairs][0]).toBe(`u:${TAG}|`)
    // The SUM a `GROUP BY gkey, label_id` would compute over this one group —
    // the real total, not half of it.
    expect(grouped.reduce((s, g) => s + g.usd, 0)).toBe(1_230_000)
  })

  it('proves the bug was real: gkey-only folding (label_id left as bare t.lid) splits the same two members into two groups', () => {
    // The pre-fix shape: only `gkey` is fold-aware; `label_id` is still the
    // bare `t.lid`, exactly as `grouped`'s SELECT read before labelIdSql.
    const buggyPairs = new Set(rows.map(r => `${gkey(r.id, r.lid)}|${r.lid}`))
    expect(buggyPairs.size).toBe(2)
    expect(buggyPairs).toEqual(new Set([`u:${TAG}|treasury`, `u:${TAG}|`]))
  })
})
