import { noAutofill } from './ui'
import { useEffect, useId, useRef, useState } from 'react'
import { fieldHistory, removeFieldValue, suggestionsFor } from '../writeHistory'

// A contract-form field (Read and Write tabs) that offers what was last typed
// into the same field of the same function signature (writeHistory.ts). Built
// on the combo tokens the filters use, with one addition the filters do not
// need: every suggestion can be forgotten, by its × or by Delete/Backspace
// while it is highlighted — a mistyped address should not follow you around
// forever.
export function RecentValueInput({
  signature, field, value, placeholder, onChange,
}: {
  signature: string
  field: string
  value: string
  placeholder?: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  // Opens upward when downward would cover what follows the field — for the last
  // argument that is the Write or Query button itself.
  const [flip, setFlip] = useState(false)
  const listboxId = useId()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const blurTimer = useRef<number | undefined>(undefined)

  // Read on open rather than on mount: another row (or another tab) may have
  // recorded a value since this row was rendered.
  const reopen = () => {
    window.clearTimeout(blurTimer.current)
    const next = fieldHistory(signature, field)
    setHistory(next)
    setActiveIndex(-1)
    setOpen(true)
    decideFlip(suggestionsFor(next, value).length)
  }
  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  // A pointer press anywhere outside closes immediately rather than on the blur
  // timer. Without this the popover is still up when the press lands, and since
  // it sits over the Write button the click hits a suggestion instead of the
  // button — a write that silently refills a field.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Decided when the list opens or changes, from the space left in the row —
  // computed in the event handler rather than an effect, so no cascading render.
  // ROW_HEIGHT is the padded height of one .combo-opt; only its order of
  // magnitude matters, since the question is just "does this reach past the row".
  const ROW_HEIGHT = 34
  const decideFlip = (count: number) => {
    const wrap = wrapRef.current
    const row = wrap?.closest('.fn-row')
    if (!wrap || !row || !count) return setFlip(false)
    // The limit is whatever must stay clickable below the field — the write
    // button's container when this input sits in a write row — falling back to
    // the end of the row. Overlaying plain content is fine; overlaying the
    // primary action is not, because the press would land on a suggestion.
    const actions = row.querySelector('.fn-actions')
    const limit = actions ? actions.getBoundingClientRect().top - 6 : row.getBoundingClientRect().bottom - 4
    setFlip(Math.min(count * ROW_HEIGHT + 12, 280) > limit - wrap.getBoundingClientRect().bottom)
  }

  const list = open ? suggestionsFor(history, value) : []
  const forget = (candidate: string) => {
    removeFieldValue(signature, field, candidate)
    const next = fieldHistory(signature, field)
    setHistory(next)
    const remaining = suggestionsFor(next, value)
    setActiveIndex(index => Math.min(index, remaining.length - 1))
    decideFlip(remaining.length)
  }

  return (
    <div className="combo recent-field" ref={wrapRef}>
      <input {...noAutofill}
        className="input"
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && list.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        onChange={event => {
          onChange(event.target.value)
          setActiveIndex(-1)
          setOpen(true)
          decideFlip(suggestionsFor(history, event.target.value).length)
        }}
        onFocus={reopen}
        onMouseDown={() => { if (!open) reopen() }}
        onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 160) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) return reopen()
            setActiveIndex(index => Math.min(index + 1, list.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex(index => Math.max(index - 1, -1))
          } else if (event.key === 'Enter' && open && activeIndex >= 0 && list[activeIndex]) {
            event.preventDefault()
            onChange(list[activeIndex])
            setOpen(false)
          } else if ((event.key === 'Delete' || event.key === 'Backspace') && open && activeIndex >= 0 && list[activeIndex]) {
            // Only while a suggestion is highlighted — otherwise Delete and
            // Backspace must keep editing the text, which is what they are for.
            event.preventDefault()
            forget(list[activeIndex])
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          }
        }}
      />
      {open && list.length > 0 && (
        <div ref={popRef} id={listboxId} className={`combo-pop recent-pop${flip ? ' up' : ''}`} role="listbox" aria-label="Recently used values">
          {list.map((candidate, index) => (
            <div
              key={candidate}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`combo-opt recent-opt${index === activeIndex ? ' active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => { event.preventDefault(); onChange(candidate); setOpen(false) }}
            >
              <span className="recent-val">{candidate}</span>
              <button
                type="button"
                className="acct-chip-x recent-forget"
                aria-label={`Forget ${candidate}`}
                title="Forget this value"
                onMouseDown={event => { event.preventDefault(); event.stopPropagation(); forget(candidate) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
