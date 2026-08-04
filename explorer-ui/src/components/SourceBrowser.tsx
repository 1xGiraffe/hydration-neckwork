import { useMemo, useState } from 'react'
import { CopyTextButton } from './ui'
import { buildFileTree, pickMainSource, type FileTreeNode } from '../utils/sourceTree'
import { tokenizeSolidity } from '../utils/solidityHighlight'

// The verified-source browser on the Contract tab's Code sub-tab: a file tree
// beside the file itself. A wrapping strip of 31 full paths cost ~300px of
// vertical space before any code (and overflowed at 390px), so the tree keeps
// its own scroll column on desktop and folds into a <details> picker below
// 860px — the CSS owns that switch, both forms render the same tree.

function TreeNodes({ nodes, selected, onSelect }: { nodes: FileTreeNode[]; selected?: string; onSelect: (path: string) => void }) {
  return (
    <>
      {nodes.map(node => node.kind === 'file'
        ? (
          <button
            key={node.path}
            type="button"
            className={`src-tree-file${node.path === selected ? ' on' : ''}`}
            title={node.path}
            aria-current={node.path === selected}
            onClick={() => onSelect(node.path)}
          >
            {node.name}
          </button>
        )
        : <TreeDir key={node.path} node={node} selected={selected} onSelect={onSelect} />)}
    </>
  )
}

function TreeDir({ node, selected, onSelect }: { node: Extract<FileTreeNode, { kind: 'dir' }>; selected?: string; onSelect: (path: string) => void }) {
  // Open by default: the whole point of the column is seeing the file set at a
  // glance. Collapsing is there for the reader who wants the noise gone.
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" className="src-tree-dir" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="tw" aria-hidden="true">{open ? '▾' : '▸'}</span>{node.name}
      </button>
      {open && <div className="src-tree-kids"><TreeNodes nodes={node.children} selected={selected} onSelect={onSelect} /></div>}
    </>
  )
}

// Highlighted source with a line-number gutter. Memoised on the file's own
// content, so switching files tokenises once rather than on every parent render.
//
// The gutter is its own <pre> beside the code rather than a per-line wrapper: a
// block comment or a string spans lines, so the token stream cannot be cut into
// one element per line without splitting those. Both panes share the scroll box
// and the same line-height, and the gutter sticks to the left edge so it stays put
// while the code scrolls sideways. It is aria-hidden and unselectable, so copying
// a selection never picks up the numbers.
function SolidityCode({ source }: { source: string }) {
  const tokens = useMemo(() => tokenizeSolidity(source), [source])
  const gutter = useMemo(() => {
    const lines = source ? source.split('\n').length : 0
    return Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n')
  }, [source])
  return (
    <div className="src-viewer">
      <pre className="src-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="src-code sol">
        {tokens.map((t, i) => t.kind === 'plain' ? t.text : <span key={i} className={`s-${t.kind}`}>{t.text}</span>)}
      </pre>
    </div>
  )
}

export function SourceBrowser({ files, contractName }: { files: { path: string; content: string }[]; contractName?: string | null }) {
  // One scalar identity for the file set: `files` is a fresh array on every
  // render, so nothing derived from it can be a dependency directly.
  const pathKey = files.map(f => f.path).join('\n')
  const paths = useMemo(() => (pathKey ? pathKey.split('\n') : []), [pathKey])
  const tree = useMemo(() => buildFileTree(paths), [paths])
  const fallback = useMemo(() => pickMainSource(paths, contractName), [paths, contractName])
  const [chosen, setChosen] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const selectedPath = (chosen && paths.includes(chosen) ? chosen : fallback) ?? paths[0]
  const selected = files.find(f => f.path === selectedPath)
  const select = (path: string) => { setChosen(path); setPickerOpen(false) }
  const shortName = selectedPath?.split('/').pop() ?? 'file'

  return (
    <div className="id-card">
      <div className="id-card-head">Source files · {files.length}</div>
      <div className="src-split">
        <div className="src-tree"><TreeNodes nodes={tree} selected={selectedPath} onSelect={select} /></div>
        <div className="src-pane">
          {/* Same tree, phone shape: the summary carries the current file so the
              picker can stay shut, and choosing a file shuts it again. */}
          <details className="src-picker" open={pickerOpen} onToggle={e => setPickerOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary><span aria-hidden="true">{pickerOpen ? '▾' : '▸'}</span> {shortName}<span className="cnt">{files.length} files</span></summary>
            <div className="src-tree"><TreeNodes nodes={tree} selected={selectedPath} onSelect={select} /></div>
          </details>
          {selected && (
            <>
              {/* Directory and filename are separate spans so only the directory
                  can truncate — the filename is the part that identifies the file.
                  This replaced `direction: rtl` (the usual truncate-at-the-start
                  trick), which reorders leading bidi-neutral characters: an npm
                  scope like `@aave/core-v3/…` rendered with its `@` moved to the
                  far end of the path. */}
              <div className="src-pane-head">
                <span className="p" title={selected.path}>
                  <span className="dir">{selected.path.slice(0, selected.path.length - shortName.length)}</span>
                  <span className="file">{shortName}</span>
                </span>
                <CopyTextButton label={shortName} text={selected.content} />
              </div>
              <SolidityCode source={selected.content} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
