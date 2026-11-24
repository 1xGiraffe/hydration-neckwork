// The forum IPFS node's RPC (kubo, the `ipfs` compose service), over plain fetch and
// FormData — no SDK. Reached only on the internal ipfs network.

export class KuboClient {
  /**
   * `token`: this client's bearer token for the node's RPC (API.Authorizations, set by
   * ops/ipfs-init.sh, each token scoped to the paths its client uses); empty sends none,
   * which a node without authorizations still accepts.
   */
  constructor(private readonly apiUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly token = '') {}

  private async call(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = new Headers(init.headers)
      if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
      const res = await this.fetchImpl(this.apiUrl.replace(/\/+$/, '') + '/api/v0/' + path, { method: 'POST', ...init, headers, signal: controller.signal })
      if (!res.ok) throw new Error(`ipfs ${path.split('?')[0]} → HTTP ${res.status}`)
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Adds bytes and returns the CID. Uploads and re-hosted images: CIDv1, sha2-256, raw
   * leaves, pinned. `onlyHash` computes the CID without storing (the re-hash check);
   * `cidVersion: 0` reproduces a legacy CIDv0's parameters.
   */
  async add(bytes: Uint8Array, opts: { onlyHash?: boolean; cidVersion?: 0 | 1; pin?: boolean; rawLeaves?: boolean } = {}): Promise<string> {
    const v = opts.cidVersion ?? 1
    const params = new URLSearchParams({ 'cid-version': String(v), hash: 'sha2-256', pin: String(opts.pin ?? !opts.onlyHash), quiet: 'true' })
    if (opts.rawLeaves ?? v === 1) params.set('raw-leaves', 'true')
    if (opts.onlyHash) params.set('only-hash', 'true')
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(bytes)]), 'image')
    const res = await this.call(`add?${params}`, { body: form })
    const text = await res.text()
    const last = text.trim().split('\n').pop() ?? ''
    const hash = (JSON.parse(last) as { Hash?: string }).Hash
    if (!hash || !isCid(hash)) throw new Error('ipfs add returned no CID')
    return hash
  }

  /** Pins an existing CID, fetching it from the network; false on timeout or failure. */
  async pinAdd(cid: string, timeoutMs = 60_000): Promise<boolean> {
    try { await this.call(`pin/add?arg=${encodeURIComponent(cid)}&progress=false`, {}, timeoutMs); return true } catch { return false }
  }

  /**
   * A CID's size from its ROOT block alone (`files/stat`): for a UnixFS file the root
   * states the whole file's size, so an oversized CID is refused before any of its
   * data is fetched. (`dag/stat` would walk — and fetch — the whole DAG to answer.)
   */
  async rootStat(cid: string, timeoutMs = 30_000): Promise<{ size: number; cumulativeSize: number; type: string }> {
    const res = await this.call(`files/stat?arg=${encodeURIComponent('/ipfs/' + cid)}`, {}, timeoutMs)
    const j = await res.json() as { Size?: number; CumulativeSize?: number; Type?: string }
    return { size: Number(j.Size ?? NaN), cumulativeSize: Number(j.CumulativeSize ?? NaN), type: String(j.Type ?? '') }
  }

  /** A CID's parameters as kubo reads them: version, codec and multihash, e.g. { version: 1, codec: 'raw', hash: 'sha2-256' }. */
  async cidParams(cid: string): Promise<{ version: number; codec: string; hash: string }> {
    const res = await this.call(`cid/format?arg=${encodeURIComponent(cid)}&f=${encodeURIComponent('%v %c %h')}`, {}, 10_000)
    const j = await res.json() as { Formatted?: string; ErrorMsg?: string }
    const [v, codec, hash] = String(j.Formatted ?? '').trim().split(' ')
    if (j.ErrorMsg || !codec || !hash) throw new Error('cid-format')
    return { version: Number(v.replace(/^cidv/, '')), codec, hash }
  }

  /** The repo's size and its StorageMax, in bytes (`repo/stat` without walking the blocks). */
  async repoStat(timeoutMs = 10_000): Promise<{ repoSize: number; storageMax: number }> {
    const res = await this.call('repo/stat?size-only=true', {}, timeoutMs)
    const j = await res.json() as { RepoSize?: number; StorageMax?: number }
    const repoSize = Number(j.RepoSize), storageMax = Number(j.StorageMax)
    if (!(repoSize >= 0) || !(storageMax > 0)) throw new Error('repo/stat unreadable')
    return { repoSize, storageMax }
  }

  /** Removes every block no pin holds (an unpinned or refused CID's fetched blocks among them). */
  async repoGc(timeoutMs = 300_000): Promise<void> {
    const res = await this.call('repo/gc?quiet=true', {}, timeoutMs)
    await res.text()
  }

  async pinRm(cid: string): Promise<void> {
    try { await this.call(`pin/rm?arg=${encodeURIComponent(cid)}`) } catch { /* not pinned */ }
  }

  /** A pinned CID's bytes, refusing more than `maxBytes`. */
  async cat(cid: string, maxBytes: number, timeoutMs = 30_000): Promise<Uint8Array> {
    const res = await this.call(`cat?arg=${encodeURIComponent(cid)}&length=${maxBytes + 1}`, {}, timeoutMs)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('too-large')
    return buf
  }
}

/** CIDv0 (Qm…, base58btc) or CIDv1 in base32 (b…) — the only forms the forum stores. */
export function isCid(s: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s) || /^b[a-z2-7]{50,100}$/.test(s)
}
