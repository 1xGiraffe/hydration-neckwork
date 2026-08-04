// The verified-source file tree: pure path→tree shaping for the Contract tab's
// Code sub-tab (rendered by components/SourceBrowser.tsx).

export type FileTreeNode =
  | { kind: 'dir'; name: string; path: string; children: FileTreeNode[] }
  | { kind: 'file'; name: string; path: string }

type DirBuilder = { dirs: Map<string, DirBuilder>; files: string[] }

// Directory chains with a single directory child collapse into one label
// ("lib/openzeppelin-contracts/contracts"), so dependency-heavy sources stay
// two or three levels deep instead of six.
function toNodes(builder: DirBuilder, prefix: string): FileTreeNode[] {
  const dirs: FileTreeNode[] = []
  for (const [name, child] of [...builder.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    let label = name
    let node = child
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [onlyName, onlyChild] = [...node.dirs][0]
      label = `${label}/${onlyName}`
      node = onlyChild
    }
    const path = `${prefix}${label}`
    dirs.push({ kind: 'dir', name: label, path, children: toNodes(node, `${path}/`) })
  }
  const files: FileTreeNode[] = builder.files
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({ kind: 'file', name, path: `${prefix}${name}` }))
  return [...dirs, ...files]
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: DirBuilder = { dirs: new Map(), files: [] }
  for (const full of paths) {
    const segments = full.split('/').filter(s => s !== '')
    if (!segments.length) continue
    let cursor = root
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.dirs.get(segment)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        cursor.dirs.set(segment, next)
      }
      cursor = next
    }
    cursor.files.push(segments[segments.length - 1]!)
  }
  return toNodes(root, '')
}

// The file the reader came for: the one declaring the verified contract, not
// whichever dependency the compiler input happened to list first.
export function pickMainSource(paths: string[], contractName?: string | null): string | undefined {
  if (!paths.length) return undefined
  if (contractName) {
    const exact = paths.find(p => p.split('/').pop() === `${contractName}.sol`)
    if (exact) return exact
    const named = paths.find(p => (p.split('/').pop() ?? '').startsWith(contractName))
    if (named) return named
  }
  // Project sources over vendored dependencies, then the shallowest path.
  const own = paths.filter(p => !/(^|\/)(lib|node_modules)\//.test(p))
  const pool = own.length ? own : paths
  return [...pool].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
}
