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

  // A viewer's fold never touches the shared cachedSwr/cacheRefresh entry —
  // it returns through a SEPARATE `cached()` call before either is reached.
  it('a viewerFold request returns via cached() before the shared cacheRefresh/cachedSwr calls, on its own key prefix', () => {
    const body = accountsPageBody()
    const foldReturn = body.indexOf('if (viewerFold) {')
    const cacheRefreshCall = body.indexOf('if (refresh) return cacheRefresh(key,')
    expect(foldReturn).toBeGreaterThan(-1)
    expect(cacheRefreshCall).toBeGreaterThan(foldReturn)
    expect(body).toContain('const viewerKey = `user-accounts:${modelVersion}:${generation}:${viewerFold.fingerprint}:${sort}:${offset}:${limit}`')
    expect(body).toContain('return cached(viewerKey, ACCOUNTS_FRESH_MS, build)')
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
