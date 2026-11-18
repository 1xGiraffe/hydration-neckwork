import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode,
} from 'react'
import { Markdown } from './Markdown'
import {
  activeTrigger, applyEdit, completeTrigger, continueList, indentLines, insertAt, insertLink, insertPlaceholder,
  previewMedia, replacePlaceholder, selectionInList, toggleBullets, toggleCode, toggleHeading, toggleNumbered,
  toggleQuote, toggleWrap, uploadPlaceholder, altFromName, suggestionsFrom, type Edit, type Suggestion, type TextState,
} from './editorCommands'
import { loadDraft, pruneDrafts, saveDraft, scopedDraftKey } from './drafts'
import { ACCEPT_ATTR, ImagePrepError, UploadAborted, UploadError, imageFilesFrom, prepareImage, uploadImage } from './imageUpload'
import { api } from '../api/explorer'
import { getSession, setSession, useSession } from '../session'
import './editor.css'

// The forum's writing surface: a plain textarea (no editor framework) with a
// formatting toolbar, keyboard shortcuts, a preview rendered by the forum's one
// renderer (so what you see is what readers get), @mentions and #referendum
// suggestions, images by paste, drop or picker (checked and stripped in the
// browser, uploaded to the forum's IPFS node), a live character count and a draft
// kept in this browser until the text is posted.

export interface MarkdownEditorProps {
  value: string
  onChange(v: string): void
  maxChars: number
  label: string
  placeholder?: string
  minRows?: number
  draftKey?: string | null
  onSubmit?(): void
  disabled?: boolean
  autoFocus?: boolean
  canUpload: boolean
  /** Why images cannot be added (shown on the image button and on paste/drop); defaults to "Sign in to add images." */
  uploadBlockedReason?: string | null
  onBusyChange?(uploading: number): void
  footer?: ReactNode
}

interface UploadItem { id: string; name: string; progress: number; phase: 'preparing' | 'uploading'; controller: AbortController }
interface Notice { id: number; text: string }

const DRAFT_SAVE_MS = 2000
// Upload placeholders must be unique across every editor on the page and against a
// placeholder a reload left behind in a restored draft.
const SESSION_TAG = Date.now().toString(36)
let uploadSeq = 0
const MAX_ROWS_PX = 560
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl'

const fmt = (n: number) => n.toLocaleString('en-US')

function savedAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86_400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

// ---- icons (inline SVG elements, 16 px, currentColor) ----

const Icon = ({ d, label }: { d: string; label?: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden={label ? undefined : true} focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
const ICONS = {
  bold: 'M4.5 2.75h4.25a2.6 2.6 0 0 1 0 5.2H4.5zM4.5 7.95h5a2.65 2.65 0 0 1 0 5.3h-5z',
  italic: 'M6.5 2.75h5M4.5 13.25h5M9.75 2.75l-3.5 10.5',
  heading: 'M3.5 2.75v10.5M12.5 2.75v10.5M3.5 8h9',
  link: 'M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 0 0-3.9-3.9l-.6.6M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 0 0 3.9 3.9l.6-.6',
  quote: 'M3 4.5h4v4H4.75L3 11.5zM9 4.5h4v4h-2.25L9 11.5z',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  bullets: 'M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01',
  numbered: 'M6.5 4h7M6.5 8h7M6.5 12h7M2.25 2.75h1v3M2 10.25c.3-.4.7-.5 1-.5.5 0 .9.3.9.8 0 .7-1.9 1.4-1.9 2.2h2',
  image: 'M2.75 3.25h10.5v9.5H2.75zM2.75 10.5l3-3 2.5 2.5 1.75-1.75 3.25 3.25M10.25 6.25h.01',
  mention: 'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm0 0v.9c0 1 .7 1.6 1.5 1.6s1.5-.8 1.5-2.5a5.5 5.5 0 1 0-2.2 4.4',
  help: 'M8 14.25A6.25 6.25 0 1 0 8 1.75a6.25 6.25 0 0 0 0 12.5zM6.25 6.25a1.8 1.8 0 0 1 3.5.5c0 1.2-1.75 1.5-1.75 2.6M8 11.5h.01',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
} as const

interface ToolDef { key: keyof typeof ICONS; label: string; shortcut?: string; run?: (s: TextState) => Edit }
// The tools every width shows (image and mention come right after them, so a phone
// never loses them), and the rest — inline on a wide editor, under "More" on a narrow one.
const TOOLS: ToolDef[] = [
  { key: 'bold', label: 'Bold', shortcut: `${MOD}+B`, run: s => toggleWrap(s, '**', 'bold text') },
  { key: 'italic', label: 'Italic', shortcut: `${MOD}+I`, run: s => toggleWrap(s, '_', 'italic text') },
  { key: 'link', label: 'Link', shortcut: `${MOD}+K`, run: insertLink },
]
const MORE_TOOLS: ToolDef[] = [
  { key: 'heading', label: 'Heading', run: toggleHeading },
  { key: 'quote', label: 'Quote', run: toggleQuote },
  { key: 'code', label: 'Code', shortcut: `${MOD}+E`, run: toggleCode },
  { key: 'bullets', label: 'Bulleted list', shortcut: `${MOD}+Shift+8`, run: toggleBullets },
  { key: 'numbered', label: 'Numbered list', shortcut: `${MOD}+Shift+7`, run: toggleNumbered },
]

const HELP_ROWS: [string, string][] = [
  ['**bold**', 'bold'],
  ['_italic_', 'italic'],
  ['## Heading', 'a section heading'],
  ['[text](https://…)', 'a link'],
  ['> quoted', 'a quotation'],
  ['`code`', 'code; ``` on its own lines for a block'],
  ['- item', 'a bulleted list (1. for numbered)'],
  ['@address', 'mentions an account — they can be notified'],
  ['#450', 'links referendum 450'],
]

export function MarkdownEditor({
  value, onChange, maxChars, label, placeholder, minRows = 4, draftKey: placeKey = null, onSubmit, disabled = false,
  autoFocus = false, canUpload, uploadBlockedReason, onBusyChange, footer,
}: MarkdownEditorProps) {
  // Drafts are kept per signed-in account (and 'anon' signed out): another account on
  // this browser is never offered someone else's unsent text.
  const session = useSession()
  const draftKey = placeKey ? scopedDraftKey(placeKey, session?.accountId) : null
  const uploadRefusal = canUpload ? null : uploadBlockedReason || 'Sign in to add images.'
  const uid = useId()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The latest text: the textarea's own value when it is mounted (it is always
  // mounted, hidden in Preview), so several edits in one tick each see the previous.
  const valueRef = useRef(value)
  useLayoutEffect(() => { valueRef.current = value }, [value])
  const current = useCallback(() => taRef.current?.value ?? valueRef.current, [])
  const pendingSel = useRef<[number, number] | null>(null)
  const dirty = useRef(false)
  const noticeSeq = useRef(0)

  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [uploads, setUploads] = useState<UploadItem[]>([])
  // Set once an image has started uploading from this editor: from then on it says
  // that the image is already public, whether or not the text is ever posted.
  const [published, setPublished] = useState(false)
  const [notices, setNotices] = useState<Notice[]>([])
  const [dragDepth, setDragDepth] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [draftOffer, setDraftOffer] = useState<{ text: string; ago: string } | null>(null)
  const [trigger, setTrigger] = useState<ReturnType<typeof activeTrigger>>(null)
  const [found, setFound] = useState<{ key: string; rows: Suggestion[] }>({ key: '', rows: [] })
  const [activeSuggestion, setActiveSuggestion] = useState(0)

  const notify = useCallback((text: string) => {
    const id = ++noticeSeq.current
    setNotices(prev => [...prev.slice(-2), { id, text }])
  }, [])

  // ---- applying edits (native insertText first, so the browser's undo keeps working) ----

  const change = useCallback((next: string) => {
    dirty.current = true
    valueRef.current = next
    // Writing (or restoring) answers the "restore your draft?" question.
    if (next.trim()) setDraftOffer(null)
    onChange(next)
  }, [onChange])

  const apply = useCallback((edit: Edit) => {
    const ta = taRef.current
    const expected = applyEdit(current(), edit).text
    if (ta && !ta.disabled) {
      ta.focus()
      ta.setSelectionRange(edit.from, edit.to)
      let ok = false
      try {
        ok = edit.insert ? document.execCommand('insertText', false, edit.insert) : edit.from === edit.to || document.execCommand('delete')
      } catch { ok = false }
      if (ok && ta.value === expected) {
        ta.setSelectionRange(edit.selStart, edit.selEnd)
        dirty.current = true
        valueRef.current = expected
        return
      }
    }
    pendingSel.current = [edit.selStart, edit.selEnd]
    change(expected)
  }, [change, current])

  useLayoutEffect(() => {
    const ta = taRef.current
    const sel = pendingSel.current
    if (ta && sel && ta.value === value) {
      pendingSel.current = null
      ta.setSelectionRange(sel[0], sel[1])
    }
  }, [value])

  // Auto-grow up to a ceiling, then scroll — again whenever the width changes (a
  // rotated phone re-wraps every line).
  const grow = useCallback(() => {
    const ta = taRef.current
    if (!ta || ta.hidden) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight + 2, MAX_ROWS_PX)}px`
  }, [])
  useLayoutEffect(grow, [value, tab, grow])
  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    let width = ta.clientWidth
    const ro = new ResizeObserver(() => { if (ta.clientWidth !== width) { width = ta.clientWidth; grow() } })
    ro.observe(ta)
    return () => ro.disconnect()
  }, [grow])

  const state = useCallback((): TextState => {
    const ta = taRef.current
    const text = current()
    return { text, start: ta?.selectionStart ?? text.length, end: ta?.selectionEnd ?? text.length }
  }, [current])
  const run = (cmd: (s: TextState) => Edit) => { if (!disabled) { setTab('write'); apply(cmd(state())) } }

  // ---- drafts ----

  useEffect(() => {
    if (!draftKey) return
    pruneDrafts()
    if (valueRef.current.trim()) return
    const d = loadDraft(draftKey)
    if (d && d.text !== valueRef.current) setDraftOffer({ text: d.text, ago: savedAgo(d.savedAt, Date.now()) })
  }, [draftKey])

  useEffect(() => {
    if (!draftKey || !dirty.current) return
    const t = setTimeout(() => saveDraft(draftKey, value), DRAFT_SAVE_MS)
    return () => clearTimeout(t)
  }, [draftKey, value])

  const saveNow = () => { if (draftKey && dirty.current) saveDraft(draftKey, valueRef.current) }

  // ---- uploads ----

  useEffect(() => { onBusyChange?.(uploads.length) }, [uploads.length, onBusyChange])

  // Leaving the page (or unmounting the editor) cancels what is still uploading.
  const controllers = useRef(new Set<AbortController>())
  useEffect(() => {
    const live = controllers.current
    return () => { for (const c of live) c.abort() }
  }, [])

  const swapPlaceholder = useCallback((placeholder: string, replacement: string) => {
    const ta = taRef.current
    const focused = !!ta && document.activeElement === ta
    const cur: TextState = { text: current(), start: ta?.selectionStart ?? 0, end: ta?.selectionEnd ?? 0 }
    const next = replacePlaceholder(cur, placeholder, replacement)
    if (!next) return
    if (focused) pendingSel.current = [next.start, next.end]
    change(next.text)
  }, [change, current])

  const startUploads = useCallback((files: File[]) => {
    if (!files.length || disabled) return
    if (!canUpload) { notify(uploadRefusal ?? 'Sign in to add images.'); return }
    setTab('write')
    for (const file of files) {
      const id = `${SESSION_TAG}${(++uploadSeq).toString(36)}`
      const placeholder = uploadPlaceholder(id, file.name || 'image')
      const controller = new AbortController()
      controllers.current.add(controller)
      apply(insertPlaceholder(state(), placeholder))
      setUploads(prev => [...prev, { id, name: file.name || 'image', progress: 0, phase: 'preparing', controller }])
      const update = (patch: Partial<UploadItem>) => setUploads(prev => prev.map(u => (u.id === id ? { ...u, ...patch } : u)))
      const finish = () => setUploads(prev => prev.filter(u => u.id !== id))
      void (async () => {
        try {
          const prepared = await prepareImage(file)
          if (controller.signal.aborted) throw new UploadAborted()
          update({ phase: 'uploading' })
          setPublished(true)
          const result = await uploadImage(prepared.blob, {
            token: getSession()?.token ?? null,
            signal: controller.signal,
            onProgress: p => update({ progress: p }),
            onUnauthorized: () => setSession(null),
          })
          swapPlaceholder(placeholder, `![${altFromName(file.name || 'image')}](${result.url})`)
        } catch (err) {
          swapPlaceholder(placeholder, '')
          if (!(err instanceof UploadAborted)) {
            const why = err instanceof ImagePrepError || err instanceof UploadError ? err.message : 'The image could not be added. Try again.'
            notify(`${file.name || 'Image'}: ${why}`)
          }
        } finally {
          controllers.current.delete(controller)
          finish()
        }
      })()
    }
  }, [apply, canUpload, disabled, notify, state, swapPlaceholder, uploadRefusal])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(e.clipboardData?.files)
    if (!files.length) return
    e.preventDefault()
    startUploads(files)
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragDepth(d => d + 1) } }
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = canUpload && !disabled ? 'copy' : 'none' } }
  const onDragLeave = (e: DragEvent) => { if (hasFiles(e)) setDragDepth(d => Math.max(0, d - 1)) }
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragDepth(0)
    const files = imageFilesFrom(e.dataTransfer.files)
    if (!files.length) { notify('Only images can be dropped here (PNG, JPEG, WebP or GIF).'); return }
    startUploads(files)
  }

  // ---- @mentions and #referendum suggestions ----

  const updateTrigger = () => {
    const ta = taRef.current
    if (!ta || ta.selectionStart !== ta.selectionEnd) { setTrigger(null); return }
    const t = activeTrigger(ta.value, ta.selectionStart)
    setTrigger(prev => (prev?.kind === t?.kind && prev?.query === t?.query && prev?.from === t?.from ? prev : t))
  }

  const triggerKey = trigger ? `${trigger.kind}${trigger.query}` : ''
  useEffect(() => {
    if (!trigger) return
    const key = `${trigger.kind}${trigger.query}`
    const controller = new AbortController()
    const t = setTimeout(() => {
      api.search(trigger.query, controller.signal)
        .then(rows => { setFound({ key, rows: suggestionsFrom(trigger.kind, rows, trigger.query) }); setActiveSuggestion(0) })
        .catch(() => { if (!controller.signal.aborted) setFound({ key, rows: [] }) })
    }, 220)
    return () => { clearTimeout(t); controller.abort() }
  }, [trigger])

  const pick = (s: Suggestion) => {
    if (!trigger) return
    apply(completeTrigger(state(), trigger.from, s.token))
    setTrigger(null)
  }
  // Results answer only the trigger they were fetched for, never a newer one.
  const suggestions = found.key === triggerKey ? found.rows : []
  const listOpen = !!trigger && suggestions.length > 0 && tab === 'write'

  // ---- keyboard ----

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggestion(i => (i + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion(i => (i - 1 + suggestions.length) % suggestions.length); return }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); pick(suggestions[activeSuggestion] ?? suggestions[0]); return }
      if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return }
    }
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') { e.preventDefault(); saveNow(); onSubmit?.(); return }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (!e.shiftKey && k === 'b') { e.preventDefault(); run(s => toggleWrap(s, '**', 'bold text')); return }
      if (!e.shiftKey && k === 'i') { e.preventDefault(); run(s => toggleWrap(s, '_', 'italic text')); return }
      if (!e.shiftKey && k === 'k') { e.preventDefault(); run(insertLink); return }
      if (!e.shiftKey && k === 'e') { e.preventDefault(); run(toggleCode); return }
      if (e.shiftKey && e.code === 'Digit7') { e.preventDefault(); run(toggleNumbered); return }
      if (e.shiftKey && e.code === 'Digit8') { e.preventDefault(); run(toggleBullets); return }
    }
    if (e.key === 'Tab' && !mod && !e.altKey && selectionInList(state())) {
      e.preventDefault()
      run(s => indentLines(s, e.shiftKey))
      return
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      const edit = continueList(state())
      if (edit) { e.preventDefault(); apply(edit) }
    }
  }

  // ---- the "More" menu: opens with click or ArrowDown, arrow keys move, Escape closes ----
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const moreId = `${uid}-more`
  useEffect(() => {
    if (!moreOpen) return
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!moreRef.current?.contains(t) && !moreBtnRef.current?.contains(t)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [moreOpen])
  const onMoreKey = (e: KeyboardEvent) => {
    const items = Array.from(moreRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus() }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); setMoreOpen(false); moreBtnRef.current?.focus() }
  }

  // ---- help popover: closes on Escape and outside clicks ----

  const helpRef = useRef<HTMLDivElement>(null)
  const helpBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!helpOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!helpRef.current?.contains(t) && !helpBtnRef.current?.contains(t)) setHelpOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setHelpOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [helpOpen])

  // ---- render ----

  const media = useMemo(() => (tab === 'preview' ? previewMedia(value) : {}), [tab, value])
  const count = value.length
  const over = count - maxChars
  const near = over <= 0 && count >= maxChars * 0.9
  const counterId = `${uid}-count`
  const listId = `${uid}-suggest`
  const helpId = `${uid}-help`
  const dropping = dragDepth > 0

  return (
    <div
      className={`mde${disabled ? ' mde-disabled' : ''}${dropping ? ' mde-dropping' : ''}`}
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      {draftOffer && (
        <div className="mde-draft" role="status">
          <span>You have an unsent draft here, saved {draftOffer.ago}.</span>
          <span className="mde-draft-actions">
            <button type="button" className="mde-link-btn" onClick={() => { change(draftOffer.text); setDraftOffer(null); requestAnimationFrame(() => taRef.current?.focus()) }}>Restore it</button>
            <button type="button" className="mde-link-btn mde-muted" onClick={() => { if (draftKey) saveDraft(draftKey, ''); setDraftOffer(null) }}>Discard</button>
          </span>
        </div>
      )}

      <div className="mde-bar">
        <div className="mde-tabs" role="tablist" aria-label="Editor mode">
          <button type="button" role="tab" aria-selected={tab === 'write'} className={`mde-tab${tab === 'write' ? ' on' : ''}`} onClick={() => setTab('write')}>Write</button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} className={`mde-tab${tab === 'preview' ? ' on' : ''}`} onClick={() => { saveNow(); setTab('preview') }}>Preview</button>
        </div>
        <div className="mde-tools" role="toolbar" aria-label="Formatting" aria-orientation="horizontal">
          {TOOLS.map(t => (
            <button
              key={t.key} type="button" className="mde-tool" disabled={disabled}
              aria-label={t.shortcut ? `${t.label} (${t.shortcut})` : t.label} title={t.shortcut ? `${t.label} · ${t.shortcut}` : t.label}
              onMouseDown={e => e.preventDefault()} onClick={() => t.run && run(t.run)}
            ><Icon d={ICONS[t.key]} /></button>
          ))}
          <button
            type="button" className={`mde-tool${canUpload ? '' : ' mde-tool-blocked'}`} disabled={disabled}
            aria-label={canUpload ? 'Add an image' : `Add an image — ${uploadRefusal}`} title={canUpload ? 'Add an image — or paste or drop one. It is public as soon as it uploads, even if you don’t post.' : uploadRefusal ?? undefined}
            aria-disabled={!canUpload || undefined}
            onMouseDown={e => e.preventDefault()}
            onClick={() => (canUpload ? fileRef.current?.click() : notify(uploadRefusal ?? 'Sign in to add images.'))}
          ><Icon d={ICONS.image} /></button>
          <button
            type="button" className="mde-tool" disabled={disabled} aria-label="Mention an account" title="Mention an account (type @ and a name or address)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => run(s => insertAt(s, s.start > 0 && !/\s/.test(s.text[s.start - 1]) ? ' @' : '@'))}
          ><Icon d={ICONS.mention} /></button>
          <span className="mde-sep" aria-hidden="true" />
          <span className="mde-inline-more">
            {MORE_TOOLS.map(t => (
              <button
                key={t.key} type="button" className="mde-tool" disabled={disabled}
                aria-label={t.shortcut ? `${t.label} (${t.shortcut})` : t.label} title={t.shortcut ? `${t.label} · ${t.shortcut}` : t.label}
                onMouseDown={e => e.preventDefault()} onClick={() => t.run && run(t.run)}
              ><Icon d={ICONS[t.key]} /></button>
            ))}
          </span>
          <button
            ref={moreBtnRef} type="button" className="mde-tool mde-more-btn" disabled={disabled}
            aria-label="More formatting" title="More formatting" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreOpen ? moreId : undefined}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setMoreOpen(o => !o)}
            onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setMoreOpen(true) } }}
          ><Icon d={ICONS.more} /></button>
          <button ref={helpBtnRef} type="button" className="mde-tool" aria-label="Formatting help" aria-expanded={helpOpen} aria-controls={helpId} title="Formatting help" onClick={() => setHelpOpen(o => !o)}>
            <Icon d={ICONS.help} />
          </button>
        </div>
        {moreOpen && (
          <div ref={moreRef} className="mde-more-menu" id={moreId} role="menu" aria-label="More formatting" onKeyDown={onMoreKey}>
            {MORE_TOOLS.map(t => (
              <button
                key={t.key} type="button" role="menuitem" className="mde-more-item" tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onClick={() => { setMoreOpen(false); if (t.run) run(t.run) }}
              >
                <Icon d={ICONS[t.key]} /><span>{t.label}</span>{t.shortcut && <kbd>{t.shortcut}</kbd>}
              </button>
            ))}
          </div>
        )}
        {/* Outside the toolbar's scroll box (and its fading mask), anchored to the bar. */}
        {helpOpen && (
          <div ref={helpRef} className="mde-help-pop" id={helpId} role="dialog" aria-label="Formatting help">
            <table>
              <tbody>
                {HELP_ROWS.map(([syntax, means]) => <tr key={syntax}><td><code>{syntax}</code></td><td>{means}</td></tr>)}
              </tbody>
            </table>
            <p>Paste or drop an image to add it. It uploads at once and is public on IPFS from then on, even if you don’t post.<span className="mde-kbd-hint"> {MOD}+Enter posts.</span></p>
          </div>
        )}
      </div>

      <input
        ref={fileRef} type="file" accept={ACCEPT_ATTR} multiple hidden tabIndex={-1}
        onChange={e => { const files = imageFilesFrom(e.target.files); e.target.value = ''; startUploads(files) }}
      />

      <div className="mde-body">
        <textarea
          ref={taRef}
          hidden={tab !== 'write'}
          className="mde-input"
          value={value}
          rows={minRows}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={counterId}
          aria-invalid={over > 0 || undefined}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? `${listId}-${activeSuggestion}` : undefined}
          disabled={disabled}
          autoFocus={autoFocus}
          spellCheck
          onChange={e => { change(e.target.value); updateTrigger() }}
          onSelect={updateTrigger}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { saveNow(); setTimeout(() => setTrigger(null), 150) }}
        />
        {tab === 'preview' && (
          <div className="mde-preview" aria-live="polite" aria-label="Preview">
            {value.trim()
              ? <Markdown body={value} format="markdown" media={media} className="mde-preview-md" native />
              : <p className="mde-empty">Nothing to preview yet.</p>}
          </div>
        )}
        {listOpen && (
          <ul className="mde-suggest" id={listId} role="listbox" aria-label={trigger!.kind === '@' ? 'Accounts' : 'Referenda'}>
            {suggestions.map((s, i) => (
              <li
                key={s.key} id={`${listId}-${i}`} role="option" aria-selected={i === activeSuggestion}
                className={i === activeSuggestion ? 'on' : undefined}
                onMouseDown={e => { e.preventDefault(); pick(s) }}
                onMouseEnter={() => setActiveSuggestion(i)}
              >
                <span className="mde-suggest-primary">{s.primary}</span>
                <span className="mde-suggest-secondary">{s.secondary}</span>
              </li>
            ))}
          </ul>
        )}
        {dropping && (
          <div className="mde-drop" aria-hidden="true">
            {canUpload && !disabled ? 'Drop images to add them' : uploadRefusal}
          </div>
        )}
      </div>

      {uploads.length > 0 && (
        <ul className="mde-uploads" aria-label="Images being added">
          {uploads.map(u => (
            <li key={u.id} className="mde-upload">
              <span className="mde-upload-name" title={u.name}>{u.name}</span>
              <span className="mde-upload-bar" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={u.phase === 'uploading' ? Math.round(u.progress * 100) : undefined}>
                <span style={{ width: `${u.phase === 'uploading' ? Math.max(4, Math.round(u.progress * 100)) : 4}%` }} />
              </span>
              <span className="mde-upload-state">{u.phase === 'preparing' ? 'Preparing…' : u.progress >= 1 ? 'Saving…' : `${Math.round(u.progress * 100)}%`}</span>
              <button type="button" className="mde-link-btn mde-muted" onClick={() => u.controller.abort()}>Cancel</button>
            </li>
          ))}
        </ul>
      )}

      {published && <p className="mde-public-note">Images are public on IPFS as soon as they upload, even if you don’t post. One that no post ends up using is taken down after about a day.</p>}

      {notices.length > 0 && (
        <ul className="mde-notices" role="alert">
          {notices.map(n => (
            <li key={n.id}>
              <span>{n.text}</span>
              <button type="button" className="mde-link-btn mde-muted" aria-label="Dismiss" onClick={() => setNotices(prev => prev.filter(x => x.id !== n.id))}>Dismiss</button>
            </li>
          ))}
        </ul>
      )}

      <div className="mde-foot">
        <div className="mde-foot-main">{footer}</div>
        <span id={counterId} className={`mde-count${over > 0 ? ' over' : near ? ' near' : ''}`} aria-live={over > 0 ? 'polite' : 'off'}>
          {over > 0 ? `${fmt(over)} over the ${fmt(maxChars)} limit` : `${fmt(count)} / ${fmt(maxChars)}`}
        </span>
      </div>
    </div>
  )
}
