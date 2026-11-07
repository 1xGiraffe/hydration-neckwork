import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

// Real tab semantics over the app's own `.tabs` bar: the styling, the ink and the
// narrow-screen edge fade come from the shared class; the roles, the
// `aria-controls` → panel relation and roving focus (←/→, Home/End) are this
// component's. Each tab names the panel `${idPrefix}-panel-${id}`, so the caller
// renders its panel with that id, `role="tabpanel"` and
// `aria-labelledby={`${idPrefix}-tab-${id}`}` (TabPanel does).
//
// `onChange(id, replace)`: a CLICK is a deliberate choice (replace = false); arrow
// movement is roving focus inside one control (replace = true), so a caller that
// keeps the tab in the URL can avoid an entry per keypress.
export interface RovingTab { id: string; label: ReactNode }
export function RovingTabs({ tabs, value, onChange, idPrefix, label, className = 'tabs' }: {
  tabs: readonly RovingTab[]; value: string; onChange: (id: string, replace: boolean) => void
  idPrefix: string; label: string; className?: string
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? last
            : null
    if (next == null) return
    e.preventDefault()
    const target = tabs[next]
    onChange(target.id, true)
    refs.current[target.id]?.focus()
  }
  return (
    <div className={className} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          ref={el => { refs.current[tab.id] = el }}
          className={value === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id, false)}
          onKeyDown={e => onKeyDown(e, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** The panel a RovingTabs tab controls. */
export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
  return <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0}>{children}</div>
}
