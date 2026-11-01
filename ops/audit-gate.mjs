#!/usr/bin/env node
// Deploy gate on known-vulnerable production dependencies (AGENTS.md, Dependencies
// and supply chain). Runs `npm audit --omit=dev` in the given package directory and
// fails on any HIGH or CRITICAL advisory that ops/audit-allowlist.json does not
// acknowledge — or acknowledges past its `expires` date, so an exception lapses on
// its own instead of hiding a finding forever. Fails CLOSED when the audit itself
// cannot run (registry unreachable, bad JSON): DEPLOY_SKIP_AUDIT=1 is the explicit,
// logged way past an outage.
//
//   node ops/audit-gate.mjs api
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2]
if (!dir) { console.error('usage: audit-gate.mjs <package-dir>'); process.exit(2) }
const allowlistPath = fileURLToPath(new URL('./audit-allowlist.json', import.meta.url))
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

let report
try {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  let out
  try { out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { out = e.stdout }
  report = JSON.parse(out)
  if (!report.vulnerabilities) throw new Error(report.error?.summary ?? 'no vulnerabilities key in the audit output')
} catch (e) {
  console.error(`audit-gate: npm audit could not run in ${dir}: ${e.message} (DEPLOY_SKIP_AUDIT=1 to deploy anyway)`)
  process.exit(1)
}

const blocking = []
const acknowledged = []
for (const [pkg, v] of Object.entries(report.vulnerabilities)) {
  for (const via of v.via) {
    if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue
    const id = String(via.url ?? '').split('/').pop()
    const entry = allowlist.find(a => a.advisory === id && a.package === pkg)
    if (entry && entry.expires >= today) acknowledged.push(`${via.severity} ${pkg} ${id} (until ${entry.expires}: ${entry.reason})`)
    else blocking.push(`${via.severity} ${pkg} ${id}${entry ? ` — allowlist entry EXPIRED ${entry.expires}` : ''}: ${via.title}`)
  }
}
for (const line of [...new Set(acknowledged)]) console.log(`audit-gate: acknowledged ${line}`)
if (blocking.length) {
  for (const line of [...new Set(blocking)]) console.error(`audit-gate: BLOCKING ${line}`)
  process.exit(1)
}
console.log(`audit-gate: ${dir} has no unacknowledged high/critical production advisory`)
